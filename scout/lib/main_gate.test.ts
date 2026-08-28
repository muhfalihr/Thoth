import assert from 'node:assert/strict';
import type { MainCandidate, MainStoryEvidence, MainSuitability } from './main_candidate.ts';
import {
  chooseInputOrReplacement,
  isPlausibleSource,
  MainCandidateNotFoundError,
  rankAcceptedMainCandidates,
} from './main_gate.ts';
import { OCR_ANALYZER_VERSION } from './ocr_contract.ts';
import type { PersistedOcrFields } from './ocr_contract.ts';

const input: MainCandidate = {
  url: 'https://www.instagram.com/p/INPUT/',
  platform: 'instagram',
};
const story = {
  caption: 'story',
  headline: 'headline',
  scene: 'scene',
  title: 'title',
  description: 'description',
  keywords: ['keyword'],
  storyText: 'headline scene description',
} satisfies MainStoryEvidence;

const ocrFields: PersistedOcrFields = {
  ocr_schema_version: 1,
  ocr_status: 'analyzed',
  ocr_model: 'deepseek/deepseek-ocr',
  ocr_analyzer_version: OCR_ANALYZER_VERSION,
  ocr_analyzed_at: '2026-07-29T00:00:00.000Z',
  ocr_requested_frames: 1,
  ocr_valid_frames: 1,
  ocr_outcome: 'clean',
  trim_start: 0,
  mute_audio: false,
  subtitle_blur: [],
};

const accepted = (
  value: MainCandidate,
  similarity: number,
): Extract<MainSuitability, { status: 'accepted' }> => ({
  status: 'accepted',
  similarity,
  kind: 'footage',
  confidence: 'high',
  candidate: {
    ...value,
    ...ocrFields,
  },
});

{
  let searches = 0;
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (candidate, _story, origin) => {
      assert.equal(origin, 'input');
      return accepted(candidate, 0.7);
    },
    search: async () => {
      searches++;
      return [];
    },
  });
  assert.equal(decision.status, 'retain');
  assert.equal(decision.confidence, 'high');
  assert.equal(decision.candidate.ocr_status, 'analyzed');
  assert.equal(searches, 0);
}

{
  let searches = 0;
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (candidate) => ({
      status: 'indeterminate',
      reason: 'similarity_unavailable',
      confidence: 'low',
      kind: 'footage',
      candidate: accepted(candidate, 0.5).candidate,
    }),
    search: async () => {
      searches++;
      return [];
    },
  });
  assert.equal(decision.status, 'retain');
  assert.equal(decision.confidence, 'low');
  assert.equal(searches, 0);
}

{
  const first = {
    url: 'https://x.com/news/status/1',
    platform: 'twitter',
    uploader: 'news',
  };
  const second = {
    url: 'https://www.instagram.com/creator/reel/2/',
    platform: 'instagram',
    uploader: 'creator',
  };
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (candidate, _story, origin) => {
      if (origin === 'input') {
        return { status: 'rejected', reason: 'off_topic', similarity: 0.1 };
      }
      return accepted(candidate, candidate.url === second.url ? 0.63 : 0.8);
    },
    search: async () => [first, second],
    rankAccepted: (results) =>
      rankAcceptedMainCandidates(results, {
        credited: 'creator',
        repostHandle: 'news',
        preferFootage: true,
      }),
  });
  assert.equal(decision.status, 'replace');
  assert.equal(decision.status === 'replace' && decision.candidate.url, second.url);
}

