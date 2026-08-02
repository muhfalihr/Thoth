# Shared Acquisition Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Scout discovery, post inspection, comments, media downloads, and social-card screenshots through one safe, cached, cross-platform acquisition kernel.

**Architecture:** Add a run-scoped `AcquisitionService` with normalized contracts, canonical URL identities, a persistent sanitized cache, one serialized CDP coordinator, capability-aware source policy, and focused platform adapters. Convert pipeline stages from subprocess-only scripts into importable async functions so one run context can enforce navigation deduplication and platform circuits from seed creation through validation.

**Tech Stack:** Bun, TypeScript with NodeNext modules, raw Chrome DevTools Protocol, Node built-ins, `gallery-dl`, yt-dlp, existing Scout scrapers and content-set types.

## Global Constraints

- All shell commands in this repository are prefixed with `rtk`.
- The managed Chromium browser stays visible and uses its persistent dedicated profile.
- Browser navigation concurrency is exactly one globally.
- A canonical post URL receives at most one browser navigation per pipeline run.
- Network capture deadline defaults to 15 seconds.
- Transport timeouts receive at most two attempts; every other acquisition outcome receives one attempt.
- Cache TTLs are 30 minutes for discovery, six hours for normalized post metadata, and 15 minutes for negative results.
- Signed CDN URLs, cookies, authorization values, CSRF values, complete headers, request bodies, and response bodies are never persisted.
- Captured private GraphQL requests are observed but never replayed.
- Original images and carousels prefer `gallery-dl`; contextual posts and comments use targeted CDP screenshots.
- Do not add stealth plugins, fingerprint spoofing, CAPTCHA bypass, randomized human simulation, or a persistent sidecar daemon.
- Keep the Rust content-set schema backward compatible and preserve Scout's existing ownership, relevance, suitability, OCR, and story gates.
- Downloader processes use argument arrays through `execFile`; never construct shell command strings.
- Existing user changes are preserved. Begin execution only from a clean, synchronized branch in an isolated worktree created with `superpowers:using-git-worktrees`.

---

## Planned File Structure

### New foundation files

- `scout/acquisition/types.ts` — public normalized contracts and adapter interfaces.
- `scout/acquisition/config.ts` — exact defaults and environment parsing.
- `scout/acquisition/url.ts` — platform detection and canonical URL identities.
- `scout/acquisition/cache.ts` — run memoization and sanitized durable cache.
- `scout/acquisition/browser_coordinator.ts` — intent registry, serialized visits, circuits, and malformed-response counters.
- `scout/acquisition/network_capture.ts` — generic CDP response observation and listener cleanup.
- `scout/acquisition/policy.ts` — capability-aware source ordering.
- `scout/acquisition/materialize.ts` — content-addressed direct HTTP, `gallery-dl`, and yt-dlp materialization.
- `scout/acquisition/service.ts` — facade, adapter registry, fallback execution, and shared run context.
- `scout/acquisition/index.ts` — stable public exports.

### New adapter files

- `scout/acquisition/adapters/instagram.ts`
- `scout/acquisition/adapters/twitter.ts`
- `scout/acquisition/adapters/tiktok.ts`
- `scout/acquisition/adapters/youtube.ts`
- `scout/acquisition/adapters/facebook.ts`
- `scout/acquisition/adapters/threads.ts`
- `scout/acquisition/adapters/reddit.ts`
- `scout/acquisition/adapters/json_walk.ts` — bounded recursive lookup shared by version-tolerant network parsers.
- Matching `*.test.ts` files beside each focused unit.

### Existing files migrated behind the kernel

- `scout/lib/cdp.ts` — expose safe event subscription primitives used by the observer.
- `scout/lib/paths.ts` and `scout/lib/redact.ts` — acquisition cache path and stricter safe diagnostic helpers.
- `scout/pipeline/run_pipeline_step.ts` — support async in-process stage execution.
- `scout/pipeline/run_pipeline.ts` — create one run context and call exported stage functions.
- `scout/pipeline/trace_source.ts`
- `scout/pipeline/build_footage.ts`
- `scout/pipeline/collect_comments.ts`
- `scout/pipeline/discover_reels.ts`
- `scout/pipeline/topic_to_urls.ts`
- `scout/pipeline/enrich_image_paths.ts`
- `scout/pipeline/extract_figures.ts`
- `scout/pipeline/validate_content_set.ts`
- `scout/enrich/topic_dossier.ts`
- Existing CLI behavior remains available through `if (import.meta.main)` wrappers.

---

### Task 1: Normalized contracts, configuration, and canonical identities

**Files:**
- Create: `scout/acquisition/types.ts`
- Create: `scout/acquisition/config.ts`
- Create: `scout/acquisition/url.ts`
- Create: `scout/acquisition/url.test.ts`
- Modify: `scout/tsconfig.json`

**Interfaces:**
- Produces: `Platform`, `AcquisitionIntent`, `AcquisitionSource`, `AcquisitionOutcome`, `PostRecord`, `MediaAsset`, `CommentRecord`, `DiscoveryRequest`, `DiscoveryResult`, `LocalAsset`, `PlatformAdapter`, `canonicalizeUrl()`, `platformForUrl()`, and `readAcquisitionConfig()`.
- Consumes: Node `URL`; no acquisition module dependencies.

- [ ] **Step 1: Write the failing canonicalization test**

```ts
// scout/acquisition/url.test.ts
import assert from 'node:assert/strict';
import { canonicalizeUrl, platformForUrl } from './url.ts';

assert.equal(
  canonicalizeUrl(
    'https://www.instagram.com/p/DbgARkAjHPS/?utm_source=ig_web_copy_link&igsh=secret',
  ),
  'https://www.instagram.com/p/DbgARkAjHPS/',
);
assert.equal(
  canonicalizeUrl('https://x.com/user/status/123?s=20#fragment'),
  'https://x.com/user/status/123',
);
assert.equal(
  canonicalizeUrl('https://www.youtube.com/watch?v=ABC123&utm_source=test'),
  'https://www.youtube.com/watch?v=ABC123',
);
assert.equal(
  canonicalizeUrl('https://www.facebook.com/story.php?story_fbid=9&id=7&utm_source=x'),
  'https://www.facebook.com/story.php?id=7&story_fbid=9',
);
assert.equal(platformForUrl('https://www.reddit.com/r/test/comments/abc/post/'), 'reddit');
assert.throws(() => canonicalizeUrl('not a URL'), /unsupported URL/i);

console.log('ok acquisition_url');
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `rtk proxy bun acquisition/url.test.ts` from `scout/`
Expected: FAIL with `Cannot find module './url.ts'`.

- [ ] **Step 3: Add exact public contracts and defaults**

```ts
// scout/acquisition/types.ts
import type { CdpClient } from '../lib/cdp.ts';

export type Platform =
  | 'instagram'
  | 'twitter'
  | 'tiktok'
  | 'youtube'
  | 'facebook'
  | 'threads'
  | 'reddit';

export type AcquisitionIntent = 'inspect' | 'comments' | 'media' | 'social-card';
export type AcquisitionSource =
  | 'cache'
  | 'network'
  | 'public-metadata'
  | 'gallery-dl'
  | 'yt-dlp'
  | 'direct-http'
  | 'dom';
export type AcquisitionReason =
  | 'timeout'
  | 'not-found'
  | 'unsupported'
  | 'rate-limited'
  | 'auth-required'
  | 'challenge'
  | 'invalid-response'
  | 'materialization-failed';

export interface AcquisitionOutcome {
  status: 'resolved' | 'unavailable' | 'blocked';
  source?: AcquisitionSource;
  attempts: number;
  elapsed_ms: number;
  reason?: AcquisitionReason;
}

export class AcquisitionError extends Error {
  constructor(
    message: string,
    readonly outcome: AcquisitionOutcome,
  ) {
    super(message);
    this.name = 'AcquisitionError';
  }
}

export interface MediaAsset {
  id: string;
  kind: 'image' | 'video';
  index: number;
  canonical_post_url: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  ephemeral_url?: string;
}

export interface PostRecord {
  canonical_url: string;
  platform: Platform;
  post_id: string;
  owner_handle: string;
  text: string;
  published_at?: string;
  engagement?: Record<string, number>;
  media: MediaAsset[];
  outcome: AcquisitionOutcome;
}

export interface CommentRecord {
  id: string;
  author: string;
  text: string;
  likes: number;
  image_path?: string;
}

export interface DiscoveryRequest {
  platform: Platform;
  kind: 'query' | 'profile' | 'trending';
  value: string;
  limit: number;
}

export interface DiscoveryResult {
  items: PostRecord[];
  outcome: AcquisitionOutcome;
}

export interface LocalAsset {
  path: string;
  kind: 'image' | 'video' | 'social-card';
  source: AcquisitionSource;
  bytes: number;
}

export interface CommentLimits {
  max: number;
}

export type SocialCardPurpose = 'post' | 'comment';
export type AssetPurpose = 'main' | 'footage' | 'ocr';

