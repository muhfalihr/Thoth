import type { ClipVerdict } from './subtitle_vision.ts';

export const OCR_SCHEMA_VERSION = 1;
export const OCR_ANALYZER_VERSION = 'deepseek-ocr-v3';
export const DEFAULT_OCR_MODEL = 'deepseek/deepseek-ocr';

export type OcrEnvironment = Record<string, string | undefined>;

export function configuredOcrModel(env: OcrEnvironment = process.env): string {
  return env.THOTH_SUBTITLE_OCR_MODEL?.trim() || DEFAULT_OCR_MODEL;
}

export type OcrStatus = 'analyzed' | 'failed';

export type OcrAnalysis = {
  schema_version: 1;
  ocr_status: OcrStatus;
  provider: 'novita';
  model: string;
  analyzer_version: string;
  requested_frames: number;
  valid_frames: number;
  analyzed_at: string;
  verdict?: ClipVerdict;
  error_code?: string;
  error_message?: string;
};

export type AnalyzedOcrAnalysis = OcrAnalysis & {
  ocr_status: 'analyzed';
  verdict: ClipVerdict;
};

export type PersistedOcrFields = {
  ocr_schema_version: number;
  ocr_status: OcrStatus;
  ocr_model: string;
  ocr_analyzer_version: string;
  ocr_analyzed_at: string;
  ocr_requested_frames: number;
  ocr_valid_frames: number;
  ocr_outcome: ClipVerdict['outcome'];
  trim_start: number;
  mute_audio: boolean;
  subtitle_blur: ClipVerdict['subtitle_blur'];
};

export class OcrAnalysisError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`OCR analysis failed (${code}): ${message}`);
    this.name = 'OcrAnalysisError';
    this.code = code;
  }
}

export function requireAnalyzed(analysis: OcrAnalysis): AnalyzedOcrAnalysis {
  if (analysis.ocr_status !== 'analyzed' || !analysis.verdict) {
    throw new OcrAnalysisError(
      analysis.error_code || 'unknown_failure',
      'OCR analysis did not complete successfully',
    );
  }
  return analysis as AnalyzedOcrAnalysis;
}

export async function runRequiredOcr(
  analyze: () => Promise<OcrAnalysis>,
): Promise<AnalyzedOcrAnalysis> {
  try {
    return requireAnalyzed(await analyze());
  } catch (error) {
    if (error instanceof OcrAnalysisError) throw error;
    throw new OcrAnalysisError('analysis_exception', 'OCR analysis raised an exception');
  }
}

export function analysisFields(
  rawAnalysis: AnalyzedOcrAnalysis,
): PersistedOcrFields & { ocr_schema_version: 1; ocr_status: 'analyzed' } {
  const analysis = requireAnalyzed(rawAnalysis);
  const { verdict } = analysis;
  return {
    ocr_schema_version: analysis.schema_version,
    ocr_status: 'analyzed',
    ocr_model: analysis.model,
    ocr_analyzer_version: analysis.analyzer_version,
    ocr_analyzed_at: analysis.analyzed_at,
    ocr_requested_frames: analysis.requested_frames,
    ocr_valid_frames: analysis.valid_frames,
    ocr_outcome: verdict.outcome,
    trim_start: verdict.trim_start > 0 ? verdict.trim_start : 0,
    mute_audio: verdict.outcome === 'subtitle',
    subtitle_blur: verdict.outcome === 'subtitle' ? verdict.subtitle_blur : [],
  };
}

function validBlurRegion(region: unknown): boolean {
  if (!region || typeof region !== 'object') return false;
  const value = region as Record<string, unknown>;
  const numbers = ['x', 'y', 'w', 'h'].map((key) => value[key]);
  const [x, y, w, h] = numbers as number[];
  if (
    numbers.some((number) => typeof number !== 'number' || !Number.isFinite(number)) ||
    x < 0 ||
    y < 0 ||
    w <= 0 ||
    h <= 0 ||
    x + w > 1 ||
    y + h > 1
  ) {
    return false;
  }
  const hasStart = value.start != null;
  const hasEnd = value.end != null;
  return (
    hasStart === hasEnd &&
    (!hasStart ||
      (typeof value.start === 'number' &&
        Number.isFinite(value.start) &&
        value.start >= 0 &&
        typeof value.end === 'number' &&
        Number.isFinite(value.end) &&
        value.end >= value.start))
  );
}

export function currentOcrFields(
  record: Record<string, unknown>,
  env: OcrEnvironment = process.env,
): PersistedOcrFields | null {
  if (
    record.ocr_status !== 'analyzed' ||
    record.ocr_schema_version !== OCR_SCHEMA_VERSION ||
    record.ocr_model !== configuredOcrModel(env) ||
    record.ocr_analyzer_version !== OCR_ANALYZER_VERSION ||
    typeof record.ocr_analyzed_at !== 'string' ||
    !record.ocr_analyzed_at ||
    !Number.isFinite(Date.parse(record.ocr_analyzed_at)) ||
    !Number.isInteger(record.ocr_requested_frames) ||
    (record.ocr_requested_frames as number) <= 0 ||
    !Number.isInteger(record.ocr_valid_frames) ||
    record.ocr_valid_frames !== record.ocr_requested_frames ||
    !['clean', 'cover', 'subtitle'].includes(String(record.ocr_outcome)) ||
    typeof record.trim_start !== 'number' ||
    !Number.isFinite(record.trim_start) ||
    record.trim_start < 0 ||
    typeof record.mute_audio !== 'boolean' ||
    !Array.isArray(record.subtitle_blur) ||
    !record.subtitle_blur.every(validBlurRegion)
  ) {
    return null;
  }

  const outcome = record.ocr_outcome as PersistedOcrFields['ocr_outcome'];
  const trimStart = record.trim_start;
  const muteAudio = record.mute_audio;
  const blur = record.subtitle_blur as PersistedOcrFields['subtitle_blur'];
  if (
    (outcome === 'clean' && (trimStart !== 0 || muteAudio || blur.length > 0)) ||
    (outcome === 'cover' && (!(trimStart > 0) || muteAudio || blur.length > 0)) ||
    (outcome === 'subtitle' && (!muteAudio || blur.length === 0))
  ) {
    return null;
  }

  return {
    ocr_schema_version: OCR_SCHEMA_VERSION,
    ocr_status: 'analyzed',
    ocr_model: record.ocr_model as string,
    ocr_analyzer_version: OCR_ANALYZER_VERSION,
    ocr_analyzed_at: record.ocr_analyzed_at,
    ocr_requested_frames: record.ocr_requested_frames as number,
    ocr_valid_frames: record.ocr_valid_frames as number,
    ocr_outcome: outcome,
    trim_start: trimStart,
    mute_audio: muteAudio,
    subtitle_blur: blur,
  };
}
