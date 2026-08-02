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
}

interface AttemptResult {
  local: LocalAsset | null;
  attempts: number;
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
    const chain = sourceOrder(platform, 'media', asset.kind, MATERIALIZABLE_SOURCES);
    const assetHash = createHash('sha256')
      .update(`${platform}:${asset.id}:${purpose}`)
      .digest('hex')
      .slice(0, 16);

    let attempts = 0;
    for (const source of chain) {
      const result = await this.tryOne(source, asset, assetHash);
      attempts += result.attempts;
      if (result.local) return result.local;
    }

    throw new AcquisitionError('media materialization failed', {
      status: 'unavailable',
      reason: 'materialization-failed',
      attempts,
      elapsed_ms: clock() - startedAt,
    });
  }

  private async tryOne(
    source: AcquisitionSource,
    asset: MediaAsset,
    assetHash: string,
  ): Promise<AttemptResult> {
    if (source === 'gallery-dl') {
      return { local: await this.runGalleryDl(asset, assetHash), attempts: 1 };
    }
    if (source === 'yt-dlp') {
      return { local: await this.runYtDlp(asset, assetHash), attempts: 1 };
    }
    if (source === 'direct-http') {
      return this.runDirectHttp(asset, assetHash);
    }
    return { local: null, attempts: 0 };
  }

  private async runGalleryDl(asset: MediaAsset, assetHash: string): Promise<LocalAsset | null> {
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
    if (result?.exitCode !== 0) return null;
    const found = findMaterialized(this.deps.root, assetHash);
    return found ? toLocalAsset(found, asset.kind, 'gallery-dl') : null;
  }

  private async runYtDlp(asset: MediaAsset, assetHash: string): Promise<LocalAsset | null> {
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
    if (result?.exitCode !== 0) return null;
    const found = findMaterialized(this.deps.root, assetHash);
    return found ? toLocalAsset(found, asset.kind, 'yt-dlp') : null;
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
    if (!asset.ephemeral_url) return { local: null, attempts: 0 };
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
    return { local: null, attempts };
  }
}

function findMaterialized(root: string, assetHash: string): string | undefined {
  const prefix = `${assetHash}.`;
  const match = fs.readdirSync(root).find((name) => name.startsWith(prefix));
  return match ? path.join(root, match) : undefined;
}

function toLocalAsset(
  filePath: string,
  kind: MediaAsset['kind'],
  source: AcquisitionSource,
): LocalAsset {
  return { path: filePath, kind, source, bytes: fs.statSync(filePath).size };
}
