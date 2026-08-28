// main_ocr.ts — attach the main video's OCR verdict on a forced-URL run.
//
// The normal path gets this from trace_source, which OCRs the main it just resolved. A forced-URL
// run skips trace_source entirely (main is given, there is nothing to resolve), so nothing analyzed
// it — and a main without `ocr_status` is rejected twice over: by the content-set lint here, and by
// `validate_main_ocr` on the Rust side, which treats an unanalyzed main as unable to pass the video
// safety gate. Analyze the copy already materialized into the source package instead of the URL:
// same media, on local disk, so this works even while the platform extractor is broken.

import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from '../lib/paths.ts';
import { attachVideoOcr, shouldAttachVideoOcr } from '../lib/ocr_content.ts';
import { resolveContained, resolveDescriptorManifest } from '../main_footage/paths.ts';
import type { ContentSet, MainVideo } from '../lib/types.ts';

export interface MainOcrDeps {
  analyze?: (record: MainVideo) => Promise<unknown>;
  scoutOutputRoot?: string;
}

export async function runMainOcr(
  options: { file: string },
  deps: MainOcrDeps = {},
): Promise<void> {
  const { file } = options;
  const set = JSON.parse(fs.readFileSync(file, 'utf8')) as ContentSet;
  if (!set.main_footage) throw new Error('main_footage_descriptor_missing');
  if (!shouldAttachVideoOcr(set.main)) return;

  const manifestPath = resolveDescriptorManifest(
    file,
    set.main_footage.package_manifest,
    deps.scoutOutputRoot ?? OUTPUT_DIR,
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const relative = manifest?.sources?.[0]?.path;
  if (typeof relative !== 'string') throw new Error('main_source_path_missing');

  // ponytail: the pool's first source stands in for `main` — exact for the single-video posts a
  // forced-URL run is aimed at. For a multi-video pool the verdict (trim_start/mute_audio/
  // subtitle_blur) is that first source's; analyze per source once planning consumes it per source.
  set.main.source_local = resolveContained(path.dirname(manifestPath), relative);
  await (deps.analyze ?? attachVideoOcr)(set.main);
  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
}
