# Shared Acquisition Kernel — Acceptance Record

Branch: `worktree-shared-acquisition-kernel` (base `e4803b4`)
Plan: `docs/superpowers/plans/2026-08-02-shared-acquisition-kernel.md`
Recorded: 2026-08-11

Two halves. **Part A** is the automated regression record — already run, and
reproducible by anyone. **Part B** is the manual live-platform checklist; it can
only be completed by a human operator at the visible managed browser, because it
requires real logged-in sessions. **Part B is NOT done.** Part A being green is
enough to integrate the branch; it is not enough to declare the kernel accepted
against real platforms.

---

## Safety rules for Part B — read before touching a live platform

1. **Stop that platform immediately** on any of: a login wall, a CAPTCHA, a
   checkpoint or account-verification prompt, `401`, `403`, or `429`. Record
   `SKIP` with the reason. Do not retry, do not refresh, do not switch accounts.
2. **Never induce a rate limit or challenge on purpose.** The circuit breaker is
   verified with a *simulated* adapter `429` in Part A — never against a real
   platform.
3. **Never paste into this file**, or into any log, issue, or commit message:
   request or response headers, cookies, `Authorization` or CSRF values, signed
   CDN URLs, request bodies, or response bodies. Record only PASS / FAIL / SKIP
   and a one-line non-sensitive reason.
4. One canonical URL per platform per session. The kernel allows at most one
   browser navigation per canonical URL per run; the acceptance pass must not
   work around that.
5. The managed browser stays **visible** and uses its persistent dedicated
   profile. No stealth plugins, no fingerprint spoofing, no CAPTCHA bypass, no
   randomized human simulation, no sidecar daemon.

---

## Part B — live platform checklist (operator)

Fill each cell with `PASS`, `FAIL`, or `SKIP — <short safe reason>`.

- **Metadata** — the first `inspectPost` on the supplied URL resolves normalized
  metadata (`canonical_url`, `platform`, `post_id`, `owner_handle`, `text`,
  `media[]`) with `outcome.status === 'resolved'`.
- **Media** — media materializes: original images and carousels prefer
  `gallery-dl`; video uses a captured CDN URL, falling back to `yt-dlp`.
- **Cache reuse** — a second identical request reports a cache source and
  performs **no** navigation.
- **Social/comment card** — where the platform supports it, a targeted CDP
  screenshot is produced, and only for explicitly selected items.
- **Safe failure** — when the platform declines, the run degrades with a typed
  `AcquisitionError` outcome and stops that platform rather than retrying.

| Platform | URL used | Metadata | Media | Cache reuse | Social/comment card | Safe failure |
|---|---|---|---|---|---|---|
| Instagram |  |  |  |  |  |  |
| X/Twitter |  |  |  |  |  |  |
| TikTok |  |  |  |  |  |  |
| YouTube |  |  |  |  |  |  |
| Facebook |  |  |  |  |  |  |
| Threads |  |  |  |  |  |  |
| Reddit |  |  |  |  |  |  |

### Post-run privacy audit (operator)

- [ ] `scout/output/acquisition-cache/v1` holds no signed CDN URLs, cookies,
      authorization or CSRF values, headers, request bodies, or response bodies.
- [ ] The generated content set holds none of the above.
- [ ] Console output captured during the pass holds none of the above.

### Operator notes

_(one line per platform, non-sensitive)_

### Known gap this pass must close

Instagram discovery's post-recency gate and the `browse()` plumbing around the
profile-grid DOM scrape are exercised only against stubs in Part A. They need a
real-CDP pass here.

---

## Part A — automated regression record (2026-08-11)

All commands run from `scout/`, every one prefixed with `rtk` per repo
convention.

### Step 2 — Scout regressions

| Command | Result |
|---|---|
| `rtk bun run test:acquisition` | exit 0 — `ok acquisition_suite` (46 `ok` lines, incl. `ok acquisition_boundary`) |
| `rtk bun x tsc --noEmit` | exit 0 |
| every `pipeline/*.test.ts` and `lib/*.test.ts` (31 files) | all exit 0 |
| `rtk bun run lint` | **exit 1 — pre-existing repo-wide debt, see below** |

`bun run lint` (biome) reports 265 errors across 147 files repo-wide. 141 of
those live in files this branch never touched. Measured directly on the 29
files the branch *modified*: 235 diagnostics at base `e4803b4` versus 204 at
HEAD — the branch strictly reduced lint debt on the files it touched. Safe
biome fixes were then applied to the files this branch created
(`style(scout): apply biome safe fixes to kernel-era files`), excluding
`scout/acquisition/adapters/`, which stays frozen. The remaining failures are
legacy scraper style debt (`useTemplate`, `noGlobalIsNan`, `noSparseArray`,
unused `catch (e)` bindings) and are out of scope for this branch.

### Step 3 — content-set schema compatibility

| Command | Result |
|---|---|
| `rtk proxy bun pipeline/validate_content_set.ts output/thoth_content_set.json` | exit 0 — `✓ PASS (errors=0, warnings=0)` |
| `rtk cargo check -p thoth-core` | exit 0 — finished in 47.94s, no schema changes needed |

The fixture is a single-video TikTok content set carrying the full OCR contract
(`ocr_status: analyzed`, schema version 1, configured model, matching frame
counts, `ocr_outcome: clean`) and the clean directives (`trim_start`,
`mute_audio`, `subtitle_blur`). `scout/output/` is gitignored, so regenerate the
fixture before re-running this step.

### Step 4 — controlled acceptance, automated portion only

| Check | Result |
|---|---|
| Circuit breaker on simulated `429` / `rate-limited` | covered by `acquisition/browser_coordinator.test.ts` plus the reddit, tiktok, twitter and youtube adapter tests — all exit 0. No real platform was rate-limited. |
| Persisted cache privacy — `output/acquisition-cache/v1/records.json` (19,951 bytes, real prior-run data) | CLEAN. No signed-URL parameters (`sig`, `signature`, `_nc_sid`, `_nc_ohc`, `efg`, `oh`, `oe`), no cookies or `sessionid`/`csrftoken`, no `authorization`/`bearer`/`x-csrf-token`, no `ephemeral_url` key, no `headers`, no request or response body. |
| Content-set privacy — `output/thoth_content_set.json`, `output/reel_topics.json` | CLEAN against the same patterns. |
| Downloader invocation | no `exec(`, `execSync(`, or `shell: true` anywhere under `scout/acquisition/`. Downloaders go through `execFile` with argument arrays (`acquisition/service.ts`). |

**Part B was not performed** — it needs a human operator with real logged-in
sessions on seven platforms.

### Step 5 — commit

This record is committed as `test(scout): record acquisition acceptance`.
