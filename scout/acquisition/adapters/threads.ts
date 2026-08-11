// threads.ts — Threads (Meta) platform adapter. Observes the post's own
// private Meta GraphQL/API response passively during the single navigation
// context.visit() grants (Ruling 4/7), falls back to the page's own Open
// Graph <meta> tags (read via CDP evaluate — no extra navigation, no extra
// fetch), and calls threads_video.ts's threadsVideoSrc(postUrl, {client})
// only when the caller registered a `media` intent, so the canonical post
// stays loaded and the ephemeral fbcdn URL is only resolved when actually
// needed. No comment scraper exists for Threads anywhere in scout/scrapers
// (grep of "scrape_comments" only turns up _fb/_reddit/_x/_yt/_ig and the
// TikTok-generic scrape_comments.ts) — collectComments() is deferred with an
// honest unsupported error rather than inventing selectors with no reuse
// target.
import { cropPost } from '../../scrapers/crop_post.ts';
import { threadsVideoSrc } from '../../scrapers/threads_video.ts';
import { readAcquisitionConfig } from '../config.ts';
import type { NetworkMatcher } from '../network_capture.ts';
import { observeNetworkResponses } from '../network_capture.ts';
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
import { findFirstObject } from './json_walk.ts';

interface OpenGraphMeta {
  title: string;
  description: string;
  image: string;
}

export interface ThreadsAdapterDeps {
  videoSrc: (postUrl: string, opts: { client: unknown }) => Promise<string>;
  // Network-capture deadline (ms). Defaults to the shared config knob
  // (THOTH_ACQUISITION_CAPTURE_MS, 15s) — injectable so tests can shrink it
  // without mutating process.env (which Bun would leak across test files
  // batched into one process).
  captureMs: number;
}

function resolveDeps(overrides: Partial<ThreadsAdapterDeps>): ThreadsAdapterDeps {
  return {
    videoSrc: overrides.videoSrc ?? ((postUrl, opts) => threadsVideoSrc(postUrl, opts)),
    captureMs: overrides.captureMs ?? readAcquisitionConfig().captureDeadlineMs,
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

// crop_post.ts's threads idRe: /\/post\/([\w-]+)/
function postIdFromUrl(url: string): string {
  return url.match(/\/post\/([\w-]+)/)?.[1] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// No captured Threads GraphQL/API fixture exists anywhere in this codebase
// (grep of scout/ for a Threads response payload example returned nothing
// beyond this task's own brief fixture). This predicate/accessor pair
// mirrors the brief's fixture shape (id/user.username/text/image_url); if a
// real capture diverges, only these two functions need retuning.
function isThreadsPostNode(node: Record<string, unknown>): node is Record<string, unknown> {
  return typeof node.id === 'string' && isRecord(node.user) && typeof node.user.username === 'string';
}

function mediaListOf(node: Record<string, unknown>, canonicalUrl: string): MediaAsset[] {
  if (typeof node.image_url === 'string') {
    return [
      {
        id: `${canonicalUrl}#1`,
        kind: 'image',
        index: 1,
        canonical_post_url: canonicalUrl,
        ephemeral_url: node.image_url,
      },
    ];
  }
  if (typeof node.video_url === 'string') {
    return [
      {
        id: `${canonicalUrl}#1`,
        kind: 'video',
        index: 1,
        canonical_post_url: canonicalUrl,
        ephemeral_url: node.video_url,
      },
    ];
  }
  return [];
}

function buildPostRecord(node: Record<string, unknown>, canonicalUrl: string): PostRecord {
  const user = isRecord(node.user) ? node.user : undefined;
  const ownerHandle = typeof user?.username === 'string' ? user.username : '';
  const text = typeof node.text === 'string' ? node.text : '';
  return {
    canonical_url: canonicalUrl,
    platform: 'threads',
    post_id: node.id as string,
    owner_handle: ownerHandle,
    text,
    media: mediaListOf(node, canonicalUrl),
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 0 },
  };
}

/** Pure parser: extracts a PostRecord from a captured Meta response body. */
export function parseThreadsPost(body: string, canonicalUrl: string): PostRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const node = findFirstObject<Record<string, unknown>>(parsed, isThreadsPostNode);
  if (!node) return null;
  return buildPostRecord(node, canonicalUrl);
}

function threadsPostMatcher(canonicalUrl: string): NetworkMatcher<PostRecord> {
  return {
    id: 'threads-post',
    matches: (response) =>
      /threads\.(com|net)/i.test(response.url) && /graphql|api\/v1/i.test(response.url),
    parse: (body) => parseThreadsPost(body, canonicalUrl),
  };
}

const OG_JS = `(() => {
  const get = (p) => { const el = document.querySelector('meta[property="' + p + '"]'); return el ? (el.getAttribute('content') || '') : ''; };
  return JSON.stringify({ title: get('og:title'), description: get('og:description'), image: get('og:image') });
})()`;

async function readOpenGraph(client: any): Promise<OpenGraphMeta> {
  try {
    const raw = await client.evaluate(OG_JS);
    const parsed = JSON.parse(raw || '{}');
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      image: typeof parsed.image === 'string' ? parsed.image : '',
    };
  } catch {
    return { title: '', description: '', image: '' };
  }
}