export interface AdapterContext {
  intents(url: string): ReadonlySet<AcquisitionIntent>;
  visit<T>(
    platform: Platform,
    url: string,
    acquire: (client: CdpClient, intents: ReadonlySet<AcquisitionIntent>) => Promise<T>,
  ): Promise<T>;
  now(): number;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  supports(url: string): boolean;
  discover(request: DiscoveryRequest, context: AdapterContext): Promise<DiscoveryResult>;
  inspect(url: string, context: AdapterContext): Promise<PostRecord>;
  collectComments(
    url: string,
    limits: CommentLimits,
    context: AdapterContext,
  ): Promise<CommentRecord[]>;
  captureSocialCard(
    url: string,
    purpose: SocialCardPurpose,
    context: AdapterContext,
  ): Promise<LocalAsset>;
}
```

```ts
// scout/acquisition/config.ts
export interface AcquisitionConfig {
  captureDeadlineMs: number;
  transportAttempts: number;
  discoveryTtlMs: number;
  postTtlMs: number;
  negativeTtlMs: number;
  galleryDl: string;
  ytdlp: string;
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function readAcquisitionConfig(
  env: Record<string, string | undefined> = process.env,
): AcquisitionConfig {
  return {
    captureDeadlineMs: positiveInt(env.THOTH_ACQUISITION_CAPTURE_MS, 15_000),
    transportAttempts: 2,
    discoveryTtlMs: positiveInt(env.THOTH_ACQUISITION_DISCOVERY_TTL_MS, 1_800_000),
    postTtlMs: positiveInt(env.THOTH_ACQUISITION_POST_TTL_MS, 21_600_000),
    negativeTtlMs: positiveInt(env.THOTH_ACQUISITION_NEGATIVE_TTL_MS, 900_000),
    galleryDl: env.GALLERY_DL?.trim() || 'gallery-dl',
    ytdlp: env.YTDLP?.trim() || 'yt-dlp',
  };
}
```

Implement `url.ts` with platform-specific identity query allowlists: YouTube keeps only `v`; Facebook keeps `id`, `story_fbid`, and `v`; other supported platforms drop query and fragment. Sort preserved parameters by key, normalize hostname to lowercase, remove default ports, and keep the platform pathname.

Add `"acquisition/**/*.ts"` to `tsconfig.json`'s `include` array.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `rtk proxy bun acquisition/url.test.ts` from `scout/`
Expected: `ok acquisition_url`.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit the contracts**

```powershell
rtk git add scout/acquisition/types.ts scout/acquisition/config.ts scout/acquisition/url.ts scout/acquisition/url.test.ts scout/tsconfig.json
rtk git commit -m "feat(scout): define acquisition contracts"
```

---

### Task 2: Sanitized durable cache and run memoization

**Files:**
- Create: `scout/acquisition/cache.ts`
- Create: `scout/acquisition/cache.test.ts`
- Modify: `scout/lib/paths.ts`
- Modify: `scout/lib/redact.ts`

**Interfaces:**
- Consumes: `PostRecord`, `DiscoveryResult`, `AcquisitionConfig`, `canonicalizeUrl()`.
- Produces: `AcquisitionCache.get()`, `getRun()`, `setPost()`, `setDiscovery()`, `setNegative()`, `memoize()`, and `sanitizeCacheValue()`.

- [ ] **Step 1: Write failing cache tests**

```ts
// scout/acquisition/cache.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcquisitionCache } from './cache.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-acquisition-cache-'));
let clock = 1_000;
try {
  const cache = new AcquisitionCache({ root, now: () => clock });
  const post = {
    canonical_url: 'https://www.instagram.com/p/ABC/',
    platform: 'instagram' as const,
    post_id: 'ABC',
    owner_handle: 'owner',
    text: 'caption',
    media: [
      {
        id: 'ABC:1',
        kind: 'image' as const,
        index: 1,
        canonical_post_url: 'https://www.instagram.com/p/ABC/',
        ephemeral_url: 'https://cdn.test/image.jpg?sig=secret',
      },
    ],
    outcome: { status: 'resolved' as const, source: 'network' as const, attempts: 1, elapsed_ms: 2 },
  };
  cache.setPost(post, 100);
  assert.equal(cache.getPost(post.canonical_url)?.text, 'caption');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'records.json'), 'utf8'), /cdn\.test|secret/);
  clock += 101;
  assert.equal(cache.getPost(post.canonical_url), null);

  let calls = 0;
  const one = cache.memoize('same', async () => {
    calls++;
    return 'value';
  });
  const two = cache.memoize('same', async () => 'wrong');
  assert.equal(await one, 'value');
  assert.equal(await two, 'value');
  assert.equal(cache.getRun('same'), 'value');
  assert.equal(calls, 1);
  console.log('ok acquisition_cache');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the cache test and verify failure**

Run: `rtk proxy bun acquisition/cache.test.ts` from `scout/`
Expected: FAIL with missing `./cache.ts`.

- [ ] **Step 3: Implement atomic sanitized persistence**

Add `ACQUISITION_CACHE_DIR = path.join(OUTPUT_DIR, 'acquisition-cache', 'v1')` to `lib/paths.ts` and export it.

Implement `AcquisitionCache` with:

```ts
type CacheEnvelope<T> = { expires_at: number; value: T };
type CacheFile = {
  version: 1;
  posts: Record<string, CacheEnvelope<PostRecord>>;
  discoveries: Record<string, CacheEnvelope<DiscoveryResult>>;
  negatives: Record<string, CacheEnvelope<AcquisitionOutcome>>;
};

export function sanitizeCacheValue(post: PostRecord): PostRecord {
  return {
    ...post,
    media: post.media.map(({ ephemeral_url: _secret, ...asset }) => asset),
  };
}
```

Use `createHash('sha256')` for URL keys. Write `records.json.tmp` and rename it to `records.json` after every mutation. Keep resolved same-run values in a separate in-memory `Map<string, unknown>` so ephemeral media references remain available for registered later intents. Store in-flight promises in `Map<string, Promise<unknown>>`; remove every promise in `finally` after it settles while retaining its resolved run value. Durable writes always pass through `sanitizeCacheValue()`. Extend `sanitizeResolverDetail()` tests to cover Instagram GraphQL variables, signed query strings, and `x-csrf-token` without persisting any of their values.

```ts
const capturedRequest = sanitizeResolverDetail(
  'x-csrf-token: csrf-secret variables={"shortcode":"ABC","token":"private"} ' +
    'https://cdn.test/image.jpg?oe=secret&sig=signed',
);
assert.doesNotMatch(capturedRequest, /csrf-secret|private|signed|https?:\/\//i);
```

- [ ] **Step 4: Verify cache and redaction behavior**

Run: `rtk proxy bun acquisition/cache.test.ts` from `scout/`
Expected: `ok acquisition_cache`.

Run: `rtk proxy bun lib/media_resolution.test.ts` from `scout/`
Expected: `ok media_resolution`.

- [ ] **Step 5: Commit the cache**

```powershell
rtk git add scout/acquisition/cache.ts scout/acquisition/cache.test.ts scout/lib/paths.ts scout/lib/redact.ts scout/lib/media_resolution.test.ts
rtk git commit -m "feat(scout): add sanitized acquisition cache"
```

---

### Task 3: Run-scoped browser coordinator and circuit breaker

**Files:**
- Create: `scout/acquisition/browser_coordinator.ts`
- Create: `scout/acquisition/browser_coordinator.test.ts`

**Interfaces:**
- Consumes: `Platform`, `AcquisitionIntent`, `AcquisitionOutcome`, `canonicalizeUrl()`.
- Produces: `BrowserCoordinator.registerIntent()`, `intents()`, `visitOnce()`, `recordOutcome()`, `isBlocked()`, and `blockedOutcome()`.

- [ ] **Step 1: Write failing serialization, deduplication, and circuit tests**

```ts
// scout/acquisition/browser_coordinator.test.ts
import assert from 'node:assert/strict';
import { BrowserCoordinator } from './browser_coordinator.ts';

const coordinator = new BrowserCoordinator();
const url = 'https://www.instagram.com/p/ABC/?utm_source=test';
coordinator.registerIntent(url, 'inspect');
coordinator.registerIntent(url, 'social-card');
assert.deepEqual([...coordinator.intents(url)].sort(), ['inspect', 'social-card']);

let active = 0;
let maxActive = 0;
let visits = 0;
const acquire = async () => {
  visits++;
  active++;
  maxActive = Math.max(maxActive, active);
  await Promise.resolve();
  active--;
  return { value: visits };
};
const [first, second] = await Promise.all([
  coordinator.visitOnce('instagram', url, acquire),
  coordinator.visitOnce('instagram', url, acquire),
]);
assert.equal(first.value, 1);
assert.equal(second.value, 1);
assert.equal(visits, 1);
assert.equal(maxActive, 1);

const serialized = new BrowserCoordinator();
let globalActive = 0;
let globalMax = 0;
const distinctVisit = async () => {
  globalActive++;
  globalMax = Math.max(globalMax, globalActive);
  await new Promise((resolve) => setTimeout(resolve, 1));
  globalActive--;
  return true;
};
serialized.registerIntent('https://x.com/a/status/1', 'inspect');
serialized.registerIntent('https://www.instagram.com/p/TWO/', 'inspect');
await Promise.all([
  serialized.visitOnce('twitter', 'https://x.com/a/status/1', distinctVisit),
  serialized.visitOnce('instagram', 'https://www.instagram.com/p/TWO/', distinctVisit),
]);
assert.equal(globalMax, 1);

coordinator.recordOutcome('instagram', {
  status: 'blocked',
  reason: 'rate-limited',
  attempts: 1,
  elapsed_ms: 5,
});
assert.equal(coordinator.isBlocked('instagram'), true);
await assert.rejects(
  coordinator.visitOnce('instagram', 'https://www.instagram.com/p/NEW/', acquire),
  /rate-limited/,
);

const malformed = new BrowserCoordinator();
malformed.recordOutcome('twitter', {
  status: 'unavailable',
  reason: 'invalid-response',
  attempts: 1,
  elapsed_ms: 1,
});
assert.equal(malformed.isBlocked('twitter'), false);
malformed.recordOutcome('twitter', {
  status: 'unavailable',
  reason: 'invalid-response',
  attempts: 1,
  elapsed_ms: 1,
});
assert.equal(malformed.isBlocked('twitter'), true);
console.log('ok browser_coordinator');
```

- [ ] **Step 2: Run the coordinator test and verify failure**

Run: `rtk proxy bun acquisition/browser_coordinator.test.ts` from `scout/`
Expected: FAIL with missing `./browser_coordinator.ts`.

- [ ] **Step 3: Implement one global async queue and exact circuit rules**

Use one promise tail for global serialization and a canonical-URL promise map for deduplication:

```ts
private tail: Promise<void> = Promise.resolve();

private enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = this.tail.then(operation, operation);
  this.tail = run.then(() => undefined, () => undefined);
  return run;
}
```

`registerIntent()` must reject late registration with a descriptive error once `visitOnce()` has started for that canonical URL. `recordOutcome()` opens a circuit immediately for `rate-limited`, `auth-required`, or `challenge`; it opens after two consecutive `invalid-response` outcomes and resets that counter on a resolved outcome. Do not open circuits for `materialization-failed`.

- [ ] **Step 4: Verify coordinator behavior**

Run: `rtk proxy bun acquisition/browser_coordinator.test.ts` from `scout/`
Expected: `ok browser_coordinator`.

- [ ] **Step 5: Commit the coordinator**

```powershell
rtk git add scout/acquisition/browser_coordinator.ts scout/acquisition/browser_coordinator.test.ts
rtk git commit -m "feat(scout): coordinate browser acquisition runs"
```

---

### Task 4: Generic passive CDP network observer

**Files:**
- Create: `scout/acquisition/network_capture.ts`
- Create: `scout/acquisition/network_capture.test.ts`
- Modify: `scout/lib/cdp.ts`

**Interfaces:**
- Consumes: `CdpClient`, capture deadline from `AcquisitionConfig`.
- Produces: `observeNetworkResponses<T>()`, `CapturedResponse`, and `NetworkMatcher<T>`.

- [ ] **Step 1: Write a failing fake-CDP observer test**

```ts
// scout/acquisition/network_capture.test.ts
import assert from 'node:assert/strict';
import { observeNetworkResponses } from './network_capture.ts';

class FakeSocket {
  private listeners = new Set<(event: { data: string }) => void>();
  addEventListener(_type: string, listener: (event: { data: string }) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: { data: string }) => void): void {
    this.listeners.delete(listener);
  }
  dispatchMessage(data: string): void {
    for (const listener of this.listeners) listener({ data });
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}
const ws = new FakeSocket();
const commands: string[] = [];
const client = {
  ws,
  cmd: async (method: string) => {
    commands.push(method);
    if (method === 'Network.getResponseBody') return { body: '{"data":{"id":"ABC"}}' };
    return {};
  },
} as any;

const result = observeNetworkResponses(client, {
  deadlineMs: 100,
  matchers: [
    {
      id: 'instagram-post',
      matches: (event) => event.url.includes('/graphql/query'),
      parse: (body) => JSON.parse(body).data.id,
    },
  ],
  action: async () => {
    ws.dispatchMessage(
      JSON.stringify({
        method: 'Network.responseReceived',
        params: {
          requestId: '1',
          response: { url: 'https://www.instagram.com/graphql/query', status: 200 },
        },
      }),
    );
    ws.dispatchMessage(
      JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: '1' } }),
    );
  },
});

assert.deepEqual(await result, { 'instagram-post': 'ABC' });
assert.deepEqual(commands, ['Network.enable', 'Network.getResponseBody', 'Network.disable']);
assert.equal(ws.listenerCount(), 0);

const timeoutSocket = new FakeSocket();
const timedOut = await observeNetworkResponses(
  { ws: timeoutSocket, cmd: async () => ({}) } as any,
  {
    deadlineMs: 1,
    matchers: [{ id: 'missing', matches: () => false, parse: () => null }],
    action: async () => {},
  },
);
assert.deepEqual(timedOut, {});
assert.equal(timeoutSocket.listenerCount(), 0);
console.log('ok network_capture');
```

- [ ] **Step 2: Run the observer test and verify failure**

Run: `rtk proxy bun acquisition/network_capture.test.ts` from `scout/`
Expected: FAIL with missing `./network_capture.ts`.

- [ ] **Step 3: Implement response-only observation and cleanup**

Define:

```ts
export interface CapturedResponse {
  requestId: string;
  url: string;
  status: number;
  mimeType?: string;
}

export interface NetworkMatcher<T> {
  id: string;
  matches(response: CapturedResponse): boolean;
  parse(body: string, response: CapturedResponse): T | null;
}
```

`observeNetworkResponses()` must call `Network.enable`, register one WebSocket message listener, run `action`, associate `responseReceived` with `loadingFinished`, obtain bodies through `Network.getResponseBody`, resolve when every matcher has a value or the deadline expires, and always remove the listener and call `Network.disable` in `finally`. It must not expose request headers or post bodies in its return type. Add typed `addEventListener` and `removeEventListener` methods to the `CdpClient.ws` surface if TypeScript requires them; do not change existing runtime behavior in `lib/cdp.ts`.

- [ ] **Step 4: Verify observer cleanup and existing CDP typecheck**

Run: `rtk proxy bun acquisition/network_capture.test.ts` from `scout/`
Expected: `ok network_capture`.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit the observer**

```powershell
rtk git add scout/acquisition/network_capture.ts scout/acquisition/network_capture.test.ts scout/lib/cdp.ts
rtk git commit -m "feat(scout): observe platform responses over cdp"
```

---

### Task 5: Capability policy and content-addressed materializer

**Files:**
- Create: `scout/acquisition/policy.ts`
- Create: `scout/acquisition/policy.test.ts`
- Create: `scout/acquisition/materialize.ts`
- Create: `scout/acquisition/materialize.test.ts`

**Interfaces:**
- Consumes: `Platform`, `AcquisitionIntent`, `AcquisitionSource`, `MediaAsset`, `LocalAsset`, `AcquisitionConfig`.
- Produces: `sourceOrder()`, `detectCapabilities()`, `Materializer.materialize()`, and `MaterializerDeps`.

- [ ] **Step 1: Write failing source-order tests**

```ts
// scout/acquisition/policy.test.ts
import assert from 'node:assert/strict';
import { sourceOrder } from './policy.ts';

const all = new Set(['network', 'public-metadata', 'gallery-dl', 'yt-dlp', 'direct-http', 'dom']);
assert.deepEqual(sourceOrder('instagram', 'inspect', undefined, all as any), [
  'network',
  'public-metadata',
  'dom',
]);
assert.deepEqual(sourceOrder('instagram', 'media', 'image', all as any), [
  'gallery-dl',
  'direct-http',
  'dom',
]);
assert.deepEqual(sourceOrder('youtube', 'media', 'video', all as any), ['yt-dlp']);
assert.deepEqual(sourceOrder('twitter', 'social-card', undefined, all as any), ['dom']);
console.log('ok acquisition_policy');
```

```ts
// scout/acquisition/materialize.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Materializer } from './materialize.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-materialize-'));
try {
  const calls: { executable: string; args: string[] }[] = [];
  const materializer = new Materializer(
    { galleryDl: 'gallery-dl', ytdlp: 'yt-dlp' } as any,
    {
      run: async (executable, args) => {
        calls.push({ executable, args });
        const filename = args[args.indexOf('--filename') + 1].replace('{extension}', 'jpg');
        fs.writeFileSync(path.join(root, filename), Buffer.from('image'));
        return { exitCode: 0, stderr: '', timedOut: false };
      },
      fetchBytes: async () => Buffer.from('direct'),
      root,
    },
  );
  const local = await materializer.materialize(
    {
      id: 'ABC:1',
      kind: 'image',
      index: 1,
      canonical_post_url: 'https://www.instagram.com/p/ABC/',
    },
    'footage',
  );
  assert.equal(local.source, 'gallery-dl');
  assert.equal(calls[0].executable, 'gallery-dl');
  assert.deepEqual(calls[0].args.slice(-3), ['--range', '1', 'https://www.instagram.com/p/ABC/']);
  assert.ok(fs.existsSync(local.path));

  const fallback = new Materializer(
    { galleryDl: 'gallery-dl', ytdlp: 'yt-dlp' } as any,
    {
      run: async () => ({ exitCode: 1, stderr: 'extractor failed at https://secret.test', timedOut: false }),
      fetchBytes: async () => Buffer.from('direct'),
      root,
    },
  );
  const direct = await fallback.materialize(
    {
      id: 'DEF:1',
      kind: 'image',
      index: 1,
      canonical_post_url: 'https://www.instagram.com/p/DEF/',
      ephemeral_url: 'https://cdn.test/direct.jpg?sig=secret',
    },
    'footage',
  );
  assert.equal(direct.source, 'direct-http');
  assert.ok(fs.existsSync(direct.path));
  console.log('ok acquisition_materialize');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run both tests and verify missing-module failures**

Run: `rtk proxy bun acquisition/policy.test.ts` from `scout/`
Expected: FAIL with missing `./policy.ts`.

Run: `rtk proxy bun acquisition/materialize.test.ts` from `scout/`
Expected: FAIL with missing `./materialize.ts`.

- [ ] **Step 3: Implement capability filtering and safe process arguments**

`sourceOrder()` returns only sources present in the capability set. Use these exact preferred chains:

```ts
const CHAINS = {
  inspectSocial: ['network', 'public-metadata', 'dom'],
  inspectYouTube: ['public-metadata', 'yt-dlp'],
  image: ['gallery-dl', 'direct-http', 'dom'],
  video: ['direct-http', 'yt-dlp'],
  socialCard: ['dom'],
} as const;
```

`detectCapabilities()` probes `gallery-dl --version` and `yt-dlp --version` once through injected `run`. `Materializer` hashes `platform identity + asset id + purpose` into its output basename. For an image, run:

```ts
export interface MaterializerRunResult {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
}

