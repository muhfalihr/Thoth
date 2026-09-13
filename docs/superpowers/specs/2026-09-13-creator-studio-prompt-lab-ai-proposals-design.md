# Creator Studio Prompt Lab AI Proposals Design

**Date:** 2026-09-13  
**Status:** Draft for operator review  
**Parent:** `docs/superpowers/specs/2026-09-11-ui-first-creator-studio-design.md`  
**Predecessor:** `docs/superpowers/specs/2026-09-12-creator-studio-prompt-lab-foundation-design.md`

## 1. Purpose

Sub-project C2 activates provider-backed `Improve` and `Translate` proposals
inside the existing Creator Studio Prompt Lab. It covers all three registered
prompt stages:

- `narrative_plan`;
- `visual_plan`;
- `caption_copy`.

An action targets only the currently selected stage. An AI response is a
durable proposal for review, never an automatic edit. The user compares the
proposal with its exact saved source and explicitly applies or rejects it.

C2 also removes the dead-end empty state by offering one explicit starter
template for each stage. Opening a project never writes prompt data
automatically.

## 2. User-visible outcome

For each prompt stage, the user can:

1. create a prompt from a curated starter or from scratch;
2. edit and save the template and project override independently;
3. choose an enabled provider and model in the UI;
4. request an improvement with optional instructions;
5. request a translation into a selected target language;
6. leave the page while generation continues;
7. return or refresh and recover the active proposal;
8. compare source and proposal before accepting any change;
9. selectively apply improvement changes;
10. apply a translation only as a complete language variant;
11. reject, supersede, or inspect earlier proposals; and
12. lock an editable layer against AI generation and application.

Provider credentials, private endpoints, hidden policies, and raw provider
payloads never enter browser-readable responses.

## 3. Scope

### 3.1 Included

- A safe provider/model catalog from server-owned configuration.
- Project-stage provider/model preferences with optimistic concurrency.
- Server-owned provider execution in the existing Python Temporal worker.
- Durable asynchronous proposal state in the editor PostgreSQL database.
- `Improve` for either the template or project-override layer.
- Optional improvement instructions.
- `Translate` that preserves template and override separation.
- Immutable source and result snapshots without hidden policy content.
- Safe plain-text comparison and selective improvement-hunk application.
- Whole-proposal translation application.
- Explicit Apply, Reject, Regenerate, and proposal-history interactions.
- One curated server-owned starter template per stage.
- Template and project-override locks scoped to one project-stage.
- Generated OpenAPI and TypeScript contracts.
- Offline tests with a fake provider adapter.

### 3.2 Excluded

- Automatic application of provider output.
- Batch generation across multiple stages.
- Arbitrary provider endpoints, models, API keys, or raw provider options from
  the browser.
- Browser-side provider calls or credential storage.
- Automatic provider retries.
- Token streaming or a new SSE protocol.
- User-supplied code, HTML, shell fragments, or template engines.
- Video- and scene-scoped prompt overrides.
- Per-line, per-token, or multi-user locks.
- Real-time collaboration, comments, or approval roles.
- Provider billing dashboards, quota discovery, or account validation.
- Timeline, media, audio, rendering, or EditDocument changes.
- Stage 1 parity, controlled fallback, evidence, or acceptance changes.
- Deployment, live provider verification, or production enablement.

## 4. Design principles

1. **Proposal, never mutation.** Provider output cannot update a prompt before
   explicit review and Apply.
2. **Saved revision as source.** Generation is disabled while a target layer
   has unsaved changes.
3. **Durable lifecycle.** Navigation, refresh, and API reconnection do not lose
   a queued, running, or completed proposal.
4. **Stage isolation.** A proposal for one stage cannot alter another stage.
5. **Layer preservation.** Template and project override remain distinct.
6. **Server-owned trust boundary.** The server owns provider allowlists,
   credentials, hidden policies, validation, and application.
7. **Fail closed on drift.** Apply fails after its source revision changes.
8. **One paid attempt per action.** There is no automatic retry.
9. **Plain text only.** Prompt source, result, and diff never render as HTML.
10. **Reuse existing infrastructure.** Use PostgreSQL, Temporal, the Python
    worker, existing authentication, and current Prompt Lab reducer patterns.

## 5. Domain model

### 5.1 Provider catalog

