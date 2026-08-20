import { createHash } from 'node:crypto';
import { assertArtifactPath, assertDescriptorManifestPath } from './paths.ts';
import type { AcquisitionSource } from '../acquisition/types.ts';

export const MAIN_FOOTAGE_SCHEMA_VERSION = 1 as const;
export type TransitionKind = 'match_cut' | 'cross_dissolve' | 'fade_through_black';
export type MatchLevel = 'exact' | 'topic_only';
export type PlanningMode = 'vision' | 'degraded';
export type MainFootageMode = 'forced_url_pool';
export type MainFootagePlanStatus = 'verified';

export type MainFootageErrorCode =
  | 'forced_main_no_usable_video'
  | 'forced_main_narration_required'
  | 'source_package_invalid'
  | 'narration_generation_failed'
  | 'cut_planning_failed'
  | 'cut_materialization_exhausted'
  | 'plan_verification_failed';

export type MainFootageWarningCode =
  | 'source_video_skipped'
  | 'photo_slide_ignored'
  | 'vision_degraded'
  | 'exact_scene_reused'
  | 'topic_only_match'
  | 'transition_fallback';

export interface SourceTechnicalMetadata {
  container: string;
  video_codec: string;
  duration_sec: number;
  width: number;
  height: number;
  has_audio: boolean;
}

export interface SourceVideoV1 {
  id: string;
  media_index: number;
  path: string;
  checksum: string;
  bytes?: number;
  technical: SourceTechnicalMetadata;
  acquisition?: { source: AcquisitionSource; attempts: number; elapsed_ms: number };
}

export interface SourceOutcomeV1 {
  id: string;
  media_index: number;
  code: MainFootageErrorCode | MainFootageWarningCode;
  message?: string;
}

export interface VisualMetricsV1 {
  motion_score: number;
  brightness: number;
  scene_change_score: number;
}

export interface SceneEvidenceV1 {
  id: string;
  start_sec: number;
  end_sec: number;
  representative_frame: string;
  transcript_evidence: string;
  vision_description?: string;
  embedding_path?: string;
  visual_metrics: VisualMetricsV1;
}

export interface SceneIndexV1 {
  source_id: string;
  path: string;
  checksum: string;
  planning_mode: PlanningMode;
  scenes: SceneEvidenceV1[];
}

export interface SourcePackageV1 {
  schema_version: typeof MAIN_FOOTAGE_SCHEMA_VERSION;
  post: { id: string; canonical_url: string; platform: string };
  analysis_identity: string;
  created_at?: string;
  fingerprint?: string;
  sources: SourceVideoV1[];
  ignored: SourceOutcomeV1[];
  unavailable: SourceOutcomeV1[];
  scene_indexes: SceneIndexV1[];
}

export interface NarrationWordV1 {
  text: string;
  start_sec: number;
  end_sec: number;
}

/**
 * One contiguous narration span the cut planner allocates footage against.
 * Mirrors `NarrationBeatV1` in crates/thoth-types/src/main_footage.rs. Beats are derived
 * from `words`, so they are deliberately excluded from the timeline fingerprint.
 */
