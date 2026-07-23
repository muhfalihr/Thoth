import type { ClipVerdict } from './subtitle_vision.ts';

export const OCR_SCHEMA_VERSION = 1;
export const OCR_ANALYZER_VERSION = 'deepseek-ocr-v2';
export const DEFAULT_OCR_MODEL = 'deepseek/deepseek-ocr';

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
  rawAnalysis: OcrAnalysis,
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