The safe catalog contains no credentials:

```python
class PromptModelDefinition(StrictModel):
    model_id: SafeIdentifier
    label: NonEmptyText
    capabilities: frozenset[Literal["improve", "translate"]]
    max_input_chars: int


class PromptProviderDefinition(StrictModel):
    provider_id: SafeIdentifier
    label: NonEmptyText
    enabled: bool
    models: tuple[PromptModelDefinition, ...]
```

Only enabled catalog entries are selectable. Model IDs are exact
server-configured values, not free-form browser inputs. The worker fails startup
when an enabled provider lacks required local credential or endpoint
configuration. This proves configuration presence, not authentication, quota,
or live model compatibility.

### 5.2 Project-stage preference

```python
class ProjectPromptModelPreference(StrictModel):
    project_id: ProjectId
    stage_id: PromptStageId
    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    revision: PositiveInt
    updated_at: AwareDatetime
```

The preference is independent for each project-stage. Updates use an expected
revision and return a conflict instead of silently overwriting concurrent work.

### 5.3 Editable-layer lock

```python
PromptLayer: TypeAlias = Literal["template", "project_override"]


class ProjectPromptLayerLock(StrictModel):
    project_id: ProjectId
    stage_id: PromptStageId
    layer: PromptLayer
    locked: bool
    revision: PositiveInt
    updated_at: AwareDatetime
```

This is an editing guard, not a distributed user lock. A locked layer cannot
be targeted by a new proposal or changed by Apply. Manual unlock is explicit
and revisioned. The server rechecks the lock during Apply.

### 5.4 Prompt proposal

```python
PromptProposalKind: TypeAlias = Literal["improve", "translate"]
PromptProposalStatus: TypeAlias = Literal[
    "queued",
    "running",
    "succeeded",
    "failed",
    "applied",
    "rejected",
    "superseded",
]


class PromptProposalSource(StrictModel):
    template_id: TemplateId
    template_revision: PositiveInt
    binding_revision: PositiveInt
    template_language: PromptLanguage
    template_body: PromptBody
    project_override: PromptOverride | None


class PromptProposalChange(StrictModel):
    change_id: OpaqueId
    layer: PromptLayer
    before_text: str
    after_text: str
    start_line: NonNegativeInt
    end_line: NonNegativeInt


class PromptProposal(StrictModel):
    proposal_id: OpaqueId
    project_id: ProjectId
    stage_id: PromptStageId
    kind: PromptProposalKind
    status: PromptProposalStatus
    target_layers: tuple[PromptLayer, ...]
    source: PromptProposalSource
    target_language: PromptLanguage | None
    improvement_instructions: PromptInstructions | None
    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    changes: tuple[PromptProposalChange, ...]
    translated_template_body: PromptBody | None
    translated_project_override: PromptOverride | None
    failure_code: PromptProposalFailureCode | None
    created_at: AwareDatetime
    started_at: AwareDatetime | None
    finished_at: AwareDatetime | None
```

An applied proposal also produces immutable approval provenance linking the
proposal ID, accepted change IDs, approving actor, resulting template/binding
revisions, and application timestamp. The resulting revision is classified as
`ai_assisted` and `user_approved`; it is never represented as autonomous AI
ownership.

The source snapshot, operation, and provider/model are immutable from creation.
The normalized result or safe failure code becomes immutable when the worker
records the terminal provider outcome. Only lifecycle status and its timestamps
may transition afterwards. Hidden policy and raw provider responses are never
persisted.

### 5.5 Lifecycle

```text
queued -> running -> succeeded -> applied
                          |      -> rejected
                          |      -> superseded
                  -> failed
queued  -> failed
```

A revision mismatch makes Apply return `409 stale_proposal`; it does not alter
proposal content. Creating a new proposal after a previous `succeeded` proposal
marks the earlier one `superseded`. A second proposal is rejected while one for
the same project-stage is `queued` or `running`.

## 6. Starter templates

The stage registry owns one versioned starter definition per stage. The API
exposes only its ID, label, language, and body. `Use starter` copies the body
into the existing local template form and does not write a template or binding
until Save.

Starter definitions are trusted application data, not provider output.
Changing a starter later does not alter templates already copied into projects.

## 7. Asynchronous architecture

