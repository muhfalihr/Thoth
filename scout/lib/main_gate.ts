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
      candidate: MainCandidate & PersistedOcrFields;
      confidence: 'high' | 'low';
      suitability: 'accepted' | 'indeterminate';
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
};

const AGGREGATOR_MARKERS =
  /(news|berita|media|infotainment|seleb|gosip|viral|update|terkini|trending|repost|kabar|warta|portal|redaksi|jurnal|koran|radar|grid|tempo|detik|kompas|tribun|cnnindo|cnbc|official)$/i;

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
    if (result.status === 'accepted') acceptedResults.push(result);
  }
  const selected = (deps.rankAccepted ?? ((results) => results[0] || null))(acceptedResults);
  if (!selected) throw new MainCandidateNotFoundError();
  return {
    status: 'replace',
    candidate: selected.candidate,
    confidence: selected.confidence,
    suitability: 'accepted',
  };
}