export interface NarrationBeatV1 {
  id: string;
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface NarrationTimelineV1 {
  schema_version: typeof MAIN_FOOTAGE_SCHEMA_VERSION;
  audio_path: string;
  audio_checksum: string;
  duration_sec: number;
  words: NarrationWordV1[];
  /** Derived beat segmentation. Absent in a words-only timeline. */
  beats?: NarrationBeatV1[];
  created_at?: string;
  fingerprint?: string;
}

export interface TransitionV1 {
  kind: TransitionKind;
  duration_ms: number;
}

export interface CutHandlesV1 {
  before_ms: number;
  after_ms: number;
}

export interface PlannedCutV1 {
  id: string;
  source_id: string;
  source_path: string;
  cut_path: string;
  checksum: string;
  source_start_sec: number;
  source_end_sec: number;
  output_start_sec: number;
  output_end_sec: number;
  match_level: MatchLevel;
  reuse_count: number;
  transition: TransitionV1;
  handles: CutHandlesV1;
}

export interface PlanDiagnosticsV1 {
  planning_mode: PlanningMode;
  candidate_count: number;
  warnings: MainFootageWarningCode[];
}

export interface PlanSummaryV1 {
  main_coverage_sec: number;
  main_coverage_ratio: number;
  total_duration_sec: number;
  selected_cut_count: number;
}

export interface MainFootagePlanV1 {
  schema_version: typeof MAIN_FOOTAGE_SCHEMA_VERSION;
  status: MainFootagePlanStatus;
  source_package_path: string;
  narration_timeline_path: string;
  source_package_fingerprint: string;
  narration_fingerprint: string;
  main_coverage_target: number;
  timeline: PlannedCutV1[];
  diagnostics: PlanDiagnosticsV1;
  summary: PlanSummaryV1;
  warnings: MainFootageWarningCode[];
  created_at?: string;
  fingerprint?: string;
}

/** Atomic pointer published only after every cut and the immutable plan verify. */
export interface MainFootageActiveV1 {
  schema_version: typeof MAIN_FOOTAGE_SCHEMA_VERSION;
  status: MainFootagePlanStatus;
  version: `v${string}`;
  plan_path: string;
  source_package_fingerprint: string;
  narration_fingerprint: string;
  plan_fingerprint: string;
}

export interface MainFootageDescriptor {
  mode: MainFootageMode;
  package_manifest: string;
  coverage_target: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonRecord;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

/** Like `string`, but accepts the empty string — Rust's `String` allows it. */
function looseString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function number(value: unknown, name: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function enumValue<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${name} is invalid`);
  return value as T;
}

function artifact(value: unknown, name: string): string {
  const result = string(value, name);
  assertArtifactPath(result);
  return result;
}

function descriptorManifest(value: unknown, name: string): string {
  const result = string(value, name);
  assertDescriptorManifestPath(result);
  return result;
}

function range(input: JsonRecord, start: string, end: string, name: string): void {
  const from = number(input[start], start, 0);
  const to = number(input[end], end, 0);
  if (to <= from) throw new Error(`${name} has an invalid time range`);
}

function coverageTarget(value: unknown, name: string): number {
  const result = number(value, name, 0.6);
  if (result > 1) throw new Error(`${name} must be between 0.60 and 1.00`);
  return result;
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${name}`);
}

function schema(value: JsonRecord): void {
  if (value.schema_version !== MAIN_FOOTAGE_SCHEMA_VERSION) throw new Error('unsupported schema_version');
}

function outcome(input: unknown, name: string): SourceOutcomeV1 {
  const value = record(input, name);
  const code = enumValue(value.code, `${name}.code`, [...ERROR_CODES, ...WARNING_CODES]);
  return {
    id: string(value.id, `${name}.id`),
    media_index: number(value.media_index, `${name}.media_index`, 0),
    code,
    ...(value.message === undefined ? {} : { message: string(value.message, `${name}.message`) }),
  };
}

const ERROR_CODES: readonly MainFootageErrorCode[] = [
  'forced_main_no_usable_video', 'forced_main_narration_required', 'source_package_invalid',
  'narration_generation_failed', 'cut_planning_failed', 'cut_materialization_exhausted', 'plan_verification_failed',
];
const WARNING_CODES: readonly MainFootageWarningCode[] = [
  'source_video_skipped', 'photo_slide_ignored', 'vision_degraded', 'exact_scene_reused', 'topic_only_match', 'transition_fallback',
];
const TRANSITIONS: readonly TransitionKind[] = ['match_cut', 'cross_dissolve', 'fade_through_black'];
const MATCH_LEVELS: readonly MatchLevel[] = ['exact', 'topic_only'];
const PLANNING_MODES: readonly PlanningMode[] = ['vision', 'degraded'];

export function decodeSourcePackage(input: unknown): SourcePackageV1 {
  const value = record(input, 'source package');
  schema(value);
  const post = record(value.post, 'post');
  const sources = array(value.sources, 'sources').map((item, index) => {
    const source = record(item, `sources[${index}]`);
    const technical = record(source.technical, `sources[${index}].technical`);
    return {
      id: string(source.id, `sources[${index}].id`),
      media_index: number(source.media_index, `sources[${index}].media_index`, 0),
      path: artifact(source.path, `sources[${index}].path`),
      checksum: string(source.checksum, `sources[${index}].checksum`),
      ...(source.bytes === undefined ? {} : { bytes: number(source.bytes, `sources[${index}].bytes`, 0) }),
      technical: {
        container: string(technical.container, 'technical.container'),
        video_codec: string(technical.video_codec, 'technical.video_codec'),
        duration_sec: number(technical.duration_sec, 'technical.duration_sec', 0),
        width: number(technical.width, 'technical.width', 1),
        height: number(technical.height, 'technical.height', 1),
        has_audio: typeof technical.has_audio === 'boolean' ? technical.has_audio : (() => { throw new Error('technical.has_audio must be boolean'); })(),
      },
      ...(source.acquisition === undefined ? {} : (() => {
        const acquisition = record(source.acquisition, `sources[${index}].acquisition`);
        return {
          acquisition: {
            source: enumValue(acquisition.source, `sources[${index}].acquisition.source`, [
              'cache', 'network', 'public-metadata', 'gallery-dl', 'yt-dlp', 'direct-http', 'dom',
            ]),
            attempts: number(acquisition.attempts, `sources[${index}].acquisition.attempts`, 1),
            elapsed_ms: number(acquisition.elapsed_ms, `sources[${index}].acquisition.elapsed_ms`, 0),
          },
        };
      })()),
    };
  });
  const ignored = array(value.ignored, 'ignored').map((item, index) => outcome(item, `ignored[${index}]`));
  const unavailable = array(value.unavailable, 'unavailable').map((item, index) => outcome(item, `unavailable[${index}]`));
  const scene_indexes = array(value.scene_indexes, 'scene_indexes').map((item, index) => {
    const sceneIndex = record(item, `scene_indexes[${index}]`);
    const scenes = array(sceneIndex.scenes, `scene_indexes[${index}].scenes`).map((scene, sceneIndexNumber) => {
      const evidence = record(scene, `scene_indexes[${index}].scenes[${sceneIndexNumber}]`);
      range(evidence, 'start_sec', 'end_sec', 'scene');
      const metrics = record(evidence.visual_metrics, 'visual_metrics');
      return {
        id: string(evidence.id, 'scene.id'),
        start_sec: number(evidence.start_sec, 'scene.start_sec', 0),
        end_sec: number(evidence.end_sec, 'scene.end_sec', 0),
        representative_frame: artifact(evidence.representative_frame, 'scene.representative_frame'),
        transcript_evidence: string(evidence.transcript_evidence, 'scene.transcript_evidence'),
        ...(evidence.vision_description === undefined ? {} : { vision_description: string(evidence.vision_description, 'scene.vision_description') }),
        ...(evidence.embedding_path === undefined ? {} : { embedding_path: artifact(evidence.embedding_path, 'scene.embedding_path') }),
        visual_metrics: {
          motion_score: number(metrics.motion_score, 'visual_metrics.motion_score', 0),
          brightness: number(metrics.brightness, 'visual_metrics.brightness', 0),
          scene_change_score: number(metrics.scene_change_score, 'visual_metrics.scene_change_score', 0),
        },
      };
    });
    unique(scenes.map((scene) => scene.id), 'scene id');
    return {
      source_id: string(sceneIndex.source_id, 'scene_index.source_id'),
      path: artifact(sceneIndex.path, 'scene_index.path'),
      checksum: string(sceneIndex.checksum, 'scene_index.checksum'),
      planning_mode: enumValue(sceneIndex.planning_mode, 'scene_index.planning_mode', PLANNING_MODES),
      scenes,
    };
  });
  unique(sources.map((source) => source.id), 'source id');
  unique(scene_indexes.map((sceneIndex) => sceneIndex.source_id), 'scene index source id');
  return {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    post: { id: string(post.id, 'post.id'), canonical_url: string(post.canonical_url, 'post.canonical_url'), platform: string(post.platform, 'post.platform') },
    analysis_identity: string(value.analysis_identity, 'analysis_identity'),
    ...(value.created_at === undefined ? {} : { created_at: string(value.created_at, 'created_at') }),
    ...(value.fingerprint === undefined ? {} : { fingerprint: string(value.fingerprint, 'fingerprint') }),
    sources,
    ignored,
    unavailable,
    scene_indexes,
  };
}

export function decodeMainFootageDescriptor(input: unknown): MainFootageDescriptor {
  const value = record(input, 'main_footage');
  for (const key of Object.keys(value)) {
    if (!['mode', 'package_manifest', 'coverage_target'].includes(key)) {
      throw new Error(`unexpected main_footage field: ${key}`);
    }
  }
  return {
    mode: enumValue(value.mode, 'mode', ['forced_url_pool']),
    package_manifest: descriptorManifest(value.package_manifest, 'package_manifest'),
    coverage_target: coverageTarget(value.coverage_target, 'coverage_target'),
  };
}

function decodeBeats(input: unknown): NarrationBeatV1[] {
  const beats = array(input, 'beats').map((item, index) => {
    const beat = record(item, `beats[${index}]`);
    const start_sec = number(beat.start_sec, `beats[${index}].start_sec`, 0);
    const end_sec = number(beat.end_sec, `beats[${index}].end_sec`, 0);
    if (end_sec <= start_sec) throw new Error('beat has an invalid time range');
    return {
      id: string(beat.id, `beats[${index}].id`),
      start_sec,
      end_sec,
      text: looseString(beat.text, 'beat.text'),
    };
  });
  unique(beats.map((beat) => beat.id), 'beat id');
  if (beats.length && beats[0]!.start_sec !== 0) throw new Error('beats must start at 0');
  for (let i = 1; i < beats.length; i += 1) {
    if (beats[i - 1]!.end_sec !== beats[i]!.start_sec) throw new Error('beats must be contiguous');
  }
  return beats;
}

export function decodeNarrationTimeline(input: unknown): NarrationTimelineV1 {
  const value = record(input, 'narration timeline');
  schema(value);
  const words = array(value.words, 'words').map((item, index) => {
    const word = record(item, `words[${index}]`);
    range(word, 'start_sec', 'end_sec', 'word');
    return { text: string(word.text, 'word.text'), start_sec: number(word.start_sec, 'word.start_sec', 0), end_sec: number(word.end_sec, 'word.end_sec', 0) };
  });
  const duration = number(value.duration_sec, 'duration_sec', 0);
  if (words.some((word) => word.end_sec > duration)) throw new Error('word exceeds narration duration');
  return {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    audio_path: artifact(value.audio_path, 'audio_path'),
    audio_checksum: string(value.audio_checksum, 'audio_checksum'),
    duration_sec: duration,
    words,
    ...(value.beats === undefined ? {} : { beats: decodeBeats(value.beats) }),
    ...(value.created_at === undefined ? {} : { created_at: string(value.created_at, 'created_at') }),
    ...(value.fingerprint === undefined ? {} : { fingerprint: string(value.fingerprint, 'fingerprint') }),
  };
}

export function decodeMainFootagePlan(input: unknown): MainFootagePlanV1 {
  const value = record(input, 'main footage plan');
  schema(value);
  const target = number(value.main_coverage_target, 'main_coverage_target');
  if (target < 0.60 || target > 1.00) throw new Error('main_coverage_target must be within [0.60, 1.00]');
  const timeline = array(value.timeline, 'timeline').map((item, index) => {
    const cut = record(item, `timeline[${index}]`);
    range(cut, 'source_start_sec', 'source_end_sec', 'source cut');
    range(cut, 'output_start_sec', 'output_end_sec', 'output cut');
    const transition = record(cut.transition, 'transition');
    const handles = record(cut.handles, 'handles');
    const transitionDuration = number(transition.duration_ms, 'transition.duration_ms', 0);
    if (transitionDuration < 120 || transitionDuration > 300) throw new Error('transition.duration_ms must be within [120, 300]');
    return {
      id: string(cut.id, 'cut.id'), source_id: string(cut.source_id, 'cut.source_id'),
      source_path: artifact(cut.source_path, 'cut.source_path'), cut_path: artifact(cut.cut_path, 'cut_path'),
      checksum: string(cut.checksum, 'cut.checksum'),
      source_start_sec: number(cut.source_start_sec, 'source_start_sec', 0), source_end_sec: number(cut.source_end_sec, 'source_end_sec', 0),
      output_start_sec: number(cut.output_start_sec, 'output_start_sec', 0), output_end_sec: number(cut.output_end_sec, 'output_end_sec', 0),
      match_level: enumValue(cut.match_level, 'match_level', MATCH_LEVELS), reuse_count: number(cut.reuse_count, 'reuse_count', 0),
      transition: { kind: enumValue(transition.kind, 'transition.kind', TRANSITIONS), duration_ms: transitionDuration },
      handles: { before_ms: number(handles.before_ms, 'handles.before_ms', 0), after_ms: number(handles.after_ms, 'handles.after_ms', 0) },
    };
  });
  unique(timeline.map((cut) => cut.id), 'cut id');
  const diagnostics = record(value.diagnostics, 'diagnostics');
  const summary = record(value.summary, 'summary');
  return {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    status: enumValue(value.status, 'status', ['verified']),
    source_package_path: artifact(value.source_package_path, 'source_package_path'),
    narration_timeline_path: artifact(value.narration_timeline_path, 'narration_timeline_path'),
    source_package_fingerprint: string(value.source_package_fingerprint, 'source_package_fingerprint'),
    narration_fingerprint: string(value.narration_fingerprint, 'narration_fingerprint'),
    main_coverage_target: target,
    timeline,
    diagnostics: {
      planning_mode: enumValue(diagnostics.planning_mode, 'diagnostics.planning_mode', PLANNING_MODES),
      candidate_count: number(diagnostics.candidate_count, 'diagnostics.candidate_count', 0),
      warnings: array(diagnostics.warnings, 'diagnostics.warnings').map((warning) => enumValue(warning, 'diagnostics.warning', WARNING_CODES)),
    },
    summary: {
      main_coverage_sec: number(summary.main_coverage_sec, 'summary.main_coverage_sec', 0),
      main_coverage_ratio: number(summary.main_coverage_ratio, 'summary.main_coverage_ratio', 0),
      total_duration_sec: number(summary.total_duration_sec, 'summary.total_duration_sec', 0),
      selected_cut_count: number(summary.selected_cut_count, 'summary.selected_cut_count', 0),
    },
    warnings: array(value.warnings, 'warnings').map((warning) => enumValue(warning, 'warning', WARNING_CODES)),
    ...(value.created_at === undefined ? {} : { created_at: string(value.created_at, 'created_at') }),
    ...(value.fingerprint === undefined ? {} : { fingerprint: string(value.fingerprint, 'fingerprint') }),
  };
}

function sha256Identity(value: unknown, name: string): string {
  const result = string(value, name);
  const digest = result.startsWith('sha256:') ? result.slice('sha256:'.length) : '';
  if (!digest || /\s/.test(digest)) throw new Error(`${name} must be a SHA-256 identity`);
  return result;
}

export function decodeMainFootageActive(input: unknown): MainFootageActiveV1 {
  const value = record(input, 'active main footage plan');
  schema(value);
  const version = string(value.version, 'version');
  if (!/^v\d{3,}$/.test(version)) throw new Error('version is invalid');
  const planPath = artifact(value.plan_path, 'plan_path');
  if (planPath !== `plans/${version}/main-footage-plan.json`) {
    throw new Error('plan_path does not match version');
  }
  return {
    schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
    status: enumValue(value.status, 'status', ['verified']),
    version: version as `v${string}`,
    plan_path: planPath,
    source_package_fingerprint: sha256Identity(
      value.source_package_fingerprint,
      'source_package_fingerprint',
    ),
    narration_fingerprint: sha256Identity(value.narration_fingerprint, 'narration_fingerprint'),
    plan_fingerprint: sha256Identity(value.plan_fingerprint, 'plan_fingerprint'),
  };
}

function fingerprintProjection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as JsonRecord;
  if ('sources' in record && 'scene_indexes' in record && 'post' in record) {
    return {
      schema_version: record.schema_version,
      post: record.post,
      analysis_identity: record.analysis_identity,
      sources: (record.sources as JsonRecord[]).map((source) => ({
        id: source.id, media_index: source.media_index, checksum: source.checksum, technical: source.technical,
      })),
      scene_indexes: (record.scene_indexes as JsonRecord[]).map((index) => ({
        source_id: index.source_id, checksum: index.checksum,
      })),
      ignored: (record.ignored as JsonRecord[]).map((outcome) => ({
        id: outcome.id, media_index: outcome.media_index, code: outcome.code,
      })),
      unavailable: (record.unavailable as JsonRecord[]).map((outcome) => ({
        id: outcome.id, media_index: outcome.media_index, code: outcome.code,
      })),
    };
  }
  if ('audio_checksum' in record && 'words' in record) {
    return {
      schema_version: record.schema_version,
      audio_checksum: record.audio_checksum,
      words: (record.words as unknown[]).map((word) => {
        const entry = word as JsonRecord;
        return { text: string(entry.text, 'word.text').normalize('NFC').trim().replace(/\s+/g, ' '), start_sec: entry.start_sec, end_sec: entry.end_sec };
      }),
    };
  }
  const { created_at: _createdAt, fingerprint: _fingerprint, message: _message, ...rest } = record;
  return rest;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot fingerprint non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('cannot fingerprint unsupported value');
}

export function fingerprintCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(fingerprintProjection(value))).digest('hex')}`;
}
