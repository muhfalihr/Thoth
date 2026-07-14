# Content-Set Curation UI — Design (sub-project C)

Initiative: Operator Console. Sub-project **C** (of A shipped, B shipped, D deferred).
Date: 2026-07-14
Depends on: sub-project B (scout orchestration) — reuses its supervisor, SSE stream, and
`validate` command unchanged.
Status: DESIGN (approved, pre-plan)

## Problem

Sub-project B lands a validated content-set JSON on disk (`scout/output/thoth_content_set.json`)
and reports its path + `exists` in the Discovery view. But scout is imperfect: it sometimes keeps a
wrong `main`, leaks a black/off-topic comment crop, includes an irrelevant footage cutaway, or
carries hallucinated figures/references that mislead narration. Today the only fixes are hand-editing
the JSON or re-running scout wholesale. There is no way to **curate** a content-set between discovery
and render.

Sub-project C adds a dashboard view to **inspect and curate** the canonical content-set: prune bad
items, fix the two narration-grounding text fields, save in place, and re-validate — all without
touching thoth-core or re-running scout.

## Scope

**In scope (the "curate" surface):**
- Prune (delete) items from `footage[]`, `comments[]`, `figures[]`, `references[]`.
- Edit `main.title` and `main.description` (the fields that ground narration).
- Visual inspection: cover/thumbnails, comment crops, profile card (read-only).
- Save overwrites the canonical file in place; auto re-validate after save.

**Explicitly out of scope:**
- Swapping the main video URL, or adding brand-new footage/comments/figures by hand — that is
  re-running scout, not editing a content-set.
- Editing any field other than `main.title` / `main.description` (per-item metadata like
  `relevance`, `query`, `discourse`, etc. are preserved verbatim but not editable).
- Arbitrary content-set path picker — C operates only on the canonical default path. (Follow-up.)
- One-click Discovery → render hand-off — **sub-project D**.
- The non-video `image_path` render path (separate FOLLOW-UP in the content-set contract).

## Approach (chosen: opaque-JSON round-trip)

The server never models the content-set as a Rust type. It stays raw JSON end-to-end:
- `GET` reads the file and returns the **verbatim** parsed JSON.
- The browser holds the whole object and mutates only the allowed bits.
- `PUT` parses a **copy** of the request body only to shape-guard it, then persists the **original
  received bytes verbatim** (no re-serialize) — so formatting and key order are preserved too.

This keeps thoth-server lean (it has **no** thoth-core dependency — only thoth-jobs — and we keep it
that way) and is inherently **lossless**: `discourse`, per-item `relevance`/`query`, and any field the
Rust side does not know all survive a round-trip. A typed round-trip was rejected: it would add a
heavy thoth-core dependency and, because the structs use `#[serde(default)]` without
`deny_unknown_fields`, would silently drop unknown fields on re-serialize.

## Architecture

One new dashboard view + two thin JSON handlers + one token-guarded `ServeDir` nest. No new crate
dependency (`tower-http` already has the `fs` feature; `serde_json` already present).

### Global constraints (carried from B)

- Confined to `crates/thoth-server` + `dashboard`. NO thoth-core/thoth-jobs/thoth-types/worker
  change. NO SQL migration.
- Server cwd = repo root. Canonical content-set = `scout/output/thoth_content_set.json` (reuse the
  path resolution already in the existing `scout_content_set` handler). Images under `scout/output/`.
- `api.ts` is NOT compiler-enforced → hand-sync the TS types/functions to the Rust route bodies.
- `#[serde(default)]` on any new deserialized request field.
- Reuse B's single-slot supervisor + SSE + `validate` command; do not fork them.

### Server API

All routes under `/api` (bearer-guarded) except the image `ServeDir`, which is token-guarded via a
query param (see Image serving).

| Route | Purpose | Response / body |
|---|---|---|
| `GET /api/scout/content-set/data` | Read the file for editing | `{ path: String, exists: bool, output_root: String, content: Value \| null, error: Option<String> }` — `content` is the verbatim parsed JSON object, or `null` if the file is missing or malformed; `error = "malformed"` when the file exists but is not valid JSON; `output_root` = absolute `scout/output` so the client can relativize local image paths |
| `PUT /api/scout/content-set` | Save curated set | body = the whole edited object. Parse a copy to guard: is a JSON object, has a `main` key, and `footage`/`comments`/`figures`/`references` (when present) are arrays. On pass → write the received bytes verbatim to the canonical path (overwrite in place). `400 {error}` on guard fail; `500 {error}` on IO fail; `200 {ok:true, path}` on success |

Both handlers live alongside the existing scout handlers (`routes.rs` + supervisor in `scout.rs`) and
reuse the same canonical-path helper. Neither touches the single-slot supervisor state — reading and
writing the file is independent of running a scout command.

### Image serving

