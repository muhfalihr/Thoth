// cuts.ts — immutable, verified publication of allocator decisions.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type AllocatedItemV1, type AllocationResult, reallocateBeat } from './allocator.ts';
import type { RankedCandidate } from './candidates.ts';
import {
  decodeMainFootageActive,
  decodeMainFootagePlan,
  fingerprintCanonical,
  MAIN_FOOTAGE_SCHEMA_VERSION,
  type MainFootageActiveV1,
  type MainFootagePlanV1,
  type MainFootageWarningCode,
  type PlanningMode,
  type SceneEvidenceV1,
  type SourcePackageV1,
  type SourceTechnicalMetadata,
} from './contracts.ts';
import { atomicPublish, nextVersion, resolveContained } from './paths.ts';

const HANDLE_MS = 300;
const DURATION_TOLERANCE_SEC = 0.08;

export interface TransitionSelection {
  transition: MainFootagePlanV1['timeline'][number]['transition'];
  warning?: MainFootageWarningCode;
}

function boundedDuration(durationMs: number): number {
  return Math.max(120, Math.min(300, Math.round(durationMs)));
}

function visionFacts(scene: SceneEvidenceV1): Record<string, string> | null {
  if (!scene.vision_description) return null;
  try {
    const value = JSON.parse(scene.vision_description);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result: Record<string, string> = {};
    for (const key of ['subject', 'action', 'setting', 'composition', 'motion', 'topic']) {
      if (typeof value[key] !== 'string') return null;
      result[key] = value[key].trim().toLowerCase();
    }
    return result;
  } catch {
    return null;
  }
}

/** Local transition policy; it never accepts provider output or an unapproved kind. */
export function selectTransition(
  previous: SceneEvidenceV1,
  current: SceneEvidenceV1,
  previousAfterMs: number,
  currentBeforeMs: number,
  planningMode: PlanningMode,
): TransitionSelection {
  let kind: TransitionSelection['transition']['kind'];
  let durationMs: number;
  const left = visionFacts(previous);
  const right = visionFacts(current);
  if (planningMode === 'vision' && left && right) {
    if (left.composition === right.composition && left.motion === right.motion) {
      kind = 'match_cut';
      durationMs = 120;
    } else if (
      left.setting !== right.setting &&
      left.composition !== right.composition &&
      left.motion !== right.motion
    ) {
      kind = 'fade_through_black';
      durationMs = 240;
    } else {
      kind = 'cross_dissolve';
      durationMs = 180;
    }
  } else {
    const values = [
      previous.visual_metrics.brightness,
      previous.visual_metrics.motion_score,
      current.visual_metrics.brightness,
      current.visual_metrics.motion_score,
    ];
    if (!values.every(Number.isFinite)) {
      kind = 'cross_dissolve';
      durationMs = 120;
    } else {
      const luminanceDelta = Math.abs(
        previous.visual_metrics.brightness - current.visual_metrics.brightness,
      );
      const motionDelta = Math.abs(
        previous.visual_metrics.motion_score - current.visual_metrics.motion_score,
      );
      if (luminanceDelta > 0.45 || motionDelta > 0.6) {
        kind = 'fade_through_black';
        durationMs = 240;
      } else if (luminanceDelta <= 0.15 && motionDelta <= 0.15) {
        kind = 'match_cut';
        durationMs = 120;
      } else {
        kind = 'cross_dissolve';
        durationMs = 180;
      }
    }
  }
  durationMs = boundedDuration(durationMs);
  if (kind !== 'match_cut' && (previousAfterMs < durationMs || currentBeforeMs < durationMs)) {
    return {
      transition: { kind: 'match_cut', duration_ms: 120 },
      warning: 'transition_fallback',
    };
  }
  return { transition: { kind, duration_ms: durationMs } };
}

export interface CutCommand {
  inputPath: string;
  outputPath: string;
  /** Physical cut start, including the available head handle. */
  startSec: number;
  /** Physical cut duration, including head and tail handles. */
  durationSec: number;
  visibleStartSec: number;
  visibleEndSec: number;
  mapVideo: true;
  mapAudio: boolean;
}

