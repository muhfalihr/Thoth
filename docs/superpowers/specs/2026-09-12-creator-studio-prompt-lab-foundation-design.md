# Creator Studio Prompt Lab Foundation Design

**Date:** 2026-09-12  
**Status:** Approved for specification; implementation requires a separate plan and executor handoff.  
**Parent:** `docs/superpowers/specs/2026-09-11-ui-first-creator-studio-design.md`

## 1. Purpose

Sub-project C1 adds a durable Prompt Lab to Creator Studio. A creator can select
an authoring stage, create or revise a reusable prompt template, bind a chosen
template to the current project, edit the project override, and inspect the
visible resolved prompt before any workflow uses it.

C1 deliberately does not call an AI provider. `Improve` and `Translate` must
not pretend to work with a heuristic, fixture, or client-side rewrite. They are
reserved for C2, where a server-owned provider adapter can create a typed
proposal through an explicit operator-approved live gate.

## 2. User-visible outcome

Inside an open Creator Studio document, the left workspace switches between
`Scenes` and `Prompt Lab`. Prompt Lab contains:

- an accessible stage list sourced from the control plane;
- a compact template list for the selected stage;
- a labelled editor for template text and the active project override;
- a visible resolved-draft preview with section labels; and
- disabled `Improve` and `Translate` controls that state they are unavailable
  until a provider-backed proposal service exists.

Saving a template creates a new immutable template revision. Saving a project
override changes only the selected project-stage binding. Switching back to
Scenes preserves the active Studio document and its local autosave state.

## 3. Scope

### Included

- A backend-owned, read-only stage registry.
- Three C1 `draft_only` stages: `narrative_plan`, `visual_plan`, and
  `caption_copy`. They are authoring locations, not claims that the current
  workflow invokes an LLM at those stages.
- Immutable reusable template revisions and one active project binding per
  `(project_id, stage_id)`.
- Typed REST endpoints for listing stages/templates, creating a revision,
  reading/updating the project binding, and calculating a visible resolved
  draft.
- Generated OpenAPI and TypeScript client contracts.
- An accessible desktop Prompt Lab in the existing guided Studio shell.
- Optimistic binding save with a binding revision and a safe `409` conflict
  response.

### Excluded

- Provider calls, live Improve/Translate execution, raw provider payloads,
  provider credentials, retries, and feature flags that silently enable them.
- Video- or scene-scoped bindings, variables, template sharing permissions,
  comments, locks, multi-user collaboration, and proposal persistence.
- EditDocument operations, timeline/media/audio editing, rendering, Temporal
  commands, deployment, or any Stage 1 evidence activity.

## 4. Domain model

The stage registry is an application constant, not a dashboard-maintained list:

```python
class PromptStageDefinition(StrictModel):
    stage_id: Literal["narrative_plan", "visual_plan", "caption_copy"]
    label: str
    status: Literal["draft_only"]
```

`draft_only` is deliberate. The API must not expose a stage as executable until
a later specification maps it to a real server-side workflow boundary.

Template text is plain bounded Unicode text, never executable content:

```python
class PromptTemplateRevision(StrictModel):
    project_id: ProjectId
    template_id: OpaqueId
    revision: Annotated[int, Field(gt=0)]
    stage_id: PromptStageId
    language: Annotated[str, Field(pattern=r"^[a-z]{2}(?:-[A-Z]{2})?$")]
    body: Annotated[str, Field(min_length=1, max_length=12_000)]
```

A project binding contains the template revision selected by the creator and an
optional bounded override. A binding save requires the caller's
`base_revision`; the service atomically increments it or returns the latest
validated binding as a `409` conflict.

```python
class ProjectPromptBinding(StrictModel):
    project_id: ProjectId
    stage_id: PromptStageId
    template_id: OpaqueId
    template_revision: Annotated[int, Field(gt=0)]
    project_override: Annotated[str | None, Field(max_length=12_000)]
    revision: Annotated[int, Field(gt=0)]
```

The visible resolved draft is exact and deterministic:

```text
Template
<template body>

Project override
<override body, only when present>
```

The response labels both sections and omits any internal system policy,
credentials, provider configuration, raw request/response data, URLs, paths,
or artifact references. C2 may add server-only policy and typed variables, but
must never add them to browser-readable preview output.

## 5. Persistence

C1 adds two editor-database tables through an explicit new SQL migration:

- `prompt_template_revisions` stores project-scoped append-only template
  revisions, keyed by `(project_id, template_id, revision)`.
