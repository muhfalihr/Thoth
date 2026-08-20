// cuts.ts — immutable, verified publication of allocator decisions.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
      previous.visual_metrics.scene_change_score,
      current.visual_metrics.brightness,
      current.visual_metrics.motion_score,
      current.visual_metrics.scene_change_score,
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
      const sceneChangeDelta = Math.abs(
        previous.visual_metrics.scene_change_score - current.visual_metrics.scene_change_score,
      );
      if (luminanceDelta > 0.45 || motionDelta > 0.6 || sceneChangeDelta > 0.6) {
        kind = 'fade_through_black';
        durationMs = 240;
      } else if (luminanceDelta <= 0.15 && motionDelta <= 0.15 && sceneChangeDelta <= 0.15) {
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

export interface ActivePlanExpectation {
  sourcePackageFingerprint: string;
  narrationFingerprint: string;
  coverageTarget: number;
}

export function readVerifiedActivePlan(
  jobRoot: string,
  expected: ActivePlanExpectation,
): MainFootagePlanV1 | null {
  const activePath = resolveContained(jobRoot, 'plans/active.json');
  if (!fs.existsSync(activePath)) return null;
  try {
    const active = decodeMainFootageActive(JSON.parse(fs.readFileSync(activePath, 'utf8')));
    if (
      active.source_package_fingerprint !== expected.sourcePackageFingerprint ||
      active.narration_fingerprint !== expected.narrationFingerprint
    ) {
      return null;
    }
    const planPath = resolveContained(jobRoot, active.plan_path);
    const plan = decodeMainFootagePlan(JSON.parse(fs.readFileSync(planPath, 'utf8')));
    if (
      plan.source_package_fingerprint !== active.source_package_fingerprint ||
      plan.source_package_fingerprint !== expected.sourcePackageFingerprint ||
      plan.narration_fingerprint !== active.narration_fingerprint ||
      plan.narration_fingerprint !== expected.narrationFingerprint ||
      plan.main_coverage_target !== expected.coverageTarget ||
      plan.fingerprint !== active.plan_fingerprint ||
      fingerprintCanonical({ ...plan, fingerprint: undefined }) !== active.plan_fingerprint
    ) {
      return null;
    }
    for (const cut of plan.timeline) {
      if (!cut.cut_path.startsWith(`cuts/${active.version}/`)) return null;
      const cutPath = resolveContained(jobRoot, cut.cut_path);
      if (!fs.existsSync(cutPath) || checksum(cutPath) !== cut.checksum) return null;
    }
    return plan;
  } catch {
    return null;
  }
}

function assertValidAllocation(allocation: AllocationResult): void {
  const fail = planVerificationFailed;
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

function planVerificationFailed(): never {
  throw Object.assign(new Error('plan_verification_failed'), {
    code: 'plan_verification_failed',
  });
}

function assertItemWithinSource(item: AllocatedItemV1, pkg: SourcePackageV1): void {
  if (item.asset_kind !== 'main_cut') return;
  const source = pkg.sources.find((entry) => entry.id === item.source_id);
  const scene = sourceScene(pkg, item);
  if (
    !source ||
    !scene ||
    !Number.isFinite(item.source_in_sec) ||
    !Number.isFinite(item.source_out_sec) ||
    item.source_in_sec < scene.start_sec - 1e-6 ||
    item.source_out_sec > scene.end_sec + 1e-6 ||
    item.source_out_sec > source.technical.duration_sec + 1e-6
  ) {
    planVerificationFailed();
  }
}

export function verifyMaterializedPlanStructure(plan: MainFootagePlanV1): MainFootagePlanV1 {
  const decoded = decodeMainFootagePlan(plan);
  let cursor = 0;
  for (const cut of decoded.timeline) {
    if (
      Math.abs(cut.output_start_sec - cursor) > 1e-6 ||
      cut.output_end_sec <= cut.output_start_sec
    ) {
      planVerificationFailed();
    }
    cursor = cut.output_end_sec;
  }
  if (
    decoded.summary.selected_cut_count !== decoded.timeline.length ||
    decoded.summary.main_coverage_ratio + 1e-6 < decoded.main_coverage_target ||
    Math.abs(cursor - decoded.summary.total_duration_sec) > 1e-6
  ) {
    planVerificationFailed();
  }
  return decoded;
}

interface ActivePublicationLease {
  pid: number;
  process_instance_id: string;
  token: string;
  expires_at_ms: number;
}

export interface ActivePublicationLock {
  release(): void;
}

export interface ActivePublicationLockOptions {
  timeoutMs?: number;
  leaseMs?: number;
  processInstanceId?: (pid: number) => string | null;
}

const ACTIVE_LOCK_ROOT = 'plans/.active-publication-lock';
const LEASE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESS_INSTANCE_ID = /^[a-z0-9][a-z0-9._:-]{0,191}$/i;

function decodeLease(raw: string): ActivePublicationLease | null {
  try {
    const value = JSON.parse(raw) as Partial<ActivePublicationLease>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.process_instance_id !== 'string' ||
      !PROCESS_INSTANCE_ID.test(value.process_instance_id) ||
      typeof value.token !== 'string' ||
      !LEASE_TOKEN.test(value.token) ||
      !Number.isFinite(value.expires_at_ms)
    ) {
      return null;
    }
    return value as ActivePublicationLease;
  } catch {
    return null;
  }
}

function readLease(file: string): ActivePublicationLease {
  try {
    const lease = decodeLease(fs.readFileSync(file, 'utf8'));
    if (lease) return lease;
  } catch {}
  throw new Error('active_plan_lock_invalid');
}

function pidLiveness(pid: number): 'live' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'live';
    return 'unknown';
  }
}

