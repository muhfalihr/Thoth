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

// Every combination outside the allowlisted table is rejected, whichever field is wrong. These
// are deliberately untyped: the discriminated union already refuses them at compile time, so
// annotating them as diagnostics would be a type error rather than a wire-format test.
const invalidCombinations: Record<string, unknown>[] = [
  { ...empty, stage: 'other_stage' },
  { ...empty, category: 'unknown' },
  { ...terminal, category: 'media_candidate_discovery' },
  { ...terminal, code: 'profile_discovery_empty' },
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

// --- Formatter input is validated at runtime, not only by the type checker. ---
// The static type is a closed union, but a structurally typed variable, a runtime cast, or a
// value crossing a module boundary all reach the formatter unchecked. Since the formatter is
// what writes to a stream the supervisor later parses, it re-checks the object itself.

const rejected = (value: unknown) =>
  assert.throws(
    () => formatSafeRuntimeDiagnostic(value as SafeRuntimeDiagnostic),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      // The rejected value is never echoed back — not in the message, not in a property.
      assert.doesNotMatch(
        `${(error as TypeError).message}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`,
        /private|canary|evidence|sessionid|https?:/i,
      );
      return true;
    },
  );

// An extra property riding along on a structurally typed variable is not serialized.
rejected({ ...empty, path: '/private/evidence/p4.json' });

// A combination made of otherwise-legal enum values is still not one of the three events.
rejected({
  schema_version: 1,
  kind: 'terminal',
  stage: 'trace_source',
  category: 'media_candidate_discovery',
  code: 'profile_discovery_empty',
});

// An invalid schema version, including the boolean that `== 1` would have admitted.
rejected({ ...empty, schema_version: 2 });
rejected({ ...empty, schema_version: '1' });
rejected({ ...empty, schema_version: true });

// Missing key.
rejected({
  kind: 'signal',
  stage: 'trace_source',
  category: 'media_candidate_discovery',
  code: 'profile_discovery_empty',
});

// Non-plain objects: null, arrays, primitives, and class instances whose prototype could
// carry behavior the formatter would otherwise inherit.
rejected(null);
rejected(undefined);
rejected('THOTH_DIAGNOSTIC {}');
rejected([empty]);
{
  class Diagnostic {
    schema_version = 1 as const;
    kind = 'signal' as const;
    stage = 'trace_source' as const;
    category = 'media_candidate_discovery' as const;
    code = 'profile_discovery_empty' as const;
    toJSON() {
      return { canary: 'https://private.example.test/evidence' };
    }
  }
  rejected(new Diagnostic());
}

// A hostile `toJSON` is the direct bypass of a closed contract: `JSON.stringify` would call it
// and emit whatever it returns, so the formatter must never hand the caller's object to it.
rejected({ ...empty, toJSON: () => ({ canary: 'sessionid=private' }) });
{
  // Same attack with the hook hidden from `Object.keys`.
  const hostile: Record<string, unknown> = { ...empty };
  Object.defineProperty(hostile, 'toJSON', {
    value: () => ({ canary: 'sessionid=private' }),
    enumerable: false,
  });
  rejected(hostile);
}

// Valid events survive all of that and still serialize canonically, in a fixed key order that
// does not depend on how the caller happened to build the object.
{
  const shuffled = {
    code: 'profile_discovery_empty',
    category: 'media_candidate_discovery',
    stage: 'trace_source',
    kind: 'signal',
    schema_version: 1,
  } as SafeRuntimeDiagnostic;
  assert.equal(formatSafeRuntimeDiagnostic(shuffled), formatSafeRuntimeDiagnostic(empty));
  assert.deepEqual(parseSafeRuntimeDiagnostics(formatSafeRuntimeDiagnostic(shuffled)), {
    events: [empty],
    valid: true,
  });
}

// --- Validation is total: caller-owned code never runs, and never escapes. ---
// Reading a field is not a neutral act. A getter runs caller code, and a Proxy runs caller code
// for the reflection the validator itself performs. Either one could throw an error carrying
// arbitrary text out of the formatter, which is the same leak the closed contract exists to
// prevent — only routed through an exception instead of through a frame.

// An extra symbol key is invisible to string-key reflection and is still an extra own property.
rejected({ ...empty, [Symbol('extra')]: 'canary-symbol-value' });

