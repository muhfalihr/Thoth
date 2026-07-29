import {
  type CandidateOcrResult,
  type ToleratedCandidateFailure,
  attachFootageOcrCandidate,
} from './footage_candidate_ocr.ts';
import type { PersistedOcrFields } from './ocr_contract.ts';

type VideoRecord = Record<string, unknown> & {
  url?: string;
  is_video?: boolean;
};

export type FootageCandidateSelection<T> = {
  result: CandidateOcrResult<T>;
  mediaDropped: number;
};

function unavailable<T>(): FootageCandidateSelection<T> {
  return {
    result: { status: 'unavailable', code: 'media_access_failed' },
    mediaDropped: 1,
  };
}

export function formatMediaDropSummary(mediaDropped: number): string {
  return mediaDropped ? ` (${mediaDropped} drop media tak dapat diakses)` : '';
}

export function selectFootageVideoCandidate<T extends VideoRecord, A extends T & PersistedOcrFields>(
  record: T,
  attach: (record: T) => Promise<A>,
): Promise<{
  result:
    | { status: 'accepted'; entry: A }
    | { status: 'unavailable'; code: ToleratedCandidateFailure };
  mediaDropped: number;
}>;
export function selectFootageVideoCandidate<T extends VideoRecord>(
  record: T,
  attach?: (record: T) => Promise<T & PersistedOcrFields>,
): Promise<FootageCandidateSelection<T>>;
export async function selectFootageVideoCandidate<T extends VideoRecord>(
  record: T,
  attach?: (record: T) => Promise<T & PersistedOcrFields>,
): Promise<FootageCandidateSelection<T>> {
  const result = await attachFootageOcrCandidate(record, attach);
  return { result, mediaDropped: result.status === 'unavailable' ? 1 : 0 };
}

export async function selectTikTokFootageVideoCandidate<T extends VideoRecord>(
  record: T,
  resolveDirect: (url: string) => Promise<{ url: string } | null>,
  attach?: (record: T & { source_url: string }) => Promise<(T & { source_url: string }) & PersistedOcrFields>,
): Promise<FootageCandidateSelection<T & { source_url: string }>> {
  const sourceUrl = String(record.url || '');
  const direct = await resolveDirect(sourceUrl);
  if (!direct?.url) return unavailable<T & { source_url: string }>();
  return selectFootageVideoCandidate(
    { ...record, url: direct.url, source_url: sourceUrl },
    attach,
  );
}

export async function selectCarouselFootageVideoCandidate<T extends VideoRecord>(
  record: T,
  resolveDirect: () => string | null | undefined,
  attach?: (record: T & { source_url: string }) => Promise<(T & { source_url: string }) & PersistedOcrFields>,
): Promise<FootageCandidateSelection<T & { source_url: string }>> {
  const sourceUrl = String(record.url || '');
  const direct = resolveDirect();
  if (!direct) return unavailable<T & { source_url: string }>();
  return selectFootageVideoCandidate(
    { ...record, url: direct, source_url: sourceUrl },
    attach,
  );
}
