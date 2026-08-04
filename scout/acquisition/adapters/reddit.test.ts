import assert from 'node:assert/strict';
import { EXTRACT_JS } from '../../scrapers/scrape_comments_reddit.ts';
import { AcquisitionError } from '../types.ts';
import { createRedditAdapter, parseRedditListing } from './reddit.ts';

function fakeContext(intents: string[] = []): any {
  return {
    intents: () => new Set(intents),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire({} as any, new Set(intents)),
  };
}

// --- pinned: parseRedditListing() extracts a PostRecord[] from the
// canonical `.json` Listing array (brief's exact fixture).
{
  const posts = parseRedditListing(
    [
      {
        data: {
          children: [
            {
              data: {
                id: 'r1',
                author: 'owner',
                title: 'title',
                selftext: 'body',
                url: 'https://i.redd.it/a.jpg',
              },
            },
          ],
        },
      },
    ],
    'https://www.reddit.com/r/test/comments/r1/title/',
  );
  assert.equal(posts[0].post_id, 'r1');
  assert.equal(posts[0].text, 'title\nbody');
  assert.equal(posts[0].media[0].kind, 'image');
}
console.log('ok reddit_adapter');

// --- pinned: a malformed/empty listing yields [], never throws.
{
  const posts = parseRedditListing([{ data: { children: [] } }], 'https://www.reddit.com/r/test/comments/r1/title/');
  assert.deepEqual(posts, []);
}
console.log('ok reddit_parse_empty_listing');

// --- pinned: inspect() fetches the canonical `.json` URL with an explicit,
// honest User-Agent header (politeness/compliance — Ruling 10), not a
// spoofed browser UA.
{
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  const deps = {
    fetchJson: async (url: string, headers: Record<string, string>) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return [
        { data: { children: [{ data: { id: 'r1', author: 'owner', title: 'title', selftext: 'body', url: '' } }] } },
        { data: { children: [] } },
      ];
    },
  };
  const adapter = createRedditAdapter(deps);
  const post = await adapter.inspect(
    'https://www.reddit.com/r/test/comments/r1/title/',
    fakeContext(),
  );
  assert.equal(capturedUrl, 'https://www.reddit.com/r/test/comments/r1/title/.json');
  assert.ok(capturedHeaders['User-Agent'] && capturedHeaders['User-Agent'].length > 0);
  assert.ok(!/mozilla|chrome|webkit/i.test(capturedHeaders['User-Agent']));
  assert.equal(post.post_id, 'r1');
}
console.log('ok reddit_inspect_uses_json_with_honest_user_agent');

// --- pinned: a failed `.json` fetch wraps in AcquisitionError with reason
// 'invalid-response' — NEVER a bare Error, and never 'rate-limited' /
// 'auth-required' / 'challenge' (those trip CIRCUIT_OPENING_REASONS for what
// is here just a CDN/HTTP failure, per Ruling 9).
{
  const deps = {
    fetchJson: async () => {
      throw new Error('network down');
    },
  };
  const adapter = createRedditAdapter(deps);
  try {
    await adapter.inspect('https://www.reddit.com/r/test/comments/r1/title/', fakeContext());
    assert.fail('expected inspect() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    const reason = (error as AcquisitionError).outcome.reason;
    assert.equal(reason, 'invalid-response');
    assert.notEqual(reason, 'rate-limited');
    assert.notEqual(reason, 'auth-required');
    assert.notEqual(reason, 'challenge');
    // no free-text/caught-error-message leakage into the thrown message.
    assert.ok(!(error as Error).message.includes('network down'));
  }
}
console.log('ok reddit_inspect_wraps_fetch_failure');

// --- pinned: collectComments() reuses EXTRACT_JS from scrape_comments_reddit.ts
// verbatim (reference equality) through context.visit(), normalizes the
// plain-numeric `score` likes, and truncates to limits.max. 3 raw comments
// against max=2 exercises the final-slice guard.
{
  const raw = [
    { idx: 0, author: 'alice', text: 'nice', likes_raw: '10' },
    { idx: 1, author: 'bob', text: 'cool', likes_raw: '5' },
    { idx: 2, author: 'carol', text: 'love it', likes_raw: '1' },
  ];
  const fakeClient: any = {
    evaluate: async (expr: string) => {
      if (expr === EXTRACT_JS) return JSON.stringify(raw);
      return 3;
    },
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set()),
  };
  const adapter = createRedditAdapter();
  const comments = await adapter.collectComments(
    'https://www.reddit.com/r/test/comments/r1/title/',
    { max: 2 },
    context,
  );
  assert.equal(comments.length, 2);
  assert.equal(comments[0].likes, 10);
  assert.equal(comments[1].likes, 5);
}
console.log('ok reddit_collect_comments_truncates_to_max');

// --- pinned: captureSocialCard() throws AcquisitionError(reason:'unsupported')
// — crop_post.ts's PLATFORMS map has no 'reddit' key, so no DOM crop exists.
{
  const adapter = createRedditAdapter();
  try {
    await adapter.captureSocialCard(
      'https://www.reddit.com/r/test/comments/r1/title/',
      'post',
      fakeContext(),
    );
    assert.fail('expected captureSocialCard() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal((error as AcquisitionError).outcome.reason, 'unsupported');
  }
}
console.log('ok reddit_capture_social_card_unsupported');

// --- pinned: discover() throws AcquisitionError(reason:'unsupported').
{
  const adapter = createRedditAdapter();
  try {
    await adapter.discover({ platform: 'reddit', kind: 'query', value: 'x', limit: 5 }, fakeContext());
    assert.fail('expected discover() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal((error as AcquisitionError).outcome.reason, 'unsupported');
  }
}
console.log('ok reddit_discover_unsupported');
