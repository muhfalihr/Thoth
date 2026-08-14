// run_pipeline.ts — one command: a chosen topic URL → a complete, validated Thoth content-set.
//
// Chains the whole scout enrich flow that was previously run by hand:
//   seed (auto-inspect via AcquisitionService) → trace_source (resolve real source / keyword-find main)
//   → extract_figures (tokoh) → build_footage (objek→footage, gated) → collect_comments (multi-sumber)
//   → validate.
//
//   bun run_pipeline.ts <topic_url> [--out file.json] [--title "..."] [--desc "..."]
//                        [--per 2] [--max 4] [--cap 12] [--no-comments]
//
// <topic_url> = the post/reel the topic was discovered from (e.g. an IG reel). Caption/media shape are
// inspected once via the shared AcquisitionService (context.service.inspectPost) unless --title/--desc
// are given. Every stage below runs in-process against the SAME AcquisitionRunContext, so a URL is
// never navigated to twice across the whole pipeline run.

import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR, outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import { runPipelineStep } from './run_pipeline_step.ts';
import type { AcquisitionRunContext } from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';
import { canonicalizeUrl } from '../acquisition/url.ts';
import type { ContentSet, MainVideo } from '../lib/types.ts';
import type { PostRecord } from '../acquisition/types.ts';
import { buildSourcePackage, probeSourceVideo, type SourcePackageResult } from '../main_footage/source_package.ts';
import { runTraceSource, type TraceSourceOptions } from './trace_source.ts';
import { runCollectComments, type CollectCommentsOptions } from './collect_comments.ts';
import { runTopicDossier } from '../enrich/topic_dossier.ts';
import { runBuildFootage, type BuildFootageOptions } from './build_footage.ts';
import { runExtractFigures } from './extract_figures.ts';
import { runValidateContentSet } from './validate_content_set.ts';

type FileStageOptions = { file: string };

const DEFAULT_MODEL =
  process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct';

export interface RunPipelineOptions {
  url: string;
  out: string;
  title?: string;
  desc?: string;
  per?: number;
  max?: number;
  cap?: number;
  noComments: boolean;
  useInputAsMain: boolean;
  mainCoverageTarget: number;
}

export interface RunPipelineDeps {
  createContext(): Promise<AcquisitionRunContext>;
  inspectSeed(url: string, context: AcquisitionRunContext): Promise<Partial<MainVideo> & { post?: PostRecord }>;
  packageForcedMain?(
    input: { post: PostRecord; contentSetPath: string; coverageTarget: number },
    context: AcquisitionRunContext,
  ): Promise<Pick<SourcePackageResult, 'descriptor' | 'excludedMediaIds'>>;
  writeSeed(file: string, seed: ContentSet): Promise<void>;
  traceSource(options: TraceSourceOptions, context: AcquisitionRunContext): Promise<void>;
  collectComments(options: CollectCommentsOptions, context: AcquisitionRunContext): Promise<void>;
  topicDossier(options: FileStageOptions, context: AcquisitionRunContext): Promise<void>;
  buildFootage(options: BuildFootageOptions, context: AcquisitionRunContext): Promise<void>;
  extractFigures(options: FileStageOptions, context: AcquisitionRunContext): Promise<void>;
  validate(options: FileStageOptions, context: AcquisitionRunContext): Promise<void>;
  summarize(file: string): Promise<void>;
}

const STEP_TIMEOUT_MS = 600_000;
// build_footage searches once per dossier query (each search alone is capped at
// 200 s) and then OCRs every surviving candidate, so its real cost is measured in
// tens of minutes — 61 min on a live acceptance run. The default budget silently
// SIGTERM'd it mid-query, which reads exactly like a crash.
const FOOTAGE_TIMEOUT_MS = 5_400_000;
// trace_source is in the same class since the main gate started grading a REAL frame per
// candidate: it resolves a video slide to a signed CDN url and seeks into that remote stream,
// where it used to classify the carousel's cover JPEG (fast, and always wrong — a title card
// reads as 'commentary', which rejected every candidate). Measured ~1 min per candidate against
// a live search, so the 10 min default SIGTERM'd it mid-evaluation right after its first accept.
const TRACE_SOURCE_TIMEOUT_MS = 1_800_000;

