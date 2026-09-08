// safe_runtime_diagnostic.ts — the sole definition of the strict Scout↔supervisor diagnostic
// wire contract. Every field is a compile-time enum; there is no free-form slot anywhere in this
// type, so a caller can never smuggle a URL, path, identifier, or secret through it. Scout writes
// one line per event to its own restricted stderr; the parity supervisor parses only lines that
// carry the exact prefix and only combinations in the allowlisted table below.

export const SAFE_DIAGNOSTIC_PREFIX = 'THOTH_DIAGNOSTIC ';

export type SafeRuntimeDiagnostic = {
  schema_version: 1;
  kind: 'signal' | 'terminal';
  stage: 'trace_source';
  category: 'media_candidate_discovery' | 'unknown';
  code: 'profile_discovery_exception' | 'profile_discovery_empty' | 'required_stage_failed';
};

// The only combinations of kind/stage/category/code this contract recognizes. Anything else —
// including a technically-plausible mix of otherwise-valid enum values — is rejected.
const VALID_COMBINATIONS: readonly Omit<SafeRuntimeDiagnostic, 'schema_version'>[] = [
  {
    kind: 'signal',
    stage: 'trace_source',
    category: 'media_candidate_discovery',
    code: 'profile_discovery_exception',
  },
  {
    kind: 'signal',
    stage: 'trace_source',
    category: 'media_candidate_discovery',
    code: 'profile_discovery_empty',
  },
  { kind: 'terminal', stage: 'trace_source', category: 'unknown', code: 'required_stage_failed' },
];

const EXPECTED_KEYS = ['category', 'code', 'kind', 'schema_version', 'stage'];
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_FRAMES = 32;

export function formatSafeRuntimeDiagnostic(event: SafeRuntimeDiagnostic): string {
  return `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(event)}`;
}

function parseOneFrame(raw: string): SafeRuntimeDiagnostic | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const keys = Object.keys(value).sort();
  if (keys.length !== EXPECTED_KEYS.length || keys.some((key, i) => key !== EXPECTED_KEYS[i]))
    return null;

  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== 1) return null;

  const match = VALID_COMBINATIONS.find(
    (combo) =>
      combo.kind === candidate.kind &&
      combo.stage === candidate.stage &&
      combo.category === candidate.category &&
      combo.code === candidate.code,
  );
  return match ? { schema_version: 1, ...match } : null;
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
