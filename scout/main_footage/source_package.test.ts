import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSourcePackage, fingerprintCanonical } from './contracts.ts';
import { buildSourcePackage } from './source_package.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-source-package-'));
const scoutOutputRoot = path.join(root, 'scout-output');
const contentSetPath = path.join(root, 'external-content-set', 'content.json');
const acceptedBytes = Buffer.from('accepted source bytes');

const photo = (index: number) => ({
  id: `post-1:${index}`,
  kind: 'image' as const,
  index,
  canonical_post_url: 'https://www.instagram.com/p/post-1/',
  ephemeral_url: `https://cdn.example.test/photo-${index}?ephemeral_url=secret`,
});
const video = (index: number) => ({
  id: `post-1:${index}`,
  kind: 'video' as const,
  index,
  canonical_post_url: 'https://www.instagram.com/p/post-1/',
  ephemeral_url: `https://cdn.example.test/video-${index}?ephemeral_url=secret`,
});
const post = (media: (ReturnType<typeof photo> | ReturnType<typeof video>)[]) => ({
  canonical_url: 'https://www.instagram.com/p/post-1/',
  platform: 'instagram' as const,
  post_id: 'post-1',
  owner_handle: 'owner',
  text: 'caption',
  media,
  outcome: { status: 'resolved' as const, source: 'network' as const, attempts: 1, elapsed_ms: 1 },
});

function writeDownload(name: string, bytes = acceptedBytes): string {
  const download = path.join(root, name);
  fs.writeFileSync(download, bytes);
  return download;
}

const technical = {
  container: 'mp4',
  video_codec: 'h264',
  duration_sec: 12.5,
  width: 1080,
  height: 1920,
  has_audio: true,
};

// Deterministic fakes for the six injected scene-index ports: buildSourcePackage now indexes
// every published source, and these tests must never touch ffmpeg/network/real models.
const fakeSceneDeps = {
  analyzerIdentity: 'test-source-package-analyzer@1',
  detectScenes: async () => [],
  extractFrames: async (_source: string, atSeconds: number[]) =>
    atSeconds.map((t) =>
      writeDownload(`frame-${t}-${Math.random()}.jpg`, Buffer.from(`frame:${t}`)),
    ),
  transcribe: async () => [],
  describeWithVision: async () => ({
    subject: 's',
    action: 'a',
    setting: 'se',
    composition: 'c',
    motion: 'm',
    topic: 't',
  }),
  embed: async () => null,
  measureVisuals: async () => ({ motion_score: 0, brightness: 0, scene_change_score: 0 }),
};