type CodedError = Error & { code: string };

function codedError(code: string): CodedError {
  return Object.assign(new Error(code), { code });
}

function assertMainCoverageTarget(coverage: number): void {
  if (!Number.isFinite(coverage) || coverage < 0.60 || coverage > 1.00) {
    throw codedError('invalid_main_coverage_target');
  }
}

function preflightForcedMain(url: string, outputFile: string): string {
  let normalizedUrl: string;
  try {
    normalizedUrl = canonicalizeUrl(url);
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported');
  } catch {
    throw codedError('unsupported_url');
  }

  try {
    fs.accessSync(path.dirname(outputFile), fs.constants.W_OK);
  } catch {
    throw codedError('output_parent_not_writable');
  }

  const ffmpeg = process.env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
  const ffprobe = process.env.THOTH_FFPROBE || path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  try {
    fs.accessSync(ffmpeg, fs.constants.X_OK);
  } catch {
    throw codedError('ffmpeg_missing');
  }
  try {
    fs.accessSync(ffprobe, fs.constants.X_OK);
  } catch {
    throw codedError('ffprobe_missing');
  }
  return normalizedUrl;
}

export function parseRunPipelineOptions(args: string[]): RunPipelineOptions {
  const getFlag = (name: string, defaultValue?: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : defaultValue;
  };
  const valueFlags = ['--out', '--title', '--desc', '--per', '--max', '--cap', '--main-coverage-target'];
  const url = args.find((arg, index) => !arg.startsWith('--') && !valueFlags.includes(args[index - 1]));
  if (!url) throw codedError('url_required');

  const coverage = Number(getFlag('--main-coverage-target', '0.60'));
  assertMainCoverageTarget(coverage);
  return {
    url,
    out: outPath(getFlag('--out', 'thoth_content_set.json') as string),
    title: getFlag('--title', ''),
    desc: getFlag('--desc', ''),
    per: parseInt(getFlag('--per', '2') as string, 10),
    max: parseInt(getFlag('--max', '4') as string, 10),
    cap: parseInt(getFlag('--cap', '12') as string, 10),
    noComments: args.includes('--no-comments'),
    useInputAsMain: args.includes('--use-input-as-main'),
    mainCoverageTarget: coverage,
  };
}