interface BunFfiLibrary {
  symbols: Record<string, (...args: unknown[]) => unknown>;
  close(): void;
}

interface BunFfi {
  FFIType: Record<string, unknown>;
  dlopen(
    library: string,
    symbols: Record<string, { args: unknown[]; returns: unknown }>,
  ): BunFfiLibrary;
  ptr(value: ArrayBufferView): unknown;
}

function loadBunFfi(): BunFfi {
  return createRequire(import.meta.url)('bun:ffi') as BunFfi;
}

function linuxProcessInstanceId(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    // Fields after the parenthesized command start at field 3 (state); starttime is field 22.
    const startTicks = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/)[19];
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!startTicks || !/^\d+$/.test(startTicks) || !/^[0-9a-f-]{36}$/i.test(bootId)) {
      return null;
    }
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return null;
  }
}

function windowsProcessInstanceId(pid: number): string | null {
  let library: BunFfiLibrary | undefined;
  let handle: unknown;
  try {
    const ffi = loadBunFfi();
    library = ffi.dlopen('kernel32.dll', {
      OpenProcess: {
        args: [ffi.FFIType.u32, ffi.FFIType.u32, ffi.FFIType.u32],
        returns: ffi.FFIType.ptr,
      },
      GetProcessTimes: {
        args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
      CloseHandle: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    });
    handle = library.symbols.OpenProcess?.(0x1000, 0, pid);
    if (handle === null || handle === undefined || handle === 0 || handle === 0n) return null;

    const creation = new Uint32Array(2);
    const exit = new Uint32Array(2);
    const kernel = new Uint32Array(2);
    const user = new Uint32Array(2);
    const success = library.symbols.GetProcessTimes?.(
      handle,
      ffi.ptr(creation),
      ffi.ptr(exit),
      ffi.ptr(kernel),
      ffi.ptr(user),
    );
    if (success !== 1) return null;
    const createdAt = (BigInt(creation[1] ?? 0) << 32n) | BigInt(creation[0] ?? 0);
    return createdAt > 0n ? `win32:${createdAt.toString(16)}` : null;
  } catch {
    return null;
  } finally {
    if (handle !== null && handle !== undefined && handle !== 0 && handle !== 0n) {
      try {
        library?.symbols.CloseHandle?.(handle);
      } catch {}
    }
    library?.close();
  }
}

function darwinProcessInstanceId(pid: number): string | null {
  let library: BunFfiLibrary | undefined;
  try {
    const ffi = loadBunFfi();
    library = ffi.dlopen('/usr/lib/libproc.dylib', {
      proc_pidinfo: {
        args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
    });
    const procBsdInfo = new Uint8Array(136);
    const bytes = library.symbols.proc_pidinfo?.(
      pid,
      3,
      0n,
      ffi.ptr(procBsdInfo),
      procBsdInfo.byteLength,
    );
    if (typeof bytes !== 'number' || bytes < procBsdInfo.byteLength) return null;
    const view = new DataView(procBsdInfo.buffer);
    const seconds = view.getBigUint64(120, true);
    const microseconds = view.getBigUint64(128, true);
    return seconds > 0n ? `darwin:${seconds.toString(16)}:${microseconds.toString(16)}` : null;
  } catch {
    return null;
  } finally {
    library?.close();
  }
}

function platformProcessInstanceId(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return linuxProcessInstanceId(pid);
  if (process.platform === 'win32') return windowsProcessInstanceId(pid);
  if (process.platform === 'darwin') return darwinProcessInstanceId(pid);
  return null;
}

function observedProcessInstanceId(
  pid: number,
  reader: (pid: number) => string | null,
): string | null {
  try {
    const instanceId = reader(pid);
    return instanceId && PROCESS_INSTANCE_ID.test(instanceId) ? instanceId : null;
  } catch {
    return null;
  }
}

function leaseIsAbandoned(
  lease: ActivePublicationLease,
  processInstanceId: (pid: number) => string | null,
): boolean {
  const liveness = pidLiveness(lease.pid);
  if (liveness === 'dead') return true;
  const observed = observedProcessInstanceId(lease.pid, processInstanceId);
  return observed !== null && observed !== lease.process_instance_id;
}

function lockPath(jobRoot: string, name?: string): string {
  return resolveContained(
    jobRoot,
    name ? path.posix.join(ACTIVE_LOCK_ROOT, name) : ACTIVE_LOCK_ROOT,
  );
}

function readTail(jobRoot: string): ActivePublicationLease | null {
  let pointer = lockPath(jobRoot, 'head');
  if (!fs.existsSync(pointer)) return null;
  const seen = new Set<string>();
  for (;;) {
    const lease = readLease(pointer);
    if (seen.has(lease.token)) throw new Error('active_plan_lock_invalid');
    seen.add(lease.token);
    const next = lockPath(jobRoot, `next-${lease.token}`);
    if (!fs.existsSync(next)) return lease;
    pointer = next;
  }
}

function leaseWasReleased(jobRoot: string, token: string): boolean {
  return fs.existsSync(lockPath(jobRoot, `released-${token}`));
}

function createLease(
  jobRoot: string,
  leaseMs: number,
  processInstanceId: (pid: number) => string | null,
): {
  lease: ActivePublicationLease;
  leasePath: string;
} {
  const token = randomUUID();
  const instanceId = observedProcessInstanceId(process.pid, processInstanceId);
  if (!instanceId) throw new Error('active_plan_lock_identity_unavailable');
  const lease: ActivePublicationLease = {
    pid: process.pid,
    process_instance_id: instanceId,
    token,
    expires_at_ms: Date.now() + leaseMs,
  };
  const leasePath = lockPath(jobRoot, `lease-${token}.json`);
  fs.writeFileSync(leasePath, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
  return { lease, leasePath };
}

/** Acquires append-only, crash-recoverable ownership of active-plan publication. */
export function acquireActivePublicationLock(
  jobRoot: string,
  options: ActivePublicationLockOptions = {},
): ActivePublicationLock {
  const resolvedRoot = path.resolve(jobRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error('path_outside_root');
  }
  const plansRoot = resolveContained(resolvedRoot, 'plans');
  fs.mkdirSync(plansRoot, { recursive: true });
  const stateRoot = lockPath(resolvedRoot);
  fs.mkdirSync(stateRoot, { recursive: true });
  // Re-resolve after creation so a concurrently substituted junction fails closed.
  lockPath(resolvedRoot);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const leaseMs = options.leaseMs ?? 30_000;
  const processInstanceId = options.processInstanceId ?? platformProcessInstanceId;
  const deadline = Date.now() + timeoutMs;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));

  for (;;) {
    const tail = readTail(resolvedRoot);
    if (
      tail &&
      !leaseWasReleased(resolvedRoot, tail.token) &&
      !leaseIsAbandoned(tail, processInstanceId)
    ) {
      if (Date.now() >= deadline) throw new Error('active_plan_lock_timeout');
      Atomics.wait(waitCell, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
      continue;
    }

    const { lease, leasePath } = createLease(resolvedRoot, leaseMs, processInstanceId);
    const ownerLink = tail
      ? lockPath(resolvedRoot, `next-${tail.token}`)
      : lockPath(resolvedRoot, 'head');
    try {
      fs.linkSync(leasePath, ownerLink);
    } catch (error) {
      fs.unlinkSync(leasePath);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }

    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        try {
          fs.writeFileSync(lockPath(resolvedRoot, `released-${lease.token}`), '', {
            flag: 'wx',
            mode: 0o600,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      },
    };
  }
}

function publishActive(jobRoot: string, active: MainFootageActiveV1): void {
  const destination = resolveContained(jobRoot, 'plans/active.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const lock = acquireActivePublicationLock(jobRoot);
  try {
    if (fs.existsSync(destination)) {
      const current = decodeMainFootageActive(JSON.parse(fs.readFileSync(destination, 'utf8')));
      if (Number(current.version.slice(1)) >= Number(active.version.slice(1))) return;
    }
    const temp = path.join(path.dirname(destination), `.active-${randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(active, null, 2));
    fs.renameSync(temp, destination);
  } finally {
    lock.release();
  }
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
      const containers = technical.container.split(',').map((value) => value.trim().toLowerCase());
      if (
        !fs.existsSync(temp) ||
        fs.statSync(temp).size <= 0 ||
        !Number.isFinite(technical.duration_sec) ||
        Math.abs(technical.duration_sec - physicalDuration) > DURATION_TOLERANCE_SEC ||
        !containers.includes('mp4') ||
        technical.video_codec.toLowerCase() !== 'h264' ||
        !Number.isFinite(technical.width) ||
        !Number.isFinite(technical.height) ||
        technical.width !== source.technical.width ||
        technical.height !== source.technical.height ||
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
  for (const item of allocation.timeline) assertItemWithinSource(item, deps.package);

  const reusable = readVerifiedActivePlan(resolvedRoot, {
    sourcePackageFingerprint: deps.sourcePackageFingerprint,
    narrationFingerprint: deps.narrationFingerprint,
    coverageTarget: allocation.coverage.target,
  });
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
    assertItemWithinSource(item, deps.package);
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
  verifyMaterializedPlanStructure(plan);
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
