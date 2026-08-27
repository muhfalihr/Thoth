import assert from 'node:assert/strict';
import {
  evaluateMainSuitability,
  type MainCandidate,
  type MainCandidateEvaluatorDeps,
  type MainStoryEvidence,
} from './main_candidate.ts';
import {
  OCR_ANALYZER_VERSION,
  OcrAnalysisError,
  type PersistedOcrFields,
} from './ocr_contract.ts';

const candidate: MainCandidate = {
  url: 'https://www.instagram.com/creator/reel/GOOD/',
  platform: 'instagram',
  caption: 'Ijal berjualan gorengan saat latihan film',
  thumbnail: 'https://img.example.test/good.jpg',
  isVideo: true,
};

const story: MainStoryEvidence = {
  caption: 'Ijal tertangkap kamera berjualan gorengan',
  headline: 'Ijal Copet Sibuk Jualan Gorengan',
  scene: 'Aktor berjualan gorengan di lokasi latihan film',
  title: 'Momen latihan film',
  description: 'Iqbaal Ramadhan mendalami karakter Ijal',
  keywords: ['Iqbaal Ramadhan', 'Ijal', 'gorengan'],
  storyText: 'Ijal Copet Sibuk Jualan Gorengan. Aktor berjualan gorengan di lokasi latihan film.',
};

const ocrFields: PersistedOcrFields = {
  ocr_schema_version: 1,
  ocr_status: 'analyzed',
  ocr_model: 'deepseek/deepseek-ocr',
  ocr_analyzer_version: OCR_ANALYZER_VERSION,
  ocr_analyzed_at: '2026-07-29T00:00:00.000Z',
  ocr_requested_frames: 12,
  ocr_valid_frames: 12,
  ocr_outcome: 'clean',
  trim_start: 0,
  mute_audio: false,
  subtitle_blur: [],
};

function evaluatorDeps(
  overrides: Partial<MainCandidateEvaluatorDeps> = {},
): MainCandidateEvaluatorDeps {
  return {
    storyFloor: 0.33,
    probeVideo: async (value) => ({
      available: true,
      isVideo: true,
      candidate: { ...value, isVideo: true },
    }),
    isCurated: () => false,
    describeEvidence: async () => 'rekaman aktor berjualan gorengan',
    scoreSimilarity: async () => 0.67,
    resolveMedia: async () => ({
      status: 'resolved',
      media: 'https://cdn.example.test/good.mp4',
      source: 'platform-resolver',
      attempts: 1,
      elapsed_ms: 2_000,
    }),
    classifyResolvedVisual: async () => 'footage',
    attachOcr: async (value) => ({ ...value, is_video: true, ...ocrFields }),
    ...overrides,
  };
}

const accepted = await evaluateMainSuitability(candidate, story, 'input', evaluatorDeps());
assert.equal(accepted.status, 'accepted');
assert.equal(accepted.status === 'accepted' && accepted.similarity, 0.67);
assert.equal(accepted.status === 'accepted' && accepted.kind, 'footage');
assert.equal(accepted.status === 'accepted' && accepted.confidence, 'high');
assert.equal(accepted.status === 'accepted' && accepted.candidate.ocr_status, 'analyzed');

{
  let expensiveCalls = 0;
  const notVideo = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      probeVideo: async (value) => ({
        available: true,
        isVideo: false,
        candidate: value,
        detail: 'login_required',
      }),
      describeEvidence: async () => {
        expensiveCalls++;
        return '';
      },
      resolveMedia: async () => {
        expensiveCalls++;
        throw new Error('must not run');
      },
    }),
  );
  assert.deepEqual(notVideo, {
    status: 'rejected',
    reason: 'not_video',
    detail: 'login_required',
  });
  assert.equal(expensiveCalls, 0);
}