// A throwing getter is rejected on the descriptor alone; the getter is never called.
{
  let invoked = 0;
  const hostile: Record<string, unknown> = { ...empty };
  Object.defineProperty(hostile, 'schema_version', {
    get() {
      invoked += 1;
      throw new Error('GETTER_CANARY https://private.example.test/evidence');
    },
    enumerable: true,
    configurable: true,
  });
  rejected(hostile);
  assert.equal(invoked, 0);
}

// A setter-only accessor is a data-shaped lie: reading it yields undefined rather than a value.
{
  const hostile: Record<string, unknown> = { ...empty };
  Object.defineProperty(hostile, 'code', {
    set(_value: unknown) {
      /* never invoked */
    },
    enumerable: true,
    configurable: true,
  });
  rejected(hostile);
}

// Every reflection step the validator performs is a trap a Proxy can throw from.
for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
  const explode = () => {
    throw new Error(`PROXY_CANARY sessionid=private ${trap}`);
  };
  rejected(new Proxy({ ...empty }, { [trap]: explode }));
}

// Rejection produces no frame at all: a partially written prefixed line on the supervisor's
// stream would parse as a diagnostic that nothing ever emitted.
{
  const hostile = new Proxy(
    { ...empty },
    {
      ownKeys() {
        throw new Error('PROXY_CANARY');
      },
    },
  );
  let produced: string | undefined;
  try {
    produced = formatSafeRuntimeDiagnostic(hostile as SafeRuntimeDiagnostic);
  } catch {
    produced = undefined;
  }
  assert.equal(produced, undefined);
}

// After all of that, the three approved events are unaffected and still round-trip canonically.
for (const event of [empty, exception, terminal]) {
  const frame = formatSafeRuntimeDiagnostic(event);
  assert.ok(frame.startsWith(SAFE_DIAGNOSTIC_PREFIX));
  assert.deepEqual(parseSafeRuntimeDiagnostics(frame), { events: [event], valid: true });
}

// --- Caller side effects cannot reach the emitted bytes. ---
// Catching a hostile trap's exception is not enough. A trap can answer honestly and still mutate
// shared state on its way out, and everything the formatter would touch afterwards is reachable
// from that state: an inherited `toJSON`, the global `JSON.stringify`, a setter on
// `Object.prototype` for one of the allowed keys. Once caller code has run, the frame has to be
// chosen from what this module serialized at startup, not built.

const CANONICAL = [empty, exception, terminal].map(
  (event) => `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(event)}`,
);

const restoreProperty = (
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void => {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  assert.equal(Reflect.deleteProperty(target, key), true);
};

// A trap that installs `Object.prototype.toJSON` and then returns the five real keys.
{
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const keys = Reflect.ownKeys({ ...empty });
  const hostile = new Proxy(
    { ...empty },
    {
      ownKeys() {
        Object.defineProperty(Object.prototype, 'toJSON', {
          value: () => ({ canary: 'PROXY_SIDE_EFFECT' }),
          configurable: true,
          writable: true,
        });
        return keys;
      },
    },
  );
  try {
    const frame = formatSafeRuntimeDiagnostic(hostile as SafeRuntimeDiagnostic);
    assert.equal(frame, CANONICAL[0]);
    assert.doesNotMatch(frame, /canary|side_effect/i);
  } finally {
    restoreProperty(Object.prototype, 'toJSON', original);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'), original);
}

// A trap that replaces the global serializer.
{
  const original = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  const keys = Reflect.ownKeys({ ...exception });
  const hostile = new Proxy(
    { ...exception },
    {
      ownKeys() {
        JSON.stringify = (() => '{"canary":"JSON_STRINGIFY_SIDE_EFFECT"}') as typeof JSON.stringify;
        return keys;
      },
    },
  );
  try {
    const frame = formatSafeRuntimeDiagnostic(hostile as SafeRuntimeDiagnostic);
    assert.equal(frame, CANONICAL[1]);
    assert.doesNotMatch(frame, /canary|side_effect/i);
  } finally {
    restoreProperty(JSON, 'stringify', original);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(JSON, 'stringify'), original);
}

// A trap that installs an allowed-key accessor on `Object.prototype`: a plain `{}` accumulator
// would run that setter instead of storing the value, which both executes caller code and lets
// the inherited getter answer in its place.
{
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'code');
  let invoked = 0;
  const keys = Reflect.ownKeys({ ...terminal });
  const hostile = new Proxy(
    { ...terminal },
    {
      ownKeys() {
        Object.defineProperty(Object.prototype, 'code', {
          set(_value: unknown) {
            invoked += 1;
          },
          get() {
            return 'SETTER_SIDE_EFFECT_CANARY';
          },
          configurable: true,
        });
        return keys;
      },
    },
  );
  try {
    const frame = formatSafeRuntimeDiagnostic(hostile as SafeRuntimeDiagnostic);
    assert.equal(frame, CANONICAL[2]);
    assert.doesNotMatch(frame, /canary|side_effect/i);
    assert.equal(invoked, 0);
  } finally {
    restoreProperty(Object.prototype, 'code', original);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'code'), original);
}

