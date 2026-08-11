// service.ts — the acquisition kernel's single entry point. Composes cache,
// coordinator, materializer, policy, and platform adapters (Tasks 7–10, not
// yet implemented) behind one facade so pipeline code never touches the
// individual kernel modules or lib/cdp.ts directly.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CdpClient } from '../lib/cdp.ts';
import { connect, run as runCdpRelay } from '../lib/cdp.ts';
import { ensureDir, OUTPUT_DIR } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import { createFacebookAdapter } from './adapters/facebook.ts';
import { createInstagramAdapter } from './adapters/instagram.ts';
import { createRedditAdapter } from './adapters/reddit.ts';
import { createThreadsAdapter } from './adapters/threads.ts';
import { createTikTokAdapter } from './adapters/tiktok.ts';
import { createTwitterAdapter } from './adapters/twitter.ts';
import { createYouTubeAdapter } from './adapters/youtube.ts';
import { BrowserCoordinator } from './browser_coordinator.ts';
import { AcquisitionCache } from './cache.ts';
import type { AcquisitionConfig } from './config.ts';
import { readAcquisitionConfig } from './config.ts';
import type { MaterializerDeps, MaterializerRunResult } from './materialize.ts';
import { Materializer } from './materialize.ts';
import { detectCapabilities } from './policy.ts';
import type {
  AcquisitionIntent,
  AcquisitionOutcome,
  AdapterContext,
  AssetPurpose,
  CommentLimits,
  CommentRecord,
  DiscoveryRequest,
  DiscoveryResult,
  LocalAsset,
  MediaAsset,
  Platform,
  PlatformAdapter,
  PostRecord,
  SocialCardPurpose,
} from './types.ts';
import { AcquisitionError } from './types.ts';
import { canonicalizeUrl, platformForUrl } from './url.ts';

export interface AcquisitionRunContext {
  readonly service: AcquisitionService;
  readonly runId: string;
}

