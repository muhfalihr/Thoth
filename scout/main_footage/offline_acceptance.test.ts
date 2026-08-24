// offline_acceptance.test.ts — Task 15 Step 1/2. The one Scout test that runs the whole
// forced-URL main-footage path end to end with no network and no model access: real ffmpeg
// bytes in, a real package on disk, the real planner CLI entry point, real cuts out.
//
// Only the four external intelligences are injected (scene boundaries, vision, embeddings,
// planner ranking). Acquisition, packaging, indexing, candidate building, allocation, cut
// materialization, plan verification and the active-plan resume are all the production code
// paths. Everything an operator could observe — sources/, coverage, timeline continuity,
// the absence of any signed URL on disk — is asserted against artifacts, not return values.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaAsset, PostRecord } from '../acquisition/types.ts';
import { MIN_REUSE_GAP_SEC } from './allocator.ts';
import type { CandidateDeps } from './candidates.ts';
import { fingerprintCanonical, MAIN_FOOTAGE_SCHEMA_VERSION } from './contracts.ts';
import { ffmpegCut, runPlanMainFootageCli } from './plan_job.ts';
import { buildSourcePackage, probeSourceVideo } from './source_package.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const ffmpegBin = process.env.THOTH_FFMPEG || path.join(repoRoot, 'ffmpeg.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-offline-acceptance-'));

// The job root owns everything: the package lives inside it so `resolveContained`
// resolves the same way it does in production.
const jobRoot = path.join(root, 'job');
const scoutOutputRoot = path.join(jobRoot, 'scout-output');
const contentSetPath = path.join(jobRoot, 'content-set.json');
const SIGNED_URL_SECRET = 'Signature=THIS-MUST-NEVER-BE-PERSISTED';

/** Distinguishes "this machine has no ffmpeg" from "the feature is broken". */
function requireFfmpeg(): void {
  assert.ok(
    fs.existsSync(ffmpegBin),
    `the offline acceptance test needs a real ffmpeg at ${ffmpegBin}; ` +
      'set THOTH_FFMPEG to override. It is not skippable: it is the only Scout test ' +
      'that proves the cut path produces a playable file.',
  );
}

/** 15 s of deterministic colour bars plus a tone, small enough to encode in a moment. */
function generateSourceVideo(name: string, hue: string): string {
  const file = path.join(root, name);
  execFileSync(
    ffmpegBin,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=320x240:rate=15:duration=15`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=15',
      '-vf',
      `hue=h=${hue}`,
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
  return file;
}

const media = (index: number, kind: 'image' | 'video'): MediaAsset => ({
  id: `post-1:${index}`,
  kind,
  index,
  canonical_post_url: 'https://www.instagram.com/p/post-1/',
  ephemeral_url: `https://cdn.example.test/media-${index}?${SIGNED_URL_SECRET}`,
});

// The exact shape the plan pins: photo, video A, photo, video B.
const post: PostRecord = {
  canonical_url: 'https://www.instagram.com/p/post-1/',
  platform: 'instagram',
  post_id: 'post-1',
  owner_handle: 'owner',
  text: 'a mixed carousel',
  media: [media(0, 'image'), media(1, 'video'), media(2, 'image'), media(3, 'video')],
  outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
};

const SOURCE_A = 'source-post-1-1';
const SOURCE_B = 'source-post-1-3';

// Distinct vocabularies so beat/scene token matching is decided by the fixture, not by luck.
const VISION = {
  [SOURCE_A]: {
    subject: 'harbour',
    action: 'crane',
    setting: 'dock',
    composition: 'wide',
    motion: 'panning',
    topic: 'harbour',
  },
  [SOURCE_B]: {
    subject: 'orchard',
    action: 'harvest',
    setting: 'grove',
    composition: 'close',
    motion: 'static',
    topic: 'orchard',
  },
} as const;

function sourceKeyOf(reference: string): keyof typeof VISION {
  return reference.includes(SOURCE_B) ? SOURCE_B : SOURCE_A;
}

/** A tiny fixed vector per vocabulary: enough for cosine ranking to be deterministic. */
const EMBEDDINGS: Record<keyof typeof VISION, number[]> = {
  [SOURCE_A]: [1, 0, 0, 0],
  [SOURCE_B]: [0, 1, 0, 0],
};

let visionCalls = 0;
let sceneDetectCalls = 0;

const sceneFixtures = {
  analyzerIdentity: 'offline-acceptance-analyzer@1',
  // Three even 5 s scenes, so one scene fills one 5 s beat window exactly and the
  // allocator never has to subdivide — the reuse assertion below stays about reuse.
  detectScenes: async () => {
    sceneDetectCalls += 1;
    return [5, 10];
  },
  extractFrames: async (sourcePath: string, atSeconds: number[]) =>
    atSeconds.map((second) => {
      const key = sourceKeyOf(sourcePath);
      const frame = path.join(root, `frame-${key}-${second}-${visionCalls}-${Math.random()}.jpg`);
      fs.writeFileSync(frame, Buffer.from(`frame:${key}:${second}`));
      return frame;
    }),
  transcribe: async () => [],
  describeWithVision: async (framePath: string) => {
    visionCalls += 1;
    return VISION[sourceKeyOf(path.basename(framePath))];
  },
  embed: async (text: string) => EMBEDDINGS[sourceKeyOf(text)],
  measureVisuals: async () => ({ motion_score: 0.5, brightness: 0.5, scene_change_score: 0.5 }),
};

