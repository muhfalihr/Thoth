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

// Captured at module initialization. Validation inspects caller-controlled objects, and a Proxy
// trap gets to run caller code in the middle of that inspection; reaching for these through the
// global objects afterwards would let the trap swap them out between two validation steps.
const getPrototypeOf = Reflect.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const objectPrototype = Object.prototype;

// The runtime half of that union. These objects never leave the module: callers get a fresh copy
// or a precomputed string, so nobody holds a mutable alias of the allowlist. Freezing is defense
// in depth on top of that, not the protection itself.
const EVENT_DEFINITIONS: readonly SafeRuntimeDiagnostic[] = Object.freeze([
  Object.freeze<SafeRuntimeDiagnostic>({
    schema_version: 1,
    kind: 'signal',
    stage: 'trace_source',
    category: 'media_candidate_discovery',
    code: 'profile_discovery_exception',
  }),
  Object.freeze<SafeRuntimeDiagnostic>({
    schema_version: 1,
    kind: 'signal',
    stage: 'trace_source',
    category: 'media_candidate_discovery',
    code: 'profile_discovery_empty',
  }),
  Object.freeze<SafeRuntimeDiagnostic>({
    schema_version: 1,
    kind: 'terminal',
    stage: 'trace_source',
    category: 'unknown',
    code: 'required_stage_failed',
  }),
]);

// Serialized once at startup, before any caller can install an inherited `toJSON`, replace
// `JSON.stringify`, or otherwise reach the serializer. A successful format returns one of these
// strings unchanged, so a hostile trap has nothing left to influence: the bytes already exist.
const CANONICAL_FRAMES: readonly string[] = Object.freeze(
  EVENT_DEFINITIONS.map((event) => `${SAFE_DIAGNOSTIC_PREFIX}${JSON.stringify(event)}`),
);

const EXPECTED_KEYS = ['category', 'code', 'kind', 'schema_version', 'stage'];
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_FRAMES = 32;
const REJECTED = -1;

function isExpectedKey(key: PropertyKey): key is string {
  // An indexed loop rather than `includes`: caller code may have run moments earlier, and
  // `Array.prototype` is as writable as any other shared object.
  for (let i = 0; i < EXPECTED_KEYS.length; i += 1) {
    if (EXPECTED_KEYS[i] === key) return true;
  }
  return false;
}

// Decide which table entry a value claims to be, as an INDEX rather than as an object. Handing
// back an index is what keeps caller-controlled reflection out of the result: what the caller
// finally receives is built from module state after this returns, never from the value inspected
// here and never from anything a trap arranged while it ran.
function classify(value: unknown): number {
  if (typeof value !== 'object' || value === null) return REJECTED;

  // Everything below is caller-controlled: a Proxy runs caller code for each reflection step and
  // an accessor runs caller code for each read. Both can throw, and the error they throw carries
  // caller text — the same leak a frame would, routed through an exception. So the whole
  // inspection is fail-closed: any reflection failure is just "not a diagnostic".
  try {
    // A prototype other than the plain-object one can carry a `toJSON` or accessors the formatter
    // would otherwise inherit; JSON.parse never produces one, so nothing legitimate is lost.
    const prototype = getPrototypeOf(value);
    if (prototype !== objectPrototype && prototype !== null) return REJECTED;

    // Own KEYS, not names: `getOwnPropertyNames` skips symbols, so a symbol-keyed extra property
    // would ride along invisibly. Non-enumerable keys are still included, which is what keeps a
    // hidden `toJSON` from passing the count. Duplicate entries make `ownKeys` itself throw.
    const keys = ownKeys(value);
    if (keys.length !== EXPECTED_KEYS.length) return REJECTED;
    for (let i = 0; i < keys.length; i += 1) {
      if (!isExpectedKey(keys[i])) return REJECTED;
    }

    // Null prototype: `fields[key] = …` on an ordinary object would run an inherited setter that a
    // trap had just installed, executing caller code and discarding the value it was handed.
    const fields: Record<string, unknown> = create(null);
    for (let i = 0; i < EXPECTED_KEYS.length; i += 1) {
      const key = EXPECTED_KEYS[i];
      const descriptor = getOwnPropertyDescriptor(value, key);
      // Only a plain data property is readable without running caller code. An accessor is
      // rejected on its descriptor alone, so the getter is never invoked, and the value used
      // below comes from the descriptor rather than from a second read that could differ.
      // `hasOwn` rather than `in`, because a descriptor object inherits from `Object.prototype`
      // as well and a trap may have put `get` there.
      if (!descriptor) return REJECTED;
      if (hasOwn(descriptor, 'get') || hasOwn(descriptor, 'set')) return REJECTED;
      if (!hasOwn(descriptor, 'value')) return REJECTED;
      fields[key] = descriptor.value;
    }

    if (fields.schema_version !== 1) return REJECTED;
    for (let i = 0; i < EVENT_DEFINITIONS.length; i += 1) {
      const event = EVENT_DEFINITIONS[i];
      if (
        event.kind === fields.kind &&
        event.stage === fields.stage &&
        event.category === fields.category &&
        event.code === fields.code
      ) {
        return i;
      }
    }
    return REJECTED;
  } catch {
    return REJECTED;
  }
}

// A fresh event per call. Returning `EVENT_DEFINITIONS[index]` would give every caller a mutable
// alias of the allowlist, and one `parsed.events[0].code = …` would then redefine what this
// module accepts and emits for the rest of the process. An object literal defines own properties
// instead of assigning them, so an inherited setter cannot intercept these either.
function cloneEvent(index: number): SafeRuntimeDiagnostic {
  const event = EVENT_DEFINITIONS[index];
  return {
    schema_version: 1,
    kind: event.kind,
    stage: event.stage,
    category: event.category,
    code: event.code,
  } as SafeRuntimeDiagnostic;
}

export function formatSafeRuntimeDiagnostic(event: SafeRuntimeDiagnostic): string {
  const index = classify(event);
  // Fail before a prefixed frame exists: a half-written frame on the supervisor's stream is
  // worse than no frame. The message is fixed so the rejected value cannot leak through it.
  if (index === REJECTED) {
    throw new TypeError('safe runtime diagnostic rejected by the closed contract');
  }
  return CANONICAL_FRAMES[index];
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

function parseOneFrame(raw: string): number {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return REJECTED;
  }
  // Same closed check the formatter applies: parsed input gets no weaker validation than a
  // caller in this process does.
  return classify(value);
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
  const seen = new Set<number>();
  for (const frame of frames) {
    const index = parseOneFrame(frame.slice(SAFE_DIAGNOSTIC_PREFIX.length));
    if (index === REJECTED) return invalid;
    // The index IS the semantic identity: one table entry per approved combination.
    if (seen.has(index)) return invalid;
    seen.add(index);
    events.push(cloneEvent(index));
  }
  return { events, valid: true };
}
