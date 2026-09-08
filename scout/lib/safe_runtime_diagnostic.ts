// safe_runtime_diagnostic.ts — the sole definition of the strict Scout↔supervisor diagnostic
// wire contract. Every field is a compile-time enum; there is no free-form slot anywhere in this
// type, so a caller can never smuggle a URL, path, identifier, or secret through it. Scout writes
// one line per event to its own restricted stderr; the parity supervisor parses only lines that
// carry the exact prefix and only combinations in the allowlisted table below.

export const SAFE_DIAGNOSTIC_PREFIX = 'THOTH_DIAGNOSTIC ';

// A discriminated union of the three approved events, not a cross product of four independent
// enums: a mix such as terminal/media_candidate_discovery is legal in every field and still is
// not an event this contract defines, so the type itself has to refuse it.
export type SafeRuntimeDiagnostic =
  | {
      schema_version: 1;
      kind: 'signal';
      stage: 'trace_source';
      category: 'media_candidate_discovery';
      code: 'profile_discovery_exception';
    }
  | {
      schema_version: 1;
      kind: 'signal';
      stage: 'trace_source';
      category: 'media_candidate_discovery';
      code: 'profile_discovery_empty';
    }
  | {
      schema_version: 1;
      kind: 'terminal';
      stage: 'trace_source';
      category: 'unknown';
      code: 'required_stage_failed';
    };

// The runtime half of that union. Both the formatter and the parser answer with an element of
// this table rather than with the object they were handed, so no caller-owned value is ever
// serialized or returned.
const VALID_EVENTS: readonly SafeRuntimeDiagnostic[] = [
  {
    schema_version: 1,
    kind: 'signal',
    stage: 'trace_source',
    category: 'media_candidate_discovery',
    code: 'profile_discovery_exception',
  },
  {
    schema_version: 1,
    kind: 'signal',
    stage: 'trace_source',
    category: 'media_candidate_discovery',
    code: 'profile_discovery_empty',
  },
  {
    schema_version: 1,
    kind: 'terminal',
    stage: 'trace_source',
    category: 'unknown',
    code: 'required_stage_failed',
  },
];

const EXPECTED_KEYS = ['category', 'code', 'kind', 'schema_version', 'stage'];
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_FRAMES = 32;

// Reduce any value to the table entry it claims to be, or to null. A caller-owned object is only
// ever read from here; what comes back is the canonical entry, so an extra property, a hidden
// `toJSON`, a getter, or an inherited member has nothing left to influence.
function canonicalize(value: unknown): SafeRuntimeDiagnostic | null {
  if (typeof value !== 'object' || value === null) return null;

  // A prototype other than the plain-object one can carry a `toJSON` or accessors the formatter
  // would otherwise inherit; JSON.parse never produces one, so nothing legitimate is lost.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  // Own property NAMES rather than keys: a non-enumerable `toJSON` is invisible to Object.keys
  // and is still both an extra property and a way to replace what gets serialized.
  const names = Object.getOwnPropertyNames(value).sort();
  if (names.length !== EXPECTED_KEYS.length || names.some((name, i) => name !== EXPECTED_KEYS[i]))
    return null;

  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== 1) return null;
  return (
    VALID_EVENTS.find(
      (event) =>
        event.kind === candidate.kind &&
        event.stage === candidate.stage &&
        event.category === candidate.category &&
        event.code === candidate.code,
    ) ?? null
  );
}

export function formatSafeRuntimeDiagnostic(event: SafeRuntimeDiagnostic): string {
  const canonical = canonicalize(event);
  // Fail before a prefixed frame exists: a half-written frame on the supervisor's stream is
  // worse than no frame. The message is fixed so the rejected value cannot leak through it.
  if (!canonical) throw new TypeError('safe runtime diagnostic rejected by the closed contract');
  return `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify({ ...canonical })}`;
}

export type DiagnosticSink = (event: SafeRuntimeDiagnostic) => void;

// Production sink: one frame per line on the emitting process's own stderr. For a parity reference
// that stream is already a restricted file the supervisor owns, so the frame needs no new artifact,
// no reservation, and no cleanup rule of its own. Tests inject a collector instead.
export const defaultDiagnosticSink: DiagnosticSink = (event) => {
  console.error(formatSafeRuntimeDiagnostic(event));
};

// The only way emission sites should call a sink. A diagnostic describes what a run did; it must
// never become what the run did instead, so a closed stream, a full disk, or a sink rejecting a
// malformed event all end here rather than replacing the caller's return value or its failure.
// The suppressed error is deliberately not logged: reporting it would re-enter the stream that
// just failed, and its text is unbounded caller-owned data this contract exists to keep out.
export function emitSafeRuntimeDiagnostic(
  sink: DiagnosticSink,
  event: SafeRuntimeDiagnostic,
): void {
  try {
    sink(event);
  } catch {
    // Intentionally empty; see above.
  }
}

function parseOneFrame(raw: string): SafeRuntimeDiagnostic | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  // Same closed check the formatter applies: parsed input gets no weaker validation than a
  // caller in this process does.
  return canonicalize(value);
}

export function parseSafeRuntimeDiagnostics(text: string): {
  events: SafeRuntimeDiagnostic[];
  valid: boolean;
} {
  const invalid = { events: [], valid: false };
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) return invalid;

  const frames = text.split(/\r?\n/).filter((line) => line.startsWith(SAFE_DIAGNOSTIC_PREFIX));
  if (frames.length > MAX_FRAMES) return invalid;

  const events: SafeRuntimeDiagnostic[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const event = parseOneFrame(frame.slice(SAFE_DIAGNOSTIC_PREFIX.length));
    if (!event) return invalid;
    const identity = `${event.kind}/${event.stage}/${event.category}/${event.code}`;
    if (seen.has(identity)) return invalid;
    seen.add(identity);
    events.push(event);
  }
  return { events, valid: true };
}
