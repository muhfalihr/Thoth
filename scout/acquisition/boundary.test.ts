// scout/acquisition/boundary.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const targets = [
  'pipeline/run_pipeline.ts',
  'pipeline/trace_source.ts',
  'pipeline/build_footage.ts',
  'pipeline/collect_comments.ts',
  'pipeline/discover_reels.ts',
  'pipeline/topic_to_urls.ts',
  'pipeline/enrich_image_paths.ts',
];
const forbidden = [
  /from ['"]\.\.\/lib\/cdp\.ts['"]/,
  /from ['"]\.\.\/scrapers\/(?:ig_profile|tiktok_profile|tiktok_video|x_profile|threads_video|search_social_v2)\.ts['"]/,
  /\bconnect\s*\(/,
  /\b(?:tiktokOembed|youtubeOembed|probeVideo|postShape|directStreamUrl|tiktokDirectUrl|threadsVideoSrc)\s*\(/,
  /\bexecFile(?:Sync)?\s*\([^\n]*(?:yt-dlp|gallery-dl)/,
  /\bspawn\s*\([^\n]*(?:yt-dlp|gallery-dl)/,
];
for (const relative of targets) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `${relative} bypasses acquisition kernel`);
  }
}
console.log('ok acquisition_boundary');
