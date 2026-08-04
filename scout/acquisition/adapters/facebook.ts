// facebook.ts — Facebook platform adapter. Observes the post's own private
// GraphQL response passively during the single navigation context.visit()
// grants (observe-never-replay, Ruling 4/7), then falls back to the existing
// DOM search + cropPost({url, client, navigate:false}) behavior (crop_post.ts's
// PLATFORMS.facebook, already used the same way by the Instagram/Twitter
// adapters) when no GraphQL response was captured. Comment collection reuses
// scrape_comments_fb.ts's exported EXTRACT_JS/COUNT_JS against a CDP client
// obtained through context.visit(), without changing its selectors.
import { pollCount } from '../../lib/comment_engine.ts';
import { normalizeLikes } from '../../lib/comments.ts';
import { sleep } from '../../lib/cdp.ts';
import { cropPost } from '../../scrapers/crop_post.ts';
import { COUNT_JS, EXTRACT_JS } from '../../scrapers/scrape_comments_fb.ts';
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

interface RawFbComment {
  idx: number;
  author: string;
  text: string;
  likes_raw: string;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

// crop_post.ts's facebook idRe: /(?:\/(?:posts|videos|reel)\/|story_fbid=)(\w+)/
function postIdFromUrl(url: string): string {
  return url.match(/(?:\/(?:posts|videos|reel)\/|story_fbid=)(\w+)/)?.[1] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// No captured Facebook GraphQL fixture exists anywhere in this codebase to
// verify field names against (grep of scout/ for a Facebook GraphQL payload
// example returned nothing beyond this task's own brief fixture). This
// predicate/accessor pair mirrors the brief's fixture shape
// (post_id/actors[].name/message.text/attachments[].media.image.uri); if a
// real capture diverges, only these two functions need retuning.
function isFacebookPostNode(node: Record<string, unknown>): node is Record<string, unknown> {
  return typeof node.post_id === 'string' && Array.isArray(node.actors);
}

function mediaAssetFromAttachment(
  attachment: unknown,
  index: number,
  canonicalUrl: string,
): MediaAsset | null {
  if (!isRecord(attachment) || !isRecord(attachment.media)) return null;
  const media = attachment.media;
  const image = isRecord(media.image) ? media.image : undefined;
  if (image && typeof image.uri === 'string') {
    return {
      id: `${canonicalUrl}#${index}`,
      kind: 'image',
      index,
      canonical_post_url: canonicalUrl,
      ephemeral_url: image.uri,
    };
  }
  if (typeof media.playable_url === 'string') {
    return {
      id: `${canonicalUrl}#${index}`,
      kind: 'video',
      index,
      canonical_post_url: canonicalUrl,
      ephemeral_url: media.playable_url,
    };
  }
  return null;
}

function mediaListOf(node: Record<string, unknown>, canonicalUrl: string): MediaAsset[] {
  const attachments = Array.isArray(node.attachments) ? node.attachments : [];
  const assets: MediaAsset[] = [];
  for (const attachment of attachments) {
    const asset = mediaAssetFromAttachment(attachment, assets.length + 1, canonicalUrl);
    if (asset) assets.push(asset);
  }
  return assets;
}

function buildPostRecord(node: Record<string, unknown>, canonicalUrl: string): PostRecord {
  const actor = Array.isArray(node.actors) && isRecord(node.actors[0]) ? node.actors[0] : undefined;
  const ownerHandle = typeof actor?.name === 'string' ? actor.name : '';
  const message = isRecord(node.message) ? node.message : undefined;
  const text = typeof message?.text === 'string' ? message.text : '';
  return {
    canonical_url: canonicalUrl,
    platform: 'facebook',
    post_id: node.post_id as string,
    owner_handle: ownerHandle,
    text,
    media: mediaListOf(node, canonicalUrl),
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 0 },
  };
}

/** Pure parser: extracts a PostRecord from a captured GraphQL response body. */
export function parseFacebookPost(body: string, canonicalUrl: string): PostRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const node = findFirstObject<Record<string, unknown>>(parsed, isFacebookPostNode);
  if (!node) return null;
  return buildPostRecord(node, canonicalUrl);
}

function facebookPostMatcher(canonicalUrl: string): NetworkMatcher<PostRecord> {
  return {
    id: 'facebook-post',
    matches: (response) => response.url.includes('facebook.com') && /graphql/i.test(response.url),
    parse: (body) => parseFacebookPost(body, canonicalUrl),
  };
}