- `project_prompt_bindings` stores the current project-stage binding with a
  unique `(project_id, stage_id)` key and its optimistic revision.

The binding table stores only a template identity/revision and an optional
plain-text override. It does not duplicate prompt bodies or store an EditDocument
reference. Every template lookup includes `project_id`; a template from another
project is indistinguishable from a missing template. The repository opens
short-lived connections, parameterizes every query, validates database
JSON/text through domain models, and maps database failures to one safe
unavailable error. The editor migration command remains the only supported
migration entry point.

## 6. API contract

All routes require the existing control-plane bearer authentication and live
under `/api/v1/projects/{project_id}/prompt-lab` unless noted otherwise.

| Method | Route | Result |
| --- | --- | --- |
| `GET` | `/prompt-stages` | Read-only ordered registry. |
| `GET` | `/projects/{project_id}/prompt-lab/templates?stage_id=...` | Template heads for one stage; no bindings or secrets. |
| `POST` | `/projects/{project_id}/prompt-lab/templates` | Appends a template revision; returns it with `201`. |
| `GET` | `/projects/{project_id}/prompt-lab/bindings/{stage_id}` | Current binding, or `404` when none exists. |
| `PUT` | `/projects/{project_id}/prompt-lab/bindings/{stage_id}` | Creates/updates binding with `base_revision`; returns `200` or `409` with latest binding. |
| `GET` | `/projects/{project_id}/prompt-lab/resolved/{stage_id}` | Returns the visible resolved draft for the current binding. |

Unknown fields, unsupported stage IDs, blank bodies, invalid language tags,
template-stage mismatches, and missing referenced revisions return `422` or
`404` without a partial write. Repository unavailability returns `503` with no
connection or SQL diagnostics. C1 intentionally defines no endpoint named
`improve`, `translate`, `proposal`, or `apply-proposal`.

## 7. Studio interaction design

Prompt Lab is a first-class workspace mode inside `GuidedStudio`, not another
top-level dashboard route. It uses the established dark creative-workstation
surface, existing semantic color tokens, Lucide icons where an icon is needed,
and the current 4/8px spacing rhythm. The Prompt Lab tab is a native button
with `aria-selected`; its panel is labelled and keyboard reachable.

The stage list is an ordered set of labelled buttons. Selection changes the
template list, editor, and preview together. The editor always labels its
language, template body, and project override controls. Save states are
persistent and announced through the existing non-disruptive live region:
`Saving`, `Saved`, `Failed`, `Conflict`, or `Offline`.

The resolved preview is read-only `pre-wrap` text with named sections. It is
never rendered as HTML and never accepts user edits. `Improve` and `Translate`
are disabled native buttons with an adjacent explanation; they neither issue a
network request nor produce a fabricated proposal. Keyboard focus remains
visible, disabled controls expose their reason, and Prompt Lab does not obscure
the Scene board, canvas, or Inspector when the user returns to guided editing.

## 8. Error and conflict behavior

- A failed template save leaves unsaved form text intact and offers `Retry`.
- A binding `409` preserves local form text and offers `Reload latest`; it
  never overwrites a local override silently.
- A missing binding displays an explicit empty state with `Create binding`.
- An unavailable repository displays a safe, non-diagnostic error and does not
  falsely report a saved template or binding.
- No C1 error message includes a provider name, secret, database location,
  raw SQL, user URL, or workflow artifact path.

## 9. Verification and acceptance

- Domain tests validate stage IDs, text/language bounds, immutable revisions,
  resolved-draft composition, and template-stage matching.
- Repository tests prove parameterized append-only template writes, atomic
  binding compare-and-save, and safe unavailable/conflict paths.
- API tests cover authentication, `200`/`201`, `404`, `409`, `422`, `503`, and
  the generated OpenAPI shape.
- Dashboard tests cover accessible stage selection, unsaved preservation,
  retry/conflict behaviour, disabled AI controls issuing no request, and
  resolved preview escaping text.
- Full Python, OpenAPI generation, dashboard test/lint/build, and existing CUDA
  gates must pass before updating `BLUEPRINT.md`.

## 10. C2 handoff

C2 may introduce one server-owned provider adapter that receives a resolved
draft and returns a typed `PromptProposal` containing before/after text and a
language variant. It must be separately specified, tested with a fake adapter,
and activated only through a distinct operator authorization. C2 may not turn
an unreviewed proposal into a template or binding revision automatically.
