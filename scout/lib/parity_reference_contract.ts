// parity_reference_contract.ts — the shared budget an isolated parity reference
// runs under, owned in one place so the supervisor and the pipeline cannot drift
// apart.
//
// p5 is what drift costs: the supervisor's outer deadline was shorter than the
// source stage it supervised, so a source resolution that used its own budget was
// killed from the outside and recorded as an incomparable sample. The outer
// deadline is therefore derived from the retained stage plus a named reserve,
// never written as an independent literal.
//
// Dependency-free on purpose: no environment lookup, no I/O, no timer, no mutable
// export. Both sides import the same numbers or neither compiles.

/** The retained source stage keeps the 30-minute budget measured on live runs. */
export const SOURCE_REFERENCE_TRACE_TIMEOUT_MS = 30 * 60_000;

/**
 * Pre-outcome headroom around that stage: isolated-browser readiness, seed
 * inspection, the summary, and scheduling variance. It deliberately does not
 * cover teardown or attempt finalization, which are mandatory post-outcome work
 * and run outside the deadline.
 */
export const SOURCE_REFERENCE_OVERHEAD_RESERVE_MS = 5 * 60_000;

/**
 * The supervised acquisition deadline: the retained stage plus its pre-outcome
 * reserve. It starts before browser readiness and ends when the
 * browser/reference race selects an outcome.
 */
export const SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS =
  SOURCE_REFERENCE_TRACE_TIMEOUT_MS + SOURCE_REFERENCE_OVERHEAD_RESERVE_MS;