/** Every file under a root, so "nothing persisted a signed URL" can be checked exhaustively. */
function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function candidateFixtures(): CandidateDeps {
  return {
    embedText: async (text: string) => EMBEDDINGS[sourceKeyOf(text)] ?? null,
    loadEmbedding: async (scene) => EMBEDDINGS[sourceKeyOf(scene.vision_description ?? '')] ?? null,
    // The planner is the one port a live run would send to a model. Returning [] keeps
    // the shortlist's own deterministic ranking, which is what a degraded run does.
    rankShortlist: async () => [],
  };
}

try {
  requireFfmpeg();
  fs.mkdirSync(jobRoot, { recursive: true });
  const videoA = generateSourceVideo('video-a.mp4', '0');
  const videoB = generateSourceVideo('video-b.mp4', '120');

  // ---- acquire + package --------------------------------------------------------------
  const materialized: number[] = [];
  const built = await buildSourcePackage(
    { post, contentSetPath, coverageTarget: 0.6 },
    {
      ...sceneFixtures,
      scoutOutputRoot,
      materialize: async (asset) => {
        materialized.push(asset.index);
        return {
          path: asset.index === 1 ? videoA : videoB,
          kind: 'video',
          source: 'direct-http',
          bytes: fs.statSync(asset.index === 1 ? videoA : videoB).size,
        };
      },
      probe: probeSourceVideo,
      now: () => 1_700_000_000_000,
    },
  );

  assert.deepEqual(materialized, [1, 3], 'only the two videos are ever fetched');
  const packageRoot = path.dirname(built.packagePath);
  const publishedSources = fs.readdirSync(path.join(packageRoot, 'sources')).sort();
  assert.deepEqual(
    publishedSources,
    [`${SOURCE_A}.mp4`, `${SOURCE_B}.mp4`],
    'sources/ holds exactly video A and video B — the two photos are ignored, not packaged',
  );
  assert.equal(built.summary.ignored_photo_count, 2);
  assert.equal(built.summary.usable_video_count, 2);
  assert.equal(built.summary.unavailable_video_count, 0);
  assert.equal(built.package.scene_indexes.length, 2);
  assert.equal(built.descriptor.mode, 'forced_url_pool');

  // ---- narration ----------------------------------------------------------------------
  // Beat 1 and beat 3 speak source A's vocabulary; beat 2 speaks source B's. Beat 3 starts
  // 10 s after beat 1, comfortably past MIN_REUSE_GAP_SEC, so reusing A there is legal.
  assert.ok(MIN_REUSE_GAP_SEC <= 10, 'the fixture beat spacing assumes a reuse gap of 10 s');
  const beats = [
    { id: 'beat-0001', start_sec: 0, end_sec: 5, text: 'the harbour crane swings over the dock' },
    { id: 'beat-0002', start_sec: 5, end_sec: 10, text: 'an orchard harvest fills the grove' },
    { id: 'beat-0003', start_sec: 10, end_sec: 15, text: 'back at the harbour the crane rests' },
  ];
  const narrationDir = path.join(jobRoot, 'narration');
  fs.mkdirSync(narrationDir, { recursive: true });
  const audioPath = path.join(narrationDir, 'narration.mp3');
  fs.writeFileSync(audioPath, Buffer.from('narration audio bytes'));
  const withoutFingerprint = {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    audio_path: 'narration/narration.mp3',
    audio_checksum: `sha256:${createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex')}`,
    duration_sec: 15,
    words: beats.map((beat) => ({
      text: beat.text,
      start_sec: beat.start_sec,
      end_sec: beat.end_sec,
    })),
    beats,
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
  const narrationRelative = 'narration/narration-timeline.json';
  fs.writeFileSync(
    path.join(jobRoot, narrationRelative),
    JSON.stringify(
      { ...withoutFingerprint, fingerprint: fingerprintCanonical(withoutFingerprint) },
      null,
      2,
    ),
  );

  // ---- plan through the real CLI entry point -------------------------------------------
  const packageRelative = path.relative(jobRoot, built.packagePath).split(path.sep).join('/');
  const progress: string[] = [];
  const plan = await runPlanMainFootageCli(
    [
      '--job-root',
      jobRoot,
      '--package',
      packageRelative,
      '--narration',
      narrationRelative,
      '--coverage-target',
      '0.6',
    ],
    {
      candidateDeps: candidateFixtures(),
      ffmpeg: ffmpegCut,
      ffprobe: probeSourceVideo,
      emit: (event) => progress.push(event.stage),
      now: () => 1_700_000_000_000,
    },
  );

  assert.deepEqual(
    progress,
    ['planning_cuts', 'materializing_cuts', 'verifying_plan'],
    'a first plan walks every stage exactly once',
  );
  assert.equal(plan.status, 'verified');
  assert.ok(plan.timeline.length >= 3, 'each beat contributes at least one cut');

  // Every plan item already has its cut on disk by the time the call returns, with the
  // checksum the plan claims. This is the invariant an operator's resume depends on.
  for (const cut of plan.timeline) {
    const cutFile = path.join(jobRoot, cut.cut_path);
    assert.ok(fs.existsSync(cutFile), `plan item ${cut.id} returned without its cut on disk`);
    assert.equal(
      `sha256:${createHash('sha256').update(fs.readFileSync(cutFile)).digest('hex')}`,
      cut.checksum,
      `cut ${cut.id} does not match the checksum the plan published`,
    );
    assert.ok(fs.statSync(cutFile).size > 0, `cut ${cut.id} is empty`);
  }

  // Timeline continuity: starts at zero, no gap and no overlap between consecutive cuts.
  assert.equal(plan.timeline[0]!.output_start_sec, 0, 'the timeline must start at zero');
  for (let index = 1; index < plan.timeline.length; index += 1) {
    assert.equal(
      plan.timeline[index]!.output_start_sec,
      plan.timeline[index - 1]!.output_end_sec,
      `gap or overlap between timeline items ${index - 1} and ${index}`,
    );
  }
  assert.equal(
    plan.timeline.at(-1)!.output_end_sec,
    beats.at(-1)!.end_sec,
    'the timeline must cover the whole narration',
  );

  assert.ok(
    plan.summary.main_coverage_ratio >= 0.6,
    `main coverage ${plan.summary.main_coverage_ratio} fell below the 0.60 target`,
  );

  // Source A carries two beats separated by at least the reuse gap.
  const startsOfA = plan.timeline
    .filter((cut) => cut.source_id === SOURCE_A)
    .map((cut) => cut.output_start_sec);
  assert.ok(startsOfA.length >= 2, 'source A must be used more than once');
  assert.ok(
    Math.max(...startsOfA) - Math.min(...startsOfA) >= MIN_REUSE_GAP_SEC,
    `source A was reused only ${Math.max(...startsOfA) - Math.min(...startsOfA)} s apart`,
  );
  assert.ok(
    plan.timeline.some((cut) => cut.source_id === SOURCE_B),
    'source B must appear too — a plan that used A alone would satisfy reuse trivially',
  );

  // No signed URL survives anywhere under the job root, in any artifact.
  for (const file of walk(jobRoot)) {
    const contents = fs.readFileSync(file);
    assert.ok(
      !contents.includes(SIGNED_URL_SECRET) && !contents.includes('ephemeral_url'),
      `signed acquisition URL leaked into ${path.relative(jobRoot, file)}`,
    );
  }

  // ---- unchanged rerun resumes without reacquiring or re-indexing ------------------------
  const detectCallsBeforeRerun = sceneDetectCalls;
  const visionCallsBeforeRerun = visionCalls;
  const cutFilesBeforeRerun = walk(path.join(jobRoot, 'cuts')).sort();
  const rerunProgress: string[] = [];
  const resumed = await runPlanMainFootageCli(
    [
      '--job-root',
      jobRoot,
      '--package',
      packageRelative,
      '--narration',
      narrationRelative,
      '--coverage-target',
      '0.6',
    ],
    {
      // Every expensive port now throws. If the resume path touches any of them the
      // rerun fails loudly instead of quietly redoing work.
      candidateDeps: {
        embedText: async () => assert.fail('an unchanged rerun must not re-embed'),
        loadEmbedding: async () => assert.fail('an unchanged rerun must not reload embeddings'),
        rankShortlist: async () => assert.fail('an unchanged rerun must not re-rank'),
      },
      ffmpeg: async () => assert.fail('an unchanged rerun must not re-cut'),
      ffprobe: async () => assert.fail('an unchanged rerun must not re-probe'),
      emit: (event) => rerunProgress.push(event.stage),
      now: () => 1_700_000_000_000,
    },
  );

  assert.deepEqual(
    rerunProgress,
    ['verifying_plan'],
    'an unchanged rerun goes straight to verification',
  );
  assert.equal(resumed.fingerprint, plan.fingerprint, 'the resumed plan must be the same plan');
  assert.deepEqual(resumed.timeline, plan.timeline);
  assert.equal(sceneDetectCalls, detectCallsBeforeRerun, 'no source was re-indexed');
  assert.equal(visionCalls, visionCallsBeforeRerun, 'no frame was re-described');
  assert.deepEqual(
    walk(path.join(jobRoot, 'cuts')).sort(),
    cutFilesBeforeRerun,
    'an unchanged rerun must not publish a new cut version',
  );

  console.log('ok main_footage_offline_acceptance');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
