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
