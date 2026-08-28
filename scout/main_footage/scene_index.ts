// scene_index.ts — natural-scene indexing for a published forced-main source package.
//
// One immutable source video (already published under sources/<id>.mp4 by
// source_package.ts) gets cut into natural scenes, each backed by durable evidence
// (representative frame, transcript span, optional Vision description, embedding,
// local visual metrics) persisted under `scene-index/<source-id>/<cache-key>/`.
// Analysis is entirely port-driven (detectScenes/extractFrames/transcribe/
// describeWithVision/embed/measureVisuals) so tests inject deterministic fakes and
// never touch ffmpeg, a vision model, or an embedding API.
//
// Vision failure degrades ONE index's `planning_mode` to 'degraded' — it never drops
// the source. Every other analysis step still runs (transcript, embedding, visual metrics).
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embed as embedNovita } from '../lib/embed.ts';
import { chatCompletion, chatContent, chatReady } from '../lib/llm.ts';
import type {
  MainFootageWarningCode,
  PlanningMode,
  SceneEvidenceV1,
  SceneIndexV1,
  SourceTechnicalMetadata,
  SourceVideoV1,
  VisualMetricsV1,
} from './contracts.ts';
import { decodeSourcePackage, fingerprintCanonical } from './contracts.ts';
import { atomicPublish, nextVersion, resolveContained } from './paths.ts';

/** Candidate boundaries closer together than this are folded into one scene. */
export const SCENE_MERGE_TOLERANCE_SEC = 1.0;

export const DEFAULT_ANALYZER_IDENTITY =
  `ffmpeg-scene@1|vision:${process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct'}` +
  `|embed:${process.env.THOTH_EMBED_MODEL || 'qwen/qwen3-embedding-8b'}`;

export interface TranscriptSegment {
  text: string;
  start_sec: number;
  end_sec: number;
}

export interface VisionDescription {
  subject: string;
  action: string;
  setting: string;
  composition: string;
  motion: string;
  topic: string;
}

export interface SceneIndexDeps {
  /** Identifies every analyzer/model version in play; part of the cache key. */
  analyzerIdentity: string;
  detectScenes(sourcePath: string, technical: SourceTechnicalMetadata): Promise<number[]>;
  extractFrames(sourcePath: string, atSeconds: number[]): Promise<string[]>;
  transcribe(sourcePath: string): Promise<TranscriptSegment[]>;
  describeWithVision(framePath: string): Promise<VisionDescription>;
  embed(text: string): Promise<number[] | null>;
  measureVisuals(
    sourcePath: string,
    scene: { start_sec: number; end_sec: number },
    frames: string[],
  ): Promise<VisualMetricsV1>;
}