export interface MaterializerDeps {
  run(executable: string, args: string[], timeoutMs: number): Promise<MaterializerRunResult>;
  fetchBytes(url: string, timeoutMs: number): Promise<Buffer>;
  root: string;
  now?: () => number;
}
```

```ts
[
  '--directory', outputDirectory,
  '--filename', `${assetHash}.{extension}`,
  '--range', String(asset.index),
  asset.canonical_post_url,
]
```

If `gallery-dl` is missing or exits nonzero, use `ephemeral_url` through `fetchBytes`; never put that URL in diagnostics. For video, try `ephemeral_url` through `fetchBytes`, then invoke yt-dlp with `['--no-warnings', '--no-playlist', '-o', outputTemplate, '--', canonicalUrl]`. After the permitted chain is exhausted, throw `new AcquisitionError('media materialization failed', {status:'unavailable', reason:'materialization-failed', attempts, elapsed_ms})`; `AcquisitionService` records that outcome before returning the failure to its caller.

- [ ] **Step 4: Verify policy, materializer, and secret-safe failure paths**

Run: `rtk proxy bun acquisition/policy.test.ts` from `scout/`
Expected: `ok acquisition_policy`.

Run: `rtk proxy bun acquisition/materialize.test.ts` from `scout/`
Expected: `ok acquisition_materialize`.

- [ ] **Step 5: Commit policy and materialization**

```powershell
rtk git add scout/acquisition/policy.ts scout/acquisition/policy.test.ts scout/acquisition/materialize.ts scout/acquisition/materialize.test.ts
rtk git commit -m "feat(scout): materialize acquired media safely"
```

---

### Task 6: Acquisition facade and adapter contract harness

**Files:**
- Create: `scout/acquisition/service.ts`
- Create: `scout/acquisition/service.test.ts`
- Create: `scout/acquisition/index.ts`

**Interfaces:**
- Consumes: Tasks 1–5 public interfaces and `PlatformAdapter[]`.
- Produces: `AcquisitionService.create()`, `registerIntent()`, `discover()`, `inspectPost()`, `collectComments()`, `materialize()`, `captureSocialCard()`, `AcquisitionRunContext`, `createStandaloneAcquisitionContext()`, and `runAcquisitionCli()`.

- [ ] **Step 1: Write the failing facade contract test**

```ts
// scout/acquisition/service.test.ts
import assert from 'node:assert/strict';
import { AcquisitionService } from './service.ts';

let inspections = 0;
const fakeAdapter = {
  platform: 'instagram' as const,
  supports: (url: string) => url.includes('instagram.com'),
  discover: async () => ({
    items: [],
    outcome: { status: 'resolved' as const, source: 'network' as const, attempts: 1, elapsed_ms: 1 },
  }),
  inspect: async (url: string) => {
    inspections++;
    return {
      canonical_url: url,
      platform: 'instagram' as const,
      post_id: 'ABC',
      owner_handle: 'owner',
      text: 'caption',
      media: [],
      outcome: { status: 'resolved' as const, source: 'network' as const, attempts: 1, elapsed_ms: 1 },
    };
  },
  collectComments: async () => [],
  captureSocialCard: async () => ({
    path: 'card.png',
    kind: 'social-card' as const,
    source: 'dom' as const,
    bytes: 4,
  }),
};

const service = AcquisitionService.createForTest({ adapters: [fakeAdapter] });
const url = 'https://www.instagram.com/p/ABC/?utm_source=test';
service.registerIntent(url, 'inspect');
const [first, second] = await Promise.all([service.inspectPost(url), service.inspectPost(url)]);
assert.equal(first.canonical_url, 'https://www.instagram.com/p/ABC/');
assert.equal(second.post_id, 'ABC');
assert.equal(inspections, 1);
const cached = await service.inspectPost(url);
assert.equal(cached.outcome.source, 'cache');
assert.equal(inspections, 1);
await assert.rejects(
  service.inspectPost('https://example.com/post/1'),
  /unsupported platform/i,
);
console.log('ok acquisition_service');
```

- [ ] **Step 2: Run the facade test and verify failure**

Run: `rtk proxy bun acquisition/service.test.ts` from `scout/`
Expected: FAIL with missing `./service.ts`.

- [ ] **Step 3: Implement facade routing, cache lookup, and outcome recording**

The service canonicalizes every URL before adapter lookup, checks the same-run value registry, then durable cache, then memoizes a new operation with keys such as `inspect:<canonical>`. Same-run and durable cache hits clone the public outcome with `source: 'cache'`; only the same-run value may retain ephemeral media references. The service records every adapter outcome in `BrowserCoordinator` and strips ephemeral URLs before durable writes. Define `AcquisitionRunContext` as:

```ts
export interface AcquisitionRunContext {
  readonly service: AcquisitionService;
  readonly runId: string;
}
```

`create()` wires production config, cache, coordinator, materializer, and adapters. `createForTest()` accepts all dependencies and uses a temporary in-memory cache. Export only stable contracts from `index.ts`; pipeline files import from `../acquisition/index.ts`.

The production `AdapterContext.visit()` implementation calls `connect()` inside the acquisition layer, passes the resulting `CdpClient` and registered intents to the adapter callback, and closes the client in `finally`. `runAcquisitionCli()` wraps the existing CDP relay help and `AcquisitionError` formatting so migrated pipeline files do not import `lib/cdp.ts` directly.

- [ ] **Step 4: Run facade and foundation tests**

Run: `rtk proxy bun acquisition/service.test.ts` from `scout/`
Expected: `ok acquisition_service`.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit the facade**

```powershell
rtk git add scout/acquisition/service.ts scout/acquisition/service.test.ts scout/acquisition/index.ts
rtk git commit -m "feat(scout): add acquisition service facade"
```

---

### Task 7: Instagram passive-network adapter

**Files:**
- Create: `scout/acquisition/adapters/json_walk.ts`
- Create: `scout/acquisition/adapters/instagram.ts`
- Create: `scout/acquisition/adapters/instagram.test.ts`
- Modify: `scout/acquisition/service.ts`
- Modify: `scout/scrapers/ig_profile.ts`
- Modify: `scout/scrapers/crop_post.ts`

**Interfaces:**
- Consumes: `observeNetworkResponses()`, `PlatformAdapter`, `igPostOg()`, existing DOM crop helper.
- Produces: `instagramAdapter`, `parseInstagramPost()`, and Instagram discovery/inspect/comment/social-card behavior.

- [ ] **Step 1: Write a failing sanitized GraphQL fixture test**

```ts
// scout/acquisition/adapters/instagram.test.ts
import assert from 'node:assert/strict';
import { parseInstagramPost } from './instagram.ts';

const body = JSON.stringify({
  data: {
    xdt_shortcode_media: {
      shortcode: 'DbgARkAjHPS',
      owner: { username: 'creator' },
      edge_media_to_caption: { edges: [{ node: { text: 'post caption' } }] },
      edge_sidecar_to_children: {
        edges: [
          { node: { id: 'image-1', is_video: false, display_url: 'https://cdn.test/1.jpg?sig=x' } },
          { node: { id: 'video-2', is_video: true, video_url: 'https://cdn.test/2.mp4?sig=y' } },
        ],
      },
    },
  },
});
const post = parseInstagramPost(body, 'https://www.instagram.com/p/DbgARkAjHPS/');
assert.equal(post?.post_id, 'DbgARkAjHPS');
assert.equal(post?.owner_handle, 'creator');
assert.equal(post?.text, 'post caption');
assert.deepEqual(post?.media.map((item) => item.kind), ['image', 'video']);
assert.deepEqual(post?.media.map((item) => item.index), [1, 2]);
assert.equal(post?.outcome.source, 'network');
console.log('ok instagram_adapter');
```

- [ ] **Step 2: Run the adapter test and verify failure**

Run: `rtk proxy bun acquisition/adapters/instagram.test.ts` from `scout/`
Expected: FAIL with missing `./instagram.ts`.

- [ ] **Step 3: Implement bounded JSON discovery and Instagram fallbacks**

`json_walk.ts` exports `findFirstObject(root, predicate, maxNodes = 20_000)` using an iterative stack and `WeakSet`; stop after `maxNodes` to prevent unbounded response traversal.

Extend `igPostOg()` and `cropPost()` with optional `{client, navigate}` dependencies. When a client is supplied with `navigate:false`, they read/crop the already loaded page and never close the borrowed client.

The Instagram adapter:

- observes only `instagram.com/graphql/query` responses during one direct post/profile navigation;
- accepts `xdt_shortcode_media` or `shortcode_media` shapes;
- normalizes carousel child order and media kind;
- falls back to `igPostOg(url, {client, navigate:false})` for text and cover metadata during the same visit;
- falls back to `cropPost({url, client, navigate:false})` only for a registered `social-card` intent during the same visit;
- registers no request headers or payloads in return values;
- exposes profile/query discovery through normalized `DiscoveryResult` records.

Use `gallery-dl` only later through `service.materialize()`; the adapter returns canonical post and ephemeral media references.

- [ ] **Step 4: Run Instagram and service contract tests**

Run: `rtk proxy bun acquisition/adapters/instagram.test.ts` from `scout/`
Expected: `ok instagram_adapter`.

Run: `rtk proxy bun acquisition/service.test.ts` from `scout/`
Expected: `ok acquisition_service`.

- [ ] **Step 5: Commit the Instagram adapter**

```powershell
rtk git add scout/acquisition/adapters/json_walk.ts scout/acquisition/adapters/instagram.ts scout/acquisition/adapters/instagram.test.ts scout/acquisition/service.ts scout/scrapers/ig_profile.ts scout/scrapers/crop_post.ts
rtk git commit -m "feat(scout): acquire instagram posts passively"
```

---

### Task 8: X/Twitter network and social-card adapter

**Files:**
- Create: `scout/acquisition/adapters/twitter.ts`
- Create: `scout/acquisition/adapters/twitter.test.ts`
- Modify: `scout/acquisition/service.ts`
- Reuse: `scout/scrapers/x_profile.ts`, `scout/scrapers/scrape_comments_x.ts`, `scout/scrapers/crop_post.ts`

**Interfaces:**
- Consumes: bounded JSON walker, network observer, existing X profile/comment selectors.
- Produces: `twitterAdapter` and `parseTwitterPost()`.

- [ ] **Step 1: Write a failing X result parser test**

```ts
// scout/acquisition/adapters/twitter.test.ts
import assert from 'node:assert/strict';
import { parseTwitterPost } from './twitter.ts';

