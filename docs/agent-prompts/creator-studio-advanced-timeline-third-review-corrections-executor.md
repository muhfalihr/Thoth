Mode: IMPLEMENT_PLAN

Repository: `C:\Users\mfr\Documents\MyTools\CLIPPER`

Implement the third and final micro-corrective round for D1 exactly as
specified below. Work offline on the existing branch. Do not push or begin D2.

## Read in this order

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md`
4. `docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md`
5. `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-second-review-corrections-design.md`
6. `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-third-review-corrections-design.md`
7. `docs/superpowers/plans/2026-09-20-creator-studio-advanced-timeline-third-review-corrections.md`
8. The current D1 entry at the top of `CHANGELOG.md`

The active SDD checkpoint and linked design/plan are the entrypoints. Do not
use `BLUEPRINT.md` as an entrypoint.

## Required skills and process

- Invoke `superpowers:executing-plans` and execute every checkbox in order.
- Invoke `superpowers:test-driven-development` before Tasks 1 and 2.
- Invoke `superpowers:verification-before-completion` before any completion
  claim.
- Apply Ponytail at `full` intensity and Karpathy Guidelines: trace the real
  flow, make the smallest root-cause change, and touch only authorized files.
- No Context7 query is required unless implementation unexpectedly depends on
  a third-party API; this correction changes no Remotion behavior.

## Preflight: fail closed

Before editing, report:

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse --verify '@{u}'
git rev-list --left-right --count '@{u}...HEAD'
git merge-base --is-ancestor df25cfa32c973374718f30b5aa0ba7841c21a44e HEAD
git log --oneline --decorate df25cfa32c973374718f30b5aa0ba7841c21a44e..HEAD
git diff --name-status df25cfa32c973374718f30b5aa0ba7841c21a44e...HEAD
```

Required facts:

- branch is `codex/stage1-container-ci`;
- `df25cfa32c973374718f30b5aa0ba7841c21a44e` is an ancestor;
- existing D1 history and operator commit `9ed8fa9` remain reachable;
- drift after `df25cfa` is limited to Codex's third-correction design, plan,
  executor prompt, and ignored checkpoint update;
- tracked worktree is otherwise clean.

Stop and report before implementation if product code, contracts, migrations,
dependencies, operator files, or other unexplained drift exists. Do not reset,
checkout, clean, stash, amend, squash, or rewrite it.

## Authorized deliverables

Execute every checkbox in:

`docs/superpowers/plans/2026-09-20-creator-studio-advanced-timeline-third-review-corrections.md`

Only these outcomes are authorized:

1. `save_succeeded` preserves `selectedIssueId` only while the returned
   document still produces that exact issue;
2. `typedTimelineDocument()` contains a valid contiguous scene and consistent
   clip association, with its exact runtime JSON accepted by Python
   `EditDocumentV2.model_validate`; and
3. `CHANGELOG.md` maps AC18 through AC21 correctly and removes the obsolete
   contradiction about `scenes: []`.

Keep every other D1 behavior and contract unchanged.

## TDD and commit discipline

For Tasks 1 and 2:

1. write the narrow reproducing test first;
2. run it and record the expected RED reason;
3. implement the minimum correction;
4. run the focused GREEN suite; and
5. commit only the task files with the exact short subject from the plan.

Tests must use a real `timelineIssues` identifier. The fixture proof must
validate the exact JSON emitted by the TypeScript function, not a duplicate
Python payload. Do not weaken the Python model or existing assertions.

Every commit must use exactly one concise subject line, preferably at most 72
characters, with no body, continuation, trailer, `Co-Authored-By`, or AI
attribution.

## Required verification

Run every Task 3 gate from the plan after the final product edit, including:

- frozen Python sync, full non-live and deployment tests, Ruff check and format;
- OpenAPI and generated TypeScript regeneration twice with zero diff;
- the complete dashboard suite three consecutive times, lint, and build;
- `build_cuda.bat` and `cargo test --bin thoth`;
- Scout frozen install, acquisition tests, and runtime tests;
- read-only Compose config validation;
- exact cross-boundary Pydantic validation of `typedTimelineDocument()`;
- contract and scope freeze inspection;
- `git diff --check`; and
- `graphify update .` with generated indexes remaining ignored.

Record exact pass, skip, fail, warning, and exit counts. Update the ignored
active checkpoint and correct `CHANGELOG.md`; do not add history to
`BLUEPRINT.md`.

## Preservation and security constraints

- Preserve operator-owned files and commits byte-for-byte.
- Keep preview locators, signing keys, and capabilities outside documents and
  logs.
- Add no dependency, schema bridge, package, migration, API, operation kind,
  service, renderer, upload/acquisition path, or D2 feature.
- Repository artifacts and commit subjects remain English.
- Final operator-facing report must be Indonesian.

## Hard stops

Do not push, force-push, fetch/pull, open a PR, tag, release, publish an image or
package, deploy, restart or mutate services, change a digest, migrate a running
database, access a real secret or asset, make provider/TikTok/CDN/browser/
Scout-live/Temporal/render requests, mutate Stage 1 evidence or observations,
touch p1-p6, update Issue #5, run parity or controlled fallback, or activate an
acceptance/soak window.

Do not infer authorization for D2 or render-queue work.

## Required final report

Return one Indonesian report containing:

1. product baseline, branch, final HEAD, upstream, ahead/behind, and worktree;
2. preflight drift and preserved operator-owned state;
3. task commits and one-line subjects;
4. RED-to-GREEN evidence for Tasks 1 and 2;
5. proof of the surviving/resolved issue cases;
6. proof that the exact TypeScript fixture passed Python validation;
7. the corrected AC18-AC21 mapping and removed contradiction;
8. full verification counts and scope-drift inspection;
9. limitations and any unrun gate without overstating behavior;
10. confirmation that every hard stop was respected; and
11. the next checkpoint: independent Codex review before any push.

End with exactly:

`D1 third review corrections complete offline; Codex re-review required before push.`
