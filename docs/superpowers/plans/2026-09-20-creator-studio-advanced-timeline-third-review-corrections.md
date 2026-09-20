# Creator Studio Advanced Timeline Third Review Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Close the three remaining D1 review defects without widening the
timeline foundation or changing persisted or public contracts.

**Architecture:** Keep the existing reducer and Python model authoritative.
Revalidate the selected issue against the saved document, make the shared
TypeScript fixture a real `EditDocumentV2`, and correct only the affected audit
statements.

**Tech Stack:** React 19, TypeScript, Bun, Python 3.12, Pydantic v2, pytest,
Testing Library, Ruff, Oxlint, Vite.

**Spec:**
`docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-third-review-corrections-design.md`

## Global constraints

- Product baseline `df25cfa32c973374718f30b5aa0ba7841c21a44e` remains an
  ancestor; do not rewrite existing D1 history.
- Work directly on `codex/stage1-container-ci` after fail-closed drift
  inspection.
- Preserve operator commit `9ed8fa9` and all current local commits.
- Keep operations, migrations, OpenAPI, generated TypeScript, dependencies,
  Rust, Scout, deployment, and live behavior unchanged.
- Apply strict RED-to-GREEN TDD to Tasks 1 and 2.
- Add no parser, schema bridge, committed generated fixture, or dependency for
  the cross-boundary proof.
- Keep commits as one concise subject line with no body, trailer, or AI
  attribution.
- Keep repository artifacts in English and operator reports in Indonesian.
- Verification is offline only; all operational and live gates remain closed.

---

### Task 1: Validate selected issue against the saved revision

**Files:**
- Modify: `dashboard/src/features/studio/editor_state.ts`
- Modify: `dashboard/src/features/studio/editor_state.test.ts`

**Interfaces:**
- Consumes: `save_succeeded`, `timelineIssues(returnedDocument)`.
- Produces: `selectedIssueId` that is either still present or `null`.

- [ ] **Step 1: Write focused failing reducer tests.**

Replace the made-up `issue_001` preservation case with an issue identifier
actually returned by `timelineIssues(document)`. Cover both outcomes:

1. the issue remains in the returned revision and selection is preserved; and
2. the issue is resolved by the returned revision and selection is cleared.

The test must derive or assert the real identifier from `timelineIssues`; it
must not guess an arbitrary string.

- [ ] **Step 2: Run the focused test and record RED.**

```powershell
Push-Location dashboard
bun test src/features/studio/editor_state.test.ts
Pop-Location
```

Expected RED: the resolved issue remains selected after `save_succeeded`.

- [ ] **Step 3: Implement the minimum reducer correction.**

In the zero-remaining-operations save branch, compute issue identities from
the returned document once. Preserve `state.selectedIssueId` only when that set
contains it. Do not change unrelated selection, save acknowledgement, history,
or session-preservation semantics.

- [ ] **Step 4: Run focused GREEN.**

```powershell
Push-Location dashboard
bun test src/features/studio/editor_state.test.ts
Pop-Location
```

- [ ] **Step 5: Commit Task 1.**

```powershell
git add dashboard/src/features/studio/editor_state.ts dashboard/src/features/studio/editor_state.test.ts
git commit -m "fix: validate saved timeline issue selection"
```

---

### Task 2: Make the typed timeline fixture domain-valid

**Files:**
- Modify: `dashboard/src/features/studio/timeline-test-fixtures.ts`
- Create: `dashboard/src/features/studio/timeline-test-fixtures.test.ts`
- Verify unchanged behavior: `dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx`
- Verify unchanged behavior: `dashboard/src/features/studio/TimelineInspector.test.tsx`

**Interfaces:**
- Consumes: `typedTimelineDocument()` and Python `EditDocumentV2`.
- Produces: one runtime fixture accepted by both generated TypeScript and the
  authoritative Python model.

- [ ] **Step 1: Write a focused failing fixture-contract test.**

Assert that the fixture has at least one scene, scene ranges are contiguous
from frame zero and remain within the canvas, every scene `clip_id` exists, and
every clip carrying that `scene_id` stays inside the scene. Keep the test about
the shared fixture, not a duplicate payload.

- [ ] **Step 2: Run the focused test and record RED.**

```powershell
Push-Location dashboard
bun test src/features/studio/timeline-test-fixtures.test.ts
Pop-Location
```

Expected RED: `typedTimelineDocument().scenes` is empty.

- [ ] **Step 3: Add the smallest valid scene association.**

Give the fixture at least one valid contiguous scene and associate one existing
clip consistently through both `scene.clip_ids` and `clip.scene_id`. Keep all
existing clip timing, normalized position, asset kinds, and preview expectations
unless Python validation proves another concrete fixture defect.

- [ ] **Step 4: Prove the exact runtime fixture crosses the Python boundary.**

From the repository root, emit the actual TypeScript fixture to a temporary
JSON file, validate that exact JSON with Pydantic, and remove the temporary file
in `finally` even on failure:

```powershell
$fixturePath = Join-Path $PWD '.tmp-typed-timeline-document.json'
try {
  bun -e 'import { typedTimelineDocument } from "./dashboard/src/features/studio/timeline-test-fixtures.ts"; process.stdout.write(JSON.stringify(typedTimelineDocument()));' | Set-Content -LiteralPath $fixturePath -NoNewline -Encoding utf8
  uv run --project python python -c "import json, pathlib, sys; from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2; EditDocumentV2.model_validate(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig')))" $fixturePath
  if ($LASTEXITCODE -ne 0) { throw "EditDocumentV2 validation failed with exit $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $fixturePath -ErrorAction SilentlyContinue
}
```

If validation exposes another concrete invalid field, fix only that fixture
field and add its invariant to the focused test. Do not weaken the Python
model, add a parser, or copy the fixture into Python.

- [ ] **Step 5: Run focused GREEN and consumer regressions.**

```powershell
Push-Location dashboard
bun test src/features/studio/timeline-test-fixtures.test.ts src/features/studio/AdvancedTimelineComposition.test.tsx src/features/studio/TimelineInspector.test.tsx
Pop-Location
```

- [ ] **Step 6: Commit Task 2.**

```powershell
git add dashboard/src/features/studio/timeline-test-fixtures.ts dashboard/src/features/studio/timeline-test-fixtures.test.ts
git commit -m "test: validate typed timeline fixture"
```

---

### Task 3: Verify offline and repair the audit trail

**Files:**
- Modify: `CHANGELOG.md`
- Modify (gitignored):
  `.superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md`

- [ ] **Step 1: Run Python dependency and non-live gates.**

```powershell
uv sync --project python --frozen --all-groups --extra acquisition
uv run --project python pytest -m "not live" -q
uv run --project python pytest python/tests/deployment -q
uv run --project python ruff check python/src python/tests
uv run --project python ruff format --check python/src python/tests
```

- [ ] **Step 2: Regenerate contracts twice and prove byte stability.**

```powershell
uv run --project python python python/scripts/export_openapi.py
Push-Location dashboard
bun run generate:control-plane-types
Pop-Location
git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts
```

Repeat export and generation once more and require the same zero diff.

- [ ] **Step 3: Run dashboard gates three consecutive times.**

```powershell
Push-Location dashboard
bun test
bun test
bun test
bun run lint
bun run build
Pop-Location
```

- [ ] **Step 4: Run mandatory CUDA, Rust, Scout, and Compose gates.**

```powershell
cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
Write-Output "EXIT=$LASTEXITCODE"
cargo test --bin thoth
Push-Location scout
bun install --frozen-lockfile
bun run test:acquisition
bun run test:runtime
Pop-Location
docker compose -f compose.stage1.local.yml --env-file .env.stage1.local.example config --quiet
```

Inspect the fresh build log, require exit 0 and no critical warning, then
remove only the task-created `build_log.txt`. Use WSL only for the read-only
Compose config command if native Docker is unavailable. Do not start services.

- [ ] **Step 5: Inspect scope and contract drift.**

```powershell
git diff --name-status df25cfa32c973374718f30b5aa0ba7841c21a44e..HEAD
git diff --check
git diff --exit-code df25cfa32c973374718f30b5aa0ba7841c21a44e..HEAD -- python/src/thoth_control_plane/domain python/src/thoth_control_plane/migrations python/openapi.json dashboard/src/api/generated/control-plane.ts Cargo.toml Cargo.lock scout/package.json scout/bun.lock
```

Require no dependency, migration, operation, public-contract, Rust, Scout, or
deployment drift.

- [ ] **Step 6: Correct `CHANGELOG.md` and the active checkpoint.**

Repair the second-correction entry without rewriting commit history:

- position projection is AC18;
- Player lifecycle is AC19;
- frozen scope/contracts are AC20;
- verification and audit are AC21; and
- the fixture statement reports the actual successful Python validation and
  removes the obsolete `scenes: []` limitation.

Append the third-correction result, task commits, RED-to-GREEN evidence, exact
gate counts, limitations, and hard stops to the ignored active checkpoint.
Run `graphify update .` and keep every generated index ignored.

- [ ] **Step 7: Commit only the audit correction.**

```powershell
git add CHANGELOG.md
git commit -m "docs: correct timeline review audit"
git status --short --branch
```

Expected: tracked worktree clean; ignored checkpoint updated; no operator-owned
file staged.

- [ ] **Step 8: Stop and report.**

Return the exact baseline/final SHA, task commits, RED-to-GREEN evidence,
cross-boundary validation result, full gate counts, scope-drift proof,
preserved operator state, limitations, and hard-stop confirmation. Return to
Codex for independent review before any push.

## Plan self-review

- **Finding ownership:** Task 1 owns stale issue selection; Task 2 owns the
  invalid fixture; Task 3 owns the shifted and contradictory audit record.
- **Executable proof:** The exact TypeScript fixture, not a duplicate payload,
  crosses `EditDocumentV2.model_validate`.
- **Scope:** No dependency, schema, migration, API, operation, deployment, or
  D2 work is authorized.
- **Placeholder scan:** No deferred helper or undefined later task remains.
