// instagram.ts — Instagram PlatformAdapter: observes the post's own private
// GraphQL response passively during the one navigation `context.visit()`
// grants us, and falls back to the battle-tested og:meta scraper / DOM crop
// when the network capture comes up empty. Never calls `connect()` directly
// (Ruling 4) and never closes a client it did not open itself (Ruling 3) —
// both scrapers it calls receive the visit's own client and are told
// `navigate:false` so a canonical post URL gets at most one navigation.
import fs from 'node:fs';
import type { CdpClient } from '../../lib/cdp.ts';
import { cropPost } from '../../scrapers/crop_post.ts';
import { igPostOg, igProfileReels } from '../../scrapers/ig_profile.ts';
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
import { canonicalizeUrl, platformForUrl } from '../url.ts';
import { findFirstObject } from './json_walk.ts';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findShortcodeMedia(root: unknown): Record<string, unknown> | null {
  const container = findFirstObject<Record<string, unknown>>(
    root,
    (node) => isRecord(node.xdt_shortcode_media) || isRecord(node.shortcode_media),
  );
  if (!container) return null;
  const media = container.xdt_shortcode_media ?? container.shortcode_media;
  return isRecord(media) ? media : null;
}

function captionOf(media: Record<string, unknown>): string {
  const viaEdges = (media.edge_media_to_caption as { edges?: unknown[] } | undefined)?.edges;
  const first = Array.isArray(viaEdges) ? viaEdges[0] : undefined;
  const edgeText = isRecord(first) && isRecord(first.node) ? first.node.text : undefined;
  if (typeof edgeText === 'string') return edgeText;
  const captionText = isRecord(media.caption) ? media.caption.text : undefined;
  return typeof captionText === 'string' ? captionText : '';
}

function engagementOf(media: Record<string, unknown>): Record<string, number> | undefined {
  const likes =
    (isRecord(media.edge_media_preview_like) ? media.edge_media_preview_like.count : undefined) ??
    (isRecord(media.edge_liked_by) ? media.edge_liked_by.count : undefined);
  const comments =
    (isRecord(media.edge_media_to_parent_comment)
      ? media.edge_media_to_parent_comment.count
      : undefined) ??
    (isRecord(media.edge_media_to_comment) ? media.edge_media_to_comment.count : undefined);
  const out: Record<string, number> = {};
  if (typeof likes === 'number') out.likes = likes;
  if (typeof comments === 'number') out.comments = comments;
  return Object.keys(out).length > 0 ? out : undefined;
}

function mediaAssetFromNode(
  node: Record<string, unknown>,
  index: number,
  canonicalUrl: string,
): MediaAsset {
  const kind: MediaAsset['kind'] = node.is_video ? 'video' : 'image';
  const asset: MediaAsset = {
    id: typeof node.id === 'string' ? node.id : `${canonicalUrl}#${index}`,
    kind,
    index,
    canonical_post_url: canonicalUrl,
  };
  const dimensions = isRecord(node.dimensions) ? node.dimensions : undefined;
  if (typeof dimensions?.width === 'number') asset.width = dimensions.width;
  if (typeof dimensions?.height === 'number') asset.height = dimensions.height;
  if (typeof node.video_duration === 'number') asset.duration_sec = node.video_duration;
  const ephemeral = kind === 'video' ? node.video_url : node.display_url;
  if (typeof ephemeral === 'string') asset.ephemeral_url = ephemeral;
  return asset;
}

function mediaListOf(media: Record<string, unknown>, canonicalUrl: string): MediaAsset[] {
  const children = isRecord(media.edge_sidecar_to_children)
    ? media.edge_sidecar_to_children.edges
    : undefined;
  if (Array.isArray(children) && children.length > 0) {
    return children.map((edge, i) =>
      mediaAssetFromNode(
        isRecord(edge) && isRecord(edge.node) ? edge.node : {},
        i + 1,
        canonicalUrl,
      ),
    );
  }
  return [mediaAssetFromNode(media, 1, canonicalUrl)];
}

