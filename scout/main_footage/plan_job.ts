// plan_job.ts — internal coordinator for job-local narration planned footage.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { embed } from '../lib/embed.ts';
import { novitaKey } from '../lib/env.ts';
import { fetchJsonWithTimeout } from '../lib/subtitle_vision.ts';
import { allocateTimeline } from './allocator.ts';
import {
  buildBeatCandidates,
  type CandidateDeps,
  fileEmbeddingLoader,
  type PlannerRanking,
  type ShortlistEntry,
} from './candidates.ts';
import {
  decodeNarrationTimeline,
  decodeSourcePackage,
  fingerprintCanonical,
  type MainFootagePlanV1,
} from './contracts.ts';
import {
  type CutCommand,
  type MaterializePlanDeps,
  materializePlan,
  readVerifiedActivePlan,
} from './cuts.ts';
import { resolveContained } from './paths.ts';
import { probeSourceVideo } from './source_package.ts';

export interface PlanProgress {
  stage: 'planning_cuts' | 'materializing_cuts' | 'verifying_plan';
  pct: number;
  message: string;
  warning?: string;
}

export interface PlanMainFootageProviders {
  candidateDeps: CandidateDeps;
  ffmpeg: MaterializePlanDeps['ffmpeg'];
  ffprobe: MaterializePlanDeps['ffprobe'];
  emit?: (event: PlanProgress) => void;
  now?: () => number;
}

export interface PlanMainFootageOptions {
  jobRoot: string;
  packagePath: string;
  narrationPath: string;
  coverageTarget: number;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function parseRanking(value: unknown): PlannerRanking[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { candidate_id: string; reason?: string } =>
      Boolean(entry && typeof entry === 'object' && typeof entry.candidate_id === 'string'),
    )
    .map((entry) => ({
      candidate_id: entry.candidate_id,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    }));
}

async function rankWithPlanner(shortlist: ShortlistEntry[]): Promise<PlannerRanking[]> {
  const key = novitaKey();
  if (!key || shortlist.length === 0) return [];
  try {
    const { response, data } = await fetchJsonWithTimeout(
      'https://api.novita.ai/v3/openai/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.THOTH_PLANNER_MODEL || 'openai/gpt-oss-20b',
          temperature: 0,
          max_tokens: 1000,
          messages: [
            {
              role: 'user',
              content:
                'Rank these known scene candidates for one narration beat. Return only a JSON array ' +
                'of {"candidate_id":"known id","reason":"brief editorial reason"}. Never add ids.\n' +
                JSON.stringify(shortlist),
            },
          ],
        }),
      },
      30_000,
    );
    if (!response.ok) return [];
    const content = (data as any)?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return [];
    const match = /\[[\s\S]*\]/.exec(content);
    return match ? parseRanking(JSON.parse(match[0])) : [];
  } catch {
    return [];
  }
}

/**
 * Production cut port. Exported so the offline acceptance test can drive the real
 * command builder instead of a hand-written double — a fake here would let the
 * argument list drift without a single test noticing.
 */
