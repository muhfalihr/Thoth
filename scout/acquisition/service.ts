// service.ts — the acquisition kernel's single entry point. Composes cache,
// coordinator, materializer, policy, and platform adapters (Tasks 7–10, not
// yet implemented) behind one facade so pipeline code never touches the
// individual kernel modules or lib/cdp.ts directly.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
      visit: (platform, url, acquire) =>
        coordinator.visitOnce(platform, url, async () => {
          const client = await connect({ match: hostnameOf(url), navigate: url });
          try {
            return await acquire(client, coordinator.intents(url));
          } finally {
            client.close();
          }
        }),
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
  private failUrlOperation(platform: Platform, canonicalUrl: string, error: unknown): never {
    if (!(error instanceof AcquisitionError)) throw error;
    this.coordinator.recordOutcome(platform, error.outcome);
    this.cache.setNegative(canonicalUrl, error.outcome, this.config.negativeTtlMs);
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
        const result = await adapter.discover(request, this.context);
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
    const negative = this.cache.getNegative(canonical);
    if (negative)
      throw new AcquisitionError(`inspect: cached negative outcome for ${platform}`, negative);
    const key = `inspect:${canonical}`;
    const runValue = this.cache.getRun(key) as PostRecord | undefined;
    if (runValue) return withCacheSource(runValue);
    const durable = this.cache.getPost(canonical);
    if (durable) return withCacheSource(durable);
    return this.cache.memoize(key, async () => {
      try {
        const result = await adapter.inspect(canonical, this.context);
        this.coordinator.recordOutcome(platform, result.outcome);
        this.cache.setPost(result, this.config.postTtlMs);
        return result;
      } catch (error) {
        this.failUrlOperation(platform, canonical, error);
      }
    });
  }

  async collectComments(url: string, limits: CommentLimits): Promise<CommentRecord[]> {
    const { platform, adapter } = this.resolveAdapter(url);
    const canonical = canonicalizeUrl(url);
    const negative = this.cache.getNegative(canonical);
    if (negative)
      throw new AcquisitionError(`comments: cached negative outcome for ${platform}`, negative);
    const key = `comments:${canonical}:${limits.max}`;
    const runValue = this.cache.getRun(key) as CommentRecord[] | undefined;
    if (runValue) return runValue;
    return this.cache.memoize(key, async () => {
      try {
        return await adapter.collectComments(canonical, limits, this.context);
      } catch (error) {
        this.failUrlOperation(platform, canonical, error);
      }
    });
  }

  async captureSocialCard(url: string, purpose: SocialCardPurpose): Promise<LocalAsset> {
    const { platform, adapter } = this.resolveAdapter(url);
    const canonical = canonicalizeUrl(url);
    const negative = this.cache.getNegative(canonical);
    if (negative) {
      throw new AcquisitionError(`social-card: cached negative outcome for ${platform}`, negative);
    }
    const key = `social-card:${canonical}:${purpose}`;
    const runValue = this.cache.getRun(key) as LocalAsset | undefined;
    if (runValue) return runValue;
    return this.cache.memoize(key, async () => {
      try {
        return await adapter.captureSocialCard(canonical, purpose, this.context);
      } catch (error) {
        this.failUrlOperation(platform, canonical, error);
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
