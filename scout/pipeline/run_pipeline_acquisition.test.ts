// scout/pipeline/run_pipeline_acquisition.test.ts
import assert from 'node:assert/strict';
import { parseRunPipelineOptions, runPipelineWithDeps } from './run_pipeline.ts';

const contexts = new Set<unknown>();
const stages: string[] = [];
const context = { runId: 'test', service: {} } as any;
await runPipelineWithDeps(
  {
    url: 'https://www.instagram.com/p/ABC/',
    out: 'set.json',
    noComments: false,
    useInputAsMain: false,
    mainCoverageTarget: 0.60,
  },
  {
    createContext: async () => context,
    inspectSeed: async (_url, received) => {
      contexts.add(received);
      return { title: 'caption', description: 'caption', platform: 'instagram', is_video: true };
    },
    packageForcedMain: async () => {
      throw new Error('legacy runs must not package forced main footage');
    },
    analyzeMainOcr: async () => {
      throw new Error('legacy runs get main OCR from trace_source');
    },
    writeSeed: async () => {},
    traceSource: async (_options, received) => {
      stages.push('trace');
      contexts.add(received);
    },
    collectComments: async (_options, received) => {
      stages.push('comments');
      contexts.add(received);
    },
    topicDossier: async (_options, received) => {
      stages.push('dossier');
      contexts.add(received);
    },
    buildFootage: async (_options, received) => {
      stages.push('footage');
      contexts.add(received);
    },
    packageExternalFootage: async () => {
      throw new Error('legacy runs must not package planned external footage');
    },
    extractFigures: async (_options, received) => {
      stages.push('figures');
      contexts.add(received);
    },
    validate: async (_options, received) => {
      stages.push('validate');
      contexts.add(received);
    },
    summarize: async () => {},
  },
);
assert.deepEqual(stages, ['trace', 'comments', 'dossier', 'footage', 'figures', 'validate']);
assert.equal(contexts.size, 1);

const forcedStages: string[] = [];
const forcedContext = { runId: 'forced-test', service: {} } as any;
let forcedInspectCalls = 0;
let forcedPackageCalls = 0;
const previousFfmpeg = process.env.THOTH_FFMPEG;
const previousFfprobe = process.env.THOTH_FFPROBE;
process.env.THOTH_FFMPEG = process.execPath;
process.env.THOTH_FFPROBE = process.execPath;
try {
  await runPipelineWithDeps(
    {
      url: 'https://www.instagram.com/p/FORCED/',
      out: 'set.json',
      noComments: true,
      useInputAsMain: true,
      mainCoverageTarget: 0.75,
    },
    {
      createContext: async () => forcedContext,
      inspectSeed: async () => {
        forcedInspectCalls += 1;
        return {
          title: 'caption', description: 'caption', platform: 'instagram', is_video: true,
          post: {
            canonical_url: 'https://www.instagram.com/p/FORCED/', platform: 'instagram', post_id: 'FORCED',
            owner_handle: 'owner', text: 'caption', media: [],
            outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
          },
        };
      },
      packageForcedMain: async (input, received) => {
        forcedPackageCalls += 1;
        assert.equal(received, forcedContext);
        assert.equal(input.post.post_id, 'FORCED');
        return {
          descriptor: { mode: 'forced_url_pool', package_manifest: 'main-footage/package.json', coverage_target: 0.75 },
          excludedMediaIds: ['FORCED:0'],
        };
      },
      writeSeed: async (_file, seed) => {
        assert.equal(seed.main_footage?.mode, 'forced_url_pool');
      },
      // Nothing else analyzes main here: trace_source is skipped, and both the lint and Rust's
      // validate_main_ocr reject a main without an ocr_status.
      analyzeMainOcr: async (options, received) => {
        forcedStages.push('main_ocr');
        assert.equal(received, forcedContext);
        assert.equal(options.file, 'set.json');
      },
      traceSource: async () => forcedStages.push('trace'),
      collectComments: async () => forcedStages.push('comments'),
      topicDossier: async () => forcedStages.push('dossier'),
      buildFootage: async (options) => {
        forcedStages.push('footage');
        assert.deepEqual(options.excludedMediaIds, ['FORCED:0']);
      },
      packageExternalFootage: async (options, received) => {
        forcedStages.push('external');
        assert.equal(received, forcedContext);
        assert.equal(options.contentSetPath, 'set.json');
        assert.deepEqual(options.excludedMediaIds, ['FORCED:0']);
      },
      extractFigures: async () => forcedStages.push('figures'),
      validate: async () => forcedStages.push('validate'),
      summarize: async () => {},
    } as any,
  );
} finally {
  if (previousFfmpeg === undefined) delete process.env.THOTH_FFMPEG;
  else process.env.THOTH_FFMPEG = previousFfmpeg;
  if (previousFfprobe === undefined) delete process.env.THOTH_FFPROBE;
  else process.env.THOTH_FFPROBE = previousFfprobe;
}
assert.deepEqual(forcedStages, ['main_ocr', 'footage', 'external', 'figures', 'validate']);
assert.equal(forcedInspectCalls, 1);
assert.equal(forcedPackageCalls, 1);

const parsedDefault = parseRunPipelineOptions(['https://www.instagram.com/p/ABC/']);
assert.equal(parsedDefault.useInputAsMain, false);
assert.equal(parsedDefault.mainCoverageTarget, 0.60);

const parsedForced = parseRunPipelineOptions([
  'https://www.instagram.com/p/ABC/',
  '--use-input-as-main',
  '--main-coverage-target',
  '0.75',
]);
assert.equal(parsedForced.useInputAsMain, true);
assert.equal(parsedForced.mainCoverageTarget, 0.75);

for (const mainCoverageTarget of [0.59, 1.01, Number.NaN, undefined]) {
  let createContextCalls = 0;
  await assert.rejects(
    () =>
      runPipelineWithDeps(
        {
          url: 'https://www.instagram.com/p/ABC/',
          out: 'set.json',
          noComments: true,
          useInputAsMain: false,
          mainCoverageTarget: mainCoverageTarget as number,
        },
        {
          createContext: async () => {
            createContextCalls += 1;
            return context;
          },
        } as any,
      ),
    { message: 'invalid_main_coverage_target' },
  );
  assert.equal(createContextCalls, 0);
}
console.log('ok run_pipeline_acquisition');
