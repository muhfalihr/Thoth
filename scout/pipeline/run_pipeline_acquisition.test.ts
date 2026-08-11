// scout/pipeline/run_pipeline_acquisition.test.ts
import assert from 'node:assert/strict';
import { runPipelineWithDeps } from './run_pipeline.ts';

const contexts = new Set<unknown>();
const stages: string[] = [];
const context = { runId: 'test', service: {} } as any;
await runPipelineWithDeps(
  { url: 'https://www.instagram.com/p/ABC/', out: 'set.json', noComments: false },
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
console.log('ok run_pipeline_acquisition');