const body = JSON.stringify({
  data: {
    tweetResult: {
      result: {
        rest_id: '123',
        legacy: { full_text: 'tweet text', favorite_count: 42 },
        core: { user_results: { result: { legacy: { screen_name: 'owner' } } } },
        extended_entities: {
          media: [
            { id_str: 'm1', type: 'photo', media_url_https: 'https://cdn.test/photo.jpg' },
            {
              id_str: 'm2',
              type: 'video',
              video_info: { variants: [{ bitrate: 832000, url: 'https://cdn.test/video.mp4?tag=1' }] },
            },
          ],
        },
      },
    },
  },
});
const post = parseTwitterPost(body, 'https://x.com/owner/status/123');
assert.equal(post?.post_id, '123');
assert.equal(post?.owner_handle, 'owner');
assert.equal(post?.engagement?.likes, 42);
assert.deepEqual(post?.media.map((item) => item.kind), ['image', 'video']);
console.log('ok twitter_adapter');
```

- [ ] **Step 2: Run the X adapter test and verify failure**

Run: `rtk proxy bun acquisition/adapters/twitter.test.ts` from `scout/`
Expected: FAIL with missing `./twitter.ts`.

- [ ] **Step 3: Implement X GraphQL parsing and targeted DOM reuse**

Match X responses whose URL contains `/i/api/graphql/` and a Tweet, SearchTimeline, UserTweets, or TweetDetail operation. Select the highest-bitrate MP4 variant, normalize photos, and skip tombstones and promoted entries. Use `xProfileTweets()` for DOM fallback discovery. Reuse the selectors from `scrape_comments_x.ts` for comment normalization and call `cropPost({url, client, navigate:false})` for a registered post screenshot during the same visit; do not spawn the standalone scripts. A `403` from a video CDN is returned as `materialization-failed`, not an X browser circuit event.

- [ ] **Step 4: Verify X parsing and typecheck**

Run: `rtk proxy bun acquisition/adapters/twitter.test.ts` from `scout/`
Expected: `ok twitter_adapter`.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit the X adapter**

```powershell
rtk git add scout/acquisition/adapters/twitter.ts scout/acquisition/adapters/twitter.test.ts scout/acquisition/service.ts
rtk git commit -m "feat(scout): acquire x posts and cards"
```

---

### Task 9: TikTok and YouTube adapters

**Files:**
- Create: `scout/acquisition/adapters/tiktok.ts`
- Create: `scout/acquisition/adapters/tiktok.test.ts`
- Create: `scout/acquisition/adapters/youtube.ts`
- Create: `scout/acquisition/adapters/youtube.test.ts`
- Modify: `scout/acquisition/service.ts`
- Reuse: `scout/scrapers/tiktok_video.ts`, `scout/scrapers/tiktok_profile.ts`, `scout/lib/verify.ts`, `scout/scrapers/scrape_comments_yt.ts`

**Interfaces:**
- Consumes: `tiktokOembed()`, `youtubeOembed()`, `tiktokDirectUrl()`, `tiktokProfileVideos()`, existing yt-dlp resolver.
- Produces: `tiktokAdapter` and `youtubeAdapter`.

- [ ] **Step 1: Write failing public-metadata normalization tests**

```ts
// scout/acquisition/adapters/tiktok.test.ts
import assert from 'node:assert/strict';
import { createTikTokAdapter } from './tiktok.ts';

const adapter = createTikTokAdapter({
  oembed: async () => ({ title: 'TikTok caption', author: 'creator', thumbnail: 'https://cdn.test/t.jpg' }),
  directUrl: async () => 'https://cdn.test/video.mp4?sig=secret',
  profileVideos: async () => [],
});
const post = await adapter.inspect('https://www.tiktok.com/@creator/video/123', {} as any);
assert.equal(post.post_id, '123');
assert.equal(post.owner_handle, 'creator');
assert.equal(post.text, 'TikTok caption');
assert.equal(post.media[0].kind, 'video');
assert.equal(post.outcome.source, 'public-metadata');
console.log('ok tiktok_adapter');
```

```ts
// scout/acquisition/adapters/youtube.test.ts
import assert from 'node:assert/strict';
import { createYouTubeAdapter } from './youtube.ts';

const adapter = createYouTubeAdapter({
  oembed: async () => ({ title: 'Video title', author: 'Channel', thumbnail: 'https://cdn.test/y.jpg' }),
});
const post = await adapter.inspect('https://www.youtube.com/watch?v=ABC123', {} as any);
assert.equal(post.post_id, 'ABC123');
assert.equal(post.owner_handle, 'Channel');
assert.equal(post.media[0].kind, 'video');
assert.equal(post.outcome.source, 'public-metadata');
console.log('ok youtube_adapter');
```

- [ ] **Step 2: Run both tests and verify failures**

Run: `rtk proxy bun acquisition/adapters/tiktok.test.ts` from `scout/`
Expected: FAIL with missing `./tiktok.ts`.

Run: `rtk proxy bun acquisition/adapters/youtube.test.ts` from `scout/`
Expected: FAIL with missing `./youtube.ts`.

- [ ] **Step 3: Wrap existing safe paths behind adapters**

TikTok inspection uses oEmbed first, passive network observation only when metadata or photo-slide information is missing, and `tiktokDirectUrl()` only for a registered `media` intent. Pass a `cdpResolver` dependency that returns the URL already observed by the current adapter visit, so `tiktokDirectUrl()` never opens or navigates a second CDP session. TikTok discovery wraps `tiktokProfileVideos()` and the existing trending helper. YouTube uses oEmbed/player metadata for inspection, existing search/yt-dlp helpers for discovery and video materialization, and CDP only when comments or a social card were registered. Both adapters normalize comments without changing the current selectors.

- [ ] **Step 4: Verify both adapters and existing resolver tests**

Run: `rtk proxy bun acquisition/adapters/tiktok.test.ts` from `scout/`
Expected: `ok tiktok_adapter`.

Run: `rtk proxy bun acquisition/adapters/youtube.test.ts` from `scout/`
Expected: `ok youtube_adapter`.

Run: `rtk proxy bun scrapers/tiktok_video.test.ts` from `scout/`
Expected: `ok tiktok_video`.

- [ ] **Step 5: Commit TikTok and YouTube adapters**

```powershell
rtk git add scout/acquisition/adapters/tiktok.ts scout/acquisition/adapters/tiktok.test.ts scout/acquisition/adapters/youtube.ts scout/acquisition/adapters/youtube.test.ts scout/acquisition/service.ts
rtk git commit -m "feat(scout): adapt tiktok and youtube acquisition"
```

---

### Task 10: Facebook, Threads, and Reddit adapters

**Files:**
- Create: `scout/acquisition/adapters/facebook.ts`
- Create: `scout/acquisition/adapters/facebook.test.ts`
- Create: `scout/acquisition/adapters/threads.ts`
- Create: `scout/acquisition/adapters/threads.test.ts`
- Create: `scout/acquisition/adapters/reddit.ts`
- Create: `scout/acquisition/adapters/reddit.test.ts`
- Modify: `scout/acquisition/service.ts`
- Reuse: `scout/scrapers/threads_video.ts`, `scout/scrapers/scrape_comments_fb.ts`, `scout/scrapers/scrape_comments_reddit.ts`, `scout/scrapers/crop_post.ts`

**Interfaces:**
- Consumes: passive observer, bounded JSON walker, existing Meta CDN and comment helpers.
- Produces: `facebookAdapter`, `threadsAdapter`, and `redditAdapter`.

- [ ] **Step 1: Write failing minimal normalization tests**

```ts
// scout/acquisition/adapters/threads.test.ts
import assert from 'node:assert/strict';
import { parseThreadsPost } from './threads.ts';

const post = parseThreadsPost(
  JSON.stringify({ data: { post: { id: 'TH1', user: { username: 'owner' }, text: 'thread text', image_url: 'https://cdn.test/a.jpg' } } }),
  'https://www.threads.net/@owner/post/TH1',
);
assert.equal(post?.post_id, 'TH1');
assert.equal(post?.media[0].kind, 'image');
console.log('ok threads_adapter');
```

```ts
// scout/acquisition/adapters/reddit.test.ts
import assert from 'node:assert/strict';
import { parseRedditListing } from './reddit.ts';

const posts = parseRedditListing(
  [{ data: { children: [{ data: { id: 'r1', author: 'owner', title: 'title', selftext: 'body', url: 'https://i.redd.it/a.jpg' } }] } }],
  'https://www.reddit.com/r/test/comments/r1/title/',
);
assert.equal(posts[0].post_id, 'r1');
assert.equal(posts[0].text, 'title\nbody');
assert.equal(posts[0].media[0].kind, 'image');
console.log('ok reddit_adapter');
```

```ts
// scout/acquisition/adapters/facebook.test.ts
import assert from 'node:assert/strict';
import { parseFacebookPost } from './facebook.ts';