export function createFacebookAdapter(): PlatformAdapter {
  const socialCardCache = new Map<string, LocalAsset>();

  async function stashSocialCardIfRequested(url: string, client: any): Promise<void> {
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
      // best-effort only — inspect()'s primary job is the PostRecord
    }
  }

  async function inspect(url: string, context: AdapterContext): Promise<PostRecord> {
    const config = readAcquisitionConfig();
    const startedAt = context.now();
    const wantsSocialCard = context.intents(url).has('social-card');

    return context.visit('facebook', url, async (client) => {
      const captured = await observeNetworkResponses(client, {
        deadlineMs: config.captureDeadlineMs,
        matchers: [facebookPostMatcher(url)],
        action: async () => {},
      });

      const networkPost = captured['facebook-post'];
      if (networkPost) {
        if (wantsSocialCard) await stashSocialCardIfRequested(url, client);
        return { ...networkPost, outcome: { ...networkPost.outcome, elapsed_ms: context.now() - startedAt } };
      }

      // No GraphQL response observed within the deadline — fall back to the
      // existing DOM search (crop_post.ts's PLATFORMS.facebook) for the
      // post's visible text, during the same visit/navigation.
      const crop = await cropPost({ url, client, navigate: false });
      if (!crop.ok) {
        throw new AcquisitionError(`facebook: no network or DOM data for ${hostnameOf(url)}`, {
          status: 'unavailable',
          reason: 'invalid-response',
          attempts: 1,
          elapsed_ms: context.now() - startedAt,
        });
      }
      if (wantsSocialCard && crop.image_path) {
        socialCardCache.set(url, {
          path: crop.image_path,
          kind: 'social-card',
          source: 'dom',
          bytes: crop.bytes ?? 0,
        });
      }
      return {
        canonical_url: url,
        platform: 'facebook',
        post_id: postIdFromUrl(url) || 'unknown',
        owner_handle: '',
        text: crop.text ?? '',
        media: [],
        outcome: { status: 'resolved', source: 'dom', attempts: 1, elapsed_ms: context.now() - startedAt },
      };
    });
  }

  async function collectComments(
    url: string,
    limits: CommentLimits,
    context: AdapterContext,
  ): Promise<CommentRecord[]> {
    return context.visit('facebook', url, async (client) => {
      await pollCount(client, COUNT_JS, 10, 1000);
      const byKey = new Map<string, CommentRecord>();
      for (let step = 0; step < 4 && byKey.size < limits.max; step += 1) {
        if (step > 0) {
          await client.evaluate(
            `(() => {
             const want = /(view\\s+\\d*\\s*more\\s+comment|view\\s+more\\s+comment|more comments|lihat\\s+.*komentar|komentar lainnya|komentar sebelumnya)/i;
             const btn = Array.from(document.querySelectorAll('[role="button"], span, div'))
               .find(b => want.test((b.innerText || '').trim()) && b.offsetParent !== null);
             if (btn) { btn.click(); return; }
             window.scrollBy(0, 1100);
           })()`,
          );
          await sleep(1500);
        }
        let raw: RawFbComment[] = [];
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
    const stashed = socialCardCache.get(url);
    if (stashed) return stashed;

    return context.visit('facebook', url, async (client) => {
      const crop = await cropPost({ url, client, navigate: false });
      if (!crop.ok || !crop.image_path) {
        throw new AcquisitionError(`facebook: social-card crop failed for ${hostnameOf(url)}`, {
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

  async function discover(
    request: DiscoveryRequest,
    context: AdapterContext,
  ): Promise<DiscoveryResult> {
    const startedAt = context.now();
    // No Facebook discovery helper (keyword/profile/trending → PostRecord
    // URLs) exists in this task's reuse set (grep of scout/ turns up no
    // facebook-targeted equivalent of tiktok_profile.ts/x_profile.ts).
    // Task 13 owns building general social discovery on search_social_v2.ts.
    throw new AcquisitionError(
      `facebook: discovery kind "${request.kind}" is not implemented by this adapter`,
      { status: 'unavailable', reason: 'unsupported', attempts: 0, elapsed_ms: context.now() - startedAt },
    );
  }

  return {
    platform: 'facebook',
    supports: (url) => platformForUrl(url) === 'facebook',
    discover,
    inspect,
    collectComments,
    captureSocialCard,
  };
}
