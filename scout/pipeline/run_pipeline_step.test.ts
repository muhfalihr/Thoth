import assert from 'node:assert';
import {
  PipelineStepError,
  runPipelineStep,
} from './run_pipeline_step.ts';

{
  let warned = false;
  assert.throws(
    () =>
      runPipelineStep(
        { label: 'trace_source', required: true },
        {
          execute: () => {
            throw new Error('exit 1');
          },
          warn: () => {
            warned = true;
          },
        },
      ),
    (error: unknown) =>
      error instanceof PipelineStepError &&
      error.step === 'trace_source',
  );
  assert.equal(warned, false);
}

{
  let warning = '';
  const ok = runPipelineStep(
    { label: 'comments', required: false },
    {
      execute: () => {
        throw new Error('exit 1');
      },
      warn: (message) => {
        warning = message;
      },
    },
  );
  assert.equal(ok, false);
  assert.match(warning, /comments.*optional.*continue/i);
}

{
  let calls = 0;
  const ok = runPipelineStep(
    { label: 'validate', required: true },
    {
      execute: () => {
        calls++;
      },
      warn: () => {
        throw new Error('must not warn');
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(calls, 1);
}
