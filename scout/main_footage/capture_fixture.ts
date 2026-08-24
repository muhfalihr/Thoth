// capture_fixture.ts — regenerates the committed Scout source package that the Rust
// acceptance suite imports, plans and renders.
//
// Run: `bun scout/main_footage/capture_fixture.ts`
//
// The fixture has to be Scout's own output, not a hand-typed manifest: both
// production-breaking defects on this feature were cross-runtime shape mismatches that
// only bytes Scout actually wrote could have caught. So this drives the real
// `buildSourcePackage` — real ffmpeg media, real probing, real scene indexing, real
// frame extraction, real visual metrics, real atomic publishing — and injects only the
// three ports a live run would send to a model or a network:
//
//   detectScenes      deterministic boundaries (ffmpeg's own detector finds none in
//                     synthetic bars, and the fixture needs more than one scene for
//                     scene selection to be exercised downstream)
//   transcribe        Whisper
//   describeWithVision / embed   the vision and embedding models
//
// Re-run this instead of hand-editing anything under
// `crates/thoth-core/tests/fixtures/scout_package/`. Every checksum, cache key and
// fingerprint in the package is derived, so an edited byte invalidates the tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PostRecord } from '../acquisition/types.ts';
import {
  defaultSceneIndexDeps,
  type TranscriptSegment,
  type VisionDescription,
} from './scene_index.ts';
import { buildSourcePackage, probeSourceVideo } from './source_package.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const ffmpegBin = process.env.THOTH_FFMPEG || path.join(repoRoot, 'ffmpeg.exe');
const fixtureRoot = path.join(repoRoot, 'crates/thoth-core/tests/fixtures/scout_package');

/** Fixed clock, so `created_at` and `elapsed_ms` do not change between captures. */
const NOW = 1_700_000_000_000;

/** A mixed carousel: one photo Scout must ignore, one video it must package. */
const post: PostRecord = {
  canonical_url: 'https://www.instagram.com/p/CAPTURE1/',
  platform: 'instagram',
  post_id: 'CAPTURE1',
  owner_handle: 'owner',
  text: 'a harbour crane working the dock',
  media: [
    {
      id: 'CAPTURE1:0',
      kind: 'image',
      index: 0,
      canonical_post_url: 'https://www.instagram.com/p/CAPTURE1/',
      ephemeral_url: 'https://cdn.example.test/media-0',
    },
    {
      id: 'CAPTURE1:1',
      kind: 'video',
      index: 1,
      canonical_post_url: 'https://www.instagram.com/p/CAPTURE1/',
      ephemeral_url: 'https://cdn.example.test/media-1',
    },
  ],
  outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
};

/** One vocabulary for the whole source; the Rust narration beats speak it back. */
const VISION: VisionDescription = {
  subject: 'harbour',
  action: 'crane',
  setting: 'dock',
  composition: 'wide',
  motion: 'panning',
  topic: 'harbour',
};

function generateSourceVideo(file: string): void {
  execFileSync(
    ffmpegBin,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      // 30 fps, not 15: `indexSource` samples a scene's end frame at `end - 0.05 s`,
      // which falls past the last frame of a 15 fps source and makes ffmpeg write
      // nothing. Real footage is 24 fps or better, so this stays a capture detail.
      'testsrc=size=320x240:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      file,
    ],
    { stdio: 'pipe', timeout: 120_000 },
  );
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-capture-fixture-'));
try {
  if (!fs.existsSync(ffmpegBin)) throw new Error(`no ffmpeg at ${ffmpegBin}`);
  // Write-once packaging refuses to overwrite, and a stale v001 beside a new v002 would
  // leave the Rust test importing whichever it names. Start from nothing.
  fs.rmSync(fixtureRoot, { recursive: true, force: true });

  const video = path.join(work, 'source.mp4');
  generateSourceVideo(video);

  const defaults = defaultSceneIndexDeps();
  const built = await buildSourcePackage(
    { post, contentSetPath: path.join(fixtureRoot, 'content-set.json'), coverageTarget: 0.6 },
    {
      scoutOutputRoot: fixtureRoot,
      materialize: async () => ({
        path: video,
        kind: 'video',
        source: 'direct-http',
        bytes: fs.statSync(video).size,
      }),
      probe: probeSourceVideo,
      now: () => NOW,
      analyzerIdentity: 'capture-analyzer@1',
      // Two even 3 s scenes: one per narration beat in the Rust acceptance test.
      detectScenes: async () => [3],
      extractFrames: defaults.extractFrames,
      measureVisuals: defaults.measureVisuals,
      transcribe: async (): Promise<TranscriptSegment[]> => [
        { text: 'the crane swings', start_sec: 0, end_sec: 2 },
      ],
      describeWithVision: async () => VISION,
      embed: async () => [1, 0, 0, 0],
    },
  );

  console.log(`captured ${path.relative(repoRoot, built.packagePath)}`);
  console.log(`  fingerprint ${built.package.fingerprint}`);
  console.log(`  source      ${built.package.sources[0]?.checksum}`);
  console.log(`  scenes      ${built.package.scene_indexes[0]?.scenes.length}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