// A trap that swaps out reflection the validator has not performed yet, so that the remaining
// steps would describe a different event. The validator captured its reflection at import, so the
// swap changes nothing; reading `Reflect` mid-walk would let a caller choose which frame is sent.
{
  const original = Object.getOwnPropertyDescriptor(Reflect, 'getOwnPropertyDescriptor');
  const keys = Reflect.ownKeys({ ...empty });
  const hostile = new Proxy(
    { ...empty },
    {
      ownKeys() {
        Reflect.getOwnPropertyDescriptor = ((_target: object, key: string) => ({
          value: (terminal as unknown as Record<string, unknown>)[key],
          writable: true,
          enumerable: true,
          configurable: true,
        })) as typeof Reflect.getOwnPropertyDescriptor;
        return keys;
      },
    },
  );
  try {
    assert.equal(formatSafeRuntimeDiagnostic(hostile as SafeRuntimeDiagnostic), CANONICAL[0]);
  } finally {
    restoreProperty(Reflect, 'getOwnPropertyDescriptor', original);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Reflect, 'getOwnPropertyDescriptor'), original);
}

// A trap can replace the rejection constructor before returning an invalid key set. Rejection
// must use the constructor captured by the module before caller code ran, not the global binding
// that exists after classification.
{
  const original = Object.getOwnPropertyDescriptor(globalThis, 'TypeError');
  assert.ok(original?.value);
  const OriginalTypeError = original.value as TypeErrorConstructor;
  const ReplacementTypeError = (() =>
    new Error(
      'TYPEERROR_SIDE_EFFECT_CANARY https://private.example.test/evidence',
    )) as unknown as TypeErrorConstructor;
  const target = { ...empty, extra: 'force-rejection' };
  const hostile = new Proxy(target, {
    ownKeys() {
      Object.defineProperty(globalThis, 'TypeError', {
        ...original,
        value: ReplacementTypeError,
      });
      return Reflect.ownKeys(target);
    },
  });

  let thrown: unknown;
  try {
    formatSafeRuntimeDiagnostic(hostile as unknown as SafeRuntimeDiagnostic);
  } catch (error) {
    thrown = error;
  } finally {
    restoreProperty(globalThis, 'TypeError', original);
  }

  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'TypeError'), original);
  assert.ok(thrown instanceof OriginalTypeError);
  assert.equal(
    (thrown as Error).message,
    'safe runtime diagnostic rejected by the closed contract',
  );
  assert.notStrictEqual((thrown as Error).constructor, ReplacementTypeError);
  assert.doesNotMatch(
    `${(thrown as Error).name}:${(thrown as Error).message}`,
    /canary|side_effect|private|evidence|https?:/i,
  );
}

// --- A parsed event is a copy, not a handle on the allowlist. ---
// The parser hands its result to callers who may keep, store, or edit it. If that object were the
// module's own table entry, a single assignment would redefine what this contract accepts and
// emits for the rest of the process.
for (const event of [empty, exception, terminal]) {
  const frame = formatSafeRuntimeDiagnostic(event);

  const first = parseSafeRuntimeDiagnostics(frame);
  assert.equal(first.valid, true);
  (first.events[0] as unknown as Record<string, unknown>).code = 'CALLER_MUTATION_CANARY';

  // The table is untouched: the same frame still parses to the same canonical event,
  const second = parseSafeRuntimeDiagnostics(frame);
  assert.deepEqual(second, { events: [event], valid: true });
  // the mutated object is not an approved event any more,
  rejected(first.events[0]);
  // and the formatter still answers with the canonical frame.
  assert.equal(formatSafeRuntimeDiagnostic(event), frame);

  // Every parse yields its own object, so no two callers share one mutable event.
  const third = parseSafeRuntimeDiagnostics(frame);
  assert.notStrictEqual(second.events[0], third.events[0]);
  assert.notStrictEqual(second.events[0], event);
  assert.deepEqual(third.events[0], event);
}

console.log('ok safe_runtime_diagnostic');