export interface PackageSceneSummary {
  scene_indexes: SceneIndexV1[];
  warnings: MainFootageWarningCode[];
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function fileChecksum(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

/**
 * Folds raw candidate boundaries into ordered scenes covering exactly [0, duration].
 * Out-of-range candidates are dropped; remaining ones are deduped/sorted; any gap
 * shorter than SCENE_MERGE_TOLERANCE_SEC is merged into its predecessor (a trailing
 * short gap instead replaces the previous boundary so the final scene still ends
 * exactly at `duration`). A source shorter than the tolerance still spans one scene.
 */
function mergeBoundaries(raw: readonly number[], duration: number): number[] {
  const interior = Array.from(
    new Set(raw.filter((t) => Number.isFinite(t) && t > 0 && t < duration)),
  ).sort((a, b) => a - b);
  const boundaries = [0, ...interior, duration];
  const merged: number[] = [boundaries[0]!];
  for (let i = 1; i < boundaries.length; i += 1) {
    const candidate = boundaries[i]!;
    const last = merged[merged.length - 1]!;
    if (candidate - last < SCENE_MERGE_TOLERANCE_SEC) {
      if (i === boundaries.length - 1) merged[merged.length - 1] = candidate;
      continue;
    }
    merged.push(candidate);
  }
  // A source shorter than the tolerance collapses to a single boundary — never publish an
  // index with zero scenes; the whole source is one scene.
  return merged.length < 2 ? [0, duration] : merged;
}

/** Writes `bytes` at `relPath` (package-root-relative) via temp-plus-atomic-rename. */
function publishArtifact(
  bytes: Buffer,
  packageRoot: string,
  tempRoot: string,
  relPath: string,
): { path: string; checksum: string } {
  const dest = resolveContained(packageRoot, relPath);
  fs.mkdirSync(tempRoot, { recursive: true });
  const tmp = path.join(tempRoot, `${shortHash(`${relPath}:${Math.random()}`)}.tmp`);
  fs.writeFileSync(tmp, bytes);
  atomicPublish(tmp, dest);
  return { path: relPath, checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

/**
 * Every artifact a scene declares, in a stable order. The start/end frames are real
 * published artifacts at deterministic siblings of `representative_frame`; they are not
 * named by the typed contract but they are still declared evidence, so the cache check
 * must cover them (deleting one has to invalidate the index).
 */
function sceneArtifactPaths(scene: SceneEvidenceV1): string[] {
  const mid = scene.representative_frame;
  const artifacts = [
    mid.replace(/-mid\.jpg$/, '-start.jpg'),
    mid,
    mid.replace(/-mid\.jpg$/, '-end.jpg'),
  ];
  if (scene.embedding_path) artifacts.push(scene.embedding_path);
  return artifacts;
}

/**
 * A content fingerprint of the whole index: the source checksum, the planning mode, and
 * every scene's full canonical content (boundaries, transcript evidence, vision text,
 * metrics) plus the on-disk bytes of *every* artifact it declares. Recomputing this
 * against what is actually on disk is the cache-validity check — a missing, changed, or
 * semantically different artifact all make it mismatch.
 */
function computeIndexChecksum(
  source: SourceVideoV1,
  packageRoot: string,
  planningMode: PlanningMode,
  scenes: readonly SceneEvidenceV1[],
): string {
  return fingerprintCanonical({
    source_checksum: source.checksum,
    planning_mode: planningMode,
    scenes: scenes.map((scene) => ({
      id: scene.id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      transcript_evidence: scene.transcript_evidence,
      vision_description: scene.vision_description ?? null,
      visual_metrics: scene.visual_metrics,
      // Artifact *bytes*, not artifact paths: a rebuild lands in a fresh generation
      // directory, and hashing the path would make every rebuild differ trivially while
      // hiding a real content change behind it. Reading each one is also the existence
      // check — a missing declared artifact throws and invalidates the generation.
      artifacts: sceneArtifactPaths(scene).map((relative) =>
        fileChecksum(resolveContained(packageRoot, relative)),
      ),
    })),
  });
}

/** Published generations under one cache key, newest first. */
function generations(packageRoot: string, relCacheDir: string): string[] {
  let abs: string;
  try {
    abs = resolveContained(packageRoot, relCacheDir);
  } catch {
    return [];
  }
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d{3,}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
}

/**
 * Claims a fresh, never-before-published generation directory under the cache key. A
 * rebuild therefore never overwrites or deletes the generation it is replacing —
 * published artifacts stay immutable even when the previous one is damaged.
 */
function reserveGeneration(packageRoot: string, relCacheDir: string): string {
  const absCacheDir = resolveContained(packageRoot, relCacheDir);
  fs.mkdirSync(absCacheDir, { recursive: true });
  let version = Number(nextVersion(absCacheDir).slice(1));
  for (;;) {
    const relative = path.posix.join(relCacheDir, `v${String(version).padStart(3, '0')}`);
    try {
      fs.mkdirSync(resolveContained(packageRoot, relative));
      return relative;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      version += 1;
    }
  }
}

/** Newest generation under this cache key whose every declared artifact still verifies. */
function readCachedIndex(
  source: SourceVideoV1,
  packageRoot: string,
  relCacheDir: string,
): SceneIndexV1 | null {
  for (const generation of generations(packageRoot, relCacheDir)) {
    const relIndexPath = path.posix.join(relCacheDir, generation, 'index.json');
    let abs: string;
    try {
      abs = resolveContained(packageRoot, relIndexPath);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    let parsed: SceneIndexV1;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as SceneIndexV1;
    } catch {
      continue;
    }
    const index: SceneIndexV1 = {
      source_id: parsed.source_id,
      path: parsed.path,
      checksum: parsed.checksum,
      planning_mode: parsed.planning_mode,
      scenes: parsed.scenes,
    };
    try {
      if (
        computeIndexChecksum(source, packageRoot, index.planning_mode, index.scenes) ===
        index.checksum
      ) {
        return index;
      }
    } catch {
      // A declared artifact is missing or unreadable — this generation cannot be trusted.
    }
  }
  return null;
}

/**
 * Indexes one already-published, immutable source video into natural scenes.
 * Reruns with the same source checksum + analyzer identity reuse the prior result
 * (verified against the on-disk bytes of every declared artifact, not just path
 * existence) without calling any analysis port. When that verification fails the
 * rebuild claims a *fresh* generation directory under the same cache key, so a
 * published artifact is never overwritten or deleted.
 *
 * `caption` is the source-level caption/title text. It is the last-resort embedding
 * evidence: a scene with no vision description and no overlapping transcript is
 * unrankable downstream, i.e. functionally discarded, which the degrade-don't-discard
 * constraint forbids.
 */
export async function indexSource(
  source: SourceVideoV1,
  packageRoot: string,
  deps: SceneIndexDeps,
  caption = '',
): Promise<SceneIndexV1> {
  const cacheKey = shortHash(`${source.checksum}|${deps.analyzerIdentity}`);
  const relCacheDir = path.posix.join('scene-index', source.id, cacheKey);

  const cached = readCachedIndex(source, packageRoot, relCacheDir);
  if (cached) return cached;

  const relDir = reserveGeneration(packageRoot, relCacheDir);
  const relIndexPath = path.posix.join(relDir, 'index.json');
  const captionEvidence = caption.trim();

  const sourcePath = resolveContained(packageRoot, source.path);
  const tempRoot = path.join(packageRoot, '.tmp');

  const rawBoundaries = await deps.detectScenes(sourcePath, source.technical);
  const boundaries = mergeBoundaries(rawBoundaries, source.technical.duration_sec);
  const transcript = await deps.transcribe(sourcePath);

  const scenes: SceneEvidenceV1[] = [];
  let degraded = false;

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    const sceneId = `scene-${String(i + 1).padStart(4, '0')}`;
    const mid = (start + end) / 2;
    const endSample = Math.max(start, end - Math.min(0.05, (end - start) / 2));

    const frames = await deps.extractFrames(sourcePath, [start, mid, endSample]);
    if (frames.length !== 3) throw new Error('extract_frames_incomplete');
    const [startFrame, midFrame, endFrame] = frames as [string, string, string];

    // All three timestamps are persisted as real artifacts (relative package paths) —
    // only the middle one is referenced by the contract's `representative_frame`.
    publishArtifact(
      fs.readFileSync(startFrame),
      packageRoot,
      tempRoot,
      path.posix.join(relDir, 'frames', `${sceneId}-start.jpg`),
    );
    const midPublished = publishArtifact(
      fs.readFileSync(midFrame),
      packageRoot,
      tempRoot,
      path.posix.join(relDir, 'frames', `${sceneId}-mid.jpg`),
    );
    publishArtifact(
      fs.readFileSync(endFrame),
      packageRoot,
      tempRoot,
      path.posix.join(relDir, 'frames', `${sceneId}-end.jpg`),
    );

    const metrics = await deps.measureVisuals(sourcePath, { start_sec: start, end_sec: end }, [
      startFrame,
      midFrame,
      endFrame,
    ]);

    const overlapping = transcript
      .filter((seg) => seg.start_sec < end && seg.end_sec > start)
      .map((seg) => seg.text.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    const transcriptEvidence = overlapping || '(no speech detected)';

    let visionDescription: string | undefined;
    let visionEvidence = '';
    try {
      const vision = await deps.describeWithVision(midFrame);
      visionDescription = JSON.stringify(vision);
      visionEvidence = [
        vision.subject,
        vision.action,
        vision.setting,
        vision.composition,
        vision.motion,
        vision.topic,
      ]
        .map((part) => (part ?? '').trim())
        .filter(Boolean)
        .join(' ');
    } catch {
      degraded = true;
    }

    // Fixed order: vision description, then overlapping transcript, then the source-level
    // caption. Only an entirely empty evidence set may leave a scene without an embedding.
    const embedInput = [visionEvidence, overlapping, captionEvidence]
      .filter(Boolean)
      .join(' ')
      .trim();
    let embeddingPath: string | undefined;
    if (embedInput) {
      const vector = await deps.embed(embedInput);
      if (vector) {
        embeddingPath = publishArtifact(
          Buffer.from(JSON.stringify(vector)),
          packageRoot,
          tempRoot,
          path.posix.join(relDir, 'embeddings', `${sceneId}.json`),
        ).path;
      }
    }

    scenes.push({
      id: sceneId,
      start_sec: start,
      end_sec: end,
      representative_frame: midPublished.path,
      transcript_evidence: transcriptEvidence,
      ...(visionDescription ? { vision_description: visionDescription } : {}),
      ...(embeddingPath ? { embedding_path: embeddingPath } : {}),
      visual_metrics: metrics,
    });
  }

  const index: SceneIndexV1 = {
    source_id: source.id,
    path: relIndexPath,
    checksum: computeIndexChecksum(source, packageRoot, degraded ? 'degraded' : 'vision', scenes),
    planning_mode: degraded ? 'degraded' : 'vision',
    scenes,
  };
  // analyzer_identity rides along in the persisted file for provenance/debugging; it is
  // not part of the typed contract and decoders ignore unknown fields.
  publishArtifact(
    Buffer.from(
      JSON.stringify({ ...index, analyzer_identity: deps.analyzerIdentity }, null, 2),
      'utf8',
    ),
    packageRoot,
    tempRoot,
    relIndexPath,
  );
  return index;
}

/** Indexes every source of an already-published package.json, aggregating warnings. */
export async function indexPackage(
  packageManifestPath: string,
  deps: SceneIndexDeps,
): Promise<PackageSceneSummary> {
  const absManifest = path.resolve(packageManifestPath);
  const packageRoot = path.dirname(absManifest);
  const raw = JSON.parse(fs.readFileSync(absManifest, 'utf8'));
  const pkg = decodeSourcePackage(raw);
  const scene_indexes: SceneIndexV1[] = [];
  const warnings: MainFootageWarningCode[] = [];
  const budgeted = withVisionBudget(deps);
  for (const source of pkg.sources) {
    try {
      const index = await indexSource(source, packageRoot, budgeted.deps);
      scene_indexes.push(index);
      if (index.planning_mode === 'degraded') warnings.push('vision_degraded');
    } catch (error) {
      // Without this the only trace a skipped source leaves is a warning code, which says
      // nothing about why ffmpeg/vision/embedding gave up.
      console.warn(
        `[main-footage] scene index failed for ${source.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      warnings.push('source_video_skipped');
    }
  }
  budgeted.report();
  return { scene_indexes, warnings };
}

// ---------------------------------------------------------------------------------
// Production port implementations. Only these touch ffmpeg/network/models — the
// port interfaces above stay injectable so tests never reach this section.
// ---------------------------------------------------------------------------------

function ffmpegBin(): string {
  return process.env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
}

/**
 * A non-zero (or absent) ffmpeg exit status is an indexing failure, never "no result".
 * Swallowing it turns a missing binary into a plausible-looking one-scene index, which
 * is worse than no index at all: the manifest looks valid and the feature is silently off.
 */
function ffmpegOrThrow<T>(result: SpawnSyncReturns<T>, what: string): SpawnSyncReturns<T> {
  if (result.error) throw new Error(`ffmpeg_${what}_spawn_failed`);
  if (result.status !== 0) throw new Error(`ffmpeg_${what}_exit_${result.status ?? 'signal'}`);
  return result;
}

// ponytail: a single fixed scene-score threshold (0.4, ffmpeg's own common default)
// stands in for a tuned/adaptive detector; revisit if false boundaries show up in practice.
export async function detectScenesWithFfmpeg(
  sourcePath: string,
  _technical: SourceTechnicalMetadata,
): Promise<number[]> {
  const result = ffmpegOrThrow(
    spawnSync(
      ffmpegBin(),
      ['-i', sourcePath, '-filter:v', "select='gt(scene,0.4)',showinfo", '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 60_000 },
    ),
    'scene_detect',
  );
  const text = result.stderr || '';
  return [...text.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

/** How far before a requested sample the fallback sweep starts looking for a frame. */
const FRAME_FALLBACK_WINDOW_SEC = 10;

export async function extractFramesWithFfmpeg(
  sourcePath: string,
  atSeconds: number[],
): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-scene-frame-'));
  return atSeconds.map((t, i) => {
    const at = Math.max(0, t);
    const out = path.join(dir, `frame-${i}.jpg`);
    const seeked = spawnSync(
      ffmpegBin(),
      ['-y', '-ss', String(at), '-i', sourcePath, '-frames:v', '1', '-q:v', '4', out],
      { timeout: 30_000 },
    );
    if (seeked.status !== 0 || !fs.existsSync(out)) {
      // A sample can land in the gap after the final video pts: the probed duration is the
      // container's (an audio stream outlasting the video pushes it past the last frame), and a
      // low-fps source has a frame interval wider than the back-off indexSource applies. Accurate
      // input seek then drops every frame and ffmpeg writes nothing. Sweep the window ending at
      // the sample instead and keep the last frame written — the frame at or before `at`, which
      // is what the caller wanted. Bounded by `-t` so a genuinely broken read still fails here.
      const from = Math.max(0, at - FRAME_FALLBACK_WINDOW_SEC);
      ffmpegOrThrow(
        spawnSync(
          ffmpegBin(),
          [
            '-y',
            '-ss',
            String(from),
            '-i',
            sourcePath,
            '-t',
            String(at - from),
            '-update',
            '1',
            '-q:v',
            '4',
            out,
          ],
          { timeout: 30_000 },
        ),
        'extract_frame',
      );
    }
    if (!fs.existsSync(out)) throw new Error('ffmpeg_extract_frame_missing_output');
    return out;
  });
}

// ponytail: scout has no speech-to-text pipeline of its own (Whisper runs inside
// thoth-core, a separate process). This default degrades to "no transcript" rather
// than block indexing; a caller that owns a transcript should inject its own port.
export async function transcribeUnavailable(_sourcePath: string): Promise<TranscriptSegment[]> {
  return [];
}

const VISION_MODEL = process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct';
const VISION_PROMPT =
  'Describe this video frame as compact JSON with exactly these string keys: ' +
  'subject, action, setting, composition, motion, topic. No prose outside the JSON.';

export async function describeSceneWithVision(framePath: string): Promise<VisionDescription> {
  if (!chatReady('vision')) throw new Error('vision_api_key_missing');
  const b64 = fs.readFileSync(framePath).toString('base64');
  const response = await chatCompletion(
    {
      model: VISION_MODEL,
      max_tokens: 512,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' },
            },
          ],
        },
      ],
    },
    { timeoutMs: 30_000 },
  );
  if (!response.ok) throw new Error(`vision_http_${response.status}`);
  const content = chatContent(await response.json());
  const match = typeof content === 'string' ? /\{[\s\S]*\}/.exec(content) : null;
  if (!match) throw new Error('vision_response_unparseable');
  const parsed = JSON.parse(match[0]);
  const field = (key: string) => (typeof parsed[key] === 'string' ? parsed[key] : '');
  return {
    subject: field('subject'),
    action: field('action'),
    setting: field('setting'),
    composition: field('composition'),
    motion: field('motion'),
    topic: field('topic'),
  };
}

export async function embedSceneEvidence(text: string): Promise<number[] | null> {
  const [vector] = await embedNovita([text]);
  return vector ?? null;
}

function signalstatsYavg(imagePath: string): number {
  const result = ffmpegOrThrow(
    spawnSync(
      ffmpegBin(),
      [
        '-i',
        imagePath,
        '-vf',
        'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-f',
        'null',
        '-',
      ],
      { encoding: 'utf8', timeout: 20_000 },
    ),
    'signalstats',
  );
  const match =
    /YAVG=([\d.]+)/.exec(result.stdout || '') || /YAVG=([\d.]+)/.exec(result.stderr || '');
  return match ? Number(match[1]) / 255 : 0;
}

// ponytail: motion_score and scene_change_score both proxy off one start/end
// pixel-difference pass (no dedicated optical-flow estimator). Split them apart if
// downstream planning ever needs the two signals to diverge.
export async function measureVisualsWithFfmpeg(
  _sourcePath: string,
  _scene: { start_sec: number; end_sec: number },
  frames: string[],
): Promise<VisualMetricsV1> {
  const [startFrame, midFrame, endFrame] = frames;
  const brightness = midFrame ? signalstatsYavg(midFrame) : 0;
  let motion = 0;
  if (startFrame && endFrame) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-scene-diff-'));
    const diff = path.join(dir, 'diff.jpg');
    ffmpegOrThrow(
      spawnSync(
        ffmpegBin(),
        [
          '-y',
          '-i',
          startFrame,
          '-i',
          endFrame,
          '-filter_complex',
          'blend=all_mode=difference',
          diff,
        ],
        { timeout: 20_000 },
      ),
      'frame_diff',
    );
    motion = fs.existsSync(diff) ? signalstatsYavg(diff) : 0;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  const clamped = (n: number) => Math.min(1, Math.max(0, n));
  return {
    motion_score: clamped(motion),
    brightness: clamped(brightness),
    scene_change_score: clamped(motion),
  };
}

/**
 * Vision is one serial network call per scene per source, so an unbounded package can
 * spend tens of minutes on it. This caps the whole package and makes the spend visible.
 * ponytail: one flat per-package cap, no concurrency — raise it or parallelize only if
 * real packages start hitting it.
 */
export const VISION_CALLS_PER_PACKAGE = 40;

/**
 * Bounds and reports the Vision spend of one package. Vision stays enabled/disabled by the
 * switch scout already has — `THOTH_NOVITA_API_KEY`, which `describeSceneWithVision`
 * rejects on when absent — and a cap-exceeded scene throws exactly like an unavailable
 * one, so `indexSource` degrades it (`vision_degraded`) instead of failing the package.
 */
export function withVisionBudget(
  deps: SceneIndexDeps,
  budget = VISION_CALLS_PER_PACKAGE,
): { deps: SceneIndexDeps; report(): void } {
  let used = 0;
  return {
    deps: {
      ...deps,
      describeWithVision: async (framePath: string) => {
        if (used >= budget) throw new Error('vision_budget_exhausted');
        used += 1;
        return deps.describeWithVision(framePath);
      },
    },
    report: () => console.warn(`[main-footage] vision calls: ${used}/${budget}`),
  };
}

export function defaultSceneIndexDeps(): SceneIndexDeps {
  return {
    analyzerIdentity: DEFAULT_ANALYZER_IDENTITY,
    detectScenes: detectScenesWithFfmpeg,
    extractFrames: extractFramesWithFfmpeg,
    transcribe: transcribeUnavailable,
    describeWithVision: describeSceneWithVision,
    embed: embedSceneEvidence,
    measureVisuals: measureVisualsWithFfmpeg,
  };
}
