# Python Scout Migration Roadmap

**Status:** Active migration knowledge

**Last updated:** 2026-08-31

## Purpose

This roadmap describes how CLIPPER will replace the Bun/TypeScript runtime under `scout/` with Python without performing a big-bang rewrite. The React dashboard remains TypeScript, and the Rust media engine remains responsible for media-heavy work. The retirement target is specifically the TypeScript Scout runtime, its CLI, and its worker subprocess adapter.

The first active migration slice is defined in [Python TikTok Scout Rewrite Design](superpowers/specs/2026-08-31-python-tiktok-scout-rewrite-design.md).

## Architecture Direction

The migration is organized around deep Python modules with small interfaces. It is not a file-for-file translation of TypeScript implementation details.

```text
Current

FastAPI -> Temporal -> Python placeholder / LegacyScoutActivity -> Bun Scout

Target

FastAPI -> Temporal
                |-- Python acquisition
                |-- Python source intelligence
                |-- Python content assembly
                |-- Python enrichment
                `-- Rust media engine
                          |
                          `-- validated content-set
```

Each capability crosses the same migration gates:

```text
offline fixtures
    -> Python implementation
    -> contract parity
    -> controlled live smoke
    -> shadow operation
    -> Python preferred
    -> Python only
    -> legacy removal
```

Fallback is retired per capability and per platform. A platform that has passed its gates does not need to wait for every other platform before operating Python-only.

## Migration Stages

| Stage | Primary result | Exit gate |
|---|---|---|
| 1. TikTok single post | Headless-first TikTok inspection and media materialization | Offline tests, live smoke, cancellation, and parity pass |
| 2. Complete TikTok vertical slice | All active TikTok acquisition capabilities run in Python | Normal TikTok operation no longer needs Scout fallback |
| 3. Remaining platform adapters | Threads, Instagram, X, Facebook, YouTube, and Reddit use the Python acquisition kernel | Parity and live smoke pass per platform |
| 4. Source intelligence | Source tracing, credit evidence, OCR, and candidate decisions move to Python | Original-source decision matches the stable Scout contract |
| 5. Content assembly | Comments, footage, figures, main candidate, and media gates move to Python | A complete valid content-set is produced without Scout |
| 6. Enrichment | Topic dossier, web grounding, CKB, and cultural pulse move to Python | Enriched output meets the accepted fixture contract |
| 7. Durable orchestration | Temporal replaces `run_pipeline.ts` orchestration | Runs are restart-safe, idempotent, observable, and resumable |
| 8. Discovery | Curated feeds, trending, and topic-to-URL flows move to Python | Daily discovery produces typed workflow inputs without Bun |
| 9. Cutover | Python becomes the only normal execution path | No production workflow invokes Scout |
| 10. Retirement | Legacy adapter, CLI, dependencies, and Scout files are removed | Full regression and operational soak pass |

## Stage 1: TikTok Single-Post Acquisition

**Stage 1 status:** Implemented; live gates passed. The deterministic suite, the controlled
live acquisition smoke, the live cancellation gate, and the same-URL Python/Scout parity gate
all pass on a first-party public TikTok post. The operational soak and the capability-specific
retirement decision remain open, so Scout stays reachable through the explicit fallback mode.
The authoritative
[design specification](superpowers/specs/2026-08-31-python-tiktok-scout-rewrite-design.md) and
[implementation plan](superpowers/plans/2026-08-31-python-tiktok-scout-rewrite.md) define this
slice and its retirement gates.

The first slice accepts one public TikTok post URL.

```text
TikTok URL
    -> safe URL validation
    -> Scrapling headless acquisition
    -> local media materialization
    -> TikWM/CDN fallback when headless is incomplete or fails
    -> temporary legacy fallback when explicitly enabled
    -> source-report.json
```

Required outcomes:

- Scrapling headless is always attempted first.
- TikWM is called only after a categorized headless failure, incomplete result, or failed headless-media materialization.
- Ephemeral CDN media is materialized immediately.
- Persisted reports do not contain signed URLs, cookies, raw HTML, raw provider responses, or absolute paths.
- Cancellation closes browser resources and removes partial files.
- The normalized result matches the stable subset of the TypeScript TikTok contract.

## Stage 2: Complete the TikTok Vertical Slice

After single-post inspection and media materialization are stable, migrate the remaining active TikTok capabilities individually:

1. Post metadata.
2. Media resolution and materialization.
3. Comment collection.
4. Social-card or screenshot capture.
5. Profile discovery.
6. Keyword and trending discovery.
7. Engagement and publication-time normalization.

At the end of this stage, normal TikTok inputs must run Python-only. The TypeScript path remains available only as a time-bounded emergency switch until its removal gate is approved.

## Stage 3: Port the Remaining Platform Adapters

Reuse the acquisition kernel proven by TikTok. The recommended order is:

1. Threads, because its browser and ephemeral-CDN behavior is closest to TikTok.
2. Instagram, including carousel and public/authenticated page behavior.
3. X and Facebook, which depend heavily on browser and network-capture behavior.
4. YouTube and Reddit, which can use more public metadata and direct HTTP behavior.

Each platform follows the same sequence:

```text
sanitized fixture
    -> adapter implementation
    -> offline contract tests
    -> Scout parity comparison
    -> live smoke
    -> shadow operation
    -> Python only
```

Do not expose provider or browser controls through FastAPI, the dashboard, or Temporal workflow inputs. Those details remain private implementation choices inside the acquisition module.

## Stage 4: Move Source Intelligence

This stage replaces behavior currently spread across source tracing, source resolution, credit scanning, OCR, subtitle vision, and main-candidate ranking.

The target interface is conceptually:

```python
decision = await source_attributor.identify(content_set)
```

The module hides:

- credit and watermark parsing;
- OCR and subtitle evidence;
- platform-logo evidence;
- candidate search and ranking;
- source plausibility checks;
- LLM-assisted source explanation; and
- safe rejection reasons.

Callers receive a typed decision, cited evidence, and safe failure. They do not receive provider payloads or need to understand OCR, LLM, or browser implementation details.

Video frame extraction and other media-heavy operations may remain Rust activities reached through a small adapter. They do not need to move to Python merely to eliminate Scout TypeScript.

## Stage 5: Move Content Assembly

Port the behavior that builds:

- `comments[]`;
- `footage[]`;
- `figures[]`;
- the selected main candidate;
- image paths and local media references;
- relevance and suitability gates; and
- the validated content-set.

The target interface is conceptually:

```python
content_set = await content_assembler.build(request)
```

Every sub-stage writes a versioned artifact with a checksum. A retry must either reuse the completed artifact or replace it atomically; it must not silently duplicate comments, footage, or figures.

## Stage 6: Move Enrichment

Port the active enrichment behavior:

- topic dossier creation;
- comment context and discourse analysis;
- web grounding;
- Cultural Knowledge Base reads and writes; and
- cultural-pulse harvesting.

LLM providers sit behind a replaceable interface. Domain models and Temporal workflows must not know the payload format, endpoint, or credentials of Novita, Groq, or another provider.

Enrichment output is accepted only when deterministic fixtures validate its schema, citations, redaction rules, and merge behavior. Exact natural-language wording does not need byte-for-byte parity.

## Stage 7: Replace `run_pipeline.ts` with Temporal Orchestration

Do not create a monolithic `run_pipeline.py`. The durable workflow coordinates idempotent activities:

```text
inspect source
    -> identify original source
    -> request approval when required
    -> collect comments
    -> build footage
    -> extract figures
    -> enrich context
    -> validate content-set
    -> publish artifact
```

After each activity:

- the artifact is persisted atomically;
- its checksum and schema version are recorded;
- a safe workflow event is emitted;
- retries are bounded and idempotent; and
- a worker restart can resume from durable state.

The workflow coordinates modules. It does not contain provider calls, browser logic, filesystem conventions, FFmpeg commands, or fallback implementation details.

## Stage 8: Move Discovery

Discovery moves after the single-URL content pipeline is stable because discovery produces candidate URLs rather than finished content-sets.

Replace:

- curated Instagram account discovery;
- TikTok trending discovery;
- X and YouTube topic discovery;
- topic-to-URL conversion;
- batch scheduling; and
- partial discovery checkpoints.

Discovery outputs a strict candidate list that starts the same durable workflow used by direct user URLs. It never launches a pipeline subprocess.

## Stage 9: Operational Cutover

Use four explicit operating states:

```text
shadow
    -> python_preferred
    -> python_only
    -> legacy_disabled
```

### `shadow`

Python and Scout process controlled fixtures or bounded traffic. Their normalized results are compared, but Scout remains authoritative.

### `python_preferred`

Python is authoritative. An eligible structured acquisition failure may invoke the legacy adapter while fallback telemetry is collected.

### `python_only`

Python failures remain structured failures. They do not invoke Bun.

### `legacy_disabled`

Workers no longer register the legacy activity. Deployment rollback, rather than a hidden subprocess fallback, is the recovery mechanism.

## Stage 10: Retire Scout TypeScript

Scout can be retired only when:

- every active Scout command has a Python workflow or typed CLI replacement;
- the dashboard no longer depends on `/api/scout/*`;
- no worker, script, test, or operations document invokes `bun scout/cli.ts`;
- important Scout fixtures and regressions have Python equivalents;
- every production artifact required downstream can be produced and consumed without the legacy format;
- Python-only operation has completed the agreed operational soak period; and
- rollback has been tested at the deployment level.

Retirement then proceeds in this order:

1. Stop registering `LegacyScoutActivity`.
2. Remove legacy activity modes and configuration.
3. Remove Scout CLI entry points and Bun runtime dependencies.
4. Archive or delete the `scout/` implementation.
5. Remove legacy dashboard controls and obsolete documentation.
6. Run complete Python, dashboard, Rust, workflow, and render regressions.

## Rules for Every Migration Slice

- Give each major stage its own design specification and implementation plan.
- Move behavior by capability and platform, not by translating folders wholesale.
- Keep typed domain contracts stable while adapters change behind their seams.
- Keep browser and provider details out of workflow history and public interfaces.
- Preserve Rust where it is the better media engine; eliminating Scout does not require a Python-only repository.
- Require offline fixtures before live tests.
- Require controlled live smoke before changing the authoritative path.
- Treat cancellation, retry, artifact atomicity, redaction, and restart behavior as acceptance requirements, not follow-up hardening.
- Remove fallback as soon as its capability-specific retirement gates pass.
- Never declare the migration complete while any production path still requires Bun Scout.

## Immediate Next Step

The Stage 1 live gate has passed. Complete the agreed operational soak on the Python acquisition
path, then make the capability-specific retirement decision for TikTok single-post acquisition.
Keep `legacy_scout` and `python_tiktok_with_legacy_fallback` reachable until that decision is
made, and do not widen Stage 1 scope beyond one public TikTok post URL.

Two operational items carry into the soak:

- Configure logging for the `scrapling` logger in the production worker. The library logs signed
  CDN URLs at INFO. Reports, Temporal history, and events stay clean -- this is library stdout
  only -- but those logs must not be shipped as-is.
- Install the `acquisition` extra and its browsers on worker hosts only. The ordinary test suite
  is deterministic with or without the extra and never requires it.
