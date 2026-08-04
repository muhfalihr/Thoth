import type { Platform } from './types.ts';

const HOST_PLATFORMS: Record<string, Platform> = {
  'instagram.com': 'instagram',
  'www.instagram.com': 'instagram',
  'twitter.com': 'twitter',
  'www.twitter.com': 'twitter',
  'x.com': 'twitter',
  'www.x.com': 'twitter',
  'tiktok.com': 'tiktok',
  'www.tiktok.com': 'tiktok',
  'youtube.com': 'youtube',
  'www.youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'facebook.com': 'facebook',
  'www.facebook.com': 'facebook',
  'threads.net': 'threads',
  'www.threads.net': 'threads',
  'threads.com': 'threads',
  'www.threads.com': 'threads',
  'reddit.com': 'reddit',
  'www.reddit.com': 'reddit',
};

const IDENTITY_PARAMS: Partial<Record<Platform, readonly string[]>> = {
  youtube: ['v'],
  facebook: ['id', 'story_fbid', 'v'],
};

export function platformForUrl(url: string): Platform | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return HOST_PLATFORMS[parsed.hostname.toLowerCase()];
}

export function canonicalizeUrl(url: string): string {
  const platform = platformForUrl(url);
  if (!platform) {
    throw new Error(`unsupported URL: ${url}`);
  }

  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';

  const allowedParams = IDENTITY_PARAMS[platform];
  const kept: Array<[string, string]> = [];
  if (allowedParams) {
    for (const key of allowedParams) {
      const value = parsed.searchParams.get(key);
      if (value !== null) {
        kept.push([key, value]);
      }
    }
    kept.sort(([a], [b]) => a.localeCompare(b));
  }
  parsed.search = '';
  for (const [key, value] of kept) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}
