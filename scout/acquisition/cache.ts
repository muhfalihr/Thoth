// cache.ts — two-layer cache for the acquisition kernel.
//
// Layer 1 (durable): a single sanitized JSON file on disk (records.json), written
// atomically (write .tmp, rename over the final path) after every mutation. Every
// value that reaches disk passes through sanitizeCacheValue()/its discovery-item
// equivalent first — ephemeral CDN URLs never survive a durable write.
//
// Layer 2 (run-scoped): an in-memory Map that is never sanitized and never expires
// for the lifetime of the AcquisitionCache instance — it exists so a signed
// ephemeral_url resolved once during a run stays available to later intents in the
// SAME run without re-resolving. memoize()/getRun() are this layer; they are
// unrelated to the durable posts/discoveries/negatives tables.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ACQUISITION_CACHE_DIR, ensureDir } from '../lib/paths.ts';
import type { AcquisitionOutcome, DiscoveryResult, PostRecord } from './types.ts';
import { canonicalizeUrl } from './url.ts';

type CacheEnvelope<T> = { expires_at: number; value: T };
type CacheFile = {
  version: 1;
  posts: Record<string, CacheEnvelope<PostRecord>>;
  discoveries: Record<string, CacheEnvelope<DiscoveryResult>>;
  negatives: Record<string, CacheEnvelope<AcquisitionOutcome>>;
};

export interface AcquisitionCacheOptions {
  root?: string;
  now?: () => number;
}

export function sanitizeCacheValue(post: PostRecord): PostRecord {
  return {
    ...post,
    media: post.media.map(({ ephemeral_url: _secret, ...asset }) => asset),
  };
}

function emptyFile(): CacheFile {
  return { version: 1, posts: {}, discoveries: {}, negatives: {} };
}

export class AcquisitionCache {
  private readonly root: string;
  private readonly now: () => number;
  private readonly runValues = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private file: CacheFile;

  constructor(options: AcquisitionCacheOptions = {}) {
    this.root = options.root ?? ACQUISITION_CACHE_DIR;
    this.now = options.now ?? Date.now;
    this.file = this.load();
  }

  private recordsPath(): string {
    return path.join(this.root, 'records.json');
  }

  private load(): CacheFile {
    const file = this.recordsPath();
    if (!fs.existsSync(file)) return emptyFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CacheFile>;
      return {
        version: 1,
        posts: parsed.posts ?? {},
        discoveries: parsed.discoveries ?? {},
        negatives: parsed.negatives ?? {},
      };
    } catch {
      return emptyFile();
    }
  }

  private persist(): void {
    ensureDir(this.root);
    const file = this.recordsPath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.file, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  private hashKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private read<T>(table: Record<string, CacheEnvelope<T>>, key: string): T | null {
    const entry = table[key];
    if (!entry || entry.expires_at <= this.now()) return null;
    return entry.value;
  }

  getPost(url: string): PostRecord | null {
    return this.read(this.file.posts, this.hashKey(canonicalizeUrl(url)));
  }

  setPost(post: PostRecord, ttlMs: number): void {
    const key = this.hashKey(canonicalizeUrl(post.canonical_url));
    this.file.posts[key] = { expires_at: this.now() + ttlMs, value: sanitizeCacheValue(post) };
    this.persist();
  }

  getDiscovery(key: string): DiscoveryResult | null {
    return this.read(this.file.discoveries, this.hashKey(key));
  }

  setDiscovery(key: string, result: DiscoveryResult, ttlMs: number): void {
    const hashed = this.hashKey(key);
    this.file.discoveries[hashed] = {
      expires_at: this.now() + ttlMs,
      value: { ...result, items: result.items.map(sanitizeCacheValue) },
    };
    this.persist();
  }

  getNegative(url: string): AcquisitionOutcome | null {
    return this.read(this.file.negatives, this.hashKey(canonicalizeUrl(url)));
  }

  setNegative(url: string, outcome: AcquisitionOutcome, ttlMs: number): void {
    const key = this.hashKey(canonicalizeUrl(url));
    this.file.negatives[key] = { expires_at: this.now() + ttlMs, value: outcome };
    this.persist();
  }

  // Run-scoped memoization: dedupes concurrent identical work and keeps the
  // resolved value around (unsanitized, in memory only) for the rest of the run.
  // On rejection the in-flight entry is evicted (never promoted to runValues), so
  // the next memoize() call for the same key retries from scratch rather than
  // replaying a poisoned failure forever.
  memoize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.runValues.has(key)) {
      return Promise.resolve(this.runValues.get(key) as T);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = fn()
      .then((value) => {
        this.runValues.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  getRun(key: string): unknown {
    return this.runValues.get(key);
  }
}
