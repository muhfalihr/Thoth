import assert from 'node:assert/strict';
import { EXTRACT_JS } from '../../scrapers/scrape_comments_fb.ts';
import { AcquisitionError } from '../types.ts';
import { createFacebookAdapter, parseFacebookPost } from './facebook.ts';

function fakeContext(intents: string[] = []): any {
  return {
    intents: () => new Set(intents),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire({} as any, new Set(intents)),
  };
}

// --- pinned: parseFacebookPost() extracts post_id/owner/text/media from a
// captured GraphQL body (brief's exact fixture).
{
  const post = parseFacebookPost(
    JSON.stringify({
      data: {
        post_id: 'f1',
        actors: [{ name: 'Owner' }],
        message: { text: 'message' },
        attachments: [{ media: { image: { uri: 'https://cdn.test/f.jpg' } } }],
      },
    }),
    'https://www.facebook.com/owner/posts/f1',
  );
  assert.equal(post?.post_id, 'f1');
  assert.equal(post?.owner_handle, 'Owner');
  assert.equal(post?.text, 'message');
  assert.equal(post?.media[0].kind, 'image');
}
console.log('ok facebook_adapter');

// --- pinned: a body with no matching post node returns null, never throws.
{
  const post = parseFacebookPost('{"data":{"unrelated":true}}', 'https://www.facebook.com/owner/posts/f1');
  assert.equal(post, null);
}
console.log('ok facebook_parse_returns_null_when_absent');

// --- pinned: collectComments() drives EXTRACT_JS (reference-identical to
// scrape_comments_fb.ts's export — no re-implemented selector) through
// context.visit(), normalizes likes, and truncates to limits.max. Fixture has
// 3 raw comments against max=2 so the final slice guard is actually exercised
// (Ruling 2's "fixture size == max never proves the guard" concern).
{
  const raw = [
    { idx: 0, author: 'alice', text: 'nice', likes_raw: '', avatar_url: '' },
    { idx: 1, author: 'bob', text: 'cool', likes_raw: '', avatar_url: '' },
    { idx: 2, author: 'carol', text: 'love it', likes_raw: '', avatar_url: '' },
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
  const adapter = createFacebookAdapter();
  const comments = await adapter.collectComments(
    'https://www.facebook.com/owner/posts/f1',
    { max: 2 },
    context,
  );
  assert.equal(comments.length, 2);
  assert.equal(comments[0].author, 'alice');
  assert.equal(comments[1].author, 'bob');
}
console.log('ok facebook_collect_comments_truncates_to_max');

// --- pinned: discover() throws AcquisitionError(reason:'unsupported'),
// never a bare Error, for the kinds this adapter does not implement.
{
  const adapter = createFacebookAdapter();
  try {
    await adapter.discover({ platform: 'facebook', kind: 'query', value: 'x', limit: 5 }, fakeContext());
    assert.fail('expected discover() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal((error as AcquisitionError).outcome.reason, 'unsupported');
  }
}
console.log('ok facebook_discover_unsupported');