{
  let expensiveCalls = 0;
  const unavailableProbe = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      probeVideo: async (value) => ({
        available: false,
        isVideo: false,
        candidate: value,
        detail: 'probe_timeout',
      }),
      describeEvidence: async () => {
        expensiveCalls++;
        return '';
      },
      resolveMedia: async () => {
        expensiveCalls++;
        throw new Error('must not run');
      },
    }),
  );
  assert.deepEqual(unavailableProbe, {
    status: 'rejected',
    reason: 'media_unavailable',
    detail: 'probe_timeout',
  });
  assert.equal(expensiveCalls, 0);
}

{
  let similarityCalls = 0;
  const curated = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      isCurated: () => true,
      scoreSimilarity: async () => {
        similarityCalls++;
        return 0.99;
      },
    }),
  );
  assert.deepEqual(curated, {
    status: 'rejected',
    reason: 'curated_aggregator',
  });
  assert.equal(similarityCalls, 0);
}

{
  let resolutionCalls = 0;
  const offTopic = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      scoreSimilarity: async () => 0.329,
      resolveMedia: async () => {
        resolutionCalls++;
        throw new Error('must not run');
      },
    }),
  );
  assert.deepEqual(offTopic, {
    status: 'rejected',
    reason: 'off_topic',
    similarity: 0.329,
  });
  assert.equal(resolutionCalls, 0);
}

const atFloor = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({ scoreSimilarity: async () => 0.33 }),
);
assert.equal(atFloor.status, 'accepted');

const commentary = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    classifyResolvedVisual: async () => 'commentary',
  }),
);
assert.deepEqual(commentary, { status: 'rejected', reason: 'commentary', similarity: 0.67 });

const unavailable = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    resolveMedia: async () => ({
      status: 'unavailable',
      code: 'stream_resolution_failed',
      reason: 'timeout',
      attempts: 3,
      elapsed_ms: 30_000,
    }),
  }),
);
assert.deepEqual(unavailable, {
  status: 'rejected',
  reason: 'media_unavailable',
  similarity: 0.67,
});

// OCR that cannot fetch its media is ONE candidate's problem, not grounds to end the run.
// `attachVideoOcr` throws hard on purpose — the main that was finally chosen MUST carry OCR — but
// while GRADING candidates that throw used to travel straight through the gate and kill
// trace_source on the second replacement, so a source video that had already been found was never
// taken.
const ocrThrew = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    attachOcr: async () => {
      throw new OcrAnalysisError('media_access_failed', 'OCR media could not be localized safely');
    },
  }),
);
assert.deepEqual(ocrThrew, {
  status: 'rejected',
  reason: 'media_unavailable',
  detail: 'media_access_failed',
  similarity: 0.67,
});

// A NON-OCR failure still propagates: swallowing it would disguise a bug as "no candidate found".
await assert.rejects(
  evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      attachOcr: async () => {
        throw new TypeError('bug');
      },
    }),
  ),
  TypeError,
);

const subtitle = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    attachOcr: async (value) => ({
      ...value,
      is_video: true,
      ...ocrFields,
      ocr_outcome: 'subtitle',
      mute_audio: true,
      subtitle_blur: [{ x: 0.1, y: 0.8, w: 0.8, h: 0.1 }],
    }),
  }),
);
assert.deepEqual(subtitle, {
  status: 'rejected',
  reason: 'subtitle_reaction',
  similarity: 0.67,
});

const indeterminate = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({ scoreSimilarity: async () => null }),
);
assert.equal(indeterminate.status, 'indeterminate');
assert.equal(indeterminate.status === 'indeterminate' && indeterminate.confidence, 'low');
assert.equal(
  indeterminate.status === 'indeterminate' && indeterminate.candidate.ocr_status,
  'analyzed',
);
assert.equal(indeterminate.status === 'indeterminate' && indeterminate.kind, 'footage');

