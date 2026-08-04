// youtube.ts — YouTube platform adapter. Metadata-first: oEmbed answers
// inspect() (title/author/thumbnail — no ephemeral CDN URL needed, since
// materialize.ts's YouTube chain is yt-dlp directly against canonical_url).
// Discovery has no existing YouTube scraper anywhere in this codebase
// (checked: no scrapers/pipeline file mentions "youtube" outside comment
// collection, and search_social_v2.ts has zero YouTube-specific logic) —
// Task 13 owns building that from scratch. Comment collection reuses
// scrape_comments_yt.ts's exported EXTRACT_JS/ensureLoaded against a CDP
// client obtained through context.visit(), without changing its selectors.
import fs from 'node:fs';
import { normalizeLikes } from '../../lib/comments.ts';
import { sleep } from '../../lib/cdp.ts';
import { cropPath } from '../../lib/paths.ts';
import { youtubeOembed } from '../../lib/verify.ts';
import { EXTRACT_JS, ensureLoaded } from '../../scrapers/scrape_comments_yt.ts';
import type {
  AdapterContext,
  CommentLimits,
  CommentRecord,
  DiscoveryRequest,
  DiscoveryResult,
  LocalAsset,
  MediaAsset,
  PlatformAdapter,
  PostRecord,
  SocialCardPurpose,
} from '../types.ts';
import { AcquisitionError } from '../types.ts';
import { platformForUrl } from '../url.ts';

interface OembedMeta {
  title: string;
  author: string;
  thumbnail: string;
}

interface RawYtComment {
  idx: number;
  author: string;
  text: string;
  likes_raw: string;
  avatar_url: string;
}

export interface YouTubeAdapterDeps {
  oembed: (url: string) => Promise<OembedMeta | null>;
  fetchBytes: (url: string) => Promise<Buffer>;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

function postIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const v = parsed.searchParams.get('v');
    if (v) return v;
    const shorts = parsed.pathname.match(/\/shorts\/([\w-]+)/);
    if (shorts) return shorts[1];
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
  } catch {
    // fall through
  }
  return '';
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function resolveDeps(overrides: Partial<YouTubeAdapterDeps>): YouTubeAdapterDeps {
  return {
    oembed: overrides.oembed ?? youtubeOembed,
    fetchBytes: overrides.fetchBytes ?? defaultFetchBytes,
  };
}

export function createYouTubeAdapter(overrides: Partial<YouTubeAdapterDeps> = {}): PlatformAdapter {
  const deps = resolveDeps(overrides);

  async function inspect(url: string, context: AdapterContext): Promise<PostRecord> {
    const startedAt = context?.now?.() ?? Date.now();
    const meta = await deps.oembed(url);
    if (!meta) {
      throw new AcquisitionError(`youtube: oEmbed metadata unavailable for ${hostnameOf(url)}`, {
        status: 'unavailable',
        reason: 'invalid-response',
        attempts: 1,
        elapsed_ms: (context?.now?.() ?? Date.now()) - startedAt,
      });
    }

    const media: MediaAsset[] = [{ id: `${url}#1`, kind: 'video', index: 1, canonical_post_url: url }];

    return {
      canonical_url: url,
      platform: 'youtube',
      post_id: postIdFromUrl(url),
      owner_handle: meta.author,
      text: meta.title,
      media,
      outcome: {
        status: 'resolved',
        source: 'public-metadata',
        attempts: 1,
        elapsed_ms: (context?.now?.() ?? Date.now()) - startedAt,
      },
    };
  }

  async function discover(
    request: DiscoveryRequest,
    context: AdapterContext,
  ): Promise<DiscoveryResult> {
    const startedAt = context.now();
    // No YouTube discovery helper (query/profile/trending) exists anywhere in
    // this codebase today — search_social_v2.ts has no YouTube branch and no
    // pipeline/scrapers file builds a YouTube post list. Task 13 owns
    // building YouTube discovery from scratch on search_social_v2.ts.
    throw new AcquisitionError(
      `youtube: discovery kind "${request.kind}" is not implemented by this adapter`,
      { status: 'unavailable', reason: 'unsupported', attempts: 0, elapsed_ms: context.now() - startedAt },
    );
  }

  async function collectComments(
    url: string,
    limits: CommentLimits,
    context: AdapterContext,
  ): Promise<CommentRecord[]> {
    return context.visit('youtube', url, async (client) => {
      await ensureLoaded(client);
      const byKey = new Map<string, CommentRecord>();
      for (let step = 0; step < 4 && byKey.size < limits.max; step += 1) {
        if (step > 0) {
          await client.evaluate('window.scrollBy(0, 1600)');
          await sleep(1500);
        }
        let raw: RawYtComment[] = [];
        try {
          raw = JSON.parse((await client.evaluate(EXTRACT_JS)) || '[]');
        } catch {
          raw = [];
        }
        for (const item of raw) {
          const key = `${item.author}:${item.text}`;
          if (!item.author && !item.text) continue;
          if (byKey.has(key)) continue;
          byKey.set(key, {
            id: key,
            author: item.author || '',
            text: item.text || '',
            likes: normalizeLikes(item.likes_raw),
          });
        }
      }
      return [...byKey.values()].slice(0, limits.max);
    });
  }

  async function captureSocialCard(
    url: string,
    purpose: SocialCardPurpose,
    context: AdapterContext,
  ): Promise<LocalAsset> {
    const startedAt = context?.now?.() ?? Date.now();
    const meta = await deps.oembed(url);
    if (!meta?.thumbnail) {
      throw new AcquisitionError(
        `youtube: no oEmbed thumbnail available for social card (${hostnameOf(url)})`,
        {
          status: 'unavailable',
          reason: 'invalid-response',
          attempts: 1,
          elapsed_ms: (context?.now?.() ?? Date.now()) - startedAt,
        },
      );
    }
    const bytes = await deps.fetchBytes(meta.thumbnail);
    const postId = postIdFromUrl(url) || 'unknown';
    const filePath = cropPath(`social_youtube_${purpose}_${postId}.jpg`);
    fs.writeFileSync(filePath, bytes);
    return { path: filePath, kind: 'social-card', source: 'public-metadata', bytes: bytes.length };
  }

  return {
    platform: 'youtube',
    supports: (url) => platformForUrl(url) === 'youtube',
    discover,
    inspect,
    collectComments,
    captureSocialCard,
  };
}
