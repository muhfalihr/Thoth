export class PipelineStepError extends Error {
  readonly step: string;
  readonly exitStatus: number | null;
  override readonly cause: Error;

  constructor(step: string, failure: unknown) {
    const status = extractExitStatus(failure);
    const sanitizedCause = new Error(
      status == null ? 'pipeline subprocess failed' : `pipeline subprocess exited with status ${status}`,
    );
    super(`Required pipeline step failed: ${step}`, { cause: sanitizedCause });
    this.name = 'PipelineStepError';
    this.step = step;
    this.exitStatus = status;
    this.cause = sanitizedCause;
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

function extractExitStatus(failure: unknown): number | null {
  if (!failure || typeof failure !== 'object') return null;
  const status = (failure as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 0
    ? status
    : null;
}

export function runPipelineStep(policy: StepPolicy, deps: StepDeps): boolean {
  try {
    deps.execute();
    return true;
  } catch (failure) {
    if (policy.required) throw new PipelineStepError(policy.label, failure);
    deps.warn(`${policy.label}: optional step failed; continue`);
    return false;
  }
}
