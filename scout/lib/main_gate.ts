import { normHandle, urlHandle } from './aggregators.ts';
import type {
  MainCandidate,
  MainCandidateOrigin,
  MainStoryEvidence,
  MainSuitability,
} from './main_candidate.ts';
import type { PersistedOcrFields } from './ocr_contract.ts';

type AcceptedSuitability = Extract<MainSuitability, { status: 'accepted' }>;

export type MainGateDecision =
  | {
      status: 'retain';
      // Partial: the 'unverified' fallback below retains the raw input, which never went through
      // OCR — the rejected MainSuitability variant carries no analysed candidate to hand back.
      candidate: MainCandidate & Partial<PersistedOcrFields>;
      confidence: 'high' | 'low';
      suitability: 'accepted' | 'indeterminate' | 'unverified';
    }
  | {
      status: 'replace';
      candidate: MainCandidate & PersistedOcrFields;
      confidence: 'high' | 'low';
      suitability: 'accepted';
    };

export class MainCandidateNotFoundError extends Error {
  readonly code = 'main_candidate_not_found';

  constructor() {
    super('No acceptable main video candidate was found');
    this.name = 'MainCandidateNotFoundError';
  }
}

export type MainGateDeps = {
  evaluate: (
    candidate: MainCandidate,
    story: MainStoryEvidence,
    origin: MainCandidateOrigin,
  ) => Promise<MainSuitability>;
  search: () => Promise<MainCandidate[]>;
  rankAccepted?: (candidates: AcceptedSuitability[]) => AcceptedSuitability | null;
  // Set when step 3 credited no account at all (the model omitted it, or answered with the "@akun"
  // placeholder). The search then had no handle to aim at, so finding nothing says nothing about
  // the input post — keep it as main rather than aborting the run. With a real credited handle this
  // stays false: coming back empty there is a genuine failure and must still throw.
  retainInputWhenUncredited?: boolean;
  appendDiagnostic?: (record: Record<string, unknown>) => void;
};

const AGGREGATOR_MARKERS =
  /(news|berita|media|infotainment|seleb|gosip|viral|update|terkini|trending|repost|kabar|warta|portal|redaksi|jurnal|koran|radar|grid|tempo|detik|kompas|tribun|cnnindo|cnbc|official)$/i;

function appendEvaluationDiagnostic(
  deps: MainGateDeps,
  candidate: MainCandidate,
  origin: MainCandidateOrigin,
  result: MainSuitability,
): void {
  deps.appendDiagnostic?.({
    candidate_url: candidate.url,
    origin,
    platform: candidate.platform,
    status: result.status,
    reason:
      result.status === 'rejected' || result.status === 'indeterminate' ? result.reason : undefined,
    // 'media_unavailable' covers both a stream that would not resolve and an OCR that could not read
    // the media it was given; without the code the two are one indistinguishable line in the ledger.
    detail: result.status === 'rejected' ? result.detail : undefined,
    similarity:
      result.status === 'accepted' || result.status === 'rejected' ? result.similarity : undefined,
    visual_kind:
      result.status === 'accepted' || result.status === 'indeterminate' ? result.kind : undefined,
    ocr_outcome:
      result.status === 'accepted' || result.status === 'indeterminate'
        ? result.candidate.ocr_outcome
        : undefined,
    replacement_started: origin === 'search',
  });
}

export function rankAcceptedMainCandidates(
  candidates: AcceptedSuitability[],
  options: {
    credited: string;
    repostHandle: string;
    preferFootage: boolean;
  },
): AcceptedSuitability | null {
  const credited = normHandle(options.credited);
  const repost = normHandle(options.repostHandle);
  const tier = (result: AcceptedSuitability): number => {
    const handle = normHandle(
      String(
        result.candidate.uploader || urlHandle(result.candidate.pageUrl || result.candidate.url),
      ),
    );
    if (credited && handle === credited) return 0;
    if (!handle) return 1;
    if (handle === repost || AGGREGATOR_MARKERS.test(handle)) return 2;
    return 1;
  };
  const score = (result: AcceptedSuitability): number =>
    result.similarity + (options.preferFootage && result.kind === 'footage' ? 1 : 0);

  for (const currentTier of [0, 1, 2]) {
    const pool = candidates
      .filter((result) => tier(result) === currentTier)
      .sort((a, b) => score(b) - score(a));
    if (pool[0]) return pool[0];
  }
  return null;
}

export async function chooseInputOrReplacement(
  input: MainCandidate,
  story: MainStoryEvidence,
  deps: MainGateDeps,
): Promise<MainGateDecision> {
  const inputResult = await deps.evaluate(input, story, 'input');
  appendEvaluationDiagnostic(deps, input, 'input', inputResult);
  if (inputResult.status === 'accepted') {
    return {
      status: 'retain',
      candidate: inputResult.candidate,
      confidence: inputResult.confidence,
      suitability: 'accepted',
    };
  }
  if (inputResult.status === 'indeterminate') {
    return {
      status: 'retain',
      candidate: inputResult.candidate,
      confidence: 'low',
      suitability: 'indeterminate',
    };
  }

  const discovered = await deps.search();
  const acceptedResults: AcceptedSuitability[] = [];
  for (const candidate of discovered) {
    const result = await deps.evaluate(candidate, story, 'search');
    appendEvaluationDiagnostic(deps, candidate, 'search', result);
    if (result.status === 'accepted') acceptedResults.push(result);
  }
  const selected = (deps.rankAccepted ?? ((results) => results[0] || null))(acceptedResults);
  if (!selected) {
    if (!deps.retainInputWhenUncredited) throw new MainCandidateNotFoundError();
    return { status: 'retain', candidate: input, confidence: 'low', suitability: 'unverified' };
  }
  return {
    status: 'replace',
    candidate: selected.candidate,
    confidence: selected.confidence,
    suitability: 'accepted',
  };
}
