import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  appendMainCandidateDiagnostic,
  formatMainGateSummary,
  sanitizeMainCandidateDiagnostic,
} from './main_candidate_diagnostics.ts';

const sanitized = sanitizeMainCandidateDiagnostic({
  candidate_url: 'https://cdn.example.test/video.mp4?sessionid=private-session',
  embedding: [0.1, 0.2, 0.3],
  authorization: 'Bearer private-token',
  status: 'rejected',
  reason: 'media_unavailable',
  similarity: 0.31,
  floor: 0.33,
  detail: 'media_access_failed',
});
const serialized = JSON.stringify(sanitized);
assert.doesNotMatch(serialized, /cdn\.example|sessionid|private-session|embedding|private-token/i);
assert.match(serialized, /media_unavailable/);

const originalAppendFileSync = fs.appendFileSync;
fs.appendFileSync = (() => {
  throw new Error('simulated diagnostic append failure');
}) as typeof fs.appendFileSync;
try {
  assert.doesNotThrow(() =>
    appendMainCandidateDiagnostic({
      candidate_url: 'https://cdn.example.test/video.mp4?sessionid=private-session',
      embedding: [0.1, 0.2, 0.3],
      status: 'rejected',
      reason: 'media_unavailable',
    }),
  );
} finally {
  fs.appendFileSync = originalAppendFileSync;
}

assert.deepEqual(sanitized, {
  status: 'rejected',
  reason: 'media_unavailable',
  similarity: 0.31,
  floor: 0.33,
  detail: 'media_access_failed',
  candidate_id: '5013a8cebd0dcc12',
});

// A `detail` that is not a bare code is dropped, not written: the allowlist exists so a diagnostic
// can never become the place a url or a token leaks out.
assert.deepEqual(
  sanitizeMainCandidateDiagnostic({
    status: 'rejected',
    detail: 'failed on https://cdn.example.test/video.mp4?sessionid=private-session',
  }),
  { status: 'rejected' },
);

assert.equal(
  formatMainGateSummary({
    accepted: 1,
    rejected: {
      off_topic: 2,
      media_unavailable: 1,
    },
  }),
  'accepted=1 rejected(media_unavailable=1,off_topic=2)',
);

console.log('ok main_candidate_diagnostics');
