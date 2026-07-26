import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadTiktok as defaultDownloadTikTok } from '../scrapers/tiktok_video.ts';
import {
  type AnalyzedOcrAnalysis,
  analysisFields,
  currentOcrFields,
  type OcrAnalysis,
  OcrAnalysisError,
  type OcrEnvironment,
  type PersistedOcrFields,
  runRequiredOcr,
} from './ocr_contract.ts';
import { analyzeSubtitlesDetailed } from './subtitle_vision.ts';
import { directStreamUrl } from './verify.ts';

type VideoRecord = Record<string, unknown> & {
  url?: string;
  is_video?: boolean;
  source_local?: string;
};

type AttachVideoOcrDeps = {
  resolve?: (source: string) => string;
  analyze?: (source: string) => Promise<OcrAnalysis>;
  project?: (analysis: AnalyzedOcrAnalysis) => PersistedOcrFields;
  env?: OcrEnvironment;
  ocrTempRoot?: string;
  downloadTikTok?: (source: string, output: string) => Promise<string>;
};

function isTikTokVideoPage(source: string): boolean {
  return /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/\d+/i.test(source);
}

export function shouldAttachVideoOcr(record: VideoRecord): boolean {
  return record.is_video !== false;
}

export function carryCurrentOcrMetadata(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  env: OcrEnvironment = process.env,
): boolean {
  const fields = currentOcrFields(source, env);
  if (!fields) return false;
  Object.assign(target, fields);
  return true;
}

const PERSISTED_OCR_KEYS = [
  'ocr_schema_version',
  'ocr_status',
  'ocr_model',
  'ocr_analyzer_version',
  'ocr_analyzed_at',
  'ocr_requested_frames',
  'ocr_valid_frames',
  'ocr_outcome',
  'trim_start',
  'mute_audio',
  'subtitle_blur',
] as const;

export function clearVideoOcrMetadata(record: Record<string, unknown>): void {
  for (const key of PERSISTED_OCR_KEYS) delete record[key];
}

export function attachVideoOcr<T extends VideoRecord & { is_video: false }>(
  record: T,
  deps?: AttachVideoOcrDeps,
): Promise<T>;
export function attachVideoOcr<T extends VideoRecord & { is_video?: true }>(
  record: T,
  deps?: AttachVideoOcrDeps,
): Promise<T & PersistedOcrFields>;
export function attachVideoOcr<T extends VideoRecord>(
  record: T,
  deps?: AttachVideoOcrDeps,
): Promise<T | (T & PersistedOcrFields)>;
export async function attachVideoOcr<T extends VideoRecord>(
  record: T,
  deps: AttachVideoOcrDeps = {},
): Promise<T | (T & PersistedOcrFields)> {
  if (!shouldAttachVideoOcr(record)) return record;
  if (currentOcrFields(record, deps.env)) {
    return record as T & PersistedOcrFields;
  }

  let tempDir = '';
  try {
    const analysis = await runRequiredOcr(async () => {
      const source = record.source_local || record.url || '';
      let resolved = (deps.resolve ?? ((value) => directStreamUrl(value) || value))(source);
      if (!record.source_local && isTikTokVideoPage(source)) {
        // TikTok's yt-dlp `-g` CDN URL can require extractor challenge cookies
        // that ffprobe/ffmpeg do not inherit. Use a local file so duration
        // probing and frame extraction share a stable input.
        tempDir = fs.mkdtempSync(path.join(deps.ocrTempRoot ?? os.tmpdir(), 'thoth-tiktok-ocr-'));
        const output = path.join(tempDir, 'source.mp4');
        const local = await (deps.downloadTikTok ?? defaultDownloadTikTok)(source, output);
        if (!local || !fs.existsSync(local)) {
          throw new OcrAnalysisError(
            'media_access_failed',
            'OCR media could not be localized safely',
          );
        }
        resolved = local;
      }
      return (deps.analyze ?? ((value) => analyzeSubtitlesDetailed(value)))(resolved);
    });
    Object.assign(record, (deps.project ?? analysisFields)(analysis));
    return record as T & PersistedOcrFields;
  } catch (error) {
    if (error instanceof OcrAnalysisError) throw error;
    throw new OcrAnalysisError('analysis_exception', 'OCR analysis raised an exception');
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
