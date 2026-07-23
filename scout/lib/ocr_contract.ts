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