export async function ffmpegCut(command: CutCommand): Promise<void> {
  if (!path.isAbsolute(command.inputPath) || /^[a-z][a-z0-9+.-]*:\/\//i.test(command.inputPath)) {
    throw new Error('artifact_path_must_be_local');
  }
  const ffmpeg =
    process.env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
  const args = [
    '-y',
    '-ss',
    String(command.startSec),
    '-i',
    command.inputPath,
    '-t',
    String(command.durationSec),
    '-map',
    '0:v:0',
  ];
  if (command.mapAudio) args.push('-map', '0:a:0?');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18');
  if (command.mapAudio) {
    const fadeOut = Math.max(0, command.durationSec - 0.03);
    args.push('-c:a', 'aac', '-af', `afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOut}:d=0.03`);
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', command.outputPath);
  const result = spawnSync(ffmpeg, args, { stdio: 'pipe', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error('ffmpeg_cut_failed');
}

/** Production composition; it never consults offline-mode environment variables. */
export function productionPlannerProviders(packageRoot: string): PlanMainFootageProviders {
  if (
    process.env.THOTH_PLANNER_OFFLINE !== undefined ||
    process.env.THOTH_PLANNER_TEST_CONTEXT !== undefined
  ) {
    throw new Error('planner_offline_environment_not_supported');
  }
  const loadEmbedding = fileEmbeddingLoader(packageRoot);
  return {
    candidateDeps: {
      embedText: async (text) => (await embed([text]))[0] ?? null,
      loadEmbedding,
      rankShortlist: async (_beat, shortlist) => rankWithPlanner(shortlist),
    },
    ffmpeg: ffmpegCut,
    ffprobe: probeSourceVideo,
  };
}

export async function planMainFootageJob(
  options: PlanMainFootageOptions,
  injected?: PlanMainFootageProviders,
): Promise<MainFootagePlanV1> {
  const jobRoot = fs.realpathSync.native(path.resolve(options.jobRoot));
  if (!fs.statSync(jobRoot).isDirectory()) throw new Error('path_outside_root');
  const packageFile = resolveContained(jobRoot, options.packagePath);
  const narrationFile = resolveContained(jobRoot, options.narrationPath);
  const packageRoot = path.dirname(packageFile);
  const providers = injected ?? productionPlannerProviders(packageRoot);
  const emit = providers.emit ?? ((event: PlanProgress) => console.log(JSON.stringify(event)));

  const pkg = decodeSourcePackage(JSON.parse(fs.readFileSync(packageFile, 'utf8')));
  const narration = decodeNarrationTimeline(JSON.parse(fs.readFileSync(narrationFile, 'utf8')));
  const sourceFingerprint = fingerprintCanonical(pkg);
  const narrationFingerprint = fingerprintCanonical(narration);
  if (pkg.fingerprint && pkg.fingerprint !== sourceFingerprint) {
    throw stableError('source_package_invalid');
  }
  if (narration.fingerprint && narration.fingerprint !== narrationFingerprint) {
    throw stableError('narration_generation_failed');
  }
  if (!narration.beats?.length) throw stableError('forced_main_narration_required');
  const reusable = readVerifiedActivePlan(jobRoot, {
    sourcePackageFingerprint: sourceFingerprint,
    narrationFingerprint,
    coverageTarget: options.coverageTarget,
  });
  if (reusable) {
    emit({ stage: 'verifying_plan', pct: 100, message: 'active plan verified' });
    return reusable;
  }

  emit({ stage: 'planning_cuts', pct: 15, message: 'building candidates from package indexes' });
  const candidates = new Map<string, Awaited<ReturnType<typeof buildBeatCandidates>>>();
  for (const beat of narration.beats) {
    candidates.set(
      beat.id,
      await buildBeatCandidates(
        beat,
        pkg.scene_indexes,
        { maxCandidatesPerBeat: 20, embeddingTopK: 12 },
        providers.candidateDeps,
      ),
    );
  }
  const allocation = allocateTimeline({
    beats: narration.beats,
    candidates,
    coverageTarget: options.coverageTarget,
  });
  if (allocation.error) throw Object.assign(new Error(allocation.error.code), allocation.error);

  emit({ stage: 'materializing_cuts', pct: 55, message: 'publishing job-local cut version' });
  const plan = await materializePlan(allocation, jobRoot, {
    package: pkg,
    sourcePackagePath: options.packagePath,
    narrationTimelinePath: options.narrationPath,
    sourcePackageFingerprint: sourceFingerprint,
    narrationFingerprint,
    candidates,
    ffmpeg: providers.ffmpeg,
    ffprobe: providers.ffprobe,
    now: providers.now,
  });
  emit({ stage: 'verifying_plan', pct: 100, message: 'active plan verified' });
  return plan;
}

function parseArgs(args: readonly string[]): PlanMainFootageOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error('invalid_arguments');
    if (!['--job-root', '--package', '--narration', '--coverage-target'].includes(flag)) {
      throw new Error('invalid_arguments');
    }
    values.set(flag, value);
  }
  const jobRoot = values.get('--job-root');
  const packagePath = values.get('--package');
  const narrationPath = values.get('--narration');
  const rawCoverageTarget = values.get('--coverage-target');
  const coverageTarget = Number(rawCoverageTarget);
  if (
    !jobRoot ||
    !packagePath ||
    !narrationPath ||
    rawCoverageTarget === undefined ||
    !Number.isFinite(coverageTarget) ||
    coverageTarget < 0.6 ||
    coverageTarget > 1
  ) {
    throw new Error('invalid_arguments');
  }
  return { jobRoot, packagePath, narrationPath, coverageTarget };
}

/** Test-only seam: callers may inject all provider/process ports; CLI production omits it. */
export async function runPlanMainFootageCli(
  args: readonly string[],
  providers?: PlanMainFootageProviders,
): Promise<MainFootagePlanV1> {
  return planMainFootageJob(parseArgs(args), providers);
}