```text
React Prompt Lab
  -> authenticated Prompt Proposal API
      -> editor PostgreSQL repositories
      -> Temporal workflow start/query boundary
          -> existing Python Temporal worker
              -> provider catalog validation
              -> one server-owned provider request
              -> typed result validation
              -> proposal repository completion
```

No new process, queue product, or deployment service is introduced.

The existing worker receives a restricted editor-database connection so the
activity can load and complete proposal records without putting prompt content
in Temporal history. This is a new runtime configuration for that existing
service, not a new service or browser-visible credential.

### 7.1 Creation flow

1. The UI saves the target template/binding revision.
2. The UI sends an idempotency key and proposal request.
3. The API validates stage, locks, provider/model capability, input bounds, and
   absence of another active generation.
4. The API reserves the proposal row and starts a workflow identified by the
   proposal ID.
5. The API returns `202 Accepted` with the typed proposal resource.
6. The worker moves it to `running`, performs one provider request, validates
   the response, and records `succeeded` or `failed`.
7. The UI polls the proposal resource until terminal.

Temporal provides durable execution across page refresh and API restart. The
PostgreSQL proposal is the UI read model and audit record. Temporal history
must contain IDs and safe status only. Prompt text, provider payloads,
credentials, and hidden policy must not enter Temporal inputs, results, logs,
memo, or search attributes. The activity loads proposal content by ID from the
restricted repository.

### 7.2 Timeout and retry

Each provider attempt has a hard 120-second activity timeout. The workflow has
no automatic retry policy. Retry is a new explicit proposal with a new proposal
ID and idempotency key.

## 8. Provider adapter boundary

```python
class PromptProposalProvider(Protocol):
    async def propose(self, request: ProviderPromptRequest) -> ProviderPromptResult: ...
```

The request contains only the selected catalog provider/model, source layer
text, operation, target language when applicable, optional improvement
instructions, and a server-owned hidden instruction. It contains no arbitrary
endpoint, credential, or provider-specific browser option.

Adapters must:

- perform exactly one network request per activity invocation;
- resolve credentials only in the worker;
- return typed normalized text, not a raw provider response;
- classify timeout, rate limit, unavailable, and invalid-output failures;
- avoid logging prompt text or provider payloads; and
- enforce catalog capabilities and input limits.

The adapter returns complete proposed text for each targeted layer. The
application service, not the provider, computes deterministic non-overlapping
diff hunks and assigns change IDs after validating the complete result.

Automated tests use a fake adapter and make no live provider request.

## 9. API contract

All paths use the existing `/api/v1` prefix and authentication dependency.

| Method | Path | Outcome |
| --- | --- | --- |
| `GET` | `/prompt-providers` | Safe enabled provider/model catalog. |
| `GET` | `/projects/{project_id}/prompt-lab/preferences/{stage_id}` | Current preference or `404`. |
| `PUT` | `/projects/{project_id}/prompt-lab/preferences/{stage_id}` | Create/update; `409` on revision conflict. |
| `GET` | `/projects/{project_id}/prompt-lab/locks/{stage_id}` | Both editable-layer lock states. |
| `PUT` | `/projects/{project_id}/prompt-lab/locks/{stage_id}/{layer}` | Revisioned lock or unlock. |
| `GET` | `/prompt-stages/{stage_id}/starter` | Safe starter definition. |
| `POST` | `/projects/{project_id}/prompt-lab/proposals` | Reserve and start; `202`. |
| `GET` | `/projects/{project_id}/prompt-lab/proposals?stage_id=...` | Bounded newest-first history. |
| `GET` | `/projects/{project_id}/prompt-lab/proposals/{proposal_id}` | One project-scoped proposal. |
| `POST` | `/projects/{project_id}/prompt-lab/proposals/{proposal_id}/apply` | Apply reviewed selection atomically. |
| `POST` | `/projects/{project_id}/prompt-lab/proposals/{proposal_id}/reject` | Reject succeeded proposal. |

Create contains a catalog provider/model pair, kind, target layer or layers,
optional instructions, target language when translating, exact source
revisions, and an idempotency key. Replaying the same key and payload returns
the original proposal. Reusing it with a different payload returns a conflict.

Improve Apply contains only accepted `change_id` values. Translate Apply
contains no client-authored result text and applies the complete stored result.

## 10. Apply semantics