function postFromOpenGraph(og: OpenGraphMeta, url: string, elapsedMs: number): PostRecord {
  const media: MediaAsset[] = og.image
    ? [{ id: `${url}#1`, kind: 'image', index: 1, canonical_post_url: url, ephemeral_url: og.image }]
    : [];
  return {
    canonical_url: url,
    platform: 'threads',
    post_id: postIdFromUrl(url) || 'unknown',
    owner_handle: '',
    text: og.description || og.title || '',
    media,
    outcome: { status: 'resolved', source: 'dom', attempts: 1, elapsed_ms: elapsedMs },
  };
}

export function createThreadsAdapter(overrides: Partial<ThreadsAdapterDeps> = {}): PlatformAdapter {
  const deps = resolveDeps(overrides);
  const socialCardCache = new Map<string, LocalAsset>();

  async function inspect(url: string, context: AdapterContext): Promise<PostRecord> {
    const startedAt = context.now();
    const wantsMedia = context.intents(url).has('media');
    const wantsSocialCard = context.intents(url).has('social-card');

    return context.visit('threads', url, async (client) => {
      const captured = await observeNetworkResponses(client, {
        deadlineMs: deps.captureMs,
        matchers: [threadsPostMatcher(url)],
        action: async () => {},
      });

      let post =
        captured['threads-post'] ?? postFromOpenGraph(await readOpenGraph(client), url, context.now() - startedAt);

      // Video materialization only when requested — threadsVideoSrc() reads
      // the already-loaded DOM through the same client (own=false, no
      // second navigation: postUrl's code is already in location.href).
      if (wantsMedia) {
        const videoSrc = await deps.videoSrc(url, { client });
        if (videoSrc) {
          post = {
            ...post,
            media: [
              { id: `${url}#1`, kind: 'video', index: 1, canonical_post_url: url, ephemeral_url: videoSrc },
            ],
          };
        }
      }

      if (wantsSocialCard) {
        try {
          const crop = await cropPost({ url, client, navigate: false });
          if (crop.ok && crop.image_path) {
            socialCardCache.set(url, {
              path: crop.image_path,
              kind: 'social-card',
              source: 'dom',
              bytes: crop.bytes ?? 0,
            });
          }
        } catch {
          // best-effort only
        }
      }

      return { ...post, outcome: { ...post.outcome, elapsed_ms: context.now() - startedAt } };
    });
  }

  async function captureSocialCard(
    url: string,
    _purpose: SocialCardPurpose,
    context: AdapterContext,
  ): Promise<LocalAsset> {
    const stashed = socialCardCache.get(url);
    if (stashed) return stashed;

    return context.visit('threads', url, async (client) => {
      const crop = await cropPost({ url, client, navigate: false });
      if (!crop.ok || !crop.image_path) {
        throw new AcquisitionError(`threads: social-card crop failed for ${hostnameOf(url)}`, {
          status: 'unavailable',
          reason: 'invalid-response',
          attempts: 1,
          elapsed_ms: 0,
        });
      }
      const asset: LocalAsset = {
        path: crop.image_path,
        kind: 'social-card',
        source: 'dom',
        bytes: crop.bytes ?? 0,
      };
      socialCardCache.set(url, asset);
      return asset;
    });
  }

  async function collectComments(
    _url: string,
    _limits: CommentLimits,
    context: AdapterContext,
  ): Promise<CommentRecord[]> {
    const startedAt = context.now();
    // No Threads comment scraper exists anywhere in scout/scrapers (grep of
    // "scrape_comments" only matches _fb/_reddit/_x/_yt/_ig and the
    // TikTok-generic scrape_comments.ts) — nothing to reuse without
    // inventing untested DOM selectors, which Ruling 5's "extend, never
    // rewrite" intent argues against doing blind. Left for whichever future
    // task adds a Threads comment scraper to reuse.
    throw new AcquisitionError('threads: comment collection has no reusable scraper to extend', {
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
    // No Threads discovery helper (keyword/profile/trending → PostRecord
    // URLs) exists in this task's reuse set. Task 13 owns building general
    // social discovery on search_social_v2.ts.
    throw new AcquisitionError(
      `threads: discovery kind "${request.kind}" is not implemented by this adapter`,
      { status: 'unavailable', reason: 'unsupported', attempts: 0, elapsed_ms: context.now() - startedAt },
    );
  }

  return {
    platform: 'threads',
    supports: (url) => platformForUrl(url) === 'threads',
    discover,
    inspect,
    collectComments,
    captureSocialCard,
  };
}
