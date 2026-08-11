export class PipelineStepError extends Error {
  readonly step: string;
  readonly exitStatus: number | null;
  override readonly cause: Error;

  constructor(step: string, failure: unknown) {
    const status = extractExitStatus(failure);
    let reason: string;
    let sanitizedCause: Error;
    if (status != null) {
      reason = `subprocess exited with status ${status}`;
      sanitizedCause = new Error(`pipeline ${reason}`);
    } else if (wasKilled(failure)) {
      // A killed subprocess reports no exit status and has already been denied the
      // chance to print its own error, so name the kill here or the operator sees
      // an unexplained wall where a time budget was.
      reason = 'subprocess exceeded its time budget';
      sanitizedCause = new Error(`pipeline ${reason}`);
    } else if (failure instanceof Error) {
      // In-process stage failure (the only kind possible for non-subprocess steps, including a
      // timed-out stage): nothing else prints this error, so the wrapper must carry the real
      // message/stack through -- sanitized to just those two fields, not the whole error object.
      reason = failure.message;
      sanitizedCause = new Error(failure.message);
      sanitizedCause.stack = failure.stack;
    } else {
      reason = 'step failed';
      sanitizedCause = new Error(`pipeline ${reason}`);
    }
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
  timeoutMs?: number;
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

// Bounds a stage to policy.timeoutMs so a hung in-process navigation/call can't hang the whole
// pipeline forever. Clears the timer on both outcomes so a won race doesn't keep the process alive.
function withTimeout(promise: Promise<void>, label: string, timeoutMs: number | undefined): Promise<void> {
  if (!timeoutMs) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

export async function runPipelineStep(policy: StepPolicy, deps: StepDeps): Promise<boolean> {
  try {
    await withTimeout(Promise.resolve(deps.execute()), policy.label, policy.timeoutMs);
    return true;
  } catch (failure) {
    if (policy.required) throw new PipelineStepError(policy.label, failure);
    deps.warn(`${policy.label}: optional step failed; continue`);
    return false;
  }
}