{
  const evaluated: string[] = [];
  const candidates = [
    {
      url: 'https://www.instagram.com/creator/reel/OFF/',
      platform: 'instagram',
      uploader: 'creator',
    },
    {
      url: 'https://www.instagram.com/creator/reel/GOOD/',
      platform: 'instagram',
      uploader: 'creator',
    },
    {
      url: 'https://www.youtube.com/watch?v=GENERIC',
      platform: 'youtube',
    },
  ];
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (value, _story, origin) => {
      evaluated.push(`${origin}:${value.url}`);
      if (origin === 'input') {
        return { status: 'rejected', reason: 'curated_aggregator' };
      }
      if (value.url.endsWith('/OFF/')) {
        return { status: 'rejected', reason: 'off_topic', similarity: 0.2 };
      }
      return accepted(value, value.url.endsWith('/GOOD/') ? 0.68 : 0.6);
    },
    search: async () => candidates,
    rankAccepted: (results) =>
      rankAcceptedMainCandidates(results, {
        credited: 'creator',
        repostHandle: 'curator',
        preferFootage: true,
      }),
  });
  assert.equal(decision.status, 'replace');
  assert.equal(
    decision.status === 'replace' && decision.candidate.url,
    'https://www.instagram.com/creator/reel/GOOD/',
  );
  assert.equal(decision.candidate.ocr_status, 'analyzed');
  assert.equal(evaluated.length, 4);
}

{
  const diagnostics: Record<string, unknown>[] = [];
  await assert.rejects(
    () =>
      chooseInputOrReplacement(input, story, {
        evaluate: async (_candidate, _story, origin) =>
          origin === 'input'
            ? { status: 'rejected', reason: 'off_topic', similarity: 0.1 }
            : { status: 'rejected', reason: 'media_unavailable' },
        search: async () => [{ url: 'https://example.test/unavailable', platform: 'youtube' }],
        appendDiagnostic: (record) => diagnostics.push(record),
      }),
    (error: unknown) =>
      error instanceof MainCandidateNotFoundError &&
      error.code === 'main_candidate_not_found' &&
      !error.message.includes('example.test'),
  );
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((record) => record.status),
    ['rejected', 'rejected'],
  );
}

// When step 3 never identified an account, there was no lead to chase and the search is shooting in
// the dark — throwing there kills the run over a post we already have. Keep the input post as main
// instead. This is opt-in: with a real credited handle, finding nothing is still a hard failure
// worth surfacing, so the default above must keep throwing.
{
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async () => ({ status: 'rejected', reason: 'off_topic', similarity: 0.1 }),
    search: async () => [],
    retainInputWhenUncredited: true,
  });
  assert.equal(decision.status, 'retain');
  assert.equal(decision.candidate.url, input.url);
  assert.equal(decision.suitability, 'unverified');
  assert.equal(decision.confidence, 'low');
}

{
  const decision = await chooseInputOrReplacement(
    { url: 'https://www.tiktok.com/@detikjatim/video/7677496203042360594', platform: 'tiktok' },
    story,
    {
      evaluate: async (candidate, _story, origin) =>
        origin === 'input'
          ? { status: 'rejected', reason: 'curated_aggregator' }
          : {
              status: 'indeterminate',
              reason: 'similarity_unavailable',
              confidence: 'low',
              kind: 'footage',
              candidate: { ...candidate, ...ocrFields },
            },
      search: async () => [
        {
          url: 'https://www.tiktok.com/@vincentius.christ76/video/7677137235434687752',
          platform: 'tiktok',
        },
      ],
    },
  );
  assert.equal(
    decision.status,
    'replace',
    'an unscored candidate is not a rejected one — dropping it took no video at all',
  );
  assert.equal(decision.suitability, 'indeterminate');
  assert.equal(decision.confidence, 'low');
  assert.equal(
    decision.candidate.url,
    'https://www.tiktok.com/@vincentius.christ76/video/7677137235434687752',
  );
}

{
  const decision = await chooseInputOrReplacement(
    { url: 'https://www.tiktok.com/@detikjatim/video/7677496203042360594', platform: 'tiktok' },
    story,
    {
      evaluate: async (candidate, _story, origin) =>
        origin === 'input'
          ? { status: 'rejected', reason: 'curated_aggregator' }
          : {
              status: 'indeterminate',
              reason: 'similarity_unavailable',
              confidence: 'low',
              kind: 'footage',
              candidate: { ...candidate, ...ocrFields },
            },
      search: async () => [
        {
          url: 'https://www.tiktok.com/@vincentius.christ76/video/7678367150007930130',
          platform: 'tiktok',
          uploader: 'vincentius.christ76',
          views: 485,
        },
        {
          url: 'https://www.tiktok.com/@vincentius.christ76/video/7677137235434687752',
          platform: 'tiktok',
          uploader: 'vincentius.christ76',
          views: 78000,
        },
      ],
      creditedHandle: '@Vincentius.Christ76',
    },
  );
  assert.equal(decision.status, 'replace');
  assert.equal(decision.suitability, 'indeterminate');
  assert.equal(decision.confidence, 'low');
  assert.equal(
    decision.candidate.url,
    'https://www.tiktok.com/@vincentius.christ76/video/7677137235434687752',
    'credited indeterminate candidates without metadata must prefer the highest-view source',
  );
}

