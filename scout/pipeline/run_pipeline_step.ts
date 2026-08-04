export class PipelineStepError extends Error {
  readonly step: string;
  readonly exitStatus: number | null;
  override readonly cause: Error;

  constructor(step: string, failure: unknown) {
    const status = extractExitStatus(failure);
    // A killed subprocess reports no exit status and has already been denied the
    // chance to print its own error, so name the kill here or the operator sees
    // an unexplained wall where a time budget was.
    const reason =
      status == null
        ? wasKilled(failure)
          ? 'subprocess exceeded its time budget'
          : 'subprocess failed'
        : `subprocess exited with status ${status}`;
    const sanitizedCause = new Error(`pipeline ${reason}`);
    super(`Required pipeline step failed: ${step} (${reason})`, { cause: sanitizedCause });
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
  execute: () => Promise<void> | void;
  warn: (message: string) => void;
};

function wasKilled(failure: unknown): boolean {
  if (!failure || typeof failure !== 'object') return false;
  const { code, killed, signal } = failure as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return code === 'ETIMEDOUT' || killed === true || typeof signal === 'string';
}

function extractExitStatus(failure: unknown): number | null {
  if (!failure || typeof failure !== 'object') return null;
  const status = (failure as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 0 ? status : null;
}

export async function runPipelineStep(policy: StepPolicy, deps: StepDeps): Promise<boolean> {
  try {
    await deps.execute();
    return true;
  } catch (failure) {
    if (policy.required) throw new PipelineStepError(policy.label, failure);
    deps.warn(`${policy.label}: optional step failed; continue`);
    return false;
  }
}