await assert.rejects(
  () =>
    evaluateMainSuitability(
      candidate,
      story,
      'input',
      evaluatorDeps({
        attachOcr: async () => {
          throw new Error('systemic OCR failure');
        },
      }),
    ),
  /systemic OCR failure/,
);

// What the evaluator hands to each dependency: normalized candidate, story text,
// combined evidence string, and the resolved media URL (not the carousel cover).
{
  const seen: {
    probed?: MainCandidate;
    curated?: MainCandidate;
    described?: MainCandidate;
    similarityArgs?: [string, string];
    resolveArg?: MainCandidate;
    classifyMedia?: string | null;
    ocrMedia?: string | null;
  } = {};
  const recorded = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      probeVideo: async (value) => {
        seen.probed = value;
        // Deliberately un-normalized so the evaluator's own normalization is observable.
        return {
          available: true,
          isVideo: true,
          candidate: { ...value, isVideo: false, is_video: false },
        };
      },
      isCurated: (value) => {
        seen.curated = value;
        return false;
      },
      describeEvidence: async (value) => {
        seen.described = value;
        return 'rekaman aktor berjualan gorengan';
      },
      scoreSimilarity: async (storyText, evidence) => {
        seen.similarityArgs = [storyText, evidence];
        return 0.67;
      },
      resolveMedia: async (value) => {
        seen.resolveArg = value;
        return {
          status: 'resolved',
          media: 'https://cdn.example.test/good.mp4',
          source: 'platform-resolver',
          attempts: 1,
          elapsed_ms: 2_000,
        };
      },
      classifyResolvedVisual: async (_value, media) => {
        seen.classifyMedia = media;
        return 'footage';
      },
      attachOcr: async (value, media) => {
        seen.ocrMedia = media;
        return { ...value, ...ocrFields };
      },
    }),
  );
  assert.equal(recorded.status, 'accepted');
  assert.equal(seen.probed, candidate);
  assert.equal(seen.curated?.isVideo, true);
  assert.equal(seen.curated?.is_video, true);
  assert.equal(seen.described?.isVideo, true);
  assert.equal(seen.described?.is_video, true);
  assert.deepEqual(seen.similarityArgs, [
    story.storyText,
    'rekaman aktor berjualan gorengan. Ijal berjualan gorengan saat latihan film',
  ]);
  assert.equal(seen.resolveArg?.is_video, true);
  assert.equal(seen.classifyMedia, 'https://cdn.example.test/good.mp4');
  assert.equal(seen.ocrMedia, 'https://cdn.example.test/good.mp4');
  assert.equal(recorded.status === 'accepted' && recorded.candidate.is_video, true);
}

// candidateEvidence: blank visual description drops out, caption survives.
{
  let evidence: string | null = null;
  await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      describeEvidence: async () => '   ',
      scoreSimilarity: async (_storyText, value) => {
        evidence = value;
        return 0.67;
      },
    }),
  );
  assert.equal(evidence, 'Ijal berjualan gorengan saat latihan film');
}

// candidateEvidence: missing caption drops out, visual description survives.
{
  const captionless: MainCandidate = {
    url: 'https://www.instagram.com/creator/reel/NOCAPTION/',
    platform: 'instagram',
    isVideo: true,
  };
  let evidence: string | null = null;
  await evaluateMainSuitability(
    captionless,
    story,
    'input',
    evaluatorDeps({
      scoreSimilarity: async (_storyText, value) => {
        evidence = value;
        return 0.67;
      },
    }),
  );
  assert.equal(evidence, 'rekaman aktor berjualan gorengan');
}

// Unclassifiable visual is still accepted, but as low-confidence unknown.
const unknownVisual = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({ classifyResolvedVisual: async () => 'unknown' }),
);
assert.equal(unknownVisual.status, 'accepted');
assert.equal(unknownVisual.status === 'accepted' && unknownVisual.kind, 'unknown');
assert.equal(unknownVisual.status === 'accepted' && unknownVisual.confidence, 'low');
assert.equal(unknownVisual.status === 'accepted' && unknownVisual.similarity, 0.67);