### 10.1 Improve

Improve targets one unlocked layer. The server stores stable change IDs and
before/after hunks, validates selected IDs, and reconstructs the result from the
immutable proposal.

- Template Apply creates a new immutable template revision and advances the
  project-stage binding to it.
- Project-override Apply creates a new binding revision while preserving the
  selected template revision.
- Applying no changes is rejected; Reject is the explicit no-change action.
- Improve is unavailable for an empty target layer; the user must author and
  save initial text before requesting improvement.
- Apply records approval provenance for the revisions it creates.

### 10.2 Translate

Translate preserves the current template and project override as separate
layers and creates a complete target-language variant:

- translated template body becomes a new template identity/revision;
- a non-empty project override is translated separately;
- an empty override remains empty;
- source-language template and binding history remain unchanged; and
- one transaction creates the target variant and advances the binding.

Translation is all-or-nothing. Hunk selection is unavailable because a
mixed-language prompt is not a valid translated variant.

Translate targets the template plus a non-empty override. It is rejected when
any targeted layer is locked; an empty override is not a target and therefore
does not block translation merely because its layer is locked.

### 10.3 Revalidation

Immediately before Apply, the service rechecks project/stage ownership,
proposal status, source revisions, layer locks, selected changes, and target
language constraints. Any failure rolls back the transaction and leaves the
proposal inspectable.

## 11. Prompt Lab interaction design

### 11.1 Empty and authoring states

When a stage has no binding, Prompt Lab offers `Use starter` and
`Create from scratch`. Both remain local drafts until Save. Improve and
Translate are disabled with the visible reason `Save changes first`.

The selected stage shows one compact AI Proposal panel with provider and model
selectors, saved-preference state, Improve and Translate actions, optional
improvement instructions, target language, active status, and collapsed
history. Changing provider/model saves only that project-stage preference and
does not start a provider request.

### 11.2 Review

Completed proposals open inside Prompt Lab, not a blocking modal. The review
labels AI-generated content and renders plain text.

- Improve shows source and proposal with selectable change hunks.
- Translate shows source and complete target-language layers.
- Apply, Reject, and Regenerate use visible text labels.
- Success and failure remain visible rather than existing only in a toast.
- Stale proposals show `Source changed`, disable Apply, and retain comparison.

### 11.3 Async, offline, and accessibility

`queued` and `running` use one concise `role=status` message with
`aria-atomic=true`; focus does not move as status updates. Polling stops on a
terminal status and pauses while offline. Reconnection reloads the active
proposal before polling resumes.

Navigation or refresh does not cancel generation. Existing C1 draft and
offline-recovery semantics remain authoritative. Offline mode permits reading
loaded history and comparisons, but disables Generate, Apply, Reject,
preference Save, and lock changes.

All controls are keyboard reachable, disabled reasons are visible, focus rings
remain present, and state is never communicated through colour alone.

## 12. Persistence

One append-only editor migration adds:

- `prompt_provider_preferences` keyed by project and stage;
- `prompt_layer_locks` keyed by project, stage, and layer;
- `prompt_proposals` with immutable request/source/result data and lifecycle;
- `prompt_proposal_changes` keyed by proposal and stable change ID; and
- `prompt_proposal_idempotency` keyed by project and idempotency key; and
- `prompt_proposal_applications` linking explicit approval to resulting
  template and binding revisions.

Constraints enforce valid stage, kind, layer, status, positive revisions,
bounded text, terminal timestamps, and one queued/running proposal per
project-stage. Writes are parameterized. Apply locks the current binding row and
performs proposal validation plus revision creation in one transaction.

History is newest-first with a fixed server page limit and opaque cursor. There
is no unbounded list endpoint.

## 13. Error contract

Safe proposal failure codes are:

- `provider_unavailable`;
- `provider_timeout`;
- `provider_rate_limited`;
- `invalid_provider_output`;
- `source_revision_changed`;
- `layer_locked`;
- `proposal_already_running`;
- `model_not_allowed`;
- `store_unavailable`; and
- `workflow_unavailable`.

Provider bodies, URLs, credential names, stack traces, prompt content, and raw
exceptions never appear in public errors or ordinary logs.

