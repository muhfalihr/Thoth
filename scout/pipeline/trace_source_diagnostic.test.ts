// scout/pipeline/trace_source_diagnostic.test.ts
// A thrown profile discovery and a genuinely empty profile both return [] and were therefore
// observationally identical after the fact. These tests pin the safe signal that now separates
// them, and pin that neither the caught error nor the handle can ride along with it.
import assert from 'node:assert/strict';
import type { SafeRuntimeDiagnostic } from '../lib/safe_runtime_diagnostic.ts';
import type { PostRecord } from '../acquisition/index.ts';
import { findOriginalTiktokCandidates } from './trace_source.ts';

const HANDLE = 'private.handle.canary';

function tiktokRecord(): PostRecord {
  return {
    canonical_url: `https://www.tiktok.com/@${HANDLE}/video/7677137235434687752`,
    platform: 'tiktok',
    post_id: '7677137235434687752',
    owner_handle: HANDLE,
    text: 'a video',
    media: [],
    outcome: { status: 'resolved', attempts: 1, elapsed_ms: 1 },
  };
}

function contextWith(discover: () => Promise<{ items: PostRecord[] }>) {
  return { runId: 'test', service: { discover } } as any;
}

async function collect(
  context: unknown,
): Promise<{ candidates: unknown[]; events: SafeRuntimeDiagnostic[] }> {
  const events: SafeRuntimeDiagnostic[] = [];
  const candidates = await findOriginalTiktokCandidates(HANDLE, context as never, (event) =>
    events.push(event),
  );
  return { candidates, events };
}

// A thrown discovery emits the exception signal and still returns the empty list callers expect.
{
  const thrown = new Error(
    `discover failed for https://www.tiktok.com/@${HANDLE} token=Bearer-private-token`,
  );
  const { candidates, events } = await collect(
    contextWith(() => {
      throw thrown;
    }),
  );
  assert.deepEqual(candidates, []);
  assert.deepEqual(events, [
    {
      schema_version: 1,
      kind: 'signal',
      stage: 'trace_source',
      category: 'media_candidate_discovery',
      code: 'profile_discovery_exception',
    },
  ]);
  // The caught error and the handle are the two things that must never ride along.
  assert.doesNotMatch(
    JSON.stringify(events),
    /discover failed|tiktok\.com|Bearer-private-token|private\.handle\.canary/,
  );
}

// A rejected promise (not a synchronous throw) takes the same path.
{
  const { candidates, events } = await collect(
    contextWith(() => Promise.reject(new Error('async discover failure'))),
  );
  assert.deepEqual(candidates, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'profile_discovery_exception');
  assert.doesNotMatch(JSON.stringify(events), /async discover failure/);
}

// A successful discovery with no items is a DIFFERENT fact than a thrown discovery.
{
  const { candidates, events } = await collect(contextWith(async () => ({ items: [] })));
  assert.deepEqual(candidates, []);
  assert.deepEqual(events, [
    {
      schema_version: 1,
      kind: 'signal',
      stage: 'trace_source',
      category: 'media_candidate_discovery',
      code: 'profile_discovery_empty',
    },
  ]);
}

// A non-empty discovery emits no failure signal and preserves the mapped candidates.
{
  const { candidates, events } = await collect(
    contextWith(async () => ({ items: [tiktokRecord(), tiktokRecord()] })),
  );
  assert.equal(candidates.length, 2);
  assert.deepEqual(events, []);
}

// The sink is optional: omitting it must not change candidate behavior in either branch.
{
  assert.deepEqual(
    await findOriginalTiktokCandidates(
      HANDLE,
      contextWith(() => {
        throw new Error('no sink supplied');
      }),
    ),
    [],
  );
  assert.deepEqual(
    await findOriginalTiktokCandidates(
      HANDLE,
      contextWith(async () => ({ items: [] })),
    ),
    [],
  );
  assert.equal(
    (
      await findOriginalTiktokCandidates(
        HANDLE,
        contextWith(async () => ({ items: [tiktokRecord()] })),
      )
    ).length,
    1,
  );
}

console.log('ok trace_source_diagnostic');