`.nest_service("/api/scout/output", ServeDir::new("scout/output"))`, wrapped in a
`middleware::from_fn_with_state` layer that extracts `?token=` from the request URI and compares it to
`state.api_key` (401 on mismatch) — mirroring the SSE `?token=` self-auth (`routes.rs`: `q.token !=
state.api_key`). `<img>` tags cannot send the bearer header, so the client appends `?token=<api_key>`
to every local-image `src`. Only local `image_path` fields (comment crops, profile/main/footage
post-crops under `scout/output/`) use this; remote `thumbnail` URLs are used directly.

Client image-URL derivation: if a local `image_path` starts with `output_root`, the URL is
`/api/scout/output/<path relative to output_root>?token=<api_key>`. This is robust to any subdirectory
under `scout/output/` (crops/ today), and keeps `content` verbatim (no server-side rewriting that
would corrupt the save round-trip).

### Dashboard view ("Content Set")

Fourth entry in the existing Runs/Config/Discovery view toggle. Rendered top-to-bottom:

- **Main card** — cover/thumbnail + `title` and `description` as editable text fields. Profile card
  (name/handle/followers/avatar) shown read-only if `main.profile` present.
- **Footage grid** — thumbnail + title + platform per item; each has a **✕ remove**.
- **Comments grid** — the crop PNG + author/text/likes per item; each has a **✕ remove**. The crop is
  the point: the operator prunes black/off-topic crops by seeing them.
- **Figures** / **References** — compact rows (name/term + kind + role/summary); each has **✕ remove**.
- **Footer bar** — dirty indicator, **Save** button, and a `LogPane` for the post-save RINGKASAN.

Reuses B's house conventions: `@/` alias, shared `Button`/`Input`, `LogPane` (as in Discovery), the
status source that reports whether a scout command is in-flight.

## Data flow

1. Open view → `GET …/content-set/data`.
   - `exists:false` → empty state: "No content-set yet — run Discovery first."
   - `error:"malformed"` → read-only raw-text view: "The content-set on disk isn't valid JSON."
   - else → render the editor from `content`.
2. Client holds the whole object. Remove buttons splice items out of the arrays; title/description
   edits mutate `main`. Dirty state tracked. **Save** enabled only when dirty AND no scout command is
   in-flight (the single slot means a running discover/validate could rewrite the file underneath).
3. **Save** → `PUT …/content-set` with the full object.
   - `200` → immediately kick the existing **validate** action (B's supervisor command) → `LogPane`
     streams the SSE; RINGKASAN reports renderable / what's missing. Then re-`GET` to repaint from the
     canonical file.
   - `400`/`500` → surface the error inline in the footer; keep the in-memory edit (nothing lost).

## Error handling & edges

- Missing file = empty state, not an error.
- Malformed on-disk JSON = read-only raw view (never silently overwrite an unparseable file).
- `PUT` guard rejects a set with no `main` or with non-array collections → `400`, editor state kept.
- `PUT` IO failure → `500`, editor state kept.
- Save disabled during any active scout run → avoids a write race on the single slot / canonical file.
- Validate reuses the single slot; if the slot is somehow busy, the existing 409 path applies and the
  UI reports it (Save already gated on not-in-flight makes this rare).

## Testing

**Server (mirror B's `routes_http.rs` integration style):**
- `GET`: exists / missing (`exists:false`) / malformed (`error:"malformed"`, `content:null`).
- `PUT` happy path: **lossless round-trip** — a fixture containing `discourse` + unknown/extra fields,
  PUT unchanged, read the file back, assert it equals the input (bytes identical since we persist
  verbatim; at minimum `serde_json::Value` deep-equal — proves no field drop). This is the
  load-bearing test for the whole approach.
- `PUT` guards: reject non-object body / missing `main` / non-array `footage` (etc.) → `400`.
- Image route: serves a fixture PNG with a valid `?token=`; `401` without / wrong token.

**Client:** the dashboard ships no component-test harness today, so C follows B's precedent — a
manual-integration doc (`docs/superpowers/plans/2026-07-14-content-set-editor-manual-test.md`):
load → prune footage/comment/figure → edit title/description → Save → auto-validate → RINGKASAN.

**`api.ts` hand-sync** (not compiler-enforced): add `getContentSetData()` / `putContentSet()` + the TS
response type mirroring the Rust route bodies. No `JobSpec`/`JobRecord`/`JobStatus`/`JobEvent` change.

**Build gate (per CLAUDE.md):** `build_cuda.bat` EXIT 0 via PowerShell + verify `thoth-server.exe`
mtime advanced + `cargo test --workspace` + `dashboard` `bun run build` + BLUEPRINT update.

## Out of scope (later sub-projects)

- One-click Discovery → render hand-off (pre-filling `RunForm`) — **sub-project D**.
- Arbitrary content-set path picker / multiple content-sets — C follow-up.
- Adding new items or editing arbitrary fields — that is scout's job, not curation.
- Discovery run history / audit table.
