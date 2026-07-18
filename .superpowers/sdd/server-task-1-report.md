# Server Task 1 Report — Derive Server Runtime State from Thoth Home

## Scope

- `crates/thoth-server/src/main.rs`
- `crates/thoth-server/src/auth.rs`
- `crates/thoth-server/src/routes.rs` (required follow-through: legacy TOML
  handlers now derive their temporary compatibility path from `AppState.home`)
- `crates/thoth-server/tests/routes_http.rs`

`AppState.config_path` was replaced with `home: ThothHome`. The raw TOML
endpoints remain only as a transitional compatibility surface; they use
`home/config.toml` until the planned migration task removes them.

## TDD Evidence

### RED

Added `server_runtime_paths_are_derived_from_thoth_home`, then ran:

```text
cargo test -p thoth-server --test routes_http server_runtime_paths_are_derived_from_thoth_home -- --nocapture
```

Result: expected compile failure (`E0432`) because
`legacy_output_root` and `server_db_path` did not exist.

### GREEN

Added the path helpers, `--home` parsing, `resolve_home`/layout provisioning,
`JobStore::connect_with_home`, and home-backed fixtures. Re-ran the focused
test:

```text
test server_runtime_paths_are_derived_from_thoth_home ... ok
test result: ok. 1 passed; 0 failed
```

## Final Verification

Fresh commands:

```text
cargo test -p thoth-server
cargo build -p thoth-server
git diff --check
```

Results:

- `cargo test -p thoth-server`: 21 unit + 1 reaper integration + 41 HTTP
  integration tests passed; 0 failed. The binary test target and doc tests also
  completed successfully.
- `cargo build -p thoth-server`: passed.
- `git diff --check`: passed.

`cargo fmt --all -- --check` remains non-zero only because of the known
repository-wide pre-existing formatting drift in unrelated crates; no broad
formatting changes are included in this task, per the explicit deferral.

## Self-review

- Default database path is exactly `<ThothHome>/data/thoth.db`; `THOTH_DB` is
  retained solely as an explicitly documented compatibility override.
- Default output path is home-derived at
  `<ThothHome>/projects/legacy/outputs` for the temporary unprofiled job API;
  it no longer uses CWD-relative `output`.
- `--home` is resolved before store creation and the home layout is provisioned.
- Bearer middleware and loopback-default bind logic are unchanged.
- No `thoth-core`, media, GPU, or other new dependency was added.
- The only route-file edits are necessary replacements of the removed
  `config_path` field with the transitional `home/config.toml` accessor.
