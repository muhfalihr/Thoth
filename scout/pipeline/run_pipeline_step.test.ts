import assert from 'node:assert';
import { PipelineStepError, runPipelineStep } from './run_pipeline_step.ts';

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
    (error: unknown) => error instanceof PipelineStepError && error.step === 'trace_source',
  );
  assert.equal(warned, false);
}

assert.throws(
  () =>
    runPipelineStep(
      {
        label: 'build_footage',
        required: true,
      },
      {
        execute: () => {
          throw new Error('OCR failed');
        },
        warn: () => {
          throw new Error('required footage failure must not warn-and-continue');
        },
      },
    ),
  (error: unknown) => error instanceof PipelineStepError && error.step === 'build_footage',
);

assert.throws(
  () =>
    runPipelineStep(
      { label: 'trace_source', required: true },
      {
        execute: () => {
          const cause = new Error('Bearer secret-token');
          Object.assign(cause, { status: 23 });
          throw cause;
        },
        warn: () => {},
      },
    ),
  (error: unknown) =>
    error instanceof PipelineStepError &&
    error.exitStatus === 23 &&
    error.cause instanceof Error &&
    /status 23/.test(error.cause.message) &&
    !error.cause.message.includes('secret-token'),
);

// A stage killed for exceeding its time budget carries no exit status and prints
// nothing of its own, so without this the operator sees the same bare
// "Required pipeline step failed" as a genuine crash — the failure that cost a
// live acceptance run two 15-minute debugging cycles.
assert.throws(
  () =>
    runPipelineStep(
      { label: 'build_footage', required: true },
      {
        execute: () => {
          const cause = new Error('spawn ETIMEDOUT https://cdn.test/x?sig=secret-token');
          Object.assign(cause, { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' });
          throw cause;
        },
        warn: () => {},
      },
    ),
  (error: unknown) =>
    error instanceof PipelineStepError &&
    error.exitStatus === null &&
    /time budget/.test(error.message) &&
    !error.message.includes('secret-token'),
);

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
