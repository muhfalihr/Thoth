// Regression: runCollectComments() must survive registerIntent() throwing for a URL whose visit
// already started. run_pipeline's inspectSeed() navigates the seed URL before this stage runs, and
// buildCommentSources() always feeds that same URL back in as a source — so on IG/X/FB/Reddit the
// very first registerIntent() call in the stage throws. Unguarded, that escapes runCollectComments()
// entirely and loses comments from EVERY source (the stage is required:false, so it degrades to a
// warning: silent data loss, not a crash).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCollectComments } from './collect_comments.ts';

const SEED = 'https://x.com/owner/status/1';
const OTHER = 'https://x.com/owner/status/2';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-intents-')), 'set.json');
fs.writeFileSync(
  file,
  JSON.stringify({ main: { url: SEED, title: 't' }, footage: [{ url: OTHER }], comments: [] }),
  'utf8',
);

const started = new Set([SEED]); // seed already visited this run, exactly as inspectSeed leaves it
const registered: string[] = [];
const browsed: string[] = [];

const service = {
  registerIntent(url: string, intent: string) {
    if (started.has(url)) {
      throw new Error(`cannot register intent "${intent}" for ${url}: visit already started`);
    }
    registered.push(`${url}|${intent}`);
  },
  async browse(_platform: string, url: string) {
    browsed.push(url);
    return [{ author: 'a', text: `comment for ${url}`, likes: 1 }];
  },
  async collectComments(url: string) {
    browsed.push(url);
    return [{ author: 'a', text: `comment for ${url}`, likes: 1 }];
  },
};

await runCollectComments({ file, perSource: 2, cap: 10, maxSources: 5, extra: [] }, {
  service,
} as never);

// The stage completed rather than aborting on the seed's throw...
const written = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.ok(written.comments.length > 0, 'stage aborted: no comments written');

// ...and it still collected from the seed, whose intents were already registered by the caller
// that navigated it. Losing THIS is the regression: an unguarded loop throws before any source is
// collected, so `browsed` would be empty.
assert.ok(browsed.includes(SEED), `seed never collected; browsed=${JSON.stringify(browsed)}`);

// Sources that had NOT been visited still get their intents registered — the guard must swallow
// only the already-started throw, not skip registration wholesale.
assert.ok(
  registered.includes(`${OTHER}|comments`) && registered.includes(`${OTHER}|social-card`),
  `unvisited source lost its intents; registered=${JSON.stringify(registered)}`,
);

console.log('ok collect_comments_intents');
