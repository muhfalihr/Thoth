// twitter.ts — X/Twitter PlatformAdapter: observes the post's own private
// GraphQL response passively during the one navigation `context.visit()`
// grants us. Never calls `connect()` directly (Ruling 4) and never closes a
// client it did not open itself (Ruling 3) — `cropPost()` and
// `xProfileTweets()` receive the visit's own client and are told
// `navigate:false` so a canonical URL gets at most one navigation.
import fs from 'node:fs';
import { sleep } from '../../lib/cdp.ts';
import type { CdpClient } from '../../lib/cdp.ts';
import { pollCount } from '../../lib/comment_engine.ts';
import { normalizeLikes } from '../../lib/comments.ts';
import { cropPost } from '../../scrapers/crop_post.ts';
import { COUNT_JS, EXTRACT_JS } from '../../scrapers/scrape_comments_x.ts';
import { xProfileTweets } from '../../scrapers/x_profile.ts';
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

// GraphQL operation names whose response body may contain a tweet result.
const GRAPHQL_OPERATIONS = ['Tweet', 'SearchTimeline', 'UserTweets', 'TweetDetail'];

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

function postIdFromUrl(url: string): string {
  return (url.match(/status\/(\d+)/) ?? [])[1] ?? '';
}

function ownerHandleFromUrl(url: string): string {
  return (url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\//) ?? [])[1] ?? '';
}

// A tombstone (deleted/unavailable tweet) never carries `legacy.full_text` —
// this is a structural check, not a typename allowlist, so it also catches
// tombstone shapes future API versions introduce without a `__typename` tag.
function isTombstone(node: Record<string, unknown>): boolean {
  if (node.__typename === 'TweetTombstone') return true;
  return !isRecord(node.legacy) || typeof node.legacy.full_text !== 'string';
}

function isPromoted(node: Record<string, unknown>): boolean {
  return isRecord(node.promotedMetadata);
}

function findTweetResult(root: unknown, expectedId: string): Record<string, unknown> | null {
  return findFirstObject<Record<string, unknown>>(root, (node) => {
    if (node.rest_id !== expectedId) return false;
    if (isTombstone(node)) return false;
    if (isPromoted(node)) return false;
    return true;
  });
}

function ownerHandleOf(tweet: Record<string, unknown>): string {
  const userResult =
    isRecord(tweet.core) &&
    isRecord(tweet.core.user_results) &&
    isRecord(tweet.core.user_results.result)
      ? tweet.core.user_results.result
      : undefined;
  const legacy = userResult && isRecord(userResult.legacy) ? userResult.legacy : undefined;
  return typeof legacy?.screen_name === 'string' ? legacy.screen_name : '';
}

function engagementOf(legacy: Record<string, unknown>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (typeof legacy.favorite_count === 'number') out.likes = legacy.favorite_count;
  if (typeof legacy.reply_count === 'number') out.replies = legacy.reply_count;
  if (typeof legacy.retweet_count === 'number') out.retweets = legacy.retweet_count;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Highest-bitrate MP4 variant. Variants without a numeric `bitrate` are HLS
// manifest entries (.m3u8), not a downloadable file — skip them.
function bestMp4Variant(entity: Record<string, unknown>): string | undefined {
  const info = isRecord(entity.video_info) ? entity.video_info : undefined;
  const variants = Array.isArray(info?.variants) ? info.variants : [];
  let best: { bitrate: number; url: string } | undefined;
  for (const variant of variants) {
    if (!isRecord(variant)) continue;
    if (typeof variant.bitrate !== 'number' || typeof variant.url !== 'string') continue;
    if (!best || variant.bitrate > best.bitrate) best = { bitrate: variant.bitrate, url: variant.url };
  }
  return best?.url;
}

function mediaAssetFromEntity(
  entity: Record<string, unknown>,
  index: number,
  canonicalUrl: string,
): MediaAsset | null {
  const id = typeof entity.id_str === 'string' ? entity.id_str : `${canonicalUrl}#${index}`;
  if (entity.type === 'photo') {
    const asset: MediaAsset = { id, kind: 'image', index, canonical_post_url: canonicalUrl };
    if (typeof entity.media_url_https === 'string') asset.ephemeral_url = entity.media_url_https;
    const sizes = isRecord(entity.original_info) ? entity.original_info : undefined;
    if (typeof sizes?.width === 'number') asset.width = sizes.width;
    if (typeof sizes?.height === 'number') asset.height = sizes.height;
    return asset;
  }
  if (entity.type === 'video' || entity.type === 'animated_gif') {
    const asset: MediaAsset = { id, kind: 'video', index, canonical_post_url: canonicalUrl };
    const url = bestMp4Variant(entity);
    if (url) asset.ephemeral_url = url;
    const info = isRecord(entity.video_info) ? entity.video_info : undefined;
    if (typeof info?.duration_millis === 'number') asset.duration_sec = info.duration_millis / 1000;
    return asset;
  }
  return null; // unknown media type — skip rather than guess
}

// extended_entities lives directly on the tweet result in most captures
// (brief's fixture), but some GraphQL versions nest it under `legacy`
// instead — check both for version tolerance.
function mediaContainerOf(tweet: Record<string, unknown>): unknown[] {
  const direct = isRecord(tweet.extended_entities) ? tweet.extended_entities.media : undefined;
  if (Array.isArray(direct)) return direct;
  const legacy = isRecord(tweet.legacy) ? tweet.legacy : undefined;
  const nested =
    legacy && isRecord(legacy.extended_entities) ? legacy.extended_entities.media : undefined;
  return Array.isArray(nested) ? nested : [];
}

function mediaListOf(tweet: Record<string, unknown>, canonicalUrl: string): MediaAsset[] {
  const assets: MediaAsset[] = [];
  for (const entity of mediaContainerOf(tweet)) {
    if (!isRecord(entity)) continue;
    const asset = mediaAssetFromEntity(entity, assets.length + 1, canonicalUrl);
    if (asset) assets.push(asset);
  }
  return assets;
}

function buildPostRecordFromTweet(
  tweet: Record<string, unknown>,
  canonicalUrl: string,
): PostRecord | null {
  if (typeof tweet.rest_id !== 'string') return null;
  const legacy = isRecord(tweet.legacy) ? tweet.legacy : undefined;
  if (!legacy || typeof legacy.full_text !== 'string') return null;
  const record: PostRecord = {
    canonical_url: canonicalUrl,
    platform: 'twitter',
    post_id: tweet.rest_id,
    owner_handle: ownerHandleOf(tweet),
    text: legacy.full_text,
    media: mediaListOf(tweet, canonicalUrl),
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 0 },
  };
  const engagement = engagementOf(legacy);
  if (engagement) record.engagement = engagement;
  if (typeof legacy.created_at === 'string') {
    const parsed = new Date(legacy.created_at);
    if (!Number.isNaN(parsed.getTime())) record.published_at = parsed.toISOString();
  }
  return record;
}

/** Pure parser: extracts a PostRecord from a captured GraphQL response body. */
export function parseTwitterPost(body: string, canonicalUrl: string): PostRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const expectedId = postIdFromUrl(canonicalUrl);
  const tweet = findTweetResult(parsed, expectedId);
  if (!tweet) return null;
  return buildPostRecordFromTweet(tweet, canonicalUrl);
}