const post = parseFacebookPost(
  JSON.stringify({
    data: {
      post_id: 'f1',
      actors: [{ name: 'Owner' }],
      message: { text: 'message' },
      attachments: [{ media: { image: { uri: 'https://cdn.test/f.jpg' } } }],
    },
  }),
  'https://www.facebook.com/owner/posts/f1',
);
assert.equal(post?.post_id, 'f1');
assert.equal(post?.owner_handle, 'Owner');
assert.equal(post?.text, 'message');
assert.equal(post?.media[0].kind, 'image');
console.log('ok facebook_adapter');
```

- [ ] **Step 2: Run the three tests and verify failures**

Run: `rtk proxy bun acquisition/adapters/facebook.test.ts` from `scout/`
Expected: FAIL with missing `./facebook.ts`.

Run: `rtk proxy bun acquisition/adapters/threads.test.ts` from `scout/`
Expected: FAIL with missing `./threads.ts`.

Run: `rtk proxy bun acquisition/adapters/reddit.test.ts` from `scout/`
Expected: FAIL with missing `./reddit.ts`.

- [ ] **Step 3: Implement source-specific parsing and existing fallbacks**

Facebook observes GraphQL responses, then uses existing DOM search and `cropPost({url, client, navigate:false})` behavior during the same visit. Threads observes Meta responses, falls back to Open Graph, and calls `threadsVideoSrc(postUrl, {client})` only for registered video materialization while the canonical post remains loaded. Reddit prefers the canonical `.json` representation with an explicit `User-Agent`, then uses passive CDP/DOM only when JSON is unavailable or a social card is requested. All three reuse existing comment normalization and crop selectors instead of executing standalone scraper processes.

- [ ] **Step 4: Verify adapter contracts**

Run from `scout/`:

```powershell
rtk proxy bun acquisition/adapters/facebook.test.ts
rtk proxy bun acquisition/adapters/threads.test.ts
rtk proxy bun acquisition/adapters/reddit.test.ts
```

Expected final lines: `ok facebook_adapter`, `ok threads_adapter`, and `ok reddit_adapter`.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit the remaining adapters**

```powershell
rtk git add scout/acquisition/adapters/facebook.ts scout/acquisition/adapters/facebook.test.ts scout/acquisition/adapters/threads.ts scout/acquisition/adapters/threads.test.ts scout/acquisition/adapters/reddit.ts scout/acquisition/adapters/reddit.test.ts scout/acquisition/service.ts
rtk git commit -m "feat(scout): adapt meta and reddit acquisition"
```

---

### Task 11: Async in-process pipeline stage harness

**Files:**
- Modify: `scout/pipeline/run_pipeline_step.ts`
- Modify: `scout/pipeline/run_pipeline_step.test.ts`
- Modify: `scout/pipeline/trace_source.ts`
- Modify: `scout/pipeline/build_footage.ts`
- Modify: `scout/pipeline/collect_comments.ts`
- Modify: `scout/pipeline/enrich_image_paths.ts`
- Modify: `scout/pipeline/extract_figures.ts`
- Modify: `scout/pipeline/validate_content_set.ts`
- Modify: `scout/enrich/topic_dossier.ts`

**Interfaces:**
- Consumes: `AcquisitionRunContext` from Task 6.
- Produces: `runPipelineStep(): Promise<boolean>` and exported async stage functions accepting typed args plus a run context.

- [ ] **Step 1: Convert the harness test to require async execution**

```ts
// add to scout/pipeline/run_pipeline_step.test.ts
{
  let completed = false;
  const ok = await runPipelineStep(
    { label: 'async-stage', required: true },
    {
      execute: async () => {
        await Promise.resolve();
        completed = true;
      },
      warn: () => {
        throw new Error('must not warn');
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(completed, true);
}
```

Update every existing `runPipelineStep()` assertion to `await` or `await assert.rejects()`.

- [ ] **Step 2: Run the harness test and verify failure**

Run: `rtk proxy bun pipeline/run_pipeline_step.test.ts` from `scout/`
Expected: FAIL because the synchronous harness does not await `execute()`.

- [ ] **Step 3: Export stage functions without changing inner algorithms**

Change `StepDeps.execute` to `() => Promise<void> | void`, make `runPipelineStep` async, and `await deps.execute()`.

For every listed stage, define a typed argument interface, move the current top-level/IIFE body into one exported async function, and retain a thin CLI wrapper. Use this exact wrapper pattern:

```ts
export interface TraceSourceOptions {
  file: string;
  keywords: string[];
  username: string | null;
  model: string;
  noDl: boolean;
}
export interface BuildFootageOptions {
  file: string;
  objects: string[] | null;
  per: number;
  max: number;
  noCrop: boolean;
  profile: string | null;
}
export interface CollectCommentsOptions {
  file: string;
  perSource: number;
  cap: number;
  maxSources: number;
  extra: string[];
}
export interface EnrichImagePathsOptions {
  file: string;
  force: boolean;
  keywords: string[];
  mode: 'any' | 'all';
}
export interface FileStageOptions {
  file: string;
}
```

`runExtractFigures`, `runValidateContentSet`, and `runTopicDossier` consume `FileStageOptions`. Their parsers reject missing files before entering the exported function.

```ts
export async function runCollectComments(
  options: CollectCommentsOptions,
  context: AcquisitionRunContext,
): Promise<void> {
  const { file, perSource, cap, maxSources, extra } = options;
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sources = buildCommentSources(set, extra, maxSources);
  const comments = await collectCommentsCompat(sources, perSource, cap, context);
  set.comments = comments;
  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
}

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const options = parseCollectCommentsArgs(process.argv.slice(2));
    const context = await createStandaloneAcquisitionContext();
    await runCollectComments(options, context);
  });
}
```

`buildCommentSources()` is the current ordered main/extra/footage source-list block extracted as a pure function. `collectCommentsCompat()` contains the current per-source scraper invocation, merge, deduplication, sort, cap, and crop-guard blocks with the same behavior and returns the final array. Task 15 replaces that compatibility function with `collectNormalizedComments()` and removes its scraper subprocesses.

Use corresponding names `runTraceSource`, `runBuildFootage`, `runEnrichImagePaths`, `runExtractFigures`, `runValidateContentSet`, and `runTopicDossier`. Parsing stays in explicit `parse*Args(argv)` functions and preserves current CLI flags and defaults. Replace `process.exit()` inside exported functions with returned no-op results for successful early exits and thrown typed errors for failures.

- [ ] **Step 4: Verify CLI wrappers and async harness**

Run: `rtk proxy bun pipeline/run_pipeline_step.test.ts` from `scout/`
Expected: exit 0.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

Run from `scout/` and confirm each prints its existing usage text and exits nonzero:

```powershell
rtk proxy bun pipeline/trace_source.ts
rtk proxy bun pipeline/build_footage.ts
rtk proxy bun pipeline/collect_comments.ts
rtk proxy bun pipeline/enrich_image_paths.ts
rtk proxy bun pipeline/validate_content_set.ts
rtk proxy bun enrich/topic_dossier.ts
```

- [ ] **Step 5: Commit the in-process stage interfaces**

```powershell
rtk git add scout/pipeline/run_pipeline_step.ts scout/pipeline/run_pipeline_step.test.ts scout/pipeline/trace_source.ts scout/pipeline/build_footage.ts scout/pipeline/collect_comments.ts scout/pipeline/enrich_image_paths.ts scout/pipeline/extract_figures.ts scout/pipeline/validate_content_set.ts scout/enrich/topic_dossier.ts
rtk git commit -m "refactor(scout): expose pipeline stages in process"
```

---

### Task 12: Shared run context in `run_pipeline` and seed/source tracing

**Files:**
- Modify: `scout/pipeline/run_pipeline.ts`
- Modify: `scout/pipeline/trace_source.ts`
- Create: `scout/pipeline/run_pipeline_acquisition.test.ts`
- Modify: `scout/pipeline/trace_source_vision.ts`

**Interfaces:**
- Consumes: `AcquisitionService`, `runTraceSource()`, other exported stage functions.
- Produces: one service/context per pipeline run and kernel-backed main post inspection/source candidate discovery.

- [ ] **Step 1: Write a failing one-context orchestration test**

```ts
// scout/pipeline/run_pipeline_acquisition.test.ts
import assert from 'node:assert/strict';
import { runPipelineWithDeps } from './run_pipeline.ts';

const contexts = new Set<unknown>();
const stages: string[] = [];
const context = { runId: 'test', service: {} } as any;
await runPipelineWithDeps(
  { url: 'https://www.instagram.com/p/ABC/', out: 'set.json', noComments: false },
  {
    createContext: async () => context,
    inspectSeed: async (_url, received) => {
      contexts.add(received);
      return { title: 'caption', description: 'caption', platform: 'instagram', is_video: true };
    },
    writeSeed: async () => {},
    traceSource: async (_options, received) => { stages.push('trace'); contexts.add(received); },
    collectComments: async (_options, received) => { stages.push('comments'); contexts.add(received); },
    topicDossier: async (_options, received) => { stages.push('dossier'); contexts.add(received); },
    buildFootage: async (_options, received) => { stages.push('footage'); contexts.add(received); },
    extractFigures: async (_options, received) => { stages.push('figures'); contexts.add(received); },
    validate: async (_options, received) => { stages.push('validate'); contexts.add(received); },
    summarize: async () => {},
  },
);
assert.deepEqual(stages, ['trace', 'comments', 'dossier', 'footage', 'figures', 'validate']);
assert.equal(contexts.size, 1);
console.log('ok run_pipeline_acquisition');
```

- [ ] **Step 2: Run the orchestration test and verify failure**

Run: `rtk proxy bun pipeline/run_pipeline_acquisition.test.ts` from `scout/`
Expected: FAIL because `runPipelineWithDeps` is not exported.

- [ ] **Step 3: Replace subprocess orchestration and direct seed/trace acquisition**

Define the orchestration seam used by the test and production entrypoint:

```ts
export interface RunPipelineOptions {
  url: string;
  out: string;
  title?: string;
  desc?: string;
  per?: number;
  max?: number;
  cap?: number;
  noComments: boolean;
}

