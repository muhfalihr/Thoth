import {
  type PersistedOcrFields,
  OcrAnalysisError,
} from './ocr_contract.ts';
import { attachVideoOcr } from './ocr_content.ts';

type VideoRecord = Record<string, unknown> & {
  url?: string;
  is_video?: boolean;
};

// Failures an OPTIONAL candidate may absorb. Dropping one candidate is always
// preferable to aborting the required stage that asked for it; the reason is
// carried through rather than flattened, so a dropped candidate is never
// reported as a media failure it did not have.
// `duration_probe_failed` belongs here for the same reason: ffprobe failing to read ONE candidate's
// url is that candidate's problem, not grounds to abort the stage. It was absent, so a single url
// ffprobe could not open (exit 1) took down all of build_footage.
export const TOLERATED_CANDIDATE_FAILURES = [
  'media_access_failed',
  'stream_resolution_failed',
  'incomplete_frame_coverage',
  'duration_probe_failed',
] as const;

export type ToleratedCandidateFailure = (typeof TOLERATED_CANDIDATE_FAILURES)[number];

export type CandidateOcrResult<T> =
  | { status: 'accepted'; entry: T & PersistedOcrFields }
  | { status: 'unavailable'; code: ToleratedCandidateFailure };

export function attachFootageOcrCandidate<T extends VideoRecord, A extends T & PersistedOcrFields>(
  record: T,
  attach: (record: T) => Promise<A>,
): Promise<
  { status: 'accepted'; entry: A } | { status: 'unavailable'; code: ToleratedCandidateFailure }
>;
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
    if (
      error instanceof OcrAnalysisError &&
      (TOLERATED_CANDIDATE_FAILURES as readonly string[]).includes(error.code)
    ) {
      return { status: 'unavailable', code: error.code as ToleratedCandidateFailure };
    }
    throw error;
  }
}