function buildPostRecordFromMedia(
  media: Record<string, unknown>,
  canonicalUrl: string,
): PostRecord | null {
  if (typeof media.shortcode !== 'string') return null;
  const owner = isRecord(media.owner) ? media.owner.username : undefined;
  const record: PostRecord = {
    canonical_url: canonicalUrl,
    platform: 'instagram',
    post_id: media.shortcode,
    owner_handle: typeof owner === 'string' ? owner : '',
    text: captionOf(media),
    media: mediaListOf(media, canonicalUrl),
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 0 },
  };
  if (typeof media.taken_at_timestamp === 'number') {
    record.published_at = new Date(media.taken_at_timestamp * 1000).toISOString();
  }
  const engagement = engagementOf(media);
  if (engagement) record.engagement = engagement;
  return record;
}

/** Pure parser: extracts a PostRecord from a captured GraphQL response body. */
export function parseInstagramPost(body: string, canonicalUrl: string): PostRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const media = findShortcodeMedia(parsed);
  if (!media) return null;
  return buildPostRecordFromMedia(media, canonicalUrl);
}

function shortcodeMediaMatcher(canonicalUrl: string): NetworkMatcher<PostRecord> {
  return {
    id: 'instagram-post',
    matches: (response) => response.url.includes('instagram.com/graphql/query'),
    parse: (body) => parseInstagramPost(body, canonicalUrl),
  };
}

function postIdFromUrl(url: string): string {
  return (url.match(/\/(?:p|reel|tv)\/([\w-]+)/) ?? [])[1] ?? url;
}

function ownerHandleFromUrl(url: string): string {
  return (url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel|tv)\//) ?? [])[1] ?? '';
}

function ogFallbackToPostRecord(url: string, og: { text: string; image: string }): PostRecord {
  return {
    canonical_url: url,
    platform: 'instagram',
    post_id: postIdFromUrl(url),
    owner_handle: ownerHandleFromUrl(url),
    text: og.text,
    media: og.image
      ? [
          {
            id: `${url}#cover`,
            kind: 'image',
            index: 1,
            canonical_post_url: url,
            ephemeral_url: og.image,
          },
        ]
      : [],
    outcome: { status: 'resolved', source: 'public-metadata', attempts: 1, elapsed_ms: 0 },
  };
}