export interface RunPipelineDeps {
  createContext(): Promise<AcquisitionRunContext>;
  inspectSeed(url: string, context: AcquisitionRunContext): Promise<Partial<MainVideo>>;
  writeSeed(file: string, seed: ContentSet): Promise<void>;
  traceSource(options: TraceSourceOptions, context: AcquisitionRunContext): Promise<void>;
  collectComments(options: CollectCommentsOptions, context: AcquisitionRunContext): Promise<void>;
  topicDossier(options: FileStageOptions, context: AcquisitionRunContext): Promise<void>;
  buildFootage(options: BuildFootageOptions, context: AcquisitionRunContext): Promise<void>;
  extractFigures(options: FileStageOptions, context: AcquisitionRunContext): Promise<void>;
  validate(options: FileStageOptions, context: AcquisitionRunContext): Promise<void>;
  summarize(file: string): Promise<void>;
}
```

`run_pipeline.ts` creates one `AcquisitionService`, registers `inspect`, `comments`, `media`, and required `social-card` intents for the input URL before inspection, writes the seed from `PostRecord`, and invokes exported stages through `await runPipelineStep(...)`.

In `trace_source.ts`, replace `captionOf`, `threadsOg`, `twitterText`, `xCoverImage`, generic `probeVideo`, and direct profile/search acquisition with `context.service.inspectPost()` and `context.service.discover()`. Preserve `resolveSource`, `evaluateMainSuitability`, candidate ranking, vision, and OCR functions unchanged. `trace_source_vision.ts` consumes normalized image/video assets and may call `service.materialize(asset, 'ocr')` when it needs a local or direct vision input.

- [ ] **Step 4: Verify context sharing and main-gate regressions**

Run: `rtk proxy bun pipeline/run_pipeline_acquisition.test.ts` from `scout/`
Expected: `ok run_pipeline_acquisition`.

Run: `rtk proxy bun lib/main_candidate.test.ts` from `scout/`
Expected: `ok main_candidate`.

Run: `rtk proxy bun pipeline/trace_source_vision.test.ts` from `scout/`
Expected: its existing success line and exit 0.

- [ ] **Step 5: Commit shared orchestration and tracing**

```powershell
rtk git add scout/pipeline/run_pipeline.ts scout/pipeline/run_pipeline_acquisition.test.ts scout/pipeline/trace_source.ts scout/pipeline/trace_source_vision.ts
rtk git commit -m "refactor(scout): share acquisition through source tracing"
```

---

### Task 13: Migrate discovery and cross-platform search

**Files:**
- Modify: `scout/pipeline/discover_reels.ts`
- Modify: `scout/pipeline/topic_to_urls.ts`
- Modify: `scout/scrapers/search_social_v2.ts`
- Create: `scout/pipeline/discovery_acquisition.test.ts`

**Interfaces:**
- Consumes: `AcquisitionService.discover()` and normalized `PostRecord` summaries.
- Produces: existing `reel_topics.json` and `topic_urls_<slug>.json` shapes without direct pipeline CDP calls.

- [ ] **Step 1: Write a failing discovery mapping test**

```ts
// scout/pipeline/discovery_acquisition.test.ts
import assert from 'node:assert/strict';
import { mapDiscoveryPosts } from './discover_reels.ts';

const rows = mapDiscoveryPosts('curator', [
  {
    canonical_url: 'https://www.instagram.com/reel/ABC/',
    platform: 'instagram',
    post_id: 'ABC',
    owner_handle: 'curator',
    text: 'topic caption',
    published_at: '2026-08-02T00:00:00.000Z',
    engagement: { views: 1200 },
    media: [{ id: 'ABC:1', kind: 'video', index: 1, canonical_post_url: 'https://www.instagram.com/reel/ABC/' }],
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
  },
] as any);
assert.deepEqual(rows[0], {
  account: 'curator',
  kind: 'reel',
  url: 'https://www.instagram.com/reel/ABC/',
  views: '1200',
  time: '2026-08-02T00:00:00.000Z',
  caption: 'topic caption',
});
console.log('ok discovery_acquisition');
```

- [ ] **Step 2: Run the mapping test and verify failure**

Run: `rtk proxy bun pipeline/discovery_acquisition.test.ts` from `scout/`
Expected: FAIL because `mapDiscoveryPosts` is not exported.

- [ ] **Step 3: Route discovery through adapters while retaining ranking**

`discover_reels.ts` calls `service.discover({platform, kind:'profile', value:handle, limit})` for curated Instagram, TikTok, and X accounts. Existing vision/audio topic extraction, recency decay, curator exclusion, and checkpoint writes remain unchanged. Register `inspect` and `media` intents before inspecting each returned canonical URL.

`topic_to_urls.ts` calls `service.discover({platform, kind:'query', value:QUERY, limit:MAX})` for each selected platform and maps normalized records back to its existing `{platform,url}` output. `search_social_v2.ts` becomes a compatibility CLI that invokes the relevant adapter rather than navigating itself.

- [ ] **Step 4: Verify discovery mapping and existing discovery tests**

Run: `rtk proxy bun pipeline/discovery_acquisition.test.ts` from `scout/`
Expected: `ok discovery_acquisition`.

Run: `rtk proxy bun lib/main_search_candidates.test.ts` from `scout/`
Expected: exit 0.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit discovery migration**

```powershell
rtk git add scout/pipeline/discover_reels.ts scout/pipeline/topic_to_urls.ts scout/scrapers/search_social_v2.ts scout/pipeline/discovery_acquisition.test.ts
rtk git commit -m "refactor(scout): discover content through acquisition"
```

---

### Task 14: Migrate footage inspection and delayed materialization

**Files:**
- Modify: `scout/pipeline/build_footage.ts`
- Modify: `scout/lib/footage_candidate_selection.ts`
- Create: `scout/pipeline/build_footage_acquisition.test.ts`
- Modify: `scout/lib/footage_candidate_selection.test.ts`

**Interfaces:**
- Consumes: normalized discovery/inspection, `service.materialize()`, existing relevance and OCR gates.
- Produces: unchanged `ContentResult[]`, with downloads occurring only after non-media gates admit a candidate.

- [ ] **Step 1: Write a failing rejection-before-download test**

```ts
// scout/pipeline/build_footage_acquisition.test.ts
import assert from 'node:assert/strict';
import { admitAndMaterializeFootage } from './build_footage.ts';

let materialized = 0;
const rejected = await admitAndMaterializeFootage(
  {
    canonical_url: 'https://x.com/owner/status/1',
    platform: 'twitter',
    post_id: '1',
    owner_handle: 'owner',
    text: 'unrelated advertisement',
    media: [{ id: '1:1', kind: 'image', index: 1, canonical_post_url: 'https://x.com/owner/status/1' }],
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
  } as any,
  {
    query: 'specific event',
    isRelevant: () => false,
    isMain: () => false,
    looksReaction: () => false,
    materialize: async () => {
      materialized++;
      throw new Error('must not run');
    },
  },
);
assert.equal(rejected.status, 'rejected');
assert.equal(materialized, 0);
console.log('ok build_footage_acquisition');
```

- [ ] **Step 2: Run the test and verify failure**

Run: `rtk proxy bun pipeline/build_footage_acquisition.test.ts` from `scout/`
Expected: FAIL because `admitAndMaterializeFootage` is not exported.

- [ ] **Step 3: Replace `searchObject`, `cropPost`, and direct media resolution**

Define the pure admission seam used before any downloader call:

```ts
export interface FootageAdmissionDeps {
  query: string;
  isRelevant(text: string, query: string): boolean;
  isMain(url: string, text: string): boolean;
  looksReaction(text: string): boolean;
  materialize(asset: MediaAsset): Promise<LocalAsset>;
}

export type FootageAdmissionResult =
  | { status: 'accepted'; entry: ContentResult }
  | { status: 'rejected'; reason: 'main' | 'irrelevant' | 'reaction' | 'no-media' };
```

Use `service.discover()` for each dossier query and `service.inspectPost()` for candidates. Apply canonical/main identity, curator, spam, reaction, and text/story relevance gates before materialization. For an admitted image, call `service.materialize(asset, 'footage')` and map the returned path to `image_path`. For an admitted video, materialize only when OCR needs local media; then pass that path into the existing OCR candidate selector. Preserve carousel index, `trim_start`, `mute_audio`, `subtitle_blur`, and all existing content-set fields.

- [ ] **Step 4: Verify delayed materialization and OCR regression suites**

Run: `rtk proxy bun pipeline/build_footage_acquisition.test.ts` from `scout/`
Expected: `ok build_footage_acquisition`.

Run: `rtk proxy bun lib/footage_candidate_selection.test.ts` from `scout/`
Expected: exit 0.

Run: `rtk proxy bun lib/footage_candidate_ocr.test.ts` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit footage migration**

```powershell
rtk git add scout/pipeline/build_footage.ts scout/pipeline/build_footage_acquisition.test.ts scout/lib/footage_candidate_selection.ts scout/lib/footage_candidate_selection.test.ts
rtk git commit -m "refactor(scout): acquire footage before materialization"
```

---

### Task 15: Migrate comments, social cards, and image repair

**Files:**
- Modify: `scout/pipeline/collect_comments.ts`
- Modify: `scout/lib/comment_engine.ts`
- Modify: `scout/pipeline/enrich_image_paths.ts`
- Modify: `scout/scrapers/crop_post.ts`
- Create: `scout/pipeline/comments_acquisition.test.ts`

**Interfaces:**
- Consumes: `service.collectComments()`, `service.captureSocialCard()`, and `service.materialize()`.
- Produces: unchanged `comments[]` and `image_path` fields with no per-platform scraper subprocesses.

- [ ] **Step 1: Write a failing selected-comment screenshot test**

```ts
// scout/pipeline/comments_acquisition.test.ts
import assert from 'node:assert/strict';
import { collectNormalizedComments } from './collect_comments.ts';

const calls: string[] = [];
const comments = await collectNormalizedComments(
  [{ url: 'https://x.com/owner/status/1', platform: 'twitter' }],
  {
    perSource: 3,
    cap: 2,
    collect: async () => [
      { id: 'a', author: 'one', text: 'first', likes: 10 },
      { id: 'b', author: 'two', text: 'second', likes: 5 },
      { id: 'c', author: 'three', text: 'third', likes: 1 },
    ],
    capture: async (_url, comment) => {
      calls.push(comment.id);
      return { path: `${comment.id}.png`, kind: 'social-card', source: 'dom', bytes: 1 };
    },
  },
);
assert.deepEqual(comments.map((item) => item.image_path), ['a.png', 'b.png']);
assert.deepEqual(calls, ['a', 'b']);
console.log('ok comments_acquisition');
```

- [ ] **Step 2: Run the test and verify failure**

Run: `rtk proxy bun pipeline/comments_acquisition.test.ts` from `scout/`
Expected: FAIL because `collectNormalizedComments` is not exported.

- [ ] **Step 3: Replace scraper subprocesses and make repair command a kernel wrapper**

Define the reusable comment seam:

```ts
export interface CommentSource {
  url: string;
  platform: Platform;
}

