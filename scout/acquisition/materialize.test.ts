import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Materializer } from './materialize.ts';
import { AcquisitionError } from './types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-materialize-'));
try {
  const calls: { executable: string; args: string[] }[] = [];
  const materializer = new Materializer({ galleryDl: 'gallery-dl', ytdlp: 'yt-dlp' } as any, {
    run: async (executable, args) => {
      calls.push({ executable, args });
      const filename = args[args.indexOf('--filename') + 1].replace('{extension}', 'jpg');
      fs.writeFileSync(path.join(root, filename), Buffer.from('image'));
      return { exitCode: 0, stderr: '', timedOut: false };
    },
    fetchBytes: async () => Buffer.from('direct'),
    root,
  });
  const local = await materializer.materialize(
    {
      id: 'ABC:1',
      kind: 'image',
      index: 1,
      canonical_post_url: 'https://www.instagram.com/p/ABC/',
    },
    'footage',
  );
  assert.equal(local.source, 'gallery-dl');
  assert.equal(local.attempts, 1);
  assert.ok(typeof local.elapsed_ms === 'number' && local.elapsed_ms >= 0);
  assert.equal(calls[0].executable, 'gallery-dl');
  assert.deepEqual(calls[0].args.slice(-3), ['--range', '1', 'https://www.instagram.com/p/ABC/']);
  assert.ok(fs.existsSync(local.path));

  const fallback = new Materializer({ galleryDl: 'gallery-dl', ytdlp: 'yt-dlp' } as any, {
    run: async () => ({
      exitCode: 1,
      stderr: 'extractor failed at https://secret.test',
      timedOut: false,
    }),
    fetchBytes: async () => Buffer.from('direct'),
    root,
  });
  const direct = await fallback.materialize(
    {
      id: 'DEF:1',
      kind: 'image',
      index: 1,
      canonical_post_url: 'https://www.instagram.com/p/DEF/',
      ephemeral_url: 'https://cdn.test/direct.jpg?sig=secret',
    },
    'footage',
  );
  assert.equal(direct.source, 'direct-http');
  assert.equal(direct.attempts, 2);
  assert.ok(fs.existsSync(direct.path));
  console.log('ok acquisition_materialize');

  // Non-brief case: drive every source to failure and prove the resulting
  // AcquisitionError carries no trace of the secret embedded in stderr/ephemeral_url.
  const secretToken = 'SECRET_TOKEN_9f3a1c7e';
  const allFail = new Materializer({ galleryDl: 'gallery-dl', ytdlp: 'yt-dlp' } as any, {
    run: async () => ({
      exitCode: 1,
      stderr: `extractor failed at https://cdn.test/leak?token=${secretToken}`,
      timedOut: false,
    }),
    fetchBytes: async () => {
      throw new Error(`fetch rejected for token ${secretToken}`);
    },
    root,
  });

  let caught: unknown;
  try {
    await allFail.materialize(
      {
        id: 'GHI:1',
        kind: 'image',
        index: 1,
        canonical_post_url: 'https://www.instagram.com/p/GHI/',
        ephemeral_url: `https://cdn.test/direct.jpg?sig=${secretToken}`,
      },
      'footage',
    );
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof AcquisitionError);
  const failure = caught as AcquisitionError;
  assert.equal(failure.message, 'media materialization failed');
  assert.equal(failure.outcome.reason, 'materialization-failed');
  assert.equal((failure as { cause?: unknown }).cause, undefined);

  const serialized = JSON.stringify({
    message: failure.message,
    stack: failure.stack,
    outcome: failure.outcome,
  });
  assert.ok(!serialized.includes(secretToken));
  console.log('ok acquisition_materialize_privacy');

  // An asset already materialized on disk is served from there. Regression: a TikTok post whose
  // media had already been downloaded still failed the whole run, because the chain was executed
  // unconditionally and every source happened to be down at that moment (no ephemeral_url left in
  // the cached post record, yt-dlp's extractor broken) even though the file was sitting in root.
  {
    const asset = {
      id: 'https://www.tiktok.com/@idntimes/video/7677122351166655765#1',
      kind: 'video' as const,
      index: 1,
      canonical_post_url: 'https://www.tiktok.com/@idntimes/video/7677122351166655765',
    };
    const assetHash = createHash('sha256')
      .update(`tiktok:${asset.id}:main`)
      .digest('hex')
      .slice(0, 16);
    const everySourceDown = {
      run: async () => ({ exitCode: 1, stderr: 'extractor down', timedOut: false }),
      fetchBytes: async () => {
        throw new Error('network down');
      },
      root,
    };

    // A half-written download must not pass as a materialized asset.
    fs.writeFileSync(path.join(root, `${assetHash}.mp4.part`), Buffer.from('partial'));
    await assert.rejects(
      () => new Materializer({ galleryDl: 'gallery-dl', ytdlp: 'yt-dlp' } as any, everySourceDown)
        .materialize(asset, 'main'),
      AcquisitionError,
      'an interrupted download left behind as a .part file is not a materialized asset',
    );

    fs.writeFileSync(path.join(root, `${assetHash}.mp4`), Buffer.from('already downloaded'));
    const reused = await new Materializer(
      { galleryDl: 'gallery-dl', ytdlp: 'yt-dlp' } as any,
      everySourceDown,
    ).materialize(asset, 'main');
    assert.equal(reused.source, 'cache');
    assert.equal(reused.path, path.join(root, `${assetHash}.mp4`));
    assert.equal(reused.bytes, 'already downloaded'.length);
    assert.ok(
      reused.attempts >= 1,
      'a materialized asset reports at least one attempt — SourcePackageV1 rejects attempts < 1',
    );
    console.log('ok acquisition_materialize_reuse');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
