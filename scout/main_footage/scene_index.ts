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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embed as embedNovita } from '../lib/embed.ts';
import { novitaKey } from '../lib/env.ts';
import { fetchJsonWithTimeout } from '../lib/subtitle_vision.ts';
import type {
  MainFootageWarningCode,
  SceneEvidenceV1,
  SceneIndexV1,
  SourceTechnicalMetadata,
  SourceVideoV1,
  VisualMetricsV1,
} from './contracts.ts';
import { decodeSourcePackage } from './contracts.ts';
import { atomicPublish, resolveContained } from './paths.ts';

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
 * exactly at `duration`).
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
  return merged;
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
 * A content fingerprint of the whole index: the source checksum plus, for every
 * scene, its representative frame's bytes and (if present) its embedding's bytes.
 * Recomputing this against what is actually on disk is the cache-validity check —
 * any declared artifact that is missing or has changed makes it mismatch.
 */
function computeIndexChecksum(
  source: SourceVideoV1,
  packageRoot: string,
  scenes: readonly SceneEvidenceV1[],
): string {
  const hash = createHash('sha256');
  hash.update(source.checksum);
  for (const scene of scenes) {
    hash.update(`|${scene.id}:`);
    hash.update(fileChecksum(resolveContained(packageRoot, scene.representative_frame)));
    if (scene.embedding_path) {
      hash.update(':');
      hash.update(fileChecksum(resolveContained(packageRoot, scene.embedding_path)));
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

function readCachedIndex(
  source: SourceVideoV1,
  packageRoot: string,
  relIndexPath: string,
): SceneIndexV1 | null {
  let abs: string;
  try {
    abs = resolveContained(packageRoot, relIndexPath);
  } catch {
    return null;
  }
  if (!fs.existsSync(abs)) return null;
  let parsed: SceneIndexV1;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as SceneIndexV1;
  } catch {
    return null;
  }
  const index: SceneIndexV1 = {
    source_id: parsed.source_id,
    path: parsed.path,
    checksum: parsed.checksum,
    planning_mode: parsed.planning_mode,
    scenes: parsed.scenes,
  };
  try {
    if (computeIndexChecksum(source, packageRoot, index.scenes) !== index.checksum) return null;
  } catch {
    // A declared artifact is missing or unreadable — the cache cannot be trusted.
    return null;
  }
  return index;
}

/**
 * Indexes one already-published, immutable source video into natural scenes.
 * Reruns with the same source checksum + analyzer identity reuse the prior result
 * (verified against on-disk artifact checksums, not just path existence) without
 * calling any analysis port. A different checksum or identity resolves to a
 * different, never-before-published path, so a rebuild never overwrites anything.
 */
export async function indexSource(
  source: SourceVideoV1,
  packageRoot: string,
  deps: SceneIndexDeps,
): Promise<SceneIndexV1> {
  const cacheKey = shortHash(`${source.checksum}|${deps.analyzerIdentity}`);
  const relDir = path.posix.join('scene-index', source.id, cacheKey);
  const relIndexPath = path.posix.join(relDir, 'index.json');

  const cached = readCachedIndex(source, packageRoot, relIndexPath);
  if (cached) return cached;

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
    let visionTopic = '';
    try {
      const vision = await deps.describeWithVision(midFrame);
      visionDescription = JSON.stringify(vision);
      visionTopic = vision.topic ?? '';
    } catch {
      degraded = true;
    }

    const embedInput = [overlapping, visionTopic].filter(Boolean).join(' ').trim();
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
    checksum: computeIndexChecksum(source, packageRoot, scenes),
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
  for (const source of pkg.sources) {
    const index = await indexSource(source, packageRoot, deps);
    scene_indexes.push(index);
    if (index.planning_mode === 'degraded') warnings.push('vision_degraded');
  }
  return { scene_indexes, warnings };
}

// ---------------------------------------------------------------------------------
// Production port implementations. Only these touch ffmpeg/network/models — the
// port interfaces above stay injectable so tests never reach this section.
// ---------------------------------------------------------------------------------

function ffmpegBin(): string {
  return process.env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
}

// ponytail: a single fixed scene-score threshold (0.4, ffmpeg's own common default)
// stands in for a tuned/adaptive detector; revisit if false boundaries show up in practice.
export async function detectScenesWithFfmpeg(
  sourcePath: string,
  _technical: SourceTechnicalMetadata,
): Promise<number[]> {
  const result = spawnSync(
    ffmpegBin(),
    ['-i', sourcePath, '-filter:v', "select='gt(scene,0.4)',showinfo", '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const text = result.stderr || '';
  return [...text.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
}

export async function extractFramesWithFfmpeg(
  sourcePath: string,
  atSeconds: number[],
): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-scene-frame-'));
  return atSeconds.map((t, i) => {
    const out = path.join(dir, `frame-${i}.jpg`);
    spawnSync(
      ffmpegBin(),
      ['-y', '-ss', String(Math.max(0, t)), '-i', sourcePath, '-frames:v', '1', '-q:v', '4', out],
      { timeout: 30_000 },
    );
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
  const key = novitaKey();
  if (!key) throw new Error('novita_api_key_missing');
  const b64 = fs.readFileSync(framePath).toString('base64');
  const { response, data } = await fetchJsonWithTimeout(
    'https://api.novita.ai/v3/openai/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
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
      }),
    },
    30_000,
  );
  if (!response.ok) throw new Error(`vision_http_${response.status}`);
  const content = (data as any)?.choices?.[0]?.message?.content;
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
  const result = spawnSync(
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
      {
        timeout: 20_000,
      },
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
