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
