// reddit.ts — Reddit platform adapter. Prefers the canonical `.json` Listing
// representation (a plain HTTP GET, no browser needed) with an explicit,
// honest User-Agent header — politeness/compliance with Reddit's API
// guidelines (Ruling 10), NOT browser-impersonation fingerprint spoofing.
// Falls back to passive CDP/DOM (via context.visit()) only when the JSON
// fetch fails or yields no post. Comment collection reuses
// scrape_comments_reddit.ts's exported EXTRACT_JS/COUNT_JS against a CDP
// client obtained through context.visit(), without changing its selectors.
// crop_post.ts's PLATFORMS map has no `reddit` key (grep-verified), so
// captureSocialCard() has no DOM crop to reuse and is unsupported.
import { pollCount } from '../../lib/comment_engine.ts';
import { normalizeLikes } from '../../lib/comments.ts';
import { sleep } from '../../lib/cdp.ts';
import { COUNT_JS, EXTRACT_JS } from '../../scrapers/scrape_comments_reddit.ts';
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

// Honest, identifying UA per Reddit's API access guidelines — never a
// spoofed browser string (Ruling 10 forbids fingerprint impersonation here).
const REDDIT_USER_AGENT = 'CLIPPER-scout/1.0 (content acquisition; https://github.com/muhfalihr/CLIPPER)';

interface RawRedditComment {
  idx: number;
  author: string;
  text: string;
  likes_raw: string;
}

export interface RedditAdapterDeps {
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

async function defaultFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return response.json();
}