const unknownIndeterminate = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    classifyResolvedVisual: async () => 'unknown',
    scoreSimilarity: async () => null,
  }),
);
assert.equal(unknownIndeterminate.status, 'indeterminate');
assert.equal(
  unknownIndeterminate.status === 'indeterminate' && unknownIndeterminate.kind,
  'unknown',
);

// Gate ordering: commentary is decided before OCR ever runs, even when the OCR
// outcome would also have rejected the candidate.
{
  let ocrCalls = 0;
  const commentaryAndSubtitle = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      classifyResolvedVisual: async () => 'commentary',
      attachOcr: async (value) => {
        ocrCalls++;
        return {
          ...value,
          is_video: true,
          ...ocrFields,
          ocr_outcome: 'subtitle',
          mute_audio: true,
          subtitle_blur: [{ x: 0.1, y: 0.8, w: 0.8, h: 0.1 }],
        };
      },
    }),
  );
  assert.deepEqual(commentaryAndSubtitle, {
    status: 'rejected',
    reason: 'commentary',
    similarity: 0.67,
  });
  assert.equal(ocrCalls, 0);
}

// Every rejection that carries similarity must omit the field when unscored.
const nullSimUnavailable = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    scoreSimilarity: async () => null,
    resolveMedia: async () => ({
      status: 'unavailable',
      code: 'stream_resolution_failed',
      reason: 'timeout',
      attempts: 3,
      elapsed_ms: 30_000,
    }),
  }),
);
assert.deepEqual(nullSimUnavailable, { status: 'rejected', reason: 'media_unavailable' });
assert.ok(!('similarity' in nullSimUnavailable));

const nullSimCommentary = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    scoreSimilarity: async () => null,
    classifyResolvedVisual: async () => 'commentary',
  }),
);
assert.deepEqual(nullSimCommentary, { status: 'rejected', reason: 'commentary' });
assert.ok(!('similarity' in nullSimCommentary));

const nullSimSubtitle = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    scoreSimilarity: async () => null,
    attachOcr: async (value) => ({
      ...value,
      is_video: true,
      ...ocrFields,
      ocr_outcome: 'subtitle',
      mute_audio: true,
      subtitle_blur: [{ x: 0.1, y: 0.8, w: 0.8, h: 0.1 }],
    }),
  }),
);
assert.deepEqual(nullSimSubtitle, { status: 'rejected', reason: 'subtitle_reaction' });
assert.ok(!('similarity' in nullSimSubtitle));

// No resolver for this platform (every TikTok candidate): null, not `unavailable`.
{
  let classifyMedia: string | null | undefined;
  let ocrMedia: string | null | undefined;
  const noResolver = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      resolveMedia: async () => null,
      classifyResolvedVisual: async (_value, media) => {
        classifyMedia = media;
        return 'footage';
      },
      attachOcr: async (value, media) => {
        ocrMedia = media;
        return { ...value, is_video: true, ...ocrFields };
      },
    }),
  );
  assert.equal(noResolver.status, 'accepted');
  assert.equal(noResolver.status === 'accepted' && noResolver.candidate.ocr_status, 'analyzed');
  assert.equal(classifyMedia, null);
  assert.equal(ocrMedia, null);
}

// A cover-only OCR outcome is clean enough to keep, same as 'clean'.
const coverOutcome = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    attachOcr: async (value) => ({
      ...value,
      is_video: true,
      ...ocrFields,
      ocr_outcome: 'cover',
      trim_start: 1.5,
    }),
  }),
);
assert.equal(coverOutcome.status, 'accepted');
assert.equal(coverOutcome.status === 'accepted' && coverOutcome.candidate.ocr_outcome, 'cover');
assert.equal(coverOutcome.status === 'accepted' && coverOutcome.candidate.trim_start, 1.5);

console.log('ok main_candidate');