export interface CollectNormalizedCommentDeps {
  perSource: number;
  cap: number;
  collect(url: string, max: number): Promise<CommentRecord[]>;
  capture(url: string, comment: CommentRecord): Promise<LocalAsset>;
}

export async function collectNormalizedComments(
  sources: CommentSource[],
  deps: CollectNormalizedCommentDeps,
): Promise<CommentInfo[]>;
```

`collect_comments.ts` registers `comments` and selected `social-card` intents before the source visit, calls `service.collectComments()`, deduplicates and ranks normalized comments, and captures screenshots only for the final capped set. Move reusable DOM extraction/crop functions out of CLI-only comment scripts into `comment_engine.ts` adapter-callable exports.

Replace `collectCommentsCompat()` from Task 11 with `collectNormalizedComments()` and delete the per-platform `execFileSync` loop.

`enrich_image_paths.ts` calls `service.materialize()` for original non-video media. It calls `service.captureSocialCard()` only when the entry explicitly needs social context or original media is unavailable. Preserve the current behavior of dropping unusable non-video footage and validating crop density through `okCrop()`.

- [ ] **Step 4: Verify comments, crop guards, and image repair**

Run: `rtk proxy bun pipeline/comments_acquisition.test.ts` from `scout/`
Expected: `ok comments_acquisition`.

Run: `rtk proxy bun lib/comment_content.test.ts` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit comment and social-card migration**

```powershell
rtk git add scout/pipeline/collect_comments.ts scout/pipeline/comments_acquisition.test.ts scout/lib/comment_engine.ts scout/pipeline/enrich_image_paths.ts scout/scrapers/crop_post.ts
rtk git commit -m "refactor(scout): acquire comments and social cards"
```

---

### Task 16: Enforce the acquisition boundary and document operations

**Files:**
- Create: `scout/acquisition/boundary.test.ts`
- Create: `scout/acquisition/run_all_tests.ts`
- Modify: `scout/README.md`
- Modify: `scout/RUNBOOK.md`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `scout/package.json`

**Interfaces:**
- Consumes: completed kernel and migrated pipeline.
- Produces: automated boundary enforcement, documented configuration, and a single acquisition test command.

- [ ] **Step 1: Write a failing boundary test**

```ts
// scout/acquisition/boundary.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const targets = [
  'pipeline/run_pipeline.ts',
  'pipeline/trace_source.ts',
  'pipeline/build_footage.ts',
  'pipeline/collect_comments.ts',
  'pipeline/discover_reels.ts',
  'pipeline/topic_to_urls.ts',
  'pipeline/enrich_image_paths.ts',
];
const forbidden = [
  /from ['"]\.\.\/lib\/cdp\.ts['"]/,
  /from ['"]\.\.\/scrapers\/(?:ig_profile|tiktok_profile|tiktok_video|x_profile|threads_video|search_social_v2)\.ts['"]/,
  /\bconnect\s*\(/,
  /\b(?:tiktokOembed|youtubeOembed|probeVideo|postShape|directStreamUrl|tiktokDirectUrl|threadsVideoSrc)\s*\(/,
  /\bexecFile(?:Sync)?\s*\([^\n]*(?:yt-dlp|gallery-dl)/,
  /\bspawn\s*\([^\n]*(?:yt-dlp|gallery-dl)/,
];
for (const relative of targets) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `${relative} bypasses acquisition kernel`);
  }
}
console.log('ok acquisition_boundary');
```

- [ ] **Step 2: Run the boundary test and verify current bypasses fail**

Run: `rtk proxy bun acquisition/boundary.test.ts` from `scout/`
Expected: FAIL naming any remaining direct CDP/downloader call in a target pipeline file.

- [ ] **Step 3: Remove final bypasses and document exact controls**

Move any remaining platform acquisition into adapters or `materialize.ts`. Add these documented environment variables with their exact defaults:

```dotenv
GALLERY_DL=gallery-dl
THOTH_ACQUISITION_CAPTURE_MS=15000
THOTH_ACQUISITION_DISCOVERY_TTL_MS=1800000
THOTH_ACQUISITION_POST_TTL_MS=21600000
THOTH_ACQUISITION_NEGATIVE_TTL_MS=900000
```

Document browser visibility, one-navigation behavior, cache location, `gallery-dl` optional installation, fallback order, circuit behavior, sensitive-data rules, and how to clear only `scout/output/acquisition-cache/v1`. Merge these entries into the existing `scripts` object in `scout/package.json`; retain `lint`, `lint:fix`, and `format` unchanged:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:acquisition": "bun acquisition/run_all_tests.ts"
  }
}
```

Create `run_all_tests.ts` that imports each acquisition test in deterministic foundation-to-adapter order and prints `ok acquisition_suite` only after every import resolves.

```ts
// scout/acquisition/run_all_tests.ts
const tests = [
  './url.test.ts',
  './cache.test.ts',
  './browser_coordinator.test.ts',
  './network_capture.test.ts',
  './policy.test.ts',
  './materialize.test.ts',
  './service.test.ts',
  './adapters/instagram.test.ts',
  './adapters/twitter.test.ts',
  './adapters/tiktok.test.ts',
  './adapters/youtube.test.ts',
  './adapters/facebook.test.ts',
  './adapters/threads.test.ts',
  './adapters/reddit.test.ts',
  './boundary.test.ts',
];
for (const test of tests) await import(test);
console.log('ok acquisition_suite');
```

- [ ] **Step 4: Verify boundary, docs-adjacent config, and suite**

Run: `rtk proxy bun acquisition/boundary.test.ts` from `scout/`
Expected: `ok acquisition_boundary`.

Run: `rtk bun run test:acquisition` from `scout/`
Expected: final line `ok acquisition_suite`.

Run: `rtk bun x tsc --noEmit` from `scout/`
Expected: exit 0.

- [ ] **Step 5: Commit cleanup and documentation**

```powershell
rtk git add scout/acquisition/boundary.test.ts scout/acquisition/run_all_tests.ts scout/README.md scout/RUNBOOK.md scout/package.json .env.example README.md
rtk git commit -m "docs(scout): enforce acquisition operations"
```

---

### Task 17: Full regression and controlled live acceptance

**Files:**
- Create: `docs/superpowers/plans/2026-08-02-shared-acquisition-kernel-live-test.md`
- Modify only if a regression is found: the smallest owning source and test files from Tasks 1–16.

**Interfaces:**
- Consumes: the complete kernel and migrated pipeline.
- Produces: recorded automated verification and a safe manual platform acceptance checklist.

- [ ] **Step 1: Write the live acceptance checklist before running live platforms**

The checklist contains one manually supplied canonical URL for each enabled platform and these fields for the operator to fill with `PASS`, `FAIL`, or `SKIP` plus a safe reason:

```markdown
| Platform | Metadata | Media | Cache reuse | Social/comment card | Safe failure |
|---|---|---|---|---|---|
| Instagram |  |  |  |  |  |
| X/Twitter |  |  |  |  |  |
| TikTok |  |  |  |  |  |
| YouTube |  |  |  |  |  |
| Facebook |  |  |  |  |  |
| Threads |  |  |  |  |  |
| Reddit |  |  |  |  |  |
```

The checklist must instruct the operator to stop the affected platform immediately on login, CAPTCHA, checkpoint, account verification, `401`, `403`, or `429`. It must prohibit pasting headers, cookies, signed URLs, or response bodies into the report.

- [ ] **Step 2: Run all automated Scout regressions**

Run from `scout/`:

```powershell
rtk bun run test:acquisition
rtk bun x tsc --noEmit
rtk bun run lint
```

Expected: all exit 0. If repository-wide lint reports pre-existing findings, record the exact baseline and require zero new findings in `scout/acquisition/` and every modified pipeline file.

Run every existing Scout test and stop on the first failure:

```powershell
rtk proxy powershell -NoProfile -Command "$files = Get-ChildItem -Path . -Recurse -Filter *.test.ts | Where-Object { $_.FullName -notlike '*node_modules*' }; foreach ($file in $files) { & rtk proxy bun $file.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }"
```

Expected: exit 0 after every discovered test prints its existing success line.

- [ ] **Step 3: Validate a fixture content set and Rust compatibility**

Run:

```powershell
rtk proxy bun pipeline/validate_content_set.ts output/thoth_content_set.json
rtk cargo check -p thoth-core
```

Expected: content-set validation exits 0 for a known-good fixture and `thoth-core` compiles without schema changes.

- [ ] **Step 4: Perform controlled live acceptance with a strict budget**

Start the managed browser visibly, log in manually where required, and process one supplied URL at a time. For each platform, verify:

- the first request resolves normalized metadata;
- the second identical request returns `source: cache` without navigation;
- images prefer `gallery-dl` when supported;
- video materialization uses a captured CDN or yt-dlp fallback;
- only selected X posts/comments receive CDP crops;
- a simulated adapter `429` opens the circuit in automated tests;
- logs, cache files, and content sets contain no sensitive values.

Do not induce a real rate limit or challenge to test the circuit.

- [ ] **Step 5: Commit the acceptance record**

```powershell
rtk git add -f docs/superpowers/plans/2026-08-02-shared-acquisition-kernel-live-test.md
rtk git commit -m "test(scout): record acquisition acceptance"
```

After the commit, run `rtk git status --short --branch` and require a clean worktree before branch integration.
