export class PipelineStepError extends Error {
  readonly step: string;

  constructor(step: string) {
    super(`Required pipeline step failed: ${step}`);
    this.name = 'PipelineStepError';
    this.step = step;
  }
}

type StepPolicy = {
  label: string;
  required: boolean;
};

type StepDeps = {
  execute: () => void;
  warn: (message: string) => void;
};

const REQUIRED_PIPELINE_STEPS = new Set([
  'trace_source.ts',
  'build_footage.ts',
  'validate_content_set.ts',
]);

export function isRequiredPipelineStep(script: string): boolean {
  return REQUIRED_PIPELINE_STEPS.has(script);
}

export function runPipelineStep(policy: StepPolicy, deps: StepDeps): boolean {
  try {
    deps.execute();
    return true;
  } catch {
    if (policy.required) throw new PipelineStepError(policy.label);
    deps.warn(`${policy.label}: optional step failed; continue`);
    return false;
  }
}