// Required safety steps abort the run; optional enrichment may degrade gracefully — same policy the
// old subprocess-based `step()` used, just wrapping an in-process call instead of execFileSync.
function runStage(
  label: string,
  required: boolean,
  execute: () => Promise<void>,
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<boolean> {
  ui.stage(label);
  return runPipelineStep(
    { label, required, timeoutMs },
    { execute, warn: (message) => console.log(ui.amber(`  ${ui.WARN} ${message}`)) },
  );
}

export async function runPipelineWithDeps(
  options: RunPipelineOptions,
  deps: RunPipelineDeps,
): Promise<void> {
  assertMainCoverageTarget(options.mainCoverageTarget);
  const { out: file, noComments } = options;
  const url = options.useInputAsMain ? preflightForcedMain(options.url, file) : options.url;
  const context = await deps.createContext();

  // 1) Seed content-set (main + caption/shape from a single inspect).
  const seedFields = await deps.inspectSeed(url, context);
  const desc = options.desc || seedFields.description || '';
  const seed: ContentSet = {
    main: {
      url,
      platform: seedFields.platform || '',
      title: options.title || desc.slice(0, 120),
      description: desc,
      is_video: seedFields.is_video ?? true,
      duration_sec: 0,
      profile: { name: '', handle: '', followers: '', avatar_url: '' },
    },
    footage: [],
    comments: [],
  };
  let excludedMediaIds: string[] | undefined;
  if (options.useInputAsMain) {
    if (!seedFields.post) throw codedError('forced_main_no_usable_video');
    const packageForcedMain = deps.packageForcedMain || ((input, acquisitionContext) => buildSourcePackage(input, {
      materialize: (asset) => acquisitionContext.service.materialize(asset, 'main'),
      probe: probeSourceVideo,
      scoutOutputRoot: OUTPUT_DIR,
    }));
    const packaged = await packageForcedMain(
      { post: seedFields.post, contentSetPath: file, coverageTarget: options.mainCoverageTarget },
      context,
    );
    seed.main_footage = packaged.descriptor;
    excludedMediaIds = packaged.excludedMediaIds;
  }
  console.log(`caption: ${(desc || '(kosong)').slice(0, 90)}`);
  await deps.writeSeed(file, seed);

  // 2-6) Chain the enrich steps, all sharing `context`. collect_comments runs BEFORE build_footage so
  // subject/object extraction can mine the comments too. extract_figures runs AFTER build_footage so it
  // can also read footage descriptions. Every step is awaited: they run strictly in order and each one
  // reads the file the previous step wrote.
  if (!options.useInputAsMain) {
    await runStage(
      'trace_source (sumber/main)',
      true,
      () =>
        deps.traceSource({ file, keywords: [], username: null, model: DEFAULT_MODEL, noDl: false }, context),
      TRACE_SOURCE_TIMEOUT_MS,
    );
  }

  if (!noComments) {
    await runStage('collect_comments (multi-sumber)', false, () =>
      deps.collectComments(
        { file, perSource: 6, cap: options.cap ?? 12, maxSources: 4, extra: [url] },
        context,
      ),
    );
    // topic_dossier SEBELUM build_footage: search_queries-nya men-drive pencarian footage.
    await runStage('topic_dossier (enrich topik + query footage)', false, () =>
      deps.topicDossier({ file }, context),
    );
  }

  await runStage(
    'build_footage (dossier→footage)',
    true,
    () =>
      deps.buildFootage(
        {
          file, objects: null, per: options.per ?? 2, max: options.max ?? 4, noCrop: false, profile: null,
          excludedMediaIds,
        },
        context,
      ),
    FOOTAGE_TIMEOUT_MS,
  );

  await runStage('extract_figures (tokoh — main + footage)', false, () =>
    deps.extractFigures({ file }, context),
  );

  await runStage('validate', true, () => deps.validate({ file }, context));

  await deps.summarize(file);
}

// Production deps: real AcquisitionService + the actual stage implementations.
const realDeps: RunPipelineDeps = {
  createContext: () => createStandaloneAcquisitionContext(),
  inspectSeed: async (url, context) => {
    // ponytail: intents registered here (not in runPipelineWithDeps) so the shared orchestrator stays
    // acquisition-agnostic and testable with a bare `{service:{}}` fake context.
    for (const intent of ['inspect', 'comments', 'media', 'social-card'] as const) {
      context.service.registerIntent(url, intent);
    }
    const record = await context.service.inspectPost(url);
    return { platform: record.platform, description: record.text || '', is_video: true, post: record };
  },
  writeSeed: async (file, seed) => {
    fs.writeFileSync(file, JSON.stringify(seed, null, 2), 'utf8');
  },
  traceSource: (options, context) => runTraceSource(options, context),
  collectComments: (options, context) => runCollectComments(options, context),
  topicDossier: (options, context) => runTopicDossier(options, context),
  buildFootage: (options, context) => runBuildFootage(options, context),
  extractFigures: (options, context) => runExtractFigures(options, context),
  validate: async (options, context) => {
    const ok = await runValidateContentSet(options, context);
    if (!ok) throw new Error('content-set validation failed');
  },
  summarize: async (file) => {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      ui.stage('RINGKASAN');
      console.log(`MAIN     : [${s.main.platform}] ${s.main.url}`);
      console.log(
        `FIGURES  : ${(s.figures || []).map((f) => f.name + '[' + f.type + ']').join(', ') || '(none)'}`,
      );
      console.log(
        `FOOTAGE  : ${(s.footage || []).length} (${(s.footage || []).filter((f) => f.is_video).length} video / ${(s.footage || []).filter((f) => !f.is_video).length} card)`,
      );
      console.log(`COMMENTS : ${(s.comments || []).length}`);
      console.log(`\n📄 ${file}`);
    } catch (e) {}
  },
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  runAcquisitionCli(async () => {
    const options = parseRunPipelineOptions(args);
    ui.stage('RUN PIPELINE  →  ' + options.out);
    console.log(ui.dim(`topic: ${options.url}`));
    await runPipelineWithDeps(options, realDeps);
  });
}
