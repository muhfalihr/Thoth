# Python control plane

## Temporary Legacy Scout activity

`LegacyScoutActivity` is a temporary worker-only compatibility seam. It is never
selected by a FastAPI route or request field. Operators select it with
`THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=legacy_scout`; the Temporal gateway
records that fixed choice in the workflow input, and the workflow dispatches the
activity to `thoth-legacy-adapter`.

The adapter worker has a maximum activity concurrency of one, matching the
single-browser limit. It launches a fixed `bun scout/cli.ts investigate` argument
vector without a shell, heartbeats while it waits, owns the process group/tree,
and terminates that tree if the Temporal activity is cancelled. Legacy stdout and
stderr are never parsed into state and are retained only as redacted diagnostic
metadata. Workflow state receives typed stage events and safe artifact references.

## Retirement gate

Do not remove the adapter merely because a Python source activity exists. The
replacement must first pass all of these gates:

- the same offline source-investigation fixtures;
- a controlled live smoke test with equivalent safe artifacts and failure codes;
- cancellation proving only the owned browser/process tree is terminated;
- worker crash/restart and retry tests; and
- confirmation that the production source-investigation path has no
  `bun scout/cli.ts` dependency.
