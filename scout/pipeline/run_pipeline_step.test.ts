import assert from 'node:assert';
import {
  isRequiredPipelineStep,
  PipelineStepError,
  runPipelineStep,
} from './run_pipeline_step.ts';

assert.equal(isRequiredPipelineStep('trace_source.ts'), true);
assert.equal(isRequiredPipelineStep('build_footage.ts'), true);
assert.equal(isRequiredPipelineStep('validate_content_set.ts'), true);
assert.equal(isRequiredPipelineStep('collect_comments.ts'), false);

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

assert.throws(
  () =>
    runPipelineStep(
      {
        label: 'build_footage',
        required: isRequiredPipelineStep('build_footage.ts'),
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
  (error: unknown) =>
    error instanceof PipelineStepError &&
    error.step === 'build_footage',
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
