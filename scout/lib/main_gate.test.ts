import assert from 'node:assert/strict';
import type { MainCandidate, MainStoryEvidence, MainSuitability } from './main_candidate.ts';
import {
  chooseInputOrReplacement,
  MainCandidateNotFoundError,
  rankAcceptedMainCandidates,
} from './main_gate.ts';

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
    ocr_schema_version: 1,
    ocr_status: 'analyzed',
    ocr_model: 'deepseek/deepseek-ocr',
    ocr_analyzer_version: 'deepseek-ocr-v2',
    ocr_analyzed_at: '2026-07-29T00:00:00.000Z',
    ocr_requested_frames: 1,
    ocr_valid_frames: 1,
    ocr_outcome: 'clean',
    trim_start: 0,
    mute_audio: false,
    subtitle_blur: [],
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

await assert.rejects(
  () =>
    chooseInputOrReplacement(input, story, {
      evaluate: async (_candidate, _story, origin) =>
        origin === 'input'
          ? { status: 'rejected', reason: 'curated_aggregator' }
          : {
              status: 'indeterminate',
              reason: 'similarity_unavailable',
              confidence: 'low',
              kind: 'footage',
              candidate: accepted(input, 0.5).candidate,
            },
      search: async () => [{ url: 'https://example.test/unranked', platform: 'youtube' }],
    }),
  (error: unknown) =>
    error instanceof MainCandidateNotFoundError &&
    error.code === 'main_candidate_not_found' &&
    !error.message.includes('example.test'),
);

console.log('ok main_gate');
