import assert from 'node:assert/strict';
import {
  formatSafeRuntimeDiagnostic,
  parseSafeRuntimeDiagnostics,
  SAFE_DIAGNOSTIC_PREFIX,
  type SafeRuntimeDiagnostic,
} from './safe_runtime_diagnostic.ts';

const empty: SafeRuntimeDiagnostic = {
  schema_version: 1,
  kind: 'signal',
  stage: 'trace_source',
  category: 'media_candidate_discovery',
  code: 'profile_discovery_empty',
};

const exception: SafeRuntimeDiagnostic = {
  schema_version: 1,
  kind: 'signal',
  stage: 'trace_source',
  category: 'media_candidate_discovery',
  code: 'profile_discovery_exception',
};

const terminal: SafeRuntimeDiagnostic = {
  schema_version: 1,
  kind: 'terminal',
  stage: 'trace_source',
  category: 'unknown',
  code: 'required_stage_failed',
};

// Every allowlisted combination round trips exactly.
for (const event of [empty, exception, terminal]) {
  assert.deepEqual(parseSafeRuntimeDiagnostics(formatSafeRuntimeDiagnostic(event)), {
    events: [event],
    valid: true,
  });
}

// The wire format is the fixed prefix followed by compact JSON, nothing else.
assert.equal(
  formatSafeRuntimeDiagnostic(empty),
  `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(empty)}`,
);

// Unknown keys/values are rejected without the rejected text surviving into the result.
{
  const input =
    'THOTH_DIAGNOSTIC {"schema_version":1,"kind":"signal","stage":"trace_source",' +
    '"category":"media_candidate_discovery","code":"private-token","path":"private-path"}\n';
  const parsed = parseSafeRuntimeDiagnostics(input);
  assert.deepEqual(parsed, { events: [], valid: false });
  assert.doesNotMatch(JSON.stringify(parsed), /private-token|private-path/);
}

// An extra key alongside a fully valid frame is rejected on the key count alone. This is the case
// that isolates the key allowlist: every enum value here is legal, so only the exact-key rule can
// reject it — and an admitted frame would mean the contract tolerates an unreviewed field.
{
  const input = `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify({ ...empty, path: '/private/evidence/p4.json' })}\n`;
  const parsed = parseSafeRuntimeDiagnostics(input);
  assert.deepEqual(parsed, { events: [], valid: false });
  assert.doesNotMatch(JSON.stringify(parsed), /private|evidence|p4/);
}

// A missing required key is rejected the same way as an unknown extra key.
{
  const { schema_version, ...withoutVersion } = empty as unknown as Record<string, unknown>;
  void schema_version;
  const input = `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(withoutVersion)}\n`;
  assert.deepEqual(parseSafeRuntimeDiagnostics(input), { events: [], valid: false });
}

// Malformed JSON after the prefix.
assert.deepEqual(parseSafeRuntimeDiagnostics(`${SAFE_DIAGNOSTIC_PREFIX}{not json}\n`), {
  events: [],
  valid: false,
});

// A non-object JSON value after the prefix.
assert.deepEqual(parseSafeRuntimeDiagnostics(`${SAFE_DIAGNOSTIC_PREFIX}null\n`), {
  events: [],
  valid: false,
});
assert.deepEqual(parseSafeRuntimeDiagnostics(`${SAFE_DIAGNOSTIC_PREFIX}[1,2,3]\n`), {
  events: [],
  valid: false,
});

// schema_version must be the literal number 1, not a look-alike string.
assert.deepEqual(
  parseSafeRuntimeDiagnostics(
    `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify({ ...empty, schema_version: '1' })}\n`,
  ),
  { events: [], valid: false },
);

// Every combination outside the allowlisted table is rejected, whichever field is wrong.
const invalidCombinations: SafeRuntimeDiagnostic[] = [
  { ...empty, stage: 'other_stage' as SafeRuntimeDiagnostic['stage'] },
  { ...empty, category: 'unknown' },
  { ...terminal, category: 'media_candidate_discovery' },
  { ...terminal, code: 'profile_discovery_empty' as SafeRuntimeDiagnostic['code'] },
  { ...exception, kind: 'terminal' },
];
for (const invalid of invalidCombinations) {
  const input = `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(invalid)}\n`;
  assert.deepEqual(parseSafeRuntimeDiagnostics(input), { events: [], valid: false });
}

// Duplicate semantic events invalidate the whole frame set rather than deduping.
{
  const line = `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(empty)}\n`;
  assert.deepEqual(parseSafeRuntimeDiagnostics(line + line), { events: [], valid: false });
}

// More than 32 prefixed frames is rejected outright. With only three allowlisted combinations a
// 33-frame input is necessarily duplicated too, so this outcome is over-determined; the cap's real
// job is bounding parse work on a hostile stderr, not producing a distinguishable verdict.
{
  const line = `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(empty)}\n`;
  assert.deepEqual(parseSafeRuntimeDiagnostics(line.repeat(33)), { events: [], valid: false });
}

// An input over 1 MiB is rejected even when it carries one otherwise-valid frame.
{
  const padding = 'x'.repeat(1024 * 1024 + 1);
  const input = `${padding}\n${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(empty)}\n`;
  assert.deepEqual(parseSafeRuntimeDiagnostics(input), { events: [], valid: false });
}

// CRLF-terminated frames parse the same as LF-terminated ones.
assert.deepEqual(
  parseSafeRuntimeDiagnostics(`${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(empty)}\r\n`),
  {
    events: [empty],
    valid: true,
  },
);

// Ordinary, non-prefixed stderr lines are ignored rather than invalidating the parse.
assert.deepEqual(
  parseSafeRuntimeDiagnostics(
    `some ordinary stderr line\n${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(empty)}\nanother line\n`,
  ),
  { events: [empty], valid: true },
);

// URL/path/secret canaries in ignored ordinary lines never reach the parsed result.
{
  const input =
    `leaked https://cdn.example.test/video.mp4?sessionid=abc123 secret=Bearer-xyz\n` +
    `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(empty)}\n`;
  const parsed = parseSafeRuntimeDiagnostics(input);
  assert.deepEqual(parsed, { events: [empty], valid: true });
  assert.doesNotMatch(JSON.stringify(parsed), /cdn\.example|sessionid|abc123|Bearer-xyz/);
}

// A clean input with no frames at all is valid and empty.
assert.deepEqual(parseSafeRuntimeDiagnostics(''), { events: [], valid: true });
assert.deepEqual(parseSafeRuntimeDiagnostics('no diagnostic lines here\n'), {
  events: [],
  valid: true,
});

console.log('ok safe_runtime_diagnostic');