// Per-adapter-instance only (never persisted): a `social-card` capture
// produced while inspect() already held the visit for this canonical URL, so
// a later captureSocialCard() call for the SAME url doesn't need (and
// browser_coordinator.visitOnce() would not grant) a second navigation. Lives
// inside createInstagramAdapter() (not module scope) so it can't leak a
// PostRecord-shaped promise or a stale path across independently created
// AcquisitionService instances/runs — see createInstagramAdapter below.
function makeInspectAndSocialCard(socialCardCache: Map<string, LocalAsset>) {
  // ponytail: best-effort — a failed card capture must not fail inspect(). If a
  // LATER standalone captureSocialCard() call for the same URL is made without
  // inspect() having run first, it does its own visit (see captureSocialCard
  // below) — this only serves the common "inspect, then maybe social-card"
  // ordering, not the reverse.
  async function stashSocialCardIfRequested(url: string, client: CdpClient): Promise<void> {
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

  async function inspect(url: string, context: AdapterContext): Promise<PostRecord> {
    const config = readAcquisitionConfig();
    const startedAt = context.now();
    const wantsSocialCard = context.intents(url).has('social-card');

    const post = await context.visit('instagram', url, async (client) => {
      const captured = await observeNetworkResponses(client, {
        deadlineMs: config.captureDeadlineMs,
        matchers: [shortcodeMediaMatcher(url)],
        // The visit's own connect() already navigated to `url`; Instagram's
        // page JS fires the GraphQL request(s) as it renders — nothing to
        // trigger here, only observe.
        action: async () => {},
      });

      let result = captured['instagram-post'];
      if (!result) {
        const og = await igPostOg(url, { client, navigate: false });
        if (!og.text && !og.image) {
          throw new AcquisitionError(
            `instagram: no network or og fallback data for ${hostnameOf(url)}`,
            { status: 'unavailable', reason: 'invalid-response', attempts: 1, elapsed_ms: 0 },
          );
        }
        result = ogFallbackToPostRecord(url, og);
      }

      if (wantsSocialCard) await stashSocialCardIfRequested(url, client);

      return result;
    });

    return { ...post, outcome: { ...post.outcome, elapsed_ms: context.now() - startedAt } };
  }

  async function captureSocialCard(
    url: string,
    _purpose: SocialCardPurpose,
    context: AdapterContext,
  ): Promise<LocalAsset> {
    const stashed = socialCardCache.get(url);
    if (stashed && fs.existsSync(stashed.path)) return stashed;

    return context.visit('instagram', url, async (client) => {
      const crop = await cropPost({ url, client, navigate: false });
      if (!crop.ok || !crop.image_path) {
        throw new AcquisitionError(`instagram: social-card crop failed for ${hostnameOf(url)}`, {
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

  return { inspect, captureSocialCard };
}

// Comment collection is out of Task 7's scope: this adapter observes passive
// post-page GraphQL/og/DOM-crop only. Instagram comment scraping lives in
// lib/comment_engine.ts (used by scrapers/scrape_comments_ig.ts), which owns
// its own CDP session and isn't wired to an injected AdapterContext client —
// bringing it under this adapter is follow-up work, not this task's.
async function collectComments(
  url: string,
  _limits: CommentLimits,
  _context: AdapterContext,
): Promise<CommentRecord[]> {
  throw new AcquisitionError(
    `instagram: comment collection is not implemented by this adapter for ${hostnameOf(url)}`,
    { status: 'unavailable', reason: 'unsupported', attempts: 0, elapsed_ms: 0 },
  );
}

function reelToPostRecord(
  reel: { url: string; views: number; caption: string },
  ownerHandle: string,
): PostRecord {
  const canonicalUrl = canonicalizeUrl(reel.url);
  return {
    canonical_url: canonicalUrl,
    platform: 'instagram',
    post_id: postIdFromUrl(canonicalUrl),
    owner_handle: ownerHandle,
    text: reel.caption,
    engagement: { views: reel.views },
    media: [],
    outcome: { status: 'resolved', source: 'dom', attempts: 1, elapsed_ms: 0 },
  };
}

async function discover(
  request: DiscoveryRequest,
  context: AdapterContext,
): Promise<DiscoveryResult> {
  const startedAt = context.now();
  if (request.kind !== 'profile') {
    // scrapers/search_social_v2.ts DOES have an IG keyword-search path, but
    // Task 13 owns that file and it currently does its own connect()/navigate
    // — wiring it in here would route browser work outside context.visit(),
    // which this task's Ruling 4 forbids. Deferred to Task 13, not because no
    // scraper exists, but because using it today would break that rule.
    throw new AcquisitionError(
      `instagram: discovery kind "${request.kind}" is not implemented by this adapter`,
      {
        status: 'unavailable',
        reason: 'unsupported',
        attempts: 0,
        elapsed_ms: context.now() - startedAt,
      },
    );
  }

  const profileUrl = `https://www.instagram.com/${request.value}/`;
  const items = await context.visit('instagram', profileUrl, async (client) => {
    const reels = await igProfileReels(request.value, {
      max: request.limit,
      captions: true,
      client,
    });
    return reels.map((reel) => reelToPostRecord(reel, request.value));
  });

  return {
    items,
    outcome: {
      status: 'resolved',
      source: 'dom',
      attempts: 1,
      elapsed_ms: context.now() - startedAt,
    },
  };
}

// Factory, not a module-level singleton: each call gets its own
// socialCardCache, so independently created AcquisitionService instances
// (separate runs/processes sharing this module) never see each other's
// stashed social-card entries. AcquisitionService.create() calls this once
// per service.
export function createInstagramAdapter(): PlatformAdapter {
  const { inspect, captureSocialCard } = makeInspectAndSocialCard(new Map<string, LocalAsset>());
  return {
    platform: 'instagram',
    supports: (url) => platformForUrl(url) === 'instagram',
    discover,
    inspect,
    collectComments,
    captureSocialCard,
  };
}
