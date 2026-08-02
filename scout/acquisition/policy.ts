import type { AcquisitionConfig } from './config.ts';
import type { AcquisitionIntent, AcquisitionSource, Platform } from './types.ts';

const CHAINS = {
  inspectSocial: ['network', 'public-metadata', 'dom'],
  inspectYouTube: ['public-metadata', 'yt-dlp'],
  image: ['gallery-dl', 'direct-http', 'dom'],
  video: ['direct-http', 'yt-dlp'],
  socialCard: ['dom'],
} as const;

function selectChain(
  platform: Platform,
  intent: AcquisitionIntent,
  kind: 'image' | 'video' | undefined,
): readonly AcquisitionSource[] {
  switch (intent) {
    case 'inspect':
    case 'comments':
      return platform === 'youtube' ? CHAINS.inspectYouTube : CHAINS.inspectSocial;
    case 'social-card':
      return CHAINS.socialCard;
    case 'media':
      if (kind === 'image') return CHAINS.image;
      return platform === 'youtube' ? (['yt-dlp'] as const) : CHAINS.video;
  }
}

export function sourceOrder(
  platform: Platform,
  intent: AcquisitionIntent,
  kind: 'image' | 'video' | undefined,
  capabilities: ReadonlySet<AcquisitionSource>,
): AcquisitionSource[] {
  return selectChain(platform, intent, kind).filter((source) => capabilities.has(source));
}

type CapabilityProbeResult = { exitCode: number; stderr: string; timedOut: boolean };
type CapabilityRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<CapabilityProbeResult>;

const PROBE_TIMEOUT_MS = 5_000;

// Memoize by binary identity so each configured (galleryDl, ytdlp) pair is probed once.
const capabilityCache = new Map<string, Promise<Set<AcquisitionSource>>>();

export async function detectCapabilities(
  config: AcquisitionConfig,
  run: CapabilityRunner,
): Promise<Set<AcquisitionSource>> {
  const key = `${config.galleryDl}|${config.ytdlp}`;
  let cached = capabilityCache.get(key);
  if (!cached) {
    cached = probe(config, run);
    capabilityCache.set(key, cached);
  }
  return cached;
}

async function probe(
  config: AcquisitionConfig,
  run: CapabilityRunner,
): Promise<Set<AcquisitionSource>> {
  const capabilities = new Set<AcquisitionSource>([
    'network',
    'public-metadata',
    'dom',
    'direct-http',
  ]);
  const [galleryDlOk, ytdlpOk] = await Promise.all([
    probeOne(run, config.galleryDl),
    probeOne(run, config.ytdlp),
  ]);
  if (galleryDlOk) capabilities.add('gallery-dl');
  if (ytdlpOk) capabilities.add('yt-dlp');
  return capabilities;
}

async function probeOne(run: CapabilityRunner, executable: string): Promise<boolean> {
  try {
    const result = await run(executable, ['--version'], PROBE_TIMEOUT_MS);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
