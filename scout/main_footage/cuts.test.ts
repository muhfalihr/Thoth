import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AllocationResult } from './allocator.ts';
import type { RankedCandidate } from './candidates.ts';
import type { ExternalSourcesV1, SourcePackageV1 } from './contracts.ts';
import { fingerprintCanonical } from './contracts.ts';
import {
  acquireActivePublicationLock,
  type CutCommand,
  type MaterializePlanDeps,
  materializePlan,
  readVerifiedActivePlan,
  selectTransition,
} from './cuts.ts';
import {
  type PlanMainFootageProviders,
  type PlanProgress,
  runPlanMainFootageCli,
} from './plan_job.ts';

const roots: string[] = [];

function tempJob(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-cuts-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'main-footage', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main-footage', 'sources', 'source-1.mp4'), 'immutable-source');
  return root;
}

function sourcePackage(): SourcePackageV1 {
  return {
    schema_version: 1,
    post: { id: 'post-1', canonical_url: 'https://example.test/post-1', platform: 'fixture' },
    analysis_identity: 'fixture@1',
    sources: [
      {
        id: 'source-1',
        media_index: 0,
        path: 'sources/source-1.mp4',
        checksum: 'sha256:source',
        bytes: 16,
        technical: {
          container: 'mp4',
          video_codec: 'h264',
          duration_sec: 10,
          width: 1280,
          height: 720,
          has_audio: true,
        },
      },
    ],
    ignored: [],
    unavailable: [],
    scene_indexes: [
      {
        source_id: 'source-1',
        path: 'scene-index/source-1/index.json',
        checksum: 'sha256:index',
        planning_mode: 'vision',
        scenes: [
          {
            id: 'scene-1',
            start_sec: 1,
            end_sec: 4,
            representative_frame: 'scene-index/source-1/frame.jpg',
            transcript_evidence: 'fixture narration',
            vision_description: JSON.stringify({
              subject: 'worker',
              action: 'walking',
              setting: 'street',
              composition: 'medium',
              motion: 'left',
              topic: 'fixture',
            }),
            visual_metrics: { motion_score: 0.2, brightness: 0.5, scene_change_score: 0.1 },
          },
        ],
      },
    ],
  };
}

function candidate(): RankedCandidate {
  return {
    beat_id: 'beat-1',
    scene_id: 'scene-1',
    source_id: 'source-1',
    source_in_sec: 1,
    source_out_sec: 4,
    match_level: 'exact',
    embedding_score: 1,
    visual_quality_score: 0.8,
    planner_rank: 1,
    reason: 'fixture',
  };
}

function allocation(): AllocationResult {
  return {
    timeline: [
      {
        item_id: 'item-001',
        beat_id: 'beat-1',
        timeline_start_sec: 0,
        timeline_end_sec: 3,
        asset_kind: 'main_cut',
        candidate_key: 'source-1:scene-1',
        source_id: 'source-1',
        source_in_sec: 1,
        source_out_sec: 4,
        match_level: 'exact',
        reuse_count: 0,
      },
    ],
    coverage: { target: 0.6, actual: 1, main_sec: 3, total_sec: 3 },
    candidate_count: 1,
    warnings: [],
  };
}

function deps(commands: CutCommand[]): MaterializePlanDeps {
  return {
    package: sourcePackage(),
    sourcePackagePath: 'main-footage/package.json',
    narrationTimelinePath: 'narration/narration-timeline.json',
    sourcePackageFingerprint: 'sha256:package',
    narrationFingerprint: 'sha256:narration-a',
    candidates: { 'beat-1': [candidate()] },
    ffmpeg: async (command) => {
      commands.push({ ...command });
      fs.writeFileSync(command.outputPath, 'published-cut');
    },
    ffprobe: async (file) => ({
      container: 'mp4',
      video_codec: 'h264',
      duration_sec: commands.find((command) => command.outputPath === file)?.durationSec ?? 0,
      width: 1280,
      height: 720,
      has_audio: true,
    }),
    now: () => Date.parse('2026-08-20T00:00:00.000Z'),
  };
}

