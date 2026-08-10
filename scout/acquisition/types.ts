import type { CdpClient } from '../lib/cdp.ts';
export type { CdpClient };

export type Platform =
  | 'instagram'
  | 'twitter'
  | 'tiktok'
  | 'youtube'
  | 'facebook'
  | 'threads'
  | 'reddit';

export type AcquisitionIntent = 'inspect' | 'comments' | 'media' | 'social-card';
export type AcquisitionSource =
  | 'cache'
  | 'network'
  | 'public-metadata'
  | 'gallery-dl'
  | 'yt-dlp'
  | 'direct-http'
  | 'dom';
export type AcquisitionReason =
  | 'timeout'
  | 'not-found'
  | 'unsupported'
  | 'rate-limited'
  | 'auth-required'
  | 'challenge'
  | 'invalid-response'
  | 'materialization-failed';

export interface AcquisitionOutcome {
  status: 'resolved' | 'unavailable' | 'blocked';
  source?: AcquisitionSource;
  attempts: number;
  elapsed_ms: number;
  reason?: AcquisitionReason;
}

export class AcquisitionError extends Error {
  readonly outcome: AcquisitionOutcome;
  constructor(message: string, outcome: AcquisitionOutcome) {
    super(message);
    this.name = 'AcquisitionError';
    this.outcome = outcome;
  }
}

export interface MediaAsset {
  id: string;
  kind: 'image' | 'video';
  index: number;
  canonical_post_url: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  ephemeral_url?: string;
}

export interface PostRecord {
  canonical_url: string;
  platform: Platform;
  post_id: string;
  owner_handle: string;
  text: string;
  published_at?: string;
  engagement?: Record<string, number>;
  media: MediaAsset[];
  outcome: AcquisitionOutcome;
}

export interface CommentRecord {
  id: string;
  author: string;
  text: string;
  likes: number;
  image_path?: string;
}

export interface DiscoveryRequest {
  platform: Platform;
  kind: 'query' | 'profile' | 'trending';
  value: string;
  limit: number;
}

export interface DiscoveryResult {
  items: PostRecord[];
  outcome: AcquisitionOutcome;
}

export interface LocalAsset {
  path: string;
  kind: 'image' | 'video' | 'social-card';
  source: AcquisitionSource;
  bytes: number;
}

export interface CommentLimits {
  max: number;
}

export type SocialCardPurpose = 'post' | 'comment';
export type AssetPurpose = 'main' | 'footage' | 'ocr';

export interface AdapterContext {
  intents(url: string): ReadonlySet<AcquisitionIntent>;
  visit<T>(
    platform: Platform,
    url: string,
    acquire: (client: CdpClient, intents: ReadonlySet<AcquisitionIntent>) => Promise<T>,
  ): Promise<T>;
  now(): number;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  supports(url: string): boolean;
  discover(request: DiscoveryRequest, context: AdapterContext): Promise<DiscoveryResult>;
  inspect(url: string, context: AdapterContext): Promise<PostRecord>;
  collectComments(
    url: string,
    limits: CommentLimits,
    context: AdapterContext,
  ): Promise<CommentRecord[]>;
  captureSocialCard(
    url: string,
    purpose: SocialCardPurpose,
    context: AdapterContext,
  ): Promise<LocalAsset>;
}
