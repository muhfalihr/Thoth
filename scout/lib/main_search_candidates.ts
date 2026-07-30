import type { MainCandidate } from './main_candidate.ts';

export type SearchEntry = { url: string; platform: string };

type SearchCandidateDeps = {
  downloadablePlatforms: Set<string>;
  probeGeneric: (entry: SearchEntry) => Promise<{
    isVideo: boolean;
    caption: string;
    thumbnail: string;
    uploader: string;
    webpageUrl: string;
  }>;
  youtubeMeta: (url: string) => Promise<{
    title: string;
    thumbnail: string;
  } | null>;
  tiktokMeta: (url: string) => Promise<{
    title: string;
    thumbnail: string;
  } | null>;
  threadsVideoSrc: (url: string) => Promise<string>;
};

export async function admitSearchCandidates(
  entries: SearchEntry[],
  deps: SearchCandidateDeps,
): Promise<MainCandidate[]> {
  const seen = new Set<string>();
  const admitted: MainCandidate[] = [];
  for (const entry of entries) {
    if (
      admitted.length >= 10 ||
      !deps.downloadablePlatforms.has(entry.platform) ||
      seen.has(entry.url)
    ) {
      continue;
    }
    seen.add(entry.url);
    if (entry.platform === 'tiktok') {
      const meta = await deps.tiktokMeta(entry.url);
      admitted.push({
        ...entry,
        caption: meta?.title || '',
        thumbnail: meta?.thumbnail || '',
        isVideo: true,
      });
      continue;
    }
    if (entry.platform === 'youtube') {
      const meta = await deps.youtubeMeta(entry.url);
      admitted.push({
        ...entry,
        caption: meta?.title || '',
        thumbnail: meta?.thumbnail || '',
        isVideo: true,
      });
      continue;
    }
    if (entry.platform === 'threads') {
      const videoSrc = await deps.threadsVideoSrc(entry.url);
      if (videoSrc) admitted.push({ ...entry, videoSrc, isVideo: true });
      continue;
    }
    const probed = await deps.probeGeneric(entry);
    const shapeCheckedLater = entry.platform === 'instagram' || entry.platform === 'facebook';
    if (!probed.isVideo && !shapeCheckedLater) continue;
    admitted.push({
      ...entry,
      caption: probed.caption,
      thumbnail: probed.thumbnail,
      uploader: probed.uploader,
      pageUrl: probed.webpageUrl,
      isVideo: true,
    });
  }
  return admitted;
}
