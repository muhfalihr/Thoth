// tiktok.ts — TikTok platform adapter. Metadata-first: oEmbed answers inspect()
// for the common case; `tiktokDirectUrl()` (the tikwm.com REST lookup, never a
// second browser session — see defaultDirectUrl below) resolves an ephemeral
// CDN URL only when the caller registered a `media` intent. Discovery wraps
// `tiktokProfileVideos()` for profile grids only; keyword/topic discovery has
// no post-URL-producing helper in this task's reuse set (Task 13 owns
// building that on `search_social_v2.ts`). Comment collection reuses
// scrape_comments.ts's exported EXTRACT_JS/loadComments against a CDP
// client obtained through context.visit(), without changing its selectors.
import fs from 'node:fs';
import { normalizeLikes } from '../../lib/comments.ts';
import { sleep } from '../../lib/cdp.ts';
import { cropPath } from '../../lib/paths.ts';
import { tiktokOembed } from '../../lib/verify.ts';
import { EXTRACT_JS, loadComments } from '../../scrapers/scrape_comments.ts';
import { tiktokDirectUrl } from '../../scrapers/tiktok_video.ts';
import { tiktokProfileVideos } from '../../scrapers/tiktok_profile.ts';
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

interface ProfileVideo {
  url: string;
  views: number;
  caption: string;
  thumbnail?: string;
}

interface RawTikTokComment {
  idx: number;
  author: string;
  text: string;
  likes_raw: string;
  avatar_url: string;
}

export interface TikTokAdapterDeps {
  oembed: (url: string) => Promise<OembedMeta | null>;
  directUrl: (url: string) => Promise<string | null>;
  profileVideos: (
    username: string,
    opts?: { max?: number; captions?: boolean; client?: unknown; navigate?: boolean },
  ) => Promise<ProfileVideo[]>;
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
  return url.match(/\/video\/(\d+)/)?.[1] ?? '';
}

// defaultDirectUrl passes an explicit no-op cdpResolver so tiktokDirectUrl()'s
// internal viaCdp() short-circuits before it ever imports lib/cdp.ts or opens
// its own connection — this attempts only the tikwm.com REST lookup, never a
// second, uncontrolled browser session.
async function defaultDirectUrl(url: string): Promise<string | null> {
  const resolved = await tiktokDirectUrl(url, { cdpResolver: async () => null });
  return resolved?.url ?? null;
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function resolveDeps(overrides: Partial<TikTokAdapterDeps>): TikTokAdapterDeps {
  return {
    oembed: overrides.oembed ?? tiktokOembed,
    directUrl: overrides.directUrl ?? defaultDirectUrl,
    profileVideos: overrides.profileVideos ?? tiktokProfileVideos,
    fetchBytes: overrides.fetchBytes ?? defaultFetchBytes,
  };
}

function videoToPostRecord(video: ProfileVideo, ownerHandle: string): PostRecord {
  return {
    canonical_url: video.url,
    platform: 'tiktok',
    post_id: postIdFromUrl(video.url),
    owner_handle: ownerHandle,
    text: video.caption,
    engagement: { views: video.views },
    // ponytail: media left empty for discovery results — inspect() (called
    // per-URL later in the pipeline) is what populates media/ephemeral_url;
    // duplicating that here would mean resolving every profile video's CDN
    // URL up front, most of which are never used.
    media: [],
    outcome: { status: 'resolved', source: 'dom', attempts: 1, elapsed_ms: 0 },
  };
}

export function createTikTokAdapter(overrides: Partial<TikTokAdapterDeps> = {}): PlatformAdapter {
  const deps = resolveDeps(overrides);

  async function inspect(url: string, context: AdapterContext): Promise<PostRecord> {
    const startedAt = context?.now?.() ?? Date.now();
    const meta = await deps.oembed(url);
    if (!meta) {
      throw new AcquisitionError(`tiktok: oEmbed metadata unavailable for ${hostnameOf(url)}`, {
        status: 'unavailable',
        reason: 'invalid-response',
        attempts: 1,
        elapsed_ms: (context?.now?.() ?? Date.now()) - startedAt,
      });
    }

    let ephemeralUrl: string | undefined;
    if (context?.intents?.(url)?.has('media')) {
      ephemeralUrl = (await deps.directUrl(url)) ?? undefined;
    }

    const media: MediaAsset[] = [
      {
        id: `${url}#1`,
        kind: 'video',
        index: 1,
        canonical_post_url: url,
        ...(ephemeralUrl ? { ephemeral_url: ephemeralUrl } : {}),
      },
    ];

    return {
      canonical_url: url,
      platform: 'tiktok',
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
    if (request.kind !== 'profile') {
      // 'query': no keyword-search helper in this task's reuse set produces
      // PostRecord-shaped results. 'trending': discover_tiktok_trending.ts's
      // fetchTrending() returns bare topic strings (rank/title/view-count),
      // never a post URL, so it cannot satisfy PostRecord's canonical_url/
      // post_id without a further per-topic search. Task 13 owns turning
      // either into concrete posts on search_social_v2.ts.
      throw new AcquisitionError(
        `tiktok: discovery kind "${request.kind}" is not implemented by this adapter`,
        { status: 'unavailable', reason: 'unsupported', attempts: 0, elapsed_ms: context.now() - startedAt },
      );
    }

    const profileUrl = `https://www.tiktok.com/@${request.value}`;
    const items = await context.visit('tiktok', profileUrl, (client) =>
      deps.profileVideos(request.value, {
        max: request.limit,
        captions: true,
        client,
        navigate: false,
      }),
    );

    return {
      items: items.map((video) => videoToPostRecord(video, request.value)),
      outcome: { status: 'resolved', source: 'dom', attempts: 1, elapsed_ms: context.now() - startedAt },
    };
  }

  async function collectComments(
    url: string,
    limits: CommentLimits,
    context: AdapterContext,
  ): Promise<CommentRecord[]> {
    return context.visit('tiktok', url, async (client) => {
      await loadComments(client);
      const byKey = new Map<string, CommentRecord>();
      for (let step = 0; step < 4 && byKey.size < limits.max; step += 1) {
        if (step > 0) {
          await client.evaluate('window.scrollBy(0, 1600)');
          await sleep(1500);
        }
        let raw: RawTikTokComment[] = [];
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
        `tiktok: no oEmbed thumbnail available for social card (${hostnameOf(url)})`,
        {
          status: 'unavailable',
          reason: 'invalid-response',
          attempts: 1,
          elapsed_ms: (context?.now?.() ?? Date.now()) - startedAt,
        },
      );
    }
    let bytes: Buffer;
    try {
      bytes = await deps.fetchBytes(meta.thumbnail);
    } catch {
      throw new AcquisitionError(
        `tiktok: thumbnail fetch failed for social card (${hostnameOf(url)})`,
        {
          status: 'unavailable',
          reason: 'invalid-response',
          attempts: 1,
          elapsed_ms: (context?.now?.() ?? Date.now()) - startedAt,
        },
      );
    }
    const postId = postIdFromUrl(url) || 'unknown';
    const filePath = cropPath(`social_tiktok_${purpose}_${postId}.jpg`);
    fs.writeFileSync(filePath, bytes);
    return { path: filePath, kind: 'social-card', source: 'public-metadata', bytes: bytes.length };
  }

  return {
    platform: 'tiktok',
    supports: (url) => platformForUrl(url) === 'tiktok',
    discover,
    inspect,
    collectComments,
    captureSocialCard,
  };
}
