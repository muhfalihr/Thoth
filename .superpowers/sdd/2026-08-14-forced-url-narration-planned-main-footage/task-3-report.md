# Task 3 report: Narration Profile Setting and Authoritative Enqueue Gate

## Outcome

Implemented backward-compatible narration enablement, per-run narration overrides, authoritative forced-main enqueue gates for both job creation routes, and Dashboard profile/run controls with immediate forced-handoff validation.

## RED evidence

- `rtk cargo test -p thoth-jobs profiles`
  - Failed with four compile errors: `NarrationSettings.enabled` and `RunOverrides.narration_enabled` did not exist.
- `rtk cargo test -p thoth-jobs narration_enabled_accepts_only_booleans`
  - Failed because `params.narration_enabled` was reported as `unknown_parameter`.
- `rtk cargo test -p thoth-server --test routes_http forced_main`
  - Failed because narration-disabled forced profiles and packages outside Scout output returned HTTP 201 instead of HTTP 422.
- `rtk cargo test -p thoth-server --test routes_http forced_main_legacy_route`
  - Failed because missing/false explicit narration on the profile-less route returned HTTP 201.
- `rtk bun --cwd dashboard test src/components/ProfileStudio.test.tsx`
  - Failed because the `Narrator mode` profile control did not exist.
- `rtk bun --cwd dashboard test src/components/RunForm.test.tsx`
  - Failed because forced handoffs submitted while effective narration was disabled and the one-off selector did not exist.
- `rtk bun --cwd dashboard test src/api.test.ts`
  - Failed because `{ error: { code: "forced_main_narration_required" } }` surfaced as `[object Object]`.
- `rtk bun --cwd dashboard test src/components/RunForm.test.tsx` (manual-path mapping case)
  - Failed because the authoritative code was displayed raw rather than as the narrator-required message.

Each failure was observed before the corresponding production change and matched the missing behavior under test.

## Implementation

- Added `NarrationSettings.enabled`, with an explicit serde/default value of `true` so existing persisted profiles remain enabled.
- Added `RunOverrides.narration_enabled: Option<bool>` and resolved it without mutating the selected profile; override summaries include it automatically.
- Added boolean validation for legacy `JobSpec.params.narration_enabled`.
- Added route-local forced-main descriptor/source-package inspection with exact discriminator, coverage bounds, relative artifact-path rules, canonical Scout-output containment, package schema checks, source metadata checks, and canonical post URL matching.
- Enforced the profile gate after settings resolution and before job ID/output/enqueue creation.
- Enforced explicit `params.narration_enabled == true` for forced sets on the profile-less route.
- Added Dashboard API mirrors, a profile narrator checkbox, and a keep/enabled/disabled run override selector.
- Carried the exact `forced_url_pool` discriminator through the Content Set -> App -> RunForm handoff as advisory metadata.
- Mapped the authoritative server error code for typed/manual paths to `Narrator mode is required for URL main footage.`

## Files

- `crates/thoth-jobs/src/lib.rs`
- `crates/thoth-jobs/src/profiles.rs`
- `crates/thoth-jobs/src/validation.rs`
- `crates/thoth-server/src/routes.rs`
- `crates/thoth-server/tests/routes_http.rs`
- `dashboard/src/App.tsx`
- `dashboard/src/api.test.ts`
- `dashboard/src/api.ts`
- `dashboard/src/components/ContentSet.tsx`
- `dashboard/src/components/ProfileStudio.test.tsx`
- `dashboard/src/components/ProfileStudio.tsx`
- `dashboard/src/components/RunForm.test.tsx`
- `dashboard/src/components/RunForm.tsx`

`ContentSet.tsx` and `api.test.ts` are additional Task 3 files required to propagate forced-handoff metadata and verify stable server-code handling.

## GREEN / verification evidence

- `rtk cargo test -p thoth-jobs` -> 72 passed.
- `rtk cargo test -p thoth-server --test routes_http forced_main` -> 6 passed, 69 filtered out.
- `rtk cargo test -p thoth-server --test routes_http` -> 75 passed.
- `rtk bun --cwd dashboard test` -> 20 passed, 0 failed.
- `rtk proxy cargo check -p thoth-server` -> exit 0, no warnings.
- `rtk bun dashboard/node_modules/typescript/bin/tsc -b dashboard/tsconfig.json` -> exit 0.
- `rtk bun run --cwd dashboard lint` -> exit 0; three pre-existing warnings remain in `ui/badge.tsx`, `ui/button.tsx`, and `Discovery.tsx`.
- `rtk git diff --check` -> clean.

An optional `vite build` attempt passed TypeScript compilation but the Vite bundling phase could not load the local Windows Tailwind native binding and hit `spawn EPERM`. The standalone typecheck and all Dashboard tests pass.

## Self-review

- Forced rejection occurs before UUID generation, output-path creation, import, or database enqueue.
- Error responses expose only stable codes and never include the Content Set/package absolute path.
- Legacy Content Sets without `main_footage` continue to enqueue with narration disabled.
- Profile-less forced jobs require explicit `true`; missing and false are both rejected.
- Profile defaults and one-off overrides are independent and tested for immutability.
- Immediate Dashboard validation only uses trusted handoff metadata; manual paths still rely on the authoritative server and code mapping.
- Exact forced mode, coverage interval, remote/absolute/backslash/parent traversal, canonical containment, schema, package source, and post URL rules are validated before forced-mode detection succeeds.

## Recovery note

During verification, `cargo fmt --all` unexpectedly reformatted unrelated workspace Rust files. Work stopped immediately; the parent agent restored every `crates/**` file exactly to HEAD. Task 3 Rust changes were then reapplied only with `apply_patch`, without running rustfmt/cargo fmt again. Final status/diff inspection confirms only the intended Task 3 files are modified and `crates/thoth/src/main.rs` has no diff.

## Concerns

- Vite production bundling remains blocked by the local Windows native dependency/sandbox issue described above; this is not a TypeScript or Task 3 test failure.
- The legacy worker consumption of `params.narration_enabled` is intentionally deferred to Task 12 as specified; Task 3 validates and gates the parameter at enqueue time.