// Production mutation caught: deriving a version from only the active pointer, overwriting
// an existing version, or treating style-only inputs as a new identity would mutate durable
// cuts or create needless versions; ignoring narration identity would wrongly reuse v001.
try {
  const root = tempJob();
  const commands: CutCommand[] = [];
  const first = await materializePlan(allocation(), root, deps(commands));
  assert.equal(first.timeline[0]?.cut_path, 'cuts/v001/item-001.mp4');
  assert.equal(first.status, 'verified');
  const v001Plan = path.join(root, 'plans', 'v001', 'main-footage-plan.json');
  const firstBytes = fs.readFileSync(v001Plan);

  const styleOnly = await materializePlan(allocation(), root, deps(commands));
  assert.deepEqual(styleOnly, first);
  assert.equal(commands.length, 1, 'style-only rerun must not invoke FFmpeg');
  assert.deepEqual(fs.readFileSync(v001Plan), firstBytes, 'v001 must stay byte-identical');

  const changed = deps(commands);
  changed.narrationFingerprint = 'sha256:narration-b';
  const second = await materializePlan(allocation(), root, changed);
  assert.equal(second.timeline[0]?.cut_path, 'cuts/v002/item-001.mp4');
  assert.deepEqual(fs.readFileSync(v001Plan), firstBytes, 'v002 must not modify v001');
  assert.ok(fs.existsSync(path.join(root, 'plans', 'v001', '.reserved')));
  assert.ok(fs.existsSync(path.join(root, 'plans', 'v002', '.reserved')));

  // Production mutation caught: dropping the immediate retry, changing its source range,
  // replanning the whole timeline, or publishing a plan after candidate exhaustion would
  // turn transient encoder errors into drift or expose a partial version as verified.
  {
    const retryRoot = tempJob();
    const retryCommands: CutCommand[] = [];
    const retryDeps = deps(retryCommands);
    const replacement: RankedCandidate = {
      ...candidate(),
      scene_id: 'scene-2',
      source_in_sec: 5,
      source_out_sec: 8,
      planner_rank: 2,
    };
    retryDeps.package.scene_indexes[0]!.scenes.push({
      ...retryDeps.package.scene_indexes[0]!.scenes[0]!,
      id: 'scene-2',
      start_sec: 5,
      end_sec: 8,
    });
    retryDeps.candidates = { 'beat-1': [candidate(), replacement] };
    retryDeps.ffmpeg = async (command) => {
      retryCommands.push({ ...command });
      if (command.visibleStartSec === 1) throw new Error('encoder_failed');
      fs.writeFileSync(command.outputPath, 'replacement-cut');
    };
    retryDeps.ffprobe = async (file) => ({
      container: 'mp4',
      video_codec: 'h264',
      duration_sec: retryCommands.find((command) => command.outputPath === file)?.durationSec ?? 0,
      width: 1280,
      height: 720,
      has_audio: true,
    });

    const replanned = await materializePlan(allocation(), retryRoot, retryDeps);
    assert.equal(retryCommands.length, 3, 'two identical attempts plus one replacement');
    assert.deepEqual(retryCommands[0], retryCommands[1], 'the first command must retry unchanged');
    assert.equal(replanned.timeline[0]?.source_start_sec, 5);
    assert.equal(replanned.timeline[0]?.output_start_sec, 0, 'the affected window must not move');

    const exhaustedRoot = tempJob();
    const exhaustedCommands: CutCommand[] = [];
    const exhaustedDeps = deps(exhaustedCommands);
    exhaustedDeps.ffmpeg = async (command) => {
      exhaustedCommands.push({ ...command });
      throw new Error('encoder_failed');
    };
    await assert.rejects(
      () => materializePlan(allocation(), exhaustedRoot, exhaustedDeps),
      (error: Error & { code?: string }) =>
        error.code === 'cut_materialization_exhausted' &&
        error.message === 'cut_materialization_exhausted',
    );
    assert.equal(exhaustedCommands.length, 2, 'one failed command gets exactly one retry');
    assert.ok(!fs.existsSync(path.join(exhaustedRoot, 'plans', 'active.json')));
    assert.ok(!fs.existsSync(path.join(exhaustedRoot, 'plans', 'v001', 'main-footage-plan.json')));
  }

  // Production mutation caught: collapsing every boundary to one transition, trusting
  // broken degraded metrics, or using a dissolve without both handles would violate the
  // renderer whitelist or ask it to consume frames the published cut does not contain.
  {
    const prior = sourcePackage().scene_indexes[0]!.scenes[0]!;
    const vision = (composition: string, motion: string, setting = 'street') =>
      JSON.stringify({
        subject: 'worker',
        action: 'walking',
        setting,
        composition,
        motion,
        topic: 'fixture',
      });
    const compatible = {
      ...prior,
      id: 'compatible',
      vision_description: vision('medium', 'left'),
    };
    const soft = {
      ...prior,
      id: 'soft',
      vision_description: vision('wide', 'left'),
    };
    const strong = {
      ...prior,
      id: 'strong',
      vision_description: vision('aerial', 'static', 'night interior'),
    };
    assert.deepEqual(selectTransition(prior, compatible, 300, 300, 'vision'), {
      transition: { kind: 'match_cut', duration_ms: 120 },
    });
    assert.deepEqual(selectTransition(prior, soft, 300, 300, 'vision'), {
      transition: { kind: 'cross_dissolve', duration_ms: 180 },
    });
    assert.deepEqual(selectTransition(prior, strong, 300, 300, 'vision'), {
      transition: { kind: 'fade_through_black', duration_ms: 240 },
    });
    assert.deepEqual(selectTransition(prior, soft, 300, 0, 'vision'), {
      transition: { kind: 'match_cut', duration_ms: 120 },
      warning: 'transition_fallback',
    });
    const brokenMetrics = {
      ...prior,
      id: 'broken',
      vision_description: undefined,
      visual_metrics: { ...prior.visual_metrics, brightness: Number.NaN },
    };
    assert.deepEqual(selectTransition(prior, brokenMetrics, 300, 300, 'degraded'), {
      transition: { kind: 'cross_dissolve', duration_ms: 120 },
    });
    // Production mutation caught: omitting scene_change_score collapses a strong local
    // histogram/shot discontinuity to match-cut when brightness and motion happen to agree.
    const strongSceneChange = {
      ...prior,
      id: 'strong-scene-change',
      vision_description: undefined,
      visual_metrics: { ...prior.visual_metrics, scene_change_score: 0.95 },
    };
    assert.deepEqual(selectTransition(prior, strongSceneChange, 300, 300, 'degraded'), {
      transition: { kind: 'fade_through_black', duration_ms: 240 },
    });
    // Production mutation caught: ignoring a soft scene-change delta lets a visibly
    // discontinuous degraded boundary collapse to match-cut when luminance/motion agree.
    const softSceneChange = {
      ...prior,
      id: 'soft-scene-change',
      vision_description: undefined,
      visual_metrics: { ...prior.visual_metrics, scene_change_score: 0.4 },
    };
    assert.deepEqual(selectTransition(prior, softSceneChange, 300, 300, 'degraded'), {
      transition: { kind: 'cross_dissolve', duration_ms: 180 },
    });
  }

  // Production mutation caught: applying transition policy only in memory, or forgetting
  // to copy its handle fallback into both warning lists, would hide a degraded edit from
  // durability checks and operators even though the persisted transition became match-cut.
  {
    const transitionRoot = tempJob();
    const transitionCommands: CutCommand[] = [];
    const transitionDeps = deps(transitionCommands);
    const second = {
      ...candidate(),
      beat_id: 'beat-2',
      scene_id: 'scene-2',
      source_in_sec: 0,
      source_out_sec: 3,
    };
    transitionDeps.package.scene_indexes[0]!.scenes.push({
      ...transitionDeps.package.scene_indexes[0]!.scenes[0]!,
      id: 'scene-2',
      start_sec: 0,
      end_sec: 3,
      vision_description: JSON.stringify({
        subject: 'worker',
        action: 'walking',
        setting: 'street',
        composition: 'wide',
        motion: 'left',
        topic: 'fixture',
      }),
    });
    transitionDeps.candidates = { 'beat-1': [candidate()], 'beat-2': [second] };
    const twoCuts = allocation();
    twoCuts.timeline.push({
      ...twoCuts.timeline[0]!,
      item_id: 'item-002',
      beat_id: 'beat-2',
      timeline_start_sec: 3,
      timeline_end_sec: 6,
      candidate_key: 'source-1:scene-2',
      source_in_sec: 0,
      source_out_sec: 3,
    });
    twoCuts.coverage = { target: 0.6, actual: 1, main_sec: 6, total_sec: 6 };
    twoCuts.candidate_count = 2;
    const plan = await materializePlan(twoCuts, transitionRoot, transitionDeps);
    assert.deepEqual(plan.timeline[1]?.transition, { kind: 'match_cut', duration_ms: 120 });
    assert.equal(plan.timeline[1]?.handles.before_ms, 0);
    assert.ok(plan.warnings.includes('transition_fallback'));
    assert.ok(plan.diagnostics.warnings.includes('transition_fallback'));
  }

  // Production mutation caught: trimming only the visible range, mutating the source,
  // trusting a nonempty file that lost its ambience track, or hashing different bytes
  // would publish a cut whose declared identity does not match its probed media.
  {
    const verifiedRoot = tempJob();
    const verifiedCommands: CutCommand[] = [];
    const sourcePath = path.join(verifiedRoot, 'main-footage', 'sources', 'source-1.mp4');
    const sourceBytes = fs.readFileSync(sourcePath);
    const verified = await materializePlan(allocation(), verifiedRoot, deps(verifiedCommands));
    assert.deepEqual(
      {
        startSec: verifiedCommands[0]?.startSec,
        durationSec: verifiedCommands[0]?.durationSec,
        visibleStartSec: verifiedCommands[0]?.visibleStartSec,
        visibleEndSec: verifiedCommands[0]?.visibleEndSec,
        mapVideo: verifiedCommands[0]?.mapVideo,
        mapAudio: verifiedCommands[0]?.mapAudio,
      },
      {
        startSec: 0.7,
        durationSec: 3.6,
        visibleStartSec: 1,
        visibleEndSec: 4,
        mapVideo: true,
        mapAudio: true,
      },
    );
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);
    assert.equal(
      verified.timeline[0]?.checksum,
      `sha256:${createHash('sha256').update('published-cut').digest('hex')}`,
    );

    const silentRoot = tempJob();
    const silentCommands: CutCommand[] = [];
    const silentDeps = deps(silentCommands);
    silentDeps.ffprobe = async (file) => ({
      container: 'mp4',
      video_codec: 'h264',
      duration_sec: silentCommands.find((command) => command.outputPath === file)?.durationSec ?? 0,
      width: 1280,
      height: 720,
      has_audio: false,
    });
    await assert.rejects(
      () => materializePlan(allocation(), silentRoot, silentDeps),
      (error: Error & { code?: string }) => error.code === 'cut_materialization_exhausted',
    );
    assert.ok(!fs.existsSync(path.join(silentRoot, 'cuts', 'v001', 'item-001.mp4')));
  }

  // Production mutation caught: checking only duration and positive dimensions accepts a
  // wrong container/codec, NaN/Infinity dimensions, or an unexpected finite frame size.
  for (const [name, technical] of [
    ['container', { container: 'matroska' }],
    ['codec', { video_codec: 'vp9' }],
    ['nan-width', { width: Number.NaN }],
    ['infinite-height', { height: Number.POSITIVE_INFINITY }],
    ['wrong-size', { width: 640 }],
  ] as const) {
    const metadataRoot = tempJob();
    const metadataCommands: CutCommand[] = [];
    const metadataDeps = deps(metadataCommands);
    metadataDeps.ffprobe = async (file) => ({
      container: 'mp4',
      video_codec: 'h264',
      duration_sec:
        metadataCommands.find((command) => command.outputPath === file)?.durationSec ?? 0,
      width: 1280,
      height: 720,
      has_audio: true,
      ...technical,
    });
    await assert.rejects(
      () => materializePlan(allocation(), metadataRoot, metadataDeps),
      (error: Error & { code?: string }) => error.code === 'cut_materialization_exhausted',
      name,
    );
    assert.ok(!fs.existsSync(path.join(metadataRoot, 'cuts', 'v001', 'item-001.mp4')), name);
  }

  // Production mutation caught: bypassing decoders/fingerprints, resolving a transport URL,
  // hard-wiring live providers, or printing absolute paths would make the internal command
  // unsafe and impossible to exercise in Task 15's offline acceptance run.
  {
    const cliRoot = tempJob();
    const pkg = sourcePackage();
    pkg.fingerprint = fingerprintCanonical(pkg);
    fs.writeFileSync(
      path.join(cliRoot, 'main-footage', 'package.json'),
      JSON.stringify(pkg, null, 2),
    );
    fs.mkdirSync(path.join(cliRoot, 'narration'), { recursive: true });
    const narration = {
      schema_version: 1 as const,
      audio_path: 'narration/audio.wav',
      audio_checksum: 'sha256:audio',
      duration_sec: 3,
      words: [{ text: 'fixture narration', start_sec: 0, end_sec: 3 }],
      beats: [{ id: 'beat-1', start_sec: 0, end_sec: 3, text: 'fixture narration' }],
    };
    const timeline = { ...narration, fingerprint: fingerprintCanonical(narration) };
    fs.writeFileSync(
      path.join(cliRoot, 'narration', 'narration-timeline.json'),
      JSON.stringify(timeline, null, 2),
    );
    const externalManifestPath = 'main-footage/external-footage/v001/manifest.json';
    const externalSourcePath = path.join(
      cliRoot,
      'main-footage',
      'external-footage',
      'v001',
      'sources',
      'external-1.mp4',
    );
    const externalSourceBytes = Buffer.from('cli-external-source');
    fs.mkdirSync(path.dirname(externalSourcePath), { recursive: true });
    fs.writeFileSync(externalSourcePath, externalSourceBytes);
    const unsignedExternalManifest: ExternalSourcesV1 = {
      schema_version: 1,
      sources: [
        {
          id: 'external-1',
          path: 'sources/external-1.mp4',
          checksum: `sha256:${createHash('sha256').update(externalSourceBytes).digest('hex')}`,
          technical: {
            container: 'mp4',
            video_codec: 'h264',
            duration_sec: 4,
            width: 1280,
            height: 720,
            has_audio: true,
          },
          query: 'fixture narration',
          description: 'Fixture narration b-roll.',
          trim_start_sec: 0,
        },
      ],
    };
    const externalManifest: ExternalSourcesV1 = {
      ...unsignedExternalManifest,
      fingerprint: fingerprintCanonical(unsignedExternalManifest),
    };
    fs.writeFileSync(
      path.join(cliRoot, ...externalManifestPath.split('/')),
      JSON.stringify(externalManifest, null, 2),
    );
    const progress: PlanProgress[] = [];
    let providerCalls = 0;
    const commands: CutCommand[] = [];
    const providers: PlanMainFootageProviders = {
      candidateDeps: {
        embedText: async () => {
          providerCalls += 1;
          return null;
        },
        loadEmbedding: async () => null,
        rankShortlist: async () => [],
      },
      ffmpeg: async (command) => {
        commands.push({ ...command });
        fs.writeFileSync(command.outputPath, 'cli-cut');
      },
      ffprobe: async (file) => ({
        container: 'mp4',
        video_codec: 'h264',
        duration_sec: commands.find((command) => command.outputPath === file)?.durationSec ?? 0,
        width: 1280,
        height: 720,
        has_audio: true,
      }),
      emit: (event) => progress.push(event),
      now: () => Date.parse('2026-08-20T00:00:00.000Z'),
    };
    const planned = await runPlanMainFootageCli(
      [
        '--job-root',
        cliRoot,
        '--package',
        'main-footage/package.json',
        '--narration',
        'narration/narration-timeline.json',
        '--externals',
        externalManifestPath,
        '--coverage-target',
        '0.60',
      ],
      providers,
    );
    assert.equal(planned.status, 'verified');
    assert.equal(planned.external_sources_path, externalManifestPath);
    assert.equal(planned.external_sources_fingerprint, externalManifest.fingerprint);
    assert.ok(providerCalls > 0, 'the injected provider seam must be used');
    assert.deepEqual(
      progress.map((event) => event.stage),
      ['planning_cuts', 'materializing_cuts', 'verifying_plan'],
    );
    const progressWire = progress.map((event) => JSON.stringify(event)).join('\n');
    assert.ok(!progressWire.includes(cliRoot));
    assert.ok(progress.every((event) => event.pct >= 0 && event.pct <= 100));
    assert.ok(
      progress.every((event) =>
        Object.keys(event).every((key) => ['stage', 'pct', 'message', 'warning'].includes(key)),
      ),
    );

    // Production mutation caught: moving active reuse after candidate construction makes a
    // style-only rerun depend on provider availability even though all durable bytes verify.
    const callsBeforeReuse = providerCalls;
    providers.candidateDeps.embedText = async () => {
      providerCalls += 1;
      throw new Error('provider_unavailable');
    };
    progress.length = 0;
    const reused = await runPlanMainFootageCli(
      [
        '--job-root',
        cliRoot,
        '--package',
        'main-footage/package.json',
        '--narration',
        'narration/narration-timeline.json',
        '--externals',
        externalManifestPath,
        '--coverage-target',
        '0.60',
      ],
      providers,
    );
    assert.deepEqual(reused, planned);
    assert.equal(providerCalls, callsBeforeReuse, 'verified reuse must bypass candidate providers');
    assert.deepEqual(progress, [
      { stage: 'verifying_plan', pct: 100, message: 'active plan verified' },
    ]);

    const callsBeforeRejection = providerCalls;
    await assert.rejects(
      () =>
        runPlanMainFootageCli(
          [
            '--job-root',
            cliRoot,
            '--package',
            'https://signed.example.test/package.json?token=secret',
            '--narration',
            'narration/narration-timeline.json',
            '--coverage-target',
            '0.60',
          ],
          providers,
        ),
      /artifact_path_must_be_relative/,
    );
    assert.equal(providerCalls, callsBeforeRejection, 'reject before provider access');

    // Production mutation caught: removing explicit presence/finite checks lets undefined
    // or nonnumeric coverage become NaN and reach filesystem/provider work.
    for (const coverageArgs of [[], ['--coverage-target', 'not-a-number']]) {
      await assert.rejects(
        () =>
          runPlanMainFootageCli(
            [
              '--job-root',
              path.join(cliRoot, 'does-not-exist'),
              '--package',
              'main-footage/package.json',
              '--narration',
              'narration/narration-timeline.json',
              ...coverageArgs,
            ],
            providers,
          ),
        /invalid_arguments/,
      );
    }
    assert.equal(providerCalls, callsBeforeRejection, 'invalid coverage rejects before all work');
  }

  // Production mutation caught: treating coverage as style identity, trusting only an
  // active-plan JSON while its cut bytes changed, or accepting a gapped allocator result
  // would reuse the wrong edit or mark an incomplete timeline verified.
  {
    const coverageRoot = tempJob();
    const coverageCommands: CutCommand[] = [];
    const coverageDeps = deps(coverageCommands);
    const low = await materializePlan(allocation(), coverageRoot, coverageDeps);
    assert.equal(low.timeline[0]?.cut_path, 'cuts/v001/item-001.mp4');
    const higher = allocation();
    higher.coverage.target = 0.8;
    const high = await materializePlan(higher, coverageRoot, coverageDeps);
    assert.equal(high.main_coverage_target, 0.8);
    assert.equal(high.timeline[0]?.cut_path, 'cuts/v002/item-001.mp4');

    const corruptRoot = tempJob();
    const corruptCommands: CutCommand[] = [];
    const corruptDeps = deps(corruptCommands);
    await materializePlan(allocation(), corruptRoot, corruptDeps);
    fs.writeFileSync(path.join(corruptRoot, 'cuts', 'v001', 'item-001.mp4'), 'corrupt');
    const rebuilt = await materializePlan(allocation(), corruptRoot, corruptDeps);
    assert.equal(rebuilt.timeline[0]?.cut_path, 'cuts/v002/item-001.mp4');

    const gapRoot = tempJob();
    const gapped = allocation();
    gapped.timeline[0] = {
      ...gapped.timeline[0]!,
      timeline_start_sec: 0.25,
      timeline_end_sec: 3.25,
    };
    await assert.rejects(
      () => materializePlan(gapped, gapRoot, deps([])),
      (error: Error & { code?: string }) => error.code === 'plan_verification_failed',
    );
    assert.ok(!fs.existsSync(path.join(gapRoot, 'plans')), 'reject before version reservation');
  }

  // Production mutation caught: a persistent exclusive lock survives crashes forever;
  // unowned recovery, live-owner exclusion, token-safe release, and root confinement must
  // all hold or concurrent publishers can stall, steal ownership, or write outside the job.
  {
    const abandonedRoot = tempJob();
    const abandonedState = path.join(abandonedRoot, 'plans', '.active-publication-lock');
    fs.mkdirSync(abandonedState, { recursive: true });
    const abandonedToken = '00000000-0000-4000-8000-000000000001';
    const abandonedPath = path.join(abandonedState, `lease-${abandonedToken}.json`);
    fs.writeFileSync(
      abandonedPath,
      JSON.stringify({
        pid: 2_147_483_647,
        process_instance_id: 'dead-process-instance',
        token: abandonedToken,
        expires_at_ms: 0,
      }),
    );
    fs.linkSync(abandonedPath, path.join(abandonedState, 'head'));
    const recovered = acquireActivePublicationLock(abandonedRoot, { timeoutMs: 0 });
    const recoveredLease = JSON.parse(
      fs.readFileSync(path.join(abandonedState, `next-${abandonedToken}`), 'utf8'),
    );
    assert.equal(recoveredLease.pid, process.pid);
    assert.notEqual(recoveredLease.token, abandonedToken);
    recovered.release();
    assert.ok(fs.existsSync(abandonedPath), 'dead predecessor remains immutable');

    const liveRoot = tempJob();
    const liveState = path.join(liveRoot, 'plans', '.active-publication-lock');
    fs.mkdirSync(liveState, { recursive: true });
    const liveToken = '00000000-0000-4000-8000-000000000002';
    const livePath = path.join(liveState, `lease-${liveToken}.json`);
    fs.writeFileSync(
      livePath,
      JSON.stringify({
        pid: process.pid,
        process_instance_id: 'current-process-instance',
        token: liveToken,
        expires_at_ms: 0,
      }),
    );
    fs.linkSync(livePath, path.join(liveState, 'head'));
    assert.throws(
      () =>
        acquireActivePublicationLock(liveRoot, {
          timeoutMs: 0,
          processInstanceId: () => 'current-process-instance',
        }),
      /active_plan_lock_timeout/,
    );
    assert.equal(JSON.parse(fs.readFileSync(livePath, 'utf8')).token, liveToken);

    const replacedRoot = tempJob();
    const predecessor = acquireActivePublicationLock(replacedRoot, { timeoutMs: 0 });
    const replacedState = path.join(replacedRoot, 'plans', '.active-publication-lock');
    const foreignToken = '00000000-0000-4000-8000-000000000003';
    const foreignPath = path.join(replacedState, `lease-${foreignToken}.json`);
    fs.writeFileSync(
      foreignPath,
      JSON.stringify({
        pid: process.pid,
        token: foreignToken,
        expires_at_ms: Date.now() + 60_000,
      }),
    );
    const predecessorLease = JSON.parse(fs.readFileSync(path.join(replacedState, 'head'), 'utf8'));
    fs.writeFileSync(path.join(replacedState, `released-${predecessorLease.token}`), '', {
      flag: 'wx',
    });
    const successor = acquireActivePublicationLock(replacedRoot, { timeoutMs: 0 });
    const successorLease = JSON.parse(
      fs.readFileSync(path.join(replacedState, `next-${predecessorLease.token}`), 'utf8'),
    );
    assert.notEqual(successorLease.token, predecessorLease.token);
    // Complete the predecessor release after the successor has appended to its single-assignment
    // next slot; this must not skip or remove the live successor.
    predecessor.release();
    assert.throws(
      () => acquireActivePublicationLock(replacedRoot, { timeoutMs: 0 }),
      /active_plan_lock_timeout/,
    );
    assert.ok(fs.existsSync(foreignPath), 'release cannot delete another unique token');
    successor.release();

    const escapedRoot = tempJob();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-lock-outside-'));
    roots.push(outsideRoot);
    fs.symlinkSync(
      outsideRoot,
      path.join(escapedRoot, 'plans'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(
      () => acquireActivePublicationLock(escapedRoot, { timeoutMs: 0 }),
      /path_outside_root/,
    );
    assert.ok(!fs.existsSync(path.join(outsideRoot, '.active-publication-lock')));
  }

  // Production mutation caught: comparing only the PID treats an unrelated process that reused
  // a dead owner's PID as the original live owner forever, so no contender can advance the tail.
  {
    const simultaneousRoot = tempJob();
    const simultaneousState = path.join(simultaneousRoot, 'plans', '.active-publication-lock');
    fs.mkdirSync(simultaneousState, { recursive: true });
    const reusedToken = '00000000-0000-4000-8000-000000000004';
    const reusedLeasePath = path.join(simultaneousState, `lease-${reusedToken}.json`);
    fs.writeFileSync(
      reusedLeasePath,
      JSON.stringify({
        pid: process.pid,
        process_instance_id: 'previous-process-instance',
        token: reusedToken,
        expires_at_ms: 0,
      }),
    );
    fs.linkSync(reusedLeasePath, path.join(simultaneousState, 'head'));
    const workerPath = path.join(simultaneousRoot, 'lock-contender.ts');
    fs.writeFileSync(
      workerPath,
      `import { parentPort, workerData } from 'node:worker_threads';

const state = new Int32Array(workerData.state);
const waitUntil = (index: number, target: number) => {
  for (;;) {
    const current = Atomics.load(state, index);
    if (current >= target) return;
    Atomics.wait(state, index, current);
  }
};

const { acquireActivePublicationLock } = await import(workerData.moduleUrl);
Atomics.add(state, 0, 1);
Atomics.notify(state, 0);
waitUntil(0, 2);
try {
  const lock = acquireActivePublicationLock(workerData.jobRoot, {
    timeoutMs: 0,
    processInstanceId: () => workerData.currentProcessInstanceId,
  });
  parentPort!.postMessage('acquired');
  waitUntil(1, 1);
  lock.release();
} catch (error) {
  parentPort!.postMessage((error as Error).message);
}
`,
    );
    const sharedState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const state = new Int32Array(sharedState);
    const workers = [0, 1].map(
      () =>
        new Worker(workerPath, {
          workerData: {
            jobRoot: simultaneousRoot,
            currentProcessInstanceId: 'current-process-instance',
            moduleUrl: pathToFileURL(path.join(import.meta.dirname, 'cuts.ts')).href,
            state: sharedState,
          },
        }),
    );
    const outcomes = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<string>((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
          }),
      ),
    );
    assert.throws(
      () =>
        acquireActivePublicationLock(simultaneousRoot, {
          timeoutMs: 0,
          processInstanceId: () => 'current-process-instance',
        }),
      /active_plan_lock_timeout/,
      'a late contender must observe the worker holding the live tail',
    );
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1, 2);
    await Promise.all(
      workers.map((worker) => new Promise((resolve) => worker.once('exit', resolve))),
    );
    assert.equal(outcomes.filter((outcome) => outcome === 'acquired').length, 1);
  }

  // Production mutation caught: unconditional active rename lets a late v001 completion
  // overwrite an already-verified v002 pointer after concurrent version reservations.
  {
    const raceRoot = tempJob();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const slowCommands: CutCommand[] = [];
    const slowDeps = deps(slowCommands);
    slowDeps.ffmpeg = async (command) => {
      slowCommands.push({ ...command });
      markSlowStarted();
      await slowGate;
      fs.writeFileSync(command.outputPath, 'slow-v001');
    };
    slowDeps.ffprobe = async (file) => ({
      container: 'mp4',
      video_codec: 'h264',
      duration_sec: slowCommands.find((command) => command.outputPath === file)?.durationSec ?? 0,
      width: 1280,
      height: 720,
      has_audio: true,
    });
    const lateV001 = materializePlan(allocation(), raceRoot, slowDeps);
    await slowStarted;

    const fastCommands: CutCommand[] = [];
    const fastDeps = deps(fastCommands);
    fastDeps.narrationFingerprint = 'sha256:narration-b';
    await materializePlan(allocation(), raceRoot, fastDeps);
    releaseSlow();
    await lateV001;

    const active = JSON.parse(fs.readFileSync(path.join(raceRoot, 'plans', 'active.json'), 'utf8'));
    assert.equal(active.version, 'v002');
    assert.equal(active.narration_fingerprint, 'sha256:narration-b');
  }

  // Production mutation caught: checking only pointer identities and arbitrary cut checksums
  // lets a self-consistent tampered plan claim another source or reuse bytes outside its version.
  for (const tamper of ['source-fingerprint', 'cross-version-cut'] as const) {
    const integrityRoot = tempJob();
    const integrityDeps = deps([]);
    await materializePlan(allocation(), integrityRoot, integrityDeps);
    const planPath = path.join(integrityRoot, 'plans', 'v001', 'main-footage-plan.json');
    const activePath = path.join(integrityRoot, 'plans', 'active.json');
    const persisted = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    if (tamper === 'source-fingerprint') {
      persisted.source_package_fingerprint = 'sha256:different-source';
    } else {
      fs.mkdirSync(path.join(integrityRoot, 'cuts', 'v999'), { recursive: true });
      fs.copyFileSync(
        path.join(integrityRoot, persisted.timeline[0].cut_path),
        path.join(integrityRoot, 'cuts', 'v999', 'item-001.mp4'),
      );
      persisted.timeline[0].cut_path = 'cuts/v999/item-001.mp4';
    }
    persisted.fingerprint = fingerprintCanonical({ ...persisted, fingerprint: undefined });
    fs.writeFileSync(planPath, JSON.stringify(persisted, null, 2));
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    active.plan_fingerprint = persisted.fingerprint;
    fs.writeFileSync(activePath, JSON.stringify(active, null, 2));

    assert.equal(
      readVerifiedActivePlan(integrityRoot, {
        sourcePackageFingerprint: integrityDeps.sourcePackageFingerprint,
        narrationFingerprint: integrityDeps.narrationFingerprint,
        coverageTarget: 0.6,
      }),
      null,
      tamper,
    );
  }

  // Production mutation caught: deferring source/scene structural validation until after
  // publication can expose status=verified and active.json for an out-of-bounds cut.
  {
    const invalidPlanRoot = tempJob();
    const invalidRange = allocation();
    invalidRange.timeline[0] = {
      ...invalidRange.timeline[0]!,
      source_in_sec: 8,
      source_out_sec: 11,
    };
    await assert.rejects(
      () => materializePlan(invalidRange, invalidPlanRoot, deps([])),
      (error: Error & { code?: string }) => error.code === 'plan_verification_failed',
    );
    assert.ok(
      !fs.existsSync(path.join(invalidPlanRoot, 'plans', 'v001', 'main-footage-plan.json')),
    );
    assert.ok(!fs.existsSync(path.join(invalidPlanRoot, 'plans', 'active.json')));
  }

  // Production mutation caught: moving the assembled-plan decoder after atomic publication
  // exposes a verified artifact when a runtime-invalid structural value survives allocation.
  {
    const invalidDecodedRoot = tempJob();
    const invalidDecoded = allocation();
    invalidDecoded.warnings = ['not_an_approved_warning' as never];
    await assert.rejects(
      () => materializePlan(invalidDecoded, invalidDecodedRoot, deps([])),
      /warning is invalid/,
    );
    assert.ok(
      !fs.existsSync(path.join(invalidDecodedRoot, 'plans', 'v001', 'main-footage-plan.json')),
    );
    assert.ok(!fs.existsSync(path.join(invalidDecodedRoot, 'plans', 'active.json')));
  }
  // Planned external b-roll must resolve through its own immutable registry,
  // publish its discriminator, and leave forced-main coverage at exactly 60%.
  {
    const mixedRoot = tempJob();
    const externalSource = path.join(
      mixedRoot,
      'main-footage',
      'external-footage',
      'generation-1',
      'sources',
      'external-1.mp4',
    );
    fs.mkdirSync(path.dirname(externalSource), { recursive: true });
    fs.writeFileSync(externalSource, 'external-source');
    const externalManifest: ExternalSourcesV1 = {
      schema_version: 1,
      sources: [
        {
          id: 'external-1',
          path: 'sources/external-1.mp4',
          checksum: 'sha256:external-source',
          technical: {
            container: 'mp4',
            video_codec: 'h264',
            duration_sec: 4,
            width: 1280,
            height: 720,
            has_audio: true,
          },
          query: 'harbour rescue',
          description: 'Rescue crews beside the harbour crane.',
          trim_start_sec: 1,
        },
      ],
      fingerprint: 'sha256:external-manifest',
    };
    const mixedAllocation: AllocationResult = {
      timeline: [
        allocation().timeline[0]!,
        {
          item_id: 'item-002',
          beat_id: 'beat-2',
          timeline_start_sec: 3,
          timeline_end_sec: 5,
          asset_kind: 'external_cut',
          candidate_key: 'ext:external-1-beat-2',
          source_id: 'external-1',
          source_in_sec: 1.25,
          source_out_sec: 3.25,
          match_level: 'topic_only',
          reuse_count: 0,
        },
      ],
      coverage: { target: 0.6, actual: 0.6, main_sec: 3, total_sec: 5 },
      candidate_count: 2,
      warnings: [],
    };
    const commands: CutCommand[] = [];
    const mixedDeps = deps(commands);
    mixedDeps.externalSources = externalManifest;
    mixedDeps.externalSourcesPath = 'main-footage/external-footage/generation-1/manifest.json';
    mixedDeps.externalSourcesFingerprint = 'sha256:external-manifest';
    const plan = await materializePlan(mixedAllocation, mixedRoot, mixedDeps);

    assert.equal(commands[1]?.inputPath, externalSource);
    assert.equal(commands[1]?.startSec, 1);
    assert.equal(plan.timeline[1]?.asset_kind, 'external_cut');
    assert.equal(
      plan.timeline[1]?.source_path,
      'main-footage/external-footage/generation-1/sources/external-1.mp4',
    );
    assert.equal(plan.summary.main_coverage_ratio, 0.6);
    assert.deepEqual(plan.timeline[1]?.handles, { before_ms: 250, after_ms: 300 });
    assert.equal(plan.external_sources_fingerprint, 'sha256:external-manifest');
  }
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

console.log('ok cuts');
