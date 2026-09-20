Mode: IMPLEMENT_PLAN

Repository: `C:\Users\mfr\Documents\MyTools\CLIPPER`

Implement the second D1 corrective round exactly as specified below. Work
offline on the existing branch. Do not push or begin D2.

## Read in this order

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md`
4. `docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md`
5. `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-review-corrections-design.md`
6. `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-second-review-corrections-design.md`
7. `docs/superpowers/plans/2026-09-20-creator-studio-advanced-timeline-second-review-corrections.md`
8. `CHANGELOG.md` only for the existing audit context relevant to D1

The active SDD checkpoint and the three design documents define the task. Do
not use `BLUEPRINT.md` as an entrypoint.

## Required skills and process

- Invoke `superpowers:executing-plans` and follow the plan task by task.
- Invoke `superpowers:test-driven-development` before each product behavior change.
- Invoke `superpowers:verification-before-completion` before any completion claim.
- Apply Ponytail at `full` intensity and Karpathy Guidelines: trace the real
  flow, make the smallest root-cause fix, avoid new abstractions, and touch only
  the authorized files.
- Use Context7 to confirm current Remotion 4 PlayerRef and `Img`/`Video`
  behavior before Task 3 or Task 5 implementation. Inspect installed package
  types as the version-matched source of truth.

## Preflight: fail closed

Before editing, report:

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse --verify '@{u}'
git rev-list --left-right --count '@{u}...HEAD'
git merge-base --is-ancestor c10507492fd2e57040500e91f99084bc2c91ecdf HEAD
git log --oneline --decorate c10507492fd2e57040500e91f99084bc2c91ecdf..HEAD
git diff --name-status c10507492fd2e57040500e91f99084bc2c91ecdf...HEAD
```

Required facts:

- branch is `codex/stage1-container-ci`;
- product baseline `c10507492fd2e57040500e91f99084bc2c91ecdf` is an ancestor;
- existing D1 and corrective commits remain reachable;
- commit `9ed8fa9` is operator-owned documentation and must not be rewritten;
- drift after `c105074` is limited to the second-review corrective spec, plan,
  executor prompt, and ignored checkpoint update created by Codex;
- tracked worktree is otherwise clean.

Stop and report before implementation if product code, generated contracts,
migrations, dependencies, operator files, or other unexplained drift exists.
Do not reset, checkout, clean, stash, amend, squash, or rewrite it.

## Authorized deliverables

Execute every checkbox in:

`docs/superpowers/plans/2026-09-20-creator-studio-advanced-timeline-second-review-corrections.md`

The authorized product outcomes are only:

1. preserve valid version 2 mode, selection/playback state, and loaded asset
   metadata when a successful save adopts its returned revision;
2. keep a visible loaded asset addable after another edit saves;
3. restrict upgrade eligibility to settled version 1 state and visibly disable
   document-mutating controls while the request runs;
4. deduplicate overlapping continuation pages by `asset_id`;
5. render validated image assets with Remotion `Img` and video assets with
   `Video`, selected only from trusted `asset_refs`;
6. interpret valid `position.x/y` values as normalized canvas fractions and
   remove the impossible `{x: 40, y:-20}` test fixture; and
7. own Player listeners through the actual committed instance, including
   replacement and unmount cleanup.

Keep `EditDocument`, `EditDocumentOperation`, migrations, APIs, preview
capability security, and all live behavior unchanged.

## TDD and commit discipline

For each Task 1-5:

1. write the narrow reproducing test first;
2. run it and record the expected RED reason;
3. implement the minimum root-cause correction;
4. run the focused GREEN suite;
5. commit only that task's files with the exact short subject from the plan.

Do not weaken existing assertions, replace meaningful integration tests with
implementation-detail mocks, or create fixtures that Python validation would
reject. A test that was not observed failing before implementation is not
RED-to-GREEN evidence; report it honestly.

Every commit must use exactly one concise subject line, preferably at most 72
characters, with no body, blank-line continuation, trailer, `Co-Authored-By`,
or AI attribution.

## Required verification

Run every Task 6 gate from the plan after the final product edit, including:

- frozen Python sync, full non-live tests, deployment tests, Ruff check and format;
- OpenAPI and TypeScript generation twice with zero diff;
- the complete dashboard suite three consecutive times, lint, and build;
- `build_cuda.bat` plus `cargo test --bin thoth`;
- Scout frozen install, acquisition tests, and runtime tests;
- read-only Compose config validation;
- diff/contract inspection proving no migration, operation-union, dependency,
  generated-contract, Rust, or Scout product drift;
- `git diff --check`; and
- `graphify update .` with generated indexes remaining ignored.

Record exact pass, skip, fail, warning, and exit counts. Never label a failure
flaky without reproducing and identifying its cause. Update the ignored active
checkpoint and append the completed audit to `CHANGELOG.md`; do not add history
to `BLUEPRINT.md`.

## Preservation and security constraints

- Preserve all operator-owned files and commits byte-for-byte.
- Keep preview locators, signing keys, and capabilities outside persisted
  documents and logs.
- Select image/video behavior only from validated `asset_refs`, never a URL
  suffix or client-provided executable value.
- Add no dependency, package, migration, API route, operation kind, service,
  state library, renderer, upload/acquisition path, or D2 feature.
- Repository artifacts and commit subjects remain English.
- Final operator-facing report must be Indonesian.

## Hard stops

Do not push, force-push, fetch/pull, open a PR, tag, release, publish an image or
package, deploy, restart or mutate services, change a digest, migrate a running
database, access a real secret or asset, make provider/TikTok/CDN/browser/
Scout-live/Temporal/render requests, mutate Stage 1 evidence or observations,
touch p1-p6, update Issue #5, run parity or controlled fallback, or activate an
acceptance/soak window.

Do not infer authorization for later D2 or render-queue work.

## Required final report

Return one Indonesian report containing:

1. product baseline, branch, final HEAD, upstream, ahead/behind, and worktree state;
2. preflight drift result and preserved operator-owned state;
3. one table of task commits and one-line subjects;
4. RED-to-GREEN evidence per Task 1-5;
5. exact behavior delivered for save preservation, upgrade busy state,
   pagination dedupe, image/video preview, normalized position, and Player replacement;
6. a full verification table with actual counts, warnings, and substitutions;
7. proof generated contracts, migrations, operation union, dependencies, Rust,
   and Scout product files did not drift;
8. security and privacy inspection results;
9. limitations and any gate not run, without claiming unproved live behavior;
10. confirmation that every hard stop was respected; and
11. the next checkpoint: independent Codex review before any push.

End with exactly:

`D1 second review corrections complete offline; Codex re-review required before push.`
