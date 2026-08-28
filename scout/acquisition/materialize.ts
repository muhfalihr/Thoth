import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AcquisitionConfig } from './config.ts';
import { sourceOrder } from './policy.ts';
import type { AcquisitionSource, AssetPurpose, LocalAsset, MediaAsset } from './types.ts';
import { AcquisitionError } from './types.ts';
import { platformForUrl } from './url.ts';

const RUN_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;

// Sources this materializer can physically execute. 'dom'/'network'/'public-metadata'
// capture belongs to platform adapters (CDP), not this content-addressed downloader.
const MATERIALIZABLE_SOURCES = new Set<AcquisitionSource>(['gallery-dl', 'direct-http', 'yt-dlp']);

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
  // When absent, every MATERIALIZABLE_SOURCES entry is attempted regardless of
  // what is actually installed (unchanged legacy behavior). When present
  // (wired from policy.ts::detectCapabilities by the facade), the chain is
  // narrowed to sources actually available.
  capabilities?: ReadonlySet<AcquisitionSource>;
}

interface AttemptResult {
  local: LocalAsset | null;
  attempts: number;
  /** Secret-free reason this source produced nothing — never stderr, never a signed URL. */
  note?: string;
}

export class Materializer {
  private readonly config: AcquisitionConfig;
  private readonly deps: MaterializerDeps;

  constructor(config: AcquisitionConfig, deps: MaterializerDeps) {
    this.config = config;
    this.deps = deps;
  }

  async materialize(asset: MediaAsset, purpose: AssetPurpose): Promise<LocalAsset> {
    const clock = this.deps.now ?? Date.now;
    const startedAt = clock();
    // ponytail: unresolved host falls back to a generic non-YouTube platform — every
    // platform besides YouTube shares the same media chain, so this never changes
    // real behavior. Upgrade to threading an explicit platform through MediaAsset if
    // that assumption ever breaks.
    const platform = platformForUrl(asset.canonical_post_url) ?? 'instagram';
    const chain = sourceOrder(platform, 'media', asset.kind, this.availableSources());
    const assetHash = createHash('sha256')
      .update(`${platform}:${asset.id}:${purpose}`)
      .digest('hex')
      .slice(0, 16);

    // The output path is content-addressed by (platform, asset id, purpose), so a file already
    // sitting there is this exact asset from an earlier run and re-downloading buys nothing.
    // Skipping the check is what turns a momentary extractor outage into a failed run for media
    // we already hold on disk.
    const alreadyOnDisk = findMaterialized(this.deps.root, assetHash);
    if (alreadyOnDisk) {
      return {
        ...toLocalAsset(alreadyOnDisk, asset.kind, 'cache'),
        // The disk lookup is itself the attempt that succeeded. Reporting 0 would break the
        // `attempts >= 1` invariant every consumer of a materialized asset relies on; `source`
        // already says no downloader ran.
        attempts: 1,
        elapsed_ms: clock() - startedAt,
      };
    }

    let attempts = 0;
    const notes: string[] = [];
    for (const source of chain) {
      const result = await this.tryOne(source, asset, assetHash);
      attempts += result.attempts;
      if (result.local) {
        return { ...result.local, attempts, elapsed_ms: clock() - startedAt };
      }
      notes.push(`${source}=${result.note ?? 'unavailable'}`);
    }

    // The thrown error stays deliberately cause-free so no stderr or signed URL can leak through
    // it. Without this line the caller only ever learns that materialization failed, never which
    // source gave up or how — the chain is otherwise entirely opaque from the outside.
    console.warn(
      `[acquisition] no source produced media ${asset.index} of ${asset.canonical_post_url}: ${
        notes.join(', ') || 'no source available'
      }`,
    );

    throw new AcquisitionError('media materialization failed', {
      status: 'unavailable',
      reason: 'materialization-failed',
      attempts,
      elapsed_ms: clock() - startedAt,
    });
  }

  private availableSources(): ReadonlySet<AcquisitionSource> {
    if (!this.deps.capabilities) return MATERIALIZABLE_SOURCES;
    const filtered = new Set<AcquisitionSource>();
    for (const source of MATERIALIZABLE_SOURCES) {
      if (this.deps.capabilities.has(source)) filtered.add(source);
    }
    return filtered;
  }