function tweetResultMatcher(canonicalUrl: string): NetworkMatcher<PostRecord> {
  return {
    id: 'twitter-post',
    matches: (response) =>
      response.url.includes('/i/api/graphql/') &&
      GRAPHQL_OPERATIONS.some((op) => response.url.includes(op)),
    parse: (body) => parseTwitterPost(body, canonicalUrl),
  };
}

// Per-adapter-instance only (never persisted): a `social-card` capture
// produced while inspect() already held the visit for this canonical URL, so
// a later captureSocialCard() call for the SAME url doesn't need (and
// browser_coordinator.visitOnce() would not grant) a second navigation.
// Lives inside createTwitterAdapter() (not module scope) so it can't leak a
// PostRecord-shaped promise or a stale path across independently created
// AcquisitionService instances/runs — see createTwitterAdapter below.
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

    const post = await context.visit('twitter', url, async (client) => {
      const captured = await observeNetworkResponses(client, {
        deadlineMs: config.captureDeadlineMs,
        matchers: [tweetResultMatcher(url)],
        // The visit's own connect() already navigated to `url`; X's page JS
        // fires the GraphQL request(s) as it renders — nothing to trigger
        // here, only observe.
        action: async () => {},
      });

      const result = captured['twitter-post'];
      if (!result) {
        throw new AcquisitionError(`twitter: no network data for ${hostnameOf(url)}`, {
          status: 'unavailable',
          reason: 'invalid-response',
          attempts: 1,
          elapsed_ms: 0,
        });
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

    return context.visit('twitter', url, async (client) => {
      const crop = await cropPost({ url, client, navigate: false });
      if (!crop.ok || !crop.image_path) {
        throw new AcquisitionError(`twitter: social-card crop failed for ${hostnameOf(url)}`, {
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

interface RawXComment {
  idx: number;
  key: string;
  author: string;
  text: string;
  likes_raw: string;
}

// Lighter-weight than lib/comment_engine.ts's scrapeComments(): that helper
// owns its own connect/close and writes a content-set JSON straight to disk,
// neither of which fits an AdapterContext-injected, already-navigated
// client. This reuses only the selectors (EXTRACT_JS/COUNT_JS) + pollCount +
// normalizeLikes. ponytail: no per-comment screenshot capture (image_path
// stays unset) — CommentRecord.image_path is optional; add a cropComment()
// pass here if per-comment cards are ever needed for X.
async function collectComments(
  url: string,
  limits: CommentLimits,
  context: AdapterContext,
): Promise<CommentRecord[]> {
  return context.visit('twitter', url, async (client) => {
    await pollCount(client, COUNT_JS, 8, 1000);
    const byKey = new Map<string, CommentRecord>();
    for (let step = 0; step < 4 && byKey.size < limits.max; step += 1) {
      if (step) {
        await client.evaluate('window.scrollBy(0, 1400)');
        await sleep(1500);
      }
      let list: RawXComment[] = [];
      try {
        list = JSON.parse((await client.evaluate(EXTRACT_JS)) || '[]');
      } catch {
        list = [];
      }
      for (const item of list) {
        const key = item.key || `${item.author}:${item.idx}`;
        if (!key || byKey.has(key)) continue;
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

function timelineItemToPostRecord(
  item: { id: string; url: string; text: string },
  ownerHandle: string,
): PostRecord {
  const canonicalUrl = canonicalizeUrl(item.url);
  return {
    canonical_url: canonicalUrl,
    platform: 'twitter',
    post_id: item.id || postIdFromUrl(canonicalUrl),
    owner_handle: ownerHandle,
    text: item.text,
    // ponytail: xProfileTweets() only reports hasVideo/hasPhoto booleans, not
    // the actual media entities (url/bitrate) — populating `media` here
    // would require a follow-up inspect() per item. Deferred; discover()
    // callers that need media call inspect() on the returned canonical_url.
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
    // scrapers/search_social_v2.ts owns keyword/trending search and does its
    // own connect()/navigate — Task 13 owns that file; wiring it in here
    // would route browser work outside context.visit(), which Ruling 4
    // forbids. Deferred to Task 13, not because no scraper exists.
    throw new AcquisitionError(
      `twitter: discovery kind "${request.kind}" is not implemented by this adapter`,
      {
        status: 'unavailable',
        reason: 'unsupported',
        attempts: 0,
        elapsed_ms: context.now() - startedAt,
      },
    );
  }

  const profileUrl = `https://x.com/${request.value}`;
  const items = await context.visit('twitter', profileUrl, async (client) => {
    const tweets = await xProfileTweets(request.value, {
      max: request.limit,
      client,
      navigate: false,
    });
    return tweets.map((tweet) => timelineItemToPostRecord(tweet, request.value));
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
export function createTwitterAdapter(): PlatformAdapter {
  const { inspect, captureSocialCard } = makeInspectAndSocialCard(new Map<string, LocalAsset>());
  return {
    platform: 'twitter',
    supports: (url) => platformForUrl(url) === 'twitter',
    discover,
    inspect,
    collectComments,
    captureSocialCard,
  };
}