function resolveDeps(overrides: Partial<RedditAdapterDeps>): RedditAdapterDeps {
  return { fetchJson: overrides.fetchJson ?? defaultFetchJson };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

function postIdFromUrl(url: string): string {
  return url.match(/comments\/(\w+)/)?.[1] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mediaListOf(data: Record<string, unknown>, canonicalUrl: string): MediaAsset[] {
  if (typeof data.url === 'string' && /\.(jpe?g|png|gif|gifv|webp)(\?.*)?$/i.test(data.url)) {
    return [
      { id: `${canonicalUrl}#1`, kind: 'image', index: 1, canonical_post_url: canonicalUrl, ephemeral_url: data.url },
    ];
  }
  const secureMedia = isRecord(data.secure_media) ? data.secure_media : undefined;
  const redditVideo = isRecord(secureMedia?.reddit_video) ? secureMedia.reddit_video : undefined;
  if (data.is_video === true && typeof redditVideo?.fallback_url === 'string') {
    return [
      {
        id: `${canonicalUrl}#1`,
        kind: 'video',
        index: 1,
        canonical_post_url: canonicalUrl,
        ephemeral_url: redditVideo.fallback_url,
      },
    ];
  }
  return [];
}

function buildPostRecord(data: Record<string, unknown>, canonicalUrl: string): PostRecord | null {
  if (typeof data.id !== 'string') return null;
  const title = typeof data.title === 'string' ? data.title : '';
  const selftext = typeof data.selftext === 'string' ? data.selftext : '';
  return {
    canonical_url: canonicalUrl,
    platform: 'reddit',
    post_id: data.id,
    owner_handle: typeof data.author === 'string' ? data.author : '',
    text: selftext ? `${title}\n${selftext}` : title,
    media: mediaListOf(data, canonicalUrl),
    outcome: { status: 'resolved', source: 'public-metadata', attempts: 1, elapsed_ms: 0 },
  };
}

/**
 * Pure parser: extracts PostRecord[] from the canonical `.json` Listing
 * response (an array of two Listing objects — [0] is the post, [1] is
 * comments; only [0]'s children are posts).
 */
export function parseRedditListing(listing: unknown, canonicalUrl: string): PostRecord[] {
  if (!Array.isArray(listing) || listing.length === 0) return [];
  const first = listing[0];
  if (!isRecord(first) || !isRecord(first.data) || !Array.isArray(first.data.children)) return [];
  const posts: PostRecord[] = [];
  for (const child of first.data.children) {
    if (!isRecord(child) || !isRecord(child.data)) continue;
    const post = buildPostRecord(child.data, canonicalUrl);
    if (post) posts.push(post);
  }
  return posts;
}

export function createRedditAdapter(overrides: Partial<RedditAdapterDeps> = {}): PlatformAdapter {
  const deps = resolveDeps(overrides);

  async function domFallback(
    url: string,
    startedAt: number,
    context: AdapterContext,
  ): Promise<PostRecord> {
    return context.visit('reddit', url, async (client) => {
      let title = '';
      try {
        title = (await client.evaluate('document.title')) || '';
      } catch {
        title = '';
      }
      if (!title) {
        throw new AcquisitionError(`reddit: no JSON or DOM data for ${hostnameOf(url)}`, {
          status: 'unavailable',
          reason: 'invalid-response',
          attempts: 1,
          elapsed_ms: context.now() - startedAt,
        });
      }
      return {
        canonical_url: url,
        platform: 'reddit',
        post_id: postIdFromUrl(url) || 'unknown',
        owner_handle: '',
        text: title.replace(/\s*:\s*r\/\w+\s*$/i, ''),
        media: [],
        outcome: { status: 'resolved', source: 'dom', attempts: 1, elapsed_ms: context.now() - startedAt },
      };
    });
  }

  async function inspect(url: string, context: AdapterContext): Promise<PostRecord> {
    const startedAt = context.now();
    let listing: unknown;
    try {
      listing = await deps.fetchJson(`${url}.json`, { 'User-Agent': REDDIT_USER_AGENT });
    } catch {
      return domFallback(url, startedAt, context);
    }
    const posts = parseRedditListing(listing, url);
    const post = posts[0];
    if (!post) return domFallback(url, startedAt, context);
    return { ...post, outcome: { ...post.outcome, elapsed_ms: context.now() - startedAt } };
  }

  async function collectComments(
    url: string,
    limits: CommentLimits,
    context: AdapterContext,
  ): Promise<CommentRecord[]> {
    return context.visit('reddit', url, async (client) => {
      await pollCount(client, COUNT_JS, 10, 1000);
      const byKey = new Map<string, CommentRecord>();
      for (let step = 0; step < 4 && byKey.size < limits.max; step += 1) {
        if (step > 0) {
          await client.evaluate('window.scrollBy(0, 1400)');
          await sleep(1500);
        }
        let raw: RawRedditComment[] = [];
        try {
          raw = JSON.parse((await client.evaluate(EXTRACT_JS)) || '[]');
        } catch {
          raw = [];
        }
        for (const item of raw) {
          const key = `${item.author}:${item.idx}`;
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
    _purpose: SocialCardPurpose,
    context: AdapterContext,
  ): Promise<LocalAsset> {
    const startedAt = context.now();
    // crop_post.ts's PLATFORMS map has no 'reddit' key (grep-verified) — no
    // DOM crop selector exists to reuse for a Reddit social card.
    throw new AcquisitionError(`reddit: no social-card crop available for ${hostnameOf(url)}`, {
      status: 'unavailable',
      reason: 'unsupported',
      attempts: 0,
      elapsed_ms: context.now() - startedAt,
    });
  }

  async function discover(
    request: DiscoveryRequest,
    context: AdapterContext,
  ): Promise<DiscoveryResult> {
    const startedAt = context.now();
    // No Reddit discovery helper (keyword/subreddit/trending → PostRecord
    // URLs) exists in this task's reuse set (grep of scout/scrapers for
    // "reddit" only turns up scrape_comments_reddit.ts). Task 13 owns
    // building general social discovery on search_social_v2.ts.
    throw new AcquisitionError(
      `reddit: discovery kind "${request.kind}" is not implemented by this adapter`,
      { status: 'unavailable', reason: 'unsupported', attempts: 0, elapsed_ms: context.now() - startedAt },
    );
  }

  return {
    platform: 'reddit',
    supports: (url) => platformForUrl(url) === 'reddit',
    discover,
    inspect,
    collectComments,
    captureSocialCard,
  };
}
