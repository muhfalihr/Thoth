import {
  type PersistedOcrFields,
  OcrAnalysisError,
} from './ocr_contract.ts';
import { attachVideoOcr } from './ocr_content.ts';

type VideoRecord = Record<string, unknown> & {
  url?: string;
  is_video?: boolean;
};

export type CandidateOcrResult<T> =
  | { status: 'accepted'; entry: T & PersistedOcrFields }
  | { status: 'unavailable'; code: 'media_access_failed' };

export function attachFootageOcrCandidate<T extends VideoRecord, A extends T & PersistedOcrFields>(
  record: T,
  attach: (record: T) => Promise<A>,
): Promise<{ status: 'accepted'; entry: A } | { status: 'unavailable'; code: 'media_access_failed' }>;
export function attachFootageOcrCandidate<T extends VideoRecord>(
  record: T,
  attach?: (record: T) => Promise<T & PersistedOcrFields>,
): Promise<CandidateOcrResult<T>>;
export async function attachFootageOcrCandidate<T extends VideoRecord>(
  record: T,
  attach: (record: T) => Promise<T & PersistedOcrFields> = (value) =>
    attachVideoOcr(value) as Promise<T & PersistedOcrFields>,
): Promise<CandidateOcrResult<T>> {
  try {
    return { status: 'accepted', entry: await attach(record) };
  } catch (error) {
    if (error instanceof OcrAnalysisError && error.code === 'media_access_failed') {
      return { status: 'unavailable', code: 'media_access_failed' };
    }
    throw error;
  }
}
