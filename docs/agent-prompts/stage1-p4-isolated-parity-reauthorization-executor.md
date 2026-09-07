# Stage 1 p4 Isolated Parity Reauthorization Executor

Copy the following prompt into the same Claude executor project. It grants a
second single-use authorization because the first authorization stopped before
any live request or evidence mutation.

```text
Mode: IMPLEMENT_PLAN — reauthorized single execution of activation parity sample p4

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci

Objective:
Execute the previously approved p4 isolated activation parity procedure exactly once now that the operator-provided fixture exists. Preserve the first preflight-only attempt as an audit event, run one newly authorized live p4 pair at most, append one truthful p4 sample record only when the evidence reaches the append phase, and stop for independent review.

Read completely, in order:
1. `CLAUDE.md`
2. `AGENTS.md` and its referenced instructions
3. `BLUEPRINT.md`
4. `docs/agent-prompts/stage1-p4-isolated-parity-executor.md`
5. Every specification, runbook, source file, and entrypoint named by that executor prompt
6. The prior p4 preflight report in this Claude project

Authorization reset:
- The first p4 authorization ended safely at `fixture_present=false` before any live request, workflow submission, disposable reference, or evidence mutation.
- The operator has now supplied the fixture at `/home/mfr/thoth-stage1-parity/p4/url.txt` and explicitly grants one new single-use p4 authorization.
- Codex independently observed only these safe facts before issuing this prompt: p4 directory exists, fixture file exists, neither authorized path is a symlink, directory mode/owner is `0700 mfr:mfr`, file mode/owner is `0600 mfr:mfr`, and the p4 fixture bytes differ from the preserved p3 fixture bytes.
- These observations do not replace executor preflight. Revalidate every Phase 1 predicate without printing the URL, hash, or metadata.

Current repository checkpoint:
- Expected ancestor: `71059b62b4fbd837d06150bb5aae3a8482366c69` (`docs: add p4 parity executor prompt`).
- This reauthorization-prompt commit or later operator-owned documentation commits may follow it. Inspect drift; do not reset, checkout, amend, rebase, merge, or clean.
- Require a clean worktree before live execution.

Exact authorized scope:
- One ordinary Python source-investigation workflow using the restricted p4 fixture.
- At most one isolated Scout reference using the same fixture, and only after valid Python completion and artifacts.
- The disposable parity Compose project and its mandatory teardown.
- Read-only deployment, workflow, event, artifact, provider-readiness, and containment checks required by the original prompt.
- Restricted p4 evidence creation, offline integrity validation, at most one nine-field comparison, and one append-only p4 sample row with its byte-identical mode-0600 backup when the original prompt reaches Phase 5.
- Live TikTok/CDN/provider access inherent in that one pair.

All phases, classifications, security rules, output restrictions, completion criteria, failure branches, cleanup duties, and final-report formats in `docs/agent-prompts/stage1-p4-isolated-parity-executor.md` remain authoritative and must be followed verbatim.

Hard boundaries retained:
- This is a reauthorization after a preflight-only stop, not permission to retry any live p4 result.
- Any live submission ambiguity, terminal failure, reference failure, mismatch, incomparable evidence, cleanup failure, or append failure is the first result. Preserve it and stop.
- Use the deployed `ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af` only. Do not pull, build, deploy, restart, recreate, or stop deployed services.
- Preserve p1–p3 and the valid p3 amendment byte-for-byte. P3 remains effectively `evidence_incomparable` and earns no parity credit.
- Do not create or update an observation for p4; it is a pre-window activation pair.
- Do not post, edit, or delete any Issue #5 comment. Public checkpoint approval comes after independent review of the p4 result.
- Do not run controlled fallback, open the acceptance window, collect soak observations, evaluate an aggregate, export to S3, perform rollback, cut over, change the Python default, remove Scout, or enter Task 10.
- Do not modify repository files, commit, push, publish an image, change environment/provider configuration, seed authentication, replace the fixture, or create p5.

Execution:
1. Start again at Phase 1 of `docs/agent-prompts/stage1-p4-isolated-parity-executor.md` and record that this is authorization attempt 2 after one preflight-only stop.
2. Require `fixture_present=true`, exact ownership/modes, no symlink, canonical URL validation, and `fixture_distinct_from_p3=true` before any live request.
3. Continue through Phases 2–5 only while each preceding completion criterion passes.
4. Execute no live step more than once.
5. Return the original prompt's safe Indonesian report using its truthful ending, then stop.

This prompt authorizes no action beyond the original p4 boundary. A p4 pass still requires independent review and separate authorization before an Issue #5 checkpoint, controlled fallback, or acceptance-window activation.
```
