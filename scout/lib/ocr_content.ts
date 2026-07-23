import {
  analysisFields,
  OcrAnalysisError,
  type OcrAnalysis,
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
  project?: (analysis: OcrAnalysis) => PersistedOcrFields;
};

export async function attachVideoOcr<T extends VideoRecord>(
  record: T,
  deps: AttachVideoOcrDeps = {},
): Promise<T & Partial<PersistedOcrFields>> {
  if (record.is_video === false) return record;

  try {
    const analysis = await runRequiredOcr(async () => {
      const source = record.source_local || record.url || '';
      const resolved = (deps.resolve ?? ((value) => directStreamUrl(value) || value))(source);
      return (deps.analyze ?? ((value) => analyzeSubtitlesDetailed(value)))(resolved);
    });
    Object.assign(record, (deps.project ?? analysisFields)(analysis));
    return record;
  } catch (error) {
    if (error instanceof OcrAnalysisError) throw error;
    throw new OcrAnalysisError('analysis_exception', 'OCR analysis raised an exception');
  }
}