HTTP conventions are `202` for accepted creation, `404` for absent scoped
resources, `409` for conflicts, `422` for invalid contracts, and `503` for
unavailable dependencies. A provider-side rate limit is recorded as a terminal
safe proposal failure rather than returned from the already-completed create
request.

## 14. Security and privacy

- Existing authentication and project ownership checks protect every scoped
  endpoint.
- Provider/model IDs must match the server catalog exactly.
- Credentials exist only in the worker environment.
- No arbitrary endpoint or provider option crosses the API boundary.
- Hidden policy is assembled only inside the worker and never persisted.
- Prompt/proposal content is excluded from logs, Temporal history, metric
  labels, and public errors.
- Provider output remains untrusted until schema and bounds validation passes.
- Diff rendering uses text nodes; no Markdown or HTML execution is required.
- Apply accepts stable IDs, never client-authored replacement text.
- Applied revisions retain provider/model/proposal provenance without retaining
  raw provider payloads.

## 15. Verification strategy

### 15.1 Domain, repository, and migration

- Catalog identifiers, capabilities, preferences, locks, and revisions.
- Proposal transition matrix and immutable source/result fields.
- Improvement hunk reconstruction and translation layer separation.
- Stale and locked proposal rejection.
- Forward migration from C1, parameterized writes, and bounded history.
- Idempotency replay and conflicting-key rejection.
- One active generation per project-stage.
- Atomic Apply and rollback on every failed precondition.
- Immutable Apply provenance linking the approving actor and result revisions.

### 15.2 Workflow and provider

- Fake success, timeout, rate limit, unavailable, malformed, and oversized
  results.
- Exactly one adapter call with Temporal retry disabled.
- Prompt text and payload absence from Temporal history-facing data.
- Recovery after API restart using the persisted proposal ID.
- Worker startup rejects enabled providers with missing required local config.

### 15.3 API and dashboard

- Authentication and project isolation.
- Catalog, preference, lock, proposal, and Apply contracts.
- Safe `202`, `404`, `409`, `422`, and `503` behavior.
- Deterministic OpenAPI and generated TypeScript contracts.
- Starter and create-from-scratch empty states.
- Save-before-generate gating and per-stage preference preservation.
- Async recovery across stage switch, refresh-shaped reload, offline, and
  reconnect.
- Accessible status announcements without moving focus.
- Selective Improve Apply, whole Translate Apply, stale, locked, failed,
  rejected, superseded, and history states.
- Existing unsaved C1 drafts remain intact across C2 transitions.

All automated provider tests are offline and use fakes. A live request is a
separate operator-authorized gate after review, push, publication, and
deployment authorization.

## 16. Acceptance criteria

| ID | Requirement |
| --- | --- |
| AC1 | All three stages expose C2 while each action targets only the selected stage. |
| AC2 | A user can create from a starter or scratch without automatic database mutation. |
| AC3 | Provider/model is selected in UI from a server allowlist and stored per project-stage without exposing secrets. |
| AC4 | Improve accepts optional instructions and creates a durable proposal for one unlocked layer. |
| AC5 | Translate creates a complete target-language variant with layers preserved. |
| AC6 | Generation survives navigation/refresh and makes one provider attempt per explicit action. |
| AC7 | Improve supports selected-change Apply; Translate permits only whole Apply. |
| AC8 | Apply is atomic, revision-bound, lock-aware, and fails after source drift. |
| AC9 | No provider result modifies a template or binding before explicit Apply. |
| AC10 | Applied revisions are marked AI-assisted and retain immutable user-approval provenance. |
| AC11 | Raw payloads, credentials, hidden policy, endpoints, and prompt text are absent from browser secrets, Temporal history, normal logs, and public errors. |
| AC12 | Offline/reconnect preserves C1 drafts and restores proposal state accurately. |
| AC13 | Offline fake-provider, migration, domain, repository, workflow, API, generated-contract, dashboard, lint, and build gates pass. |

## 17. Delivery boundaries

The implementation plan must separate these operator gates:

1. offline implementation and tests;
2. Codex review and corrective rounds;
3. push and CI/image publication;
4. deployment of an approved digest;
5. one explicitly authorized live provider smoke using non-sensitive text; and
6. later production enablement.

Approval of this design authorizes only writing the implementation plan after
the operator reviews this file. It does not authorize product-code changes,
provider requests, secret access, push, deployment, or Stage 1 operations.
