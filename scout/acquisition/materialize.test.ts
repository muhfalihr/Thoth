import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Materializer } from './materialize.ts';

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
  assert.ok(fs.existsSync(direct.path));
  console.log('ok acquisition_materialize');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