interface CreateForTestOverrides {
  adapters: PlatformAdapter[];
  config?: AcquisitionConfig;
  cache?: AcquisitionCache;
  coordinator?: BrowserCoordinator;
  materializer?: Materializer;
  context?: AdapterContext;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

// The ONE shared navigation site every adapter and browse() caller routes through (via
// AdapterContext.visit() below). Many SPAs only mount the detail view (comments, search
// results, ...) when the tab is focused; a backgrounded relay tab renders just a shell. Force
// focus BEFORE navigating — same fix comment_engine.ts's scrapeComments() already relies on
// (its own copy of this pair is left untouched, for the CLI path). Fixing it here covers every
// consumer instead of patching each call site. `connectFn` defaults to the real connect() and
// is overridable only so tests can prove the ordering with a fake client, without real CDP.
export async function visitWithFocus<T>(
  url: string,
  acquire: (client: CdpClient, intents: ReadonlySet<AcquisitionIntent>) => Promise<T>,
  intents: ReadonlySet<AcquisitionIntent>,
  connectFn: typeof connect = connect,
): Promise<T> {
  const client = await connectFn({ match: hostnameOf(url) });
  try {
    await client.cmd('Page.bringToFront');
  } catch (e) {}
  try {
    await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (e) {}
  await client.navigate(url);
  try {
    return await acquire(client, intents);
  } finally {
    client.close();
  }
}

// Deep clone: cache hits must be independent of the value held in
// cache.runValues / cache.file.posts, otherwise a caller mutating nested
// fields (e.g. PostRecord.media[]) in place corrupts the shared cached
// object for later hits (same-run) or the live durable record (next persist()).
function withCacheSource<T extends { outcome: AcquisitionOutcome }>(value: T): T {
  const cloned = structuredClone(value);
  return { ...cloned, outcome: { ...cloned.outcome, source: 'cache' } };
}

function unsupportedPlatform(label: string): AcquisitionError {
  return new AcquisitionError(`unsupported platform: ${label}`, {
    status: 'unavailable',
    reason: 'unsupported',
    attempts: 0,
    elapsed_ms: 0,
  });
}

export class AcquisitionService {
  private readonly adapters: PlatformAdapter[];
  private readonly config: AcquisitionConfig;
  private readonly cache: AcquisitionCache;
  private readonly coordinator: BrowserCoordinator;
  private readonly materializer: Materializer;
  private readonly context: AdapterContext;

  private constructor(
    adapters: PlatformAdapter[],
    config: AcquisitionConfig,
    cache: AcquisitionCache,
    coordinator: BrowserCoordinator,
    materializer: Materializer,
    context: AdapterContext,
  ) {
    this.adapters = adapters;
    this.config = config;
    this.cache = cache;
    this.coordinator = coordinator;
    this.materializer = materializer;
    this.context = context;
  }

  // Production wiring. `adapters` defaults to every adapter this kernel ships
  // with (Instagram, X/Twitter, TikTok, YouTube so far — Task 10 extends this
  // default list as its adapter lands). `createForTest` below stays separate
  // and synchronous — it never defaults an adapter in, callers inject exactly
  // what they fake.
  static async create(
    adapters: PlatformAdapter[] = [
      createInstagramAdapter(),
      createTwitterAdapter(),
      createTikTokAdapter(),
      createYouTubeAdapter(),
      createFacebookAdapter(),
      createThreadsAdapter(),
      createRedditAdapter(),
    ],
  ): Promise<AcquisitionService> {
    const config = readAcquisitionConfig();
    const cache = new AcquisitionCache();
    const coordinator = new BrowserCoordinator();
    const capabilities = await detectCapabilities(config, runDownloader);
    const materializationRoot = path.join(OUTPUT_DIR, 'acquisition-media');
    ensureDir(materializationRoot);
    const materializer = new Materializer(config, {
      run: runDownloader,
      fetchBytes,
      root: materializationRoot,
      capabilities,
    });
    const context: AdapterContext = {
      intents: (url) => coordinator.intents(url),
      now: () => Date.now(),
      // `purpose` defaults to 'adapter' because frozen adapter files call
      // context.visit(platform, url, acquire) with only 3 args — they cannot
      // supply a purpose. AcquisitionService.contextFor()/browse() (below)
      // supply a real one by calling this SAME visit with a 4th arg.
      visit: (platform, url, acquire, purpose = 'adapter') =>
        coordinator.visitOnce(platform, url, purpose, () =>
          visitWithFocus(url, acquire, coordinator.intents(url)),
        ),
    };
    return new AcquisitionService(adapters, config, cache, coordinator, materializer, context);
  }

  // Synchronous test wiring: no capability probing, no CDP. Defaults are real
  // (throwaway-directory) instances, not in-memory fakes — the kernel's own
  // durable-cache/materializer code paths still run.
  static createForTest(overrides: CreateForTestOverrides): AcquisitionService {
    const config = overrides.config ?? readAcquisitionConfig();
    const coordinator = overrides.coordinator ?? new BrowserCoordinator();
    const cache =
      overrides.cache ??
      new AcquisitionCache({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-acq-test-')) });
    const materializer = overrides.materializer ?? new Materializer(config, testMaterializerDeps());
    const context: AdapterContext = overrides.context ?? {
      intents: (url) => coordinator.intents(url),
      now: () => Date.now(),
      visit: async () => {
        throw new Error('no browser context in test mode');
      },
    };
    return new AcquisitionService(
      overrides.adapters,
      config,
      cache,
      coordinator,
      materializer,
      context,
    );
  }

  registerIntent(url: string, intent: AcquisitionIntent): void {
    this.coordinator.registerIntent(url, intent);
  }

  // Builds an AdapterContext whose .visit() tags every navigation it makes with
  // `purpose` — WITHOUT changing the 3-arg shape frozen adapter files call
  // (they still just write context.visit(platform, url, acquire)). Each of the
  // 4 methods below calls adapter.X(url, this.contextFor('x')) with its own
  // distinct purpose so BrowserCoordinator.visitOnce() can tell apart, on the
  // SAME canonical URL, an inspect() from a comments() from a captureSocialCard()
  // — instead of every adapter-driven visit collapsing into one anonymous bucket.
  private contextFor(purpose: string): AdapterContext {
    return {
      intents: this.context.intents,
      now: this.context.now,
      visit: (platform, url, acquire) => this.context.visit(platform, url, acquire, purpose),
    };
  }

  // Exposes the SAME context.visit() every adapter's discover()/inspect() routes
  // through — one navigation per canonical URL per run, all navigations globally
  // serialized (browser_coordinator's tail chain) — to pipeline code that has no
  // adapter to call through (e.g. keyword search: no adapter implements
  // DiscoveryRequest.kind:'query', so search_social_v2.ts scrapes the search
  // results page itself, but must never do that via a raw lib/cdp.ts connect()).
  // Adapters stay untouched; this is the one seam pipeline code gets instead.
  // `purpose` is optional (default 'browse') so existing call sites keep
  // compiling untouched (trace_source.ts in particular must not be edited for
  // this fix) — but any pipeline file that browse()s the SAME URL more than
  // once per run, or that a kernel-driven inspect/comments/social-card call
  // might ALSO reach, should pass its own distinct label for the same reason
  // contextFor() below does: BrowserCoordinator.visitOnce() refuses to alias
  // one purpose's result to a different purpose's caller on the same URL.
  async browse<T>(
    platform: Platform,
    url: string,
    acquire: (client: CdpClient) => Promise<T>,
    purpose = 'browse',
  ): Promise<T> {
    try {
      return await this.context.visit(platform, url, (client) => acquire(client), purpose);
    } catch (error) {
      // Scope the negative to this browse's own purpose, not to the URL: an
      // 'ig-grid' failure must not make inspect() think the post is unavailable.
      this.failUrlOperation(platform, purpose, canonicalizeUrl(url), error);
    }
  }

  private resolveAdapter(url: string): { platform: Platform; adapter: PlatformAdapter } {
    const platform = platformForUrl(url);
    const adapter = platform
      ? this.adapters.find(
          (candidate) => candidate.platform === platform && candidate.supports(url),
        )
      : undefined;
    if (!platform || !adapter) {
      throw unsupportedPlatform(hostnameOf(url));
    }
    return { platform, adapter };
  }

  private adapterForPlatform(platform: Platform): PlatformAdapter {
    const adapter = this.adapters.find((candidate) => candidate.platform === platform);
    if (!adapter) throw unsupportedPlatform(platform);
    return adapter;
  }

  // Records the outcome and writes a negative-cache entry before rethrowing.
  // A non-AcquisitionError throw is a bug, not a platform outcome: propagate
  // it untouched.
  //
  // `operation` scopes the negative entry. It must NOT be dropped: a url-only
  // negative key lets one operation's failure block every other operation on
  // that post for the whole negative TTL, durably. reddit.captureSocialCard()
  // throws `unsupported` unconditionally by design, and trace_source's coverOf()
  // calls it on every run — which used to poison inspect() and collectComments()
  // for that URL, aborting the next run's pipeline before its first stage.
  private failUrlOperation(
    platform: Platform,
    operation: string,
    canonicalUrl: string,
    error: unknown,
  ): never {
    if (!(error instanceof AcquisitionError)) throw error;
    this.coordinator.recordOutcome(platform, error.outcome);
    this.cache.setNegative(operation, canonicalUrl, error.outcome, this.config.negativeTtlMs);
    throw error;
  }

  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const adapter = this.adapterForPlatform(request.platform);
    const key = `discover:${request.platform}:${request.kind}:${request.value}:${request.limit}`;
    const runValue = this.cache.getRun(key) as DiscoveryResult | undefined;
    if (runValue) return withCacheSource(runValue);
    const durable = this.cache.getDiscovery(key);
    if (durable) return withCacheSource(durable);
    return this.cache.memoize(key, async () => {
      try {
        const result = await adapter.discover(request, this.contextFor('discover'));
        this.coordinator.recordOutcome(request.platform, result.outcome);
        this.cache.setDiscovery(key, result, this.config.discoveryTtlMs);
        return result;
      } catch (error) {
        if (!(error instanceof AcquisitionError)) throw error;
        this.coordinator.recordOutcome(request.platform, error.outcome);
        throw error;
      }
    });
  }

  async inspectPost(url: string): Promise<PostRecord> {
    const { platform, adapter } = this.resolveAdapter(url);
    const canonical = canonicalizeUrl(url);
    const negative = this.cache.getNegative('inspect', canonical);
    if (negative)
      throw new AcquisitionError(`inspect: cached negative outcome for ${platform}`, negative);
    const key = `inspect:${canonical}`;
    const runValue = this.cache.getRun(key) as PostRecord | undefined;
    if (runValue) return withCacheSource(runValue);
    const durable = this.cache.getPost(canonical);
    if (durable) return withCacheSource(durable);
    return this.cache.memoize(key, async () => {
      try {
        const result = await adapter.inspect(canonical, this.contextFor('inspect'));
        this.coordinator.recordOutcome(platform, result.outcome);
        this.cache.setPost(result, this.config.postTtlMs);
        return result;
      } catch (error) {
        this.failUrlOperation(platform, 'inspect', canonical, error);
      }
    });
  }

  async collectComments(url: string, limits: CommentLimits): Promise<CommentRecord[]> {
    const { platform, adapter } = this.resolveAdapter(url);
    const canonical = canonicalizeUrl(url);
    const negative = this.cache.getNegative('comments', canonical);
    if (negative)
      throw new AcquisitionError(`comments: cached negative outcome for ${platform}`, negative);
    const key = `comments:${canonical}:${limits.max}`;
    const runValue = this.cache.getRun(key) as CommentRecord[] | undefined;
    if (runValue) return runValue;
    return this.cache.memoize(key, async () => {
      try {
        return await adapter.collectComments(canonical, limits, this.contextFor('comments'));
      } catch (error) {
        this.failUrlOperation(platform, 'comments', canonical, error);
      }
    });
  }

  async captureSocialCard(url: string, purpose: SocialCardPurpose): Promise<LocalAsset> {
    const { platform, adapter } = this.resolveAdapter(url);
    const canonical = canonicalizeUrl(url);
    // Scoped by card purpose too, matching the memo key below: a failed 'comment'
    // card must not stand in for a 'post' card's outcome.
    const operation = `social-card:${purpose}`;
    const negative = this.cache.getNegative(operation, canonical);
    if (negative) {
      throw new AcquisitionError(`social-card: cached negative outcome for ${platform}`, negative);
    }
    const key = `social-card:${canonical}:${purpose}`;
    const runValue = this.cache.getRun(key) as LocalAsset | undefined;
    if (runValue) return runValue;
    return this.cache.memoize(key, async () => {
      try {
        return await adapter.captureSocialCard(canonical, purpose, this.contextFor('social-card'));
      } catch (error) {
        this.failUrlOperation(platform, operation, canonical, error);
      }
    });
  }

  async materialize(asset: MediaAsset, purpose: AssetPurpose): Promise<LocalAsset> {
    const key = `materialize:${asset.id}:${purpose}`;
    const runValue = this.cache.getRun(key) as LocalAsset | undefined;
    if (runValue) return runValue;
    return this.cache.memoize(key, () => this.materializer.materialize(asset, purpose));
  }
}

function testMaterializerDeps(): MaterializerDeps {
  return {
    run: async () => {
      throw new Error('no downloader in test mode');
    },
    fetchBytes: async () => {
      throw new Error('no downloader in test mode');
    },
    root: os.tmpdir(),
  };
}

// Production MaterializerDeps: execFile with an argument array only (never a
// shell string), and the {exitCode, stderr, timedOut} shape is always
// resolved — never thrown — so argv/stderr never leak into a thrown error.
function runDownloader(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<MaterializerRunResult> {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (!error) {
        resolve({ exitCode: 0, stderr, timedOut: false });
        return;
      }
      resolve({
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stderr,
        // ponytail: Node's exec* callback only exposes `killed`, not a clean
        // "why" — this treats any killed child as a timeout. Good enough
        // while timeoutMs is the only thing that sends a kill signal here.
        timedOut: !!error.killed,
      });
    });
  });
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function createStandaloneAcquisitionContext(): Promise<AcquisitionRunContext> {
  return { service: await AcquisitionService.create(), runId: randomUUID() };
}

// Wraps lib/cdp.ts's run() so migrated pipeline files never import it
// directly. AcquisitionError gets a short, secret-free line (message +
// status/reason/attempts, never a URL, never raw stderr) and exit(1); every
// other error still goes through run()'s existing relay-help/exit(2) path.
export function runAcquisitionCli(main: () => Promise<unknown> | unknown): Promise<void> {
  return runCdpRelay(async () => {
    try {
      await main();
    } catch (error) {
      if (error instanceof AcquisitionError) {
        const { status, reason, attempts } = error.outcome;
        console.log(
          ui.red(
            `${ui.ERR} ${error.message} (status=${status}, reason=${reason ?? 'n/a'}, attempts=${attempts})`,
          ),
        );
        process.exit(1);
      }
      throw error;
    }
  });
}