  private async tryOne(
    source: AcquisitionSource,
    asset: MediaAsset,
    assetHash: string,
  ): Promise<AttemptResult> {
    if (source === 'gallery-dl') return this.runGalleryDl(asset, assetHash);
    if (source === 'yt-dlp') return this.runYtDlp(asset, assetHash);
    if (source === 'direct-http') return this.runDirectHttp(asset, assetHash);
    return { local: null, attempts: 0, note: 'not-materializable' };
  }

  /** Secret-free summary of a downloader run, safe to log. */
  private static subprocessNote(result: MaterializerRunResult | null): string {
    if (!result) return 'spawn-failed';
    if (result.timedOut) return 'timed-out';
    return result.exitCode === 0 ? 'no-output-file' : `exit-${result.exitCode}`;
  }

  private async runGalleryDl(asset: MediaAsset, assetHash: string): Promise<AttemptResult> {
    const args = [
      '--directory',
      this.deps.root,
      '--filename',
      `${assetHash}.{extension}`,
      '--range',
      String(asset.index),
      asset.canonical_post_url,
    ];
    const result = await this.runSubprocess(this.config.galleryDl, args);
    const found = result?.exitCode === 0 ? findMaterialized(this.deps.root, assetHash) : undefined;
    return {
      local: found ? toLocalAsset(found, asset.kind, 'gallery-dl') : null,
      attempts: 1,
      note: Materializer.subprocessNote(result),
    };
  }

  private async runYtDlp(asset: MediaAsset, assetHash: string): Promise<AttemptResult> {
    const outputTemplate = path.join(this.deps.root, `${assetHash}.%(ext)s`);
    const args = [
      '--no-warnings',
      '--no-playlist',
      '-o',
      outputTemplate,
      '--',
      asset.canonical_post_url,
    ];
    const result = await this.runSubprocess(this.config.ytdlp, args);
    const found = result?.exitCode === 0 ? findMaterialized(this.deps.root, assetHash) : undefined;
    return {
      local: found ? toLocalAsset(found, asset.kind, 'yt-dlp') : null,
      attempts: 1,
      note: Materializer.subprocessNote(result),
    };
  }

  private async runSubprocess(
    executable: string,
    args: string[],
  ): Promise<MaterializerRunResult | null> {
    try {
      return await this.deps.run(executable, args, RUN_TIMEOUT_MS);
    } catch {
      return null;
    }
  }

  private async runDirectHttp(asset: MediaAsset, assetHash: string): Promise<AttemptResult> {
    if (!asset.ephemeral_url) return { local: null, attempts: 0, note: 'no-ephemeral-url' };
    const url = asset.ephemeral_url;
    const maxAttempts = Math.max(1, this.config.transportAttempts ?? 1);
    let attempts = 0;
    for (let i = 0; i < maxAttempts; i += 1) {
      attempts += 1;
      try {
        const bytes = await this.deps.fetchBytes(url, FETCH_TIMEOUT_MS);
        const extension = asset.kind === 'video' ? 'mp4' : 'jpg';
        const filePath = path.join(this.deps.root, `${assetHash}.${extension}`);
        fs.writeFileSync(filePath, bytes);
        return { local: toLocalAsset(filePath, asset.kind, 'direct-http'), attempts };
      } catch {
        // retry within budget; loop continues
      }
    }
    return { local: null, attempts, note: 'fetch-failed' };
  }
}

/** Downloader scratch files, which share the asset's name prefix but hold a partial asset. */
const INCOMPLETE_SUFFIXES = ['.part', '.ytdl', '.tmp', '.temp', '.download'];

function findMaterialized(root: string, assetHash: string): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  const prefix = `${assetHash}.`;
  const match = fs
    .readdirSync(root)
    .find(
      (name) =>
        name.startsWith(prefix) &&
        !INCOMPLETE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix)),
    );
  return match ? path.join(root, match) : undefined;
}

function toLocalAsset(
  filePath: string,
  kind: MediaAsset['kind'],
  source: AcquisitionSource,
): LocalAsset {
  return { path: filePath, kind, source, bytes: fs.statSync(filePath).size };
}