try {
  const attempted: number[] = [];
  const result = await buildSourcePackage(
    { post: post([photo(0), video(1), photo(2), video(3)]), contentSetPath, coverageTarget: 0.75 },
    {
      ...fakeSceneDeps,
      scoutOutputRoot,
      materialize: async (asset) => {
        attempted.push(asset.index);
        if (asset.index === 3) throw new Error('temporary materializer failure');
        return {
          path: writeDownload('video-1.mp4'),
          kind: 'video',
          source: 'direct-http',
          bytes: acceptedBytes.length,
        };
      },
      probe: async () => technical,
      now: () => 100,
    },
  );

  assert.deepEqual(attempted, [1, 3], 'photos must never be materialized');
  assert.equal(
    result.package.scene_indexes.length,
    result.package.sources.length,
    'every published source gets a scene index',
  );
  assert.deepEqual(
    result.package.scene_indexes.map((index) => index.source_id),
    result.package.sources.map((source) => source.id),
  );
  // The manifest this writer publishes must satisfy the reader every consumer uses. Without
  // this, a producer-side field can violate the contract (a materializer reporting attempts:0
  // did) and only surface much later as an opaque `source_package_invalid` at validation.
  assert.deepEqual(
    decodeSourcePackage(JSON.parse(result.packageJson)),
    result.package,
    'the published manifest must round-trip through decodeSourcePackage',
  );
  assert.match(result.package.fingerprint, /^sha256:[0-9a-f]{64}$/);
  // Ruling A, behaviorally: the published fingerprint really is the fingerprint of the
  // published content *including* the scene indexes — a format regex cannot show this.
  assert.equal(
    fingerprintCanonical(result.package),
    result.package.fingerprint,
    'the published fingerprint must reproduce from the published package content',
  );
  assert.notEqual(
    fingerprintCanonical({ ...result.package, scene_indexes: [] }),
    result.package.fingerprint,
    'a fingerprint computed over an empty scene-index list must differ from the real one',
  );
  assert.notEqual(
    fingerprintCanonical({
      ...result.package,
      scene_indexes: result.package.scene_indexes.map((index) => ({
        ...index,
        checksum: `sha256:${'a'.repeat(64)}`,
      })),
    }),
    result.package.fingerprint,
    'differing scene-index content must produce a different package fingerprint',
  );
  assert.deepEqual(
    result.package.sources.map((source) => source.media_index),
    [1],
  );
  assert.equal(result.package.ignored.length, 2);
  assert.ok(result.package.ignored.every((entry) => entry.code === 'photo_slide_ignored'));
  assert.equal(result.package.unavailable[0]?.code, 'source_video_skipped');
  assert.equal(result.descriptor.mode, 'forced_url_pool');
  assert.equal(result.descriptor.coverage_target, 0.75);
  assert.ok(!path.isAbsolute(result.descriptor.package_manifest));
  assert.ok(result.descriptor.package_manifest.startsWith('../'));
  assert.equal(
    result.package.sources[0]?.checksum,
    `sha256:${createHash('sha256').update(acceptedBytes).digest('hex')}`,
  );
  assert.deepEqual(result.package.sources[0]?.technical, technical);
  assert.equal(result.package.sources[0]?.bytes, acceptedBytes.length);
  assert.deepEqual(result.package.sources[0]?.acquisition, {
    source: 'direct-http',
    attempts: 1,
    elapsed_ms: 0,
  });
  const sourcePath = path.join(path.dirname(result.packagePath), result.package.sources[0]!.path);
  assert.deepEqual(fs.readFileSync(sourcePath), acceptedBytes);
  assert.ok(!result.packageJson.includes('ephemeral_url'));

  const second = await buildSourcePackage(
    { post: post([video(1)]), contentSetPath, coverageTarget: 0.75 },
    {
      ...fakeSceneDeps,
      scoutOutputRoot,
      materialize: async () => ({
        path: writeDownload('video-1-repeat.mp4'),
        kind: 'video',
        source: 'direct-http',
        bytes: acceptedBytes.length,
      }),
      probe: async () => technical,
      now: () => 100,
    },
  );
  assert.notEqual(
    second.packagePath,
    result.packagePath,
    'a published package is never overwritten',
  );
  assert.deepEqual(
    fs.readFileSync(path.join(path.dirname(second.packagePath), second.package.sources[0]!.path)),
    acceptedBytes,
  );
  assert.equal(second.package.scene_indexes.length, second.package.sources.length);
  assert.match(second.package.fingerprint, /^sha256:[0-9a-f]{64}$/);

  const everyAttempt: number[] = [];
  await assert.rejects(
    () =>
      buildSourcePackage(
        { post: post([video(1), video(3)]), contentSetPath, coverageTarget: 0.6 },
        {
          ...fakeSceneDeps,
          scoutOutputRoot,
          materialize: async (asset) => {
            everyAttempt.push(asset.index);
            throw new Error('not usable');
          },
          probe: async () => technical,
        },
      ),
    { message: 'forced_main_no_usable_video' },
  );
  assert.deepEqual(everyAttempt, [1, 3], 'every video must be tried before the forced failure');

  const interrupted = await assert.rejects(
    () =>
      buildSourcePackage(
        { post: post([video(5)]), contentSetPath, coverageTarget: 0.6 },
        {
          ...fakeSceneDeps,
          scoutOutputRoot,
          materialize: async () => ({
            path: writeDownload('interrupted.mp4'),
            kind: 'video',
            source: 'direct-http',
            bytes: acceptedBytes.length,
          }),
          probe: async () => {
            throw new Error('ffprobe interrupted');
          },
        },
      ),
    { message: 'forced_main_no_usable_video' },
  );
  assert.equal(interrupted, undefined);
  const packageRoot = path.join(scoutOutputRoot, 'main-footage');
  if (fs.existsSync(packageRoot)) {
    for (const folder of fs.readdirSync(packageRoot)) {
      const sources = path.join(packageRoot, folder, 'sources');
      assert.ok(!fs.existsSync(path.join(sources, 'source-post-1-5.mp4')));
    }
  }

  const redirectedOutputRoot = path.join(root, 'redirected-scout-output');
  const outsidePackageRoot = path.join(root, 'outside-package-root');
  fs.mkdirSync(redirectedOutputRoot, { recursive: true });
  fs.mkdirSync(outsidePackageRoot, { recursive: true });
  fs.symlinkSync(outsidePackageRoot, path.join(redirectedOutputRoot, 'main-footage'), 'junction');
  let redirectedMaterialized = 0;
  await assert.rejects(
    () =>
      buildSourcePackage(
        { post: post([video(9)]), contentSetPath, coverageTarget: 0.6 },
        {
          ...fakeSceneDeps,
          scoutOutputRoot: redirectedOutputRoot,
          materialize: async () => {
            redirectedMaterialized += 1;
            return {
              path: writeDownload('redirected.mp4'),
              kind: 'video',
              source: 'direct-http',
              bytes: acceptedBytes.length,
            };
          },
          probe: async () => technical,
        },
      ),
    /path_outside_root/,
  );
  assert.equal(redirectedMaterialized, 0, 'containment must fail before materialization');
  assert.deepEqual(
    fs.readdirSync(outsidePackageRoot),
    [],
    'no package artifact may be written through a junction',
  );

  // --- Ruling K: one failing scene index skips that source; the package still publishes ------
  {
    const isolated = await buildSourcePackage(
      { post: post([video(1), video(3)]), contentSetPath, coverageTarget: 0.6 },
      {
        ...fakeSceneDeps,
        scoutOutputRoot,
        detectScenes: async (sourcePath: string) => {
          if (sourcePath.includes('source-post-1-3')) throw new Error('ffmpeg_scene_detect_failed');
          return [];
        },
        materialize: async () => ({
          path: writeDownload(`isolated-${Math.random()}.mp4`),
          kind: 'video' as const,
          source: 'direct-http' as const,
          bytes: acceptedBytes.length,
        }),
        probe: async () => technical,
        now: () => 100,
      },
    );
    assert.deepEqual(
      isolated.package.sources.map((source) => source.media_index),
      [1],
      'a source whose index throws is dropped from the manifest, not carried without an index',
    );
    assert.equal(isolated.package.scene_indexes.length, isolated.package.sources.length);
    assert.ok(
      isolated.package.unavailable.some(
        (entry) => entry.media_index === 3 && entry.code === 'source_video_skipped',
      ),
      'an indexing failure is reported with the stable source_video_skipped code',
    );
    assert.equal(isolated.summary.usable_video_count, 1);
  }

  // --- Ruling K: zero indexed sources fails closed and publishes nothing ---------------------
  {
    const packagesRoot = path.join(scoutOutputRoot, 'main-footage');
    const manifestsBefore = fs.existsSync(packagesRoot)
      ? fs
          .readdirSync(packagesRoot)
          .filter((folder) => fs.existsSync(path.join(packagesRoot, folder, 'package.json')))
      : [];
    await assert.rejects(
      () =>
        buildSourcePackage(
          { post: post([video(1)]), contentSetPath, coverageTarget: 0.6 },
          {
            ...fakeSceneDeps,
            scoutOutputRoot,
            detectScenes: async () => {
              throw new Error('ffmpeg_scene_detect_failed');
            },
            materialize: async () => ({
              path: writeDownload(`all-index-fail-${Math.random()}.mp4`),
              kind: 'video' as const,
              source: 'direct-http' as const,
              bytes: acceptedBytes.length,
            }),
            probe: async () => technical,
            now: () => 100,
          },
        ),
      { message: 'forced_main_no_usable_video' },
    );
    const manifestsAfter = fs
      .readdirSync(packagesRoot)
      .filter((folder) => fs.existsSync(path.join(packagesRoot, folder, 'package.json')));
    assert.deepEqual(
      manifestsAfter,
      manifestsBefore,
      'a package with zero scene indexes must never be published',
    );
  }

  console.log('ok source_package');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
