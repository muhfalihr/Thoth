# Creator Studio Advanced Timeline Third Review Corrections Design

**Date:** 2026-09-20

**Parent design:** `docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md`

**Second correction:** `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-second-review-corrections-design.md`

## 1. Purpose

This addendum closes the three remaining defects found by the independent
review of the second D1 correction. It validates issue selection when a saved
revision is adopted, makes the shared typed timeline fixture valid at the
Python domain boundary, and repairs the acceptance-criteria audit mapping.

The parent design and earlier corrections remain authoritative except where
this document makes these three behaviors precise. This is not D2 and does not
add render behavior.

## 2. Scope and invariants

The correction keeps these invariants:

- `EditDocument` remains the only canonical saved draft.
- `timelineIssues(document)` remains the source of issue identity.
- Python `EditDocumentV2` remains the authoritative validation boundary.
- `EditDocumentOperation`, migrations, OpenAPI, and generated TypeScript remain
  unchanged.
- No dependency, service, worker, queue, media package, API, or operation kind
  is added.
- Work and verification are offline only.

## 3. Saved revisions may preserve only issues that still exist

When `save_succeeded` adopts a returned version 2 document, the editor may
preserve `selectedIssueId` only when that exact identifier is present in
`timelineIssues(returnedDocument)`. If the saved revision resolves, renames, or
otherwise removes the issue, selection falls back to the empty-string sentinel
`""` that `EditorState.selectedIssueId` already uses for "nothing selected".

Tests must select identifiers actually produced by `timelineIssues`; a made-up
identifier is not evidence of preservation. They must cover both a surviving
issue and an issue that disappears in the returned revision.

All other second-correction session-preservation rules remain unchanged.

## 4. The typed preview fixture is a valid domain document

`typedTimelineDocument()` is shared evidence for preview behavior. Its return
type alone does not prove that Python accepts its runtime value. The fixture
must satisfy the complete `EditDocumentV2` model, including at least one
contiguous scene and consistent scene-to-clip references.

The correction must prove two things:

1. a focused dashboard test owns the fixture's scene and clip association; and
2. the exact JSON emitted by `typedTimelineDocument()` is accepted by
   `EditDocumentV2.model_validate` in a cross-boundary offline check.

No parser, shared schema package, committed generated fixture, or new runtime
dependency is introduced for this proof.

## 5. Audit mapping is exact and non-contradictory

The D1 second-correction `CHANGELOG.md` entry must map its evidence as follows:

- AC18: normalized position projection;
- AC19: committed Player replacement and listener lifecycle;
- AC20: no dependency, migration, operation, public-contract, or operational
  drift; and
- AC21: truthful full verification and audit record.

After the fixture is valid and its exact runtime value passes Python
validation, the entry may state that proof. It must remove the earlier
contradiction between claiming revalidation and later disclosing
`scenes: []` as invalid. Existing historical commits are not rewritten.

## 6. Acceptance criteria

| ID | Requirement | Required proof |
| --- | --- | --- |
| AC22 | Save preserves a selected issue only while the returned document still produces it | Reducer tests using real `timelineIssues` identifiers for surviving and resolved cases |
| AC23 | `typedTimelineDocument()` is accepted by Python `EditDocumentV2` | Focused dashboard fixture test plus exact JSON cross-boundary validation |
| AC24 | The second-correction audit maps AC18-AC21 correctly and contains no fixture contradiction | `CHANGELOG.md` inspection and final diff review |
| AC25 | No dependency, migration, API, operation, generated-contract, or operational behavior changes | Full offline gates and contract-freeze inspection |

## 7. Operational boundary

This correction authorizes only the named dashboard reducer, tests, fixture,
`CHANGELOG.md`, and the active ignored SDD checkpoint. It does not authorize
push, publication, deployment, service mutation, database migration against a
running database, real asset or secret access, provider/TikTok/browser/
Scout-live requests, render work, Stage 1 evidence mutation, Issue #5 mutation,
parity, controlled fallback, or acceptance/soak activation.