export interface MaterializePlanDeps {
  package: SourcePackageV1;
  sourcePackagePath: string;
  narrationTimelinePath: string;
  sourcePackageFingerprint: string;
  narrationFingerprint: string;
  candidates:
    | ReadonlyMap<string, readonly RankedCandidate[]>
    | Readonly<Record<string, readonly RankedCandidate[]>>;
  ffmpeg(command: CutCommand): Promise<void>;
  ffprobe(file: string): Promise<SourceTechnicalMetadata>;
  now?: () => number;
}

function checksum(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function candidatesFor(
  candidates: MaterializePlanDeps['candidates'],
  beatId: string,
): readonly RankedCandidate[] {
  if (candidates instanceof Map) return candidates.get(beatId) ?? [];
  return (candidates as Readonly<Record<string, readonly RankedCandidate[]>>)[beatId] ?? [];
}

function reserveVersion(jobRoot: string): { version: `v${string}`; planRoot: string } {
  const plansRoot = resolveContained(jobRoot, 'plans');
  fs.mkdirSync(plansRoot, { recursive: true });
  let number = Number(nextVersion(plansRoot).slice(1));
  for (;;) {
    const version = `v${String(number).padStart(3, '0')}` as `v${string}`;
    const planRoot = resolveContained(jobRoot, path.posix.join('plans', version));
    try {
      fs.mkdirSync(planRoot);
      const reservation = path.join(planRoot, '.reserved');
      const handle = fs.openSync(reservation, 'wx');
      fs.closeSync(handle);
      fs.mkdirSync(resolveContained(jobRoot, 'cuts'), { recursive: true });
      fs.mkdirSync(resolveContained(jobRoot, path.posix.join('cuts', version)));
      return { version, planRoot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      number += 1;
    }
  }
}

function readReusablePlan(
  jobRoot: string,
  deps: MaterializePlanDeps,
  coverageTarget: number,
): MainFootagePlanV1 | null {
  const activePath = resolveContained(jobRoot, 'plans/active.json');
  if (!fs.existsSync(activePath)) return null;
  try {
    const active = decodeMainFootageActive(JSON.parse(fs.readFileSync(activePath, 'utf8')));
    if (
      active.source_package_fingerprint !== deps.sourcePackageFingerprint ||
      active.narration_fingerprint !== deps.narrationFingerprint
    ) {
      return null;
    }
    const planPath = resolveContained(jobRoot, active.plan_path);
    const plan = decodeMainFootagePlan(JSON.parse(fs.readFileSync(planPath, 'utf8')));
    if (
      plan.main_coverage_target !== coverageTarget ||
      plan.fingerprint !== active.plan_fingerprint ||
      fingerprintCanonical({ ...plan, fingerprint: undefined }) !== active.plan_fingerprint
    ) {
      return null;
    }
    for (const cut of plan.timeline) {
      const cutPath = resolveContained(jobRoot, cut.cut_path);
      if (!fs.existsSync(cutPath) || checksum(cutPath) !== cut.checksum) return null;
    }
    return plan;
  } catch {
    return null;
  }
}

function assertValidAllocation(allocation: AllocationResult): void {
  const fail = (): never => {
    throw Object.assign(new Error('plan_verification_failed'), {
      code: 'plan_verification_failed',
    });
  };
  if (
    allocation.coverage.target < 0.6 ||
    allocation.coverage.target > 1 ||
    allocation.coverage.actual + 1e-6 < allocation.coverage.target ||
    allocation.timeline.length === 0
  ) {
    fail();
  }
  let cursor = 0;
  let total = 0;
  let main = 0;
  for (const item of allocation.timeline) {
    const outputDuration = item.timeline_end_sec - item.timeline_start_sec;
    const sourceDuration = item.source_out_sec - item.source_in_sec;
    if (
      Math.abs(item.timeline_start_sec - cursor) > 1e-6 ||
      outputDuration <= 0 ||
      sourceDuration + 1e-6 < outputDuration
    ) {
      fail();
    }
    total += outputDuration;
    if (item.asset_kind === 'main_cut') main += outputDuration;
    cursor = item.timeline_end_sec;
  }
  const actual = total > 0 ? main / total : 0;
  if (
    Math.abs(total - allocation.coverage.total_sec) > 1e-6 ||
    Math.abs(main - allocation.coverage.main_sec) > 1e-6 ||
    Math.abs(actual - allocation.coverage.actual) > 1e-6
  ) {
    fail();
  }
}

function publishActive(jobRoot: string, active: MainFootageActiveV1): void {
  const destination = resolveContained(jobRoot, 'plans/active.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = path.join(path.dirname(destination), `.active-${randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(active, null, 2));
  fs.renameSync(temp, destination);
}

function sourceFor(pkg: SourcePackageV1, sourceId: string) {
  const source = pkg.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error('source_package_invalid');
  return source;
}

function sourceScene(pkg: SourcePackageV1, item: AllocatedItemV1) {
  const sceneId = item.candidate_key.startsWith(`${item.source_id}:`)
    ? item.candidate_key.slice(item.source_id.length + 1)
    : '';
  return pkg.scene_indexes
    .find((entry) => entry.source_id === item.source_id)
    ?.scenes.find((entry) => entry.id === sceneId);
}

async function publishCut(
  item: AllocatedItemV1,
  version: `v${string}`,
  jobRoot: string,
  deps: MaterializePlanDeps,
): Promise<MainFootagePlanV1['timeline'][number]> {
  const source = sourceFor(deps.package, item.source_id);
  const packageRoot = path.dirname(resolveContained(jobRoot, deps.sourcePackagePath));
  const inputPath = resolveContained(packageRoot, source.path);
  const beforeMs = Math.max(0, Math.min(HANDLE_MS, Math.floor(item.source_in_sec * 1000)));
  const afterMs = Math.max(
    0,
    Math.min(HANDLE_MS, Math.floor((source.technical.duration_sec - item.source_out_sec) * 1000)),
  );
  const relativeCut = path.posix.join('cuts', version, `${item.item_id}.mp4`);
  const destination = resolveContained(jobRoot, relativeCut);
  const temp = path.join(path.dirname(destination), `.${item.item_id}-${randomUUID()}.tmp`);
  const visibleDuration = item.source_out_sec - item.source_in_sec;
  const physicalDuration = visibleDuration + (beforeMs + afterMs) / 1000;
  const command: CutCommand = {
    inputPath,
    outputPath: temp,
    startSec: item.source_in_sec - beforeMs / 1000,
    durationSec: physicalDuration,
    visibleStartSec: item.source_in_sec,
    visibleEndSec: item.source_out_sec,
    mapVideo: true,
    mapAudio: source.technical.has_audio,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.ffmpeg(command);
      const technical = await deps.ffprobe(temp);
      if (
        !fs.existsSync(temp) ||
        fs.statSync(temp).size <= 0 ||
        !Number.isFinite(technical.duration_sec) ||
        Math.abs(technical.duration_sec - physicalDuration) > DURATION_TOLERANCE_SEC ||
        technical.width <= 0 ||
        technical.height <= 0 ||
        (source.technical.has_audio && !technical.has_audio)
      ) {
        throw new Error('plan_verification_failed');
      }
      const digest = checksum(temp);
      atomicPublish(temp, destination);
      return {
        id: item.item_id,
        source_id: item.source_id,
        source_path: path.posix.join(path.posix.dirname(deps.sourcePackagePath), source.path),
        cut_path: relativeCut,
        checksum: digest,
        source_start_sec: item.source_in_sec,
        source_end_sec: item.source_out_sec,
        output_start_sec: item.timeline_start_sec,
        output_end_sec: item.timeline_end_sec,
        match_level: item.match_level,
        reuse_count: item.reuse_count,
        transition: { kind: 'match_cut', duration_ms: 120 },
        handles: { before_ms: beforeMs, after_ms: afterMs },
      };
    } catch (error) {
      lastError = error;
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  throw lastError;
}

/** Converts one deterministic allocation into immutable, locally verified cut files. */
export async function materializePlan(
  allocation: AllocationResult,
  jobRoot: string,
  deps: MaterializePlanDeps,
): Promise<MainFootagePlanV1> {
  const resolvedRoot = path.resolve(jobRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error('path_outside_root');
  }
  resolveContained(resolvedRoot, deps.sourcePackagePath);
  resolveContained(resolvedRoot, deps.narrationTimelinePath);
  if (allocation.error) throw Object.assign(new Error(allocation.error.code), allocation.error);
  assertValidAllocation(allocation);

  const reusable = readReusablePlan(resolvedRoot, deps, allocation.coverage.target);
  if (reusable) return reusable;

  const { version, planRoot } = reserveVersion(resolvedRoot);
  const timeline: MainFootagePlanV1['timeline'] = [];
  const failedCandidateKeys = new Set<string>();
  let current = allocation;
  let itemIndex = 0;
  while (itemIndex < current.timeline.length) {
    const item = current.timeline[itemIndex]!;
    // Accessing the scene here also rejects allocator identities the package never declared.
    if (item.asset_kind === 'main_cut' && !sourceScene(deps.package, item)) {
      throw new Error('source_package_invalid');
    }
    try {
      timeline.push(await publishCut(item, version, resolvedRoot, deps));
      itemIndex += 1;
    } catch {
      failedCandidateKeys.add(item.candidate_key);
      const remaining = candidatesFor(deps.candidates, item.beat_id).filter(
        (candidate) => !failedCandidateKeys.has(`${candidate.source_id}:${candidate.scene_id}`),
      );
      const replanned = reallocateBeat(current, item.item_id, remaining);
      if (replanned.error) {
        throw Object.assign(new Error(replanned.error.code), replanned.error);
      }
      current = replanned;
    }
  }

  const planningMode = deps.package.scene_indexes.some(
    (index) => index.planning_mode === 'degraded',
  )
    ? 'degraded'
    : 'vision';
  const transitionWarnings: MainFootageWarningCode[] = [];
  for (let index = 1; index < timeline.length; index += 1) {
    const previousScene = sourceScene(deps.package, current.timeline[index - 1]!);
    const currentScene = sourceScene(deps.package, current.timeline[index]!);
    if (!previousScene || !currentScene) throw new Error('source_package_invalid');
    const selected = selectTransition(
      previousScene,
      currentScene,
      timeline[index - 1]!.handles.after_ms,
      timeline[index]!.handles.before_ms,
      planningMode,
    );
    timeline[index]!.transition = selected.transition;
    if (selected.warning) transitionWarnings.push(selected.warning);
  }
  const warnings = [...new Set([...current.warnings, ...transitionWarnings])];
  const withoutFingerprint: MainFootagePlanV1 = {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    status: 'verified',
    source_package_path: deps.sourcePackagePath,
    narration_timeline_path: deps.narrationTimelinePath,
    source_package_fingerprint: deps.sourcePackageFingerprint,
    narration_fingerprint: deps.narrationFingerprint,
    main_coverage_target: current.coverage.target,
    timeline,
    diagnostics: {
      planning_mode: planningMode,
      candidate_count: current.candidate_count,
      warnings,
    },
    summary: {
      main_coverage_sec: current.coverage.main_sec,
      main_coverage_ratio: current.coverage.actual,
      total_duration_sec: current.coverage.total_sec,
      selected_cut_count: timeline.length,
    },
    warnings,
    created_at: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  const plan: MainFootagePlanV1 = {
    ...withoutFingerprint,
    fingerprint: fingerprintCanonical(withoutFingerprint),
  };
  const planRelative = path.posix.join('plans', version, 'main-footage-plan.json');
  const planTemp = path.join(planRoot, `.main-footage-plan-${randomUUID()}.tmp`);
  fs.writeFileSync(planTemp, JSON.stringify(plan, null, 2));
  atomicPublish(planTemp, resolveContained(resolvedRoot, planRelative));
  publishActive(resolvedRoot, {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    status: 'verified',
    version,
    plan_path: planRelative,
    source_package_fingerprint: deps.sourcePackageFingerprint,
    narration_fingerprint: deps.narrationFingerprint,
    plan_fingerprint: plan.fingerprint!,
  });
  return plan;
}