{
  const creditedSource = {
    url: 'https://www.tiktok.com/@vincentius.christ76/video/7677137235434687752',
    pageUrl: 'https://example.test/captured-source',
    platform: 'tiktok',
    publishedAt: 1787472811,
    durationSec: 124,
  };
  const unrelatedAccepted = {
    url: 'https://www.tiktok.com/@kohdennies/video/7677481234567890123',
    platform: 'tiktok',
    uploader: 'kohdennies',
  };
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (candidate, _story, origin) => {
      if (origin === 'input') {
        return { status: 'rejected', reason: 'curated_aggregator' };
      }
      if (candidate.url === creditedSource.url) {
        return {
          status: 'indeterminate',
          reason: 'similarity_unavailable',
          confidence: 'low',
          kind: 'footage',
          candidate: { ...candidate, ...ocrFields },
        };
      }
      return accepted(candidate, 0.659);
    },
    search: async () => [unrelatedAccepted, creditedSource],
    creditedHandle: '@Vincentius.Christ76',
    sourceWindow: { repostTime: 1787556392, repostDuration: 90 },
    rankAccepted: (results) => results[0] ?? null,
  });
  assert.equal(
    decision.status === 'replace' && decision.candidate.url,
    creditedSource.url,
    'a plausible credited source without similarity must beat an unrelated accepted result',
  );
  assert.equal(decision.suitability, 'indeterminate');
  assert.equal(decision.confidence, 'low');
  assert.equal(decision.status === 'replace' && decision.candidate.ocr_outcome, 'clean');
}

{
  const REPOST_TIME = 1787556392; // detikjatim, 2026-08-24
  const window = { repostTime: REPOST_TIME, repostDuration: 90 };
  assert.equal(
    isPlausibleSource(
      { url: 'u', platform: 'tiktok', publishedAt: 1787472811, durationSec: 124 },
      window,
    ),
    true,
    '23.2 h earlier and longer — measured source',
  );
  assert.equal(
    isPlausibleSource(
      { url: 'u', platform: 'tiktok', publishedAt: REPOST_TIME + 3600, durationSec: 124 },
      window,
    ),
    false,
    'published after repost — cannot be its source',
  );
  assert.equal(
    isPlausibleSource(
      {
        url: 'u',
        platform: 'tiktok',
        publishedAt: REPOST_TIME - 40 * 86400,
        durationSec: 124,
      },
      window,
    ),
    false,
    'older than 14-day window',
  );
  assert.equal(
    isPlausibleSource(
      { url: 'u', platform: 'tiktok', publishedAt: 1787472811, durationSec: 30 },
      window,
    ),
    false,
    'repost cuts, does not add footage',
  );
  assert.equal(
    isPlausibleSource({ url: 'u', platform: 'tiktok' }, window),
    true,
    'no metadata not evidence against candidate',
  );
  const ranked = rankAcceptedMainCandidates(
    [
      accepted({ url: 'later', platform: 'tiktok', publishedAt: REPOST_TIME + 3600, durationSec: 124 }, 0.9),
      accepted({ url: 'source', platform: 'tiktok', publishedAt: 1787472811, durationSec: 124 }, 0.4),
    ],
    { credited: '', repostHandle: '', preferFootage: false, ...window },
  );
  assert.equal(
    ranked?.candidate.url,
    'source',
    'plausibility must outrank similarity — source clip one with no caption to score',
  );
}

console.log('ok main_gate');
