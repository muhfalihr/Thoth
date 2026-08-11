import assert from 'node:assert/strict';
import { BrowserCoordinator } from './browser_coordinator.ts';

const coordinator = new BrowserCoordinator();
const url = 'https://www.instagram.com/p/ABC/?utm_source=test';
coordinator.registerIntent(url, 'inspect');
coordinator.registerIntent(url, 'social-card');
assert.deepEqual([...coordinator.intents(url)].sort(), ['inspect', 'social-card']);

let active = 0;
let maxActive = 0;
let visits = 0;
const acquire = async () => {
  visits++;
  active++;
  maxActive = Math.max(maxActive, active);
  await Promise.resolve();
  active--;
  return { value: visits };
};
const [first, second] = await Promise.all([
  coordinator.visitOnce('instagram', url, 'inspect', acquire),
  coordinator.visitOnce('instagram', url, 'inspect', acquire),
]);
assert.equal(first.value, 1);
assert.equal(second.value, 1);
assert.equal(visits, 1);
assert.equal(maxActive, 1);

const serialized = new BrowserCoordinator();
let globalActive = 0;
let globalMax = 0;
const distinctVisit = async () => {
  globalActive++;
  globalMax = Math.max(globalMax, globalActive);
  await new Promise((resolve) => setTimeout(resolve, 1));
  globalActive--;
  return true;
};
serialized.registerIntent('https://x.com/a/status/1', 'inspect');
serialized.registerIntent('https://www.instagram.com/p/TWO/', 'inspect');
await Promise.all([
  serialized.visitOnce('twitter', 'https://x.com/a/status/1', 'inspect', distinctVisit),
  serialized.visitOnce('instagram', 'https://www.instagram.com/p/TWO/', 'inspect', distinctVisit),
]);
assert.equal(globalMax, 1);

coordinator.recordOutcome('instagram', {
  status: 'blocked',
  reason: 'rate-limited',
  attempts: 1,
  elapsed_ms: 5,
});
assert.equal(coordinator.isBlocked('instagram'), true);
await assert.rejects(
  coordinator.visitOnce('instagram', 'https://www.instagram.com/p/NEW/', 'inspect', acquire),
  /rate-limited/,
);

const malformed = new BrowserCoordinator();
malformed.recordOutcome('twitter', {
  status: 'unavailable',
  reason: 'invalid-response',
  attempts: 1,
  elapsed_ms: 1,
});
assert.equal(malformed.isBlocked('twitter'), false);
malformed.recordOutcome('twitter', {
  status: 'unavailable',
  reason: 'invalid-response',
  attempts: 1,
  elapsed_ms: 1,
});
assert.equal(malformed.isBlocked('twitter'), true);
console.log('ok browser_coordinator');

// --- Additional assertions beyond the brief ---

// registerIntent() must reject late registration once visitOnce() has started
// for that canonical URL.
const lateRegistration = new BrowserCoordinator();
const lateUrl = 'https://www.tiktok.com/@user/video/1';
lateRegistration.registerIntent(lateUrl, 'inspect');
let releaseLateVisit: (() => void) | undefined;
const lateVisitStarted = new Promise<void>((resolveStarted) => {
  const lateVisitPromise = lateRegistration.visitOnce('tiktok', lateUrl, 'inspect', async () => {
    resolveStarted();
    await new Promise<void>((resolve) => {
      releaseLateVisit = resolve;
    });
    return true;
  });
  void lateVisitPromise;
});
await lateVisitStarted;
assert.throws(() => lateRegistration.registerIntent(lateUrl, 'media'), /already started/i);
releaseLateVisit?.();

// recordOutcome() with a resolved outcome resets the invalid-response counter,
// so a single invalid-response after a resolved one does not open the circuit.
const resetCounter = new BrowserCoordinator();
resetCounter.recordOutcome('facebook', {
  status: 'unavailable',
  reason: 'invalid-response',
  attempts: 1,
  elapsed_ms: 1,
});
resetCounter.recordOutcome('facebook', {
  status: 'resolved',
  attempts: 1,
  elapsed_ms: 1,
});
resetCounter.recordOutcome('facebook', {
  status: 'unavailable',
  reason: 'invalid-response',
  attempts: 1,
  elapsed_ms: 1,
});
assert.equal(resetCounter.isBlocked('facebook'), false);

// recordOutcome() never opens the circuit for materialization-failed, no matter
// how many times it recurs.
const materializationFailures = new BrowserCoordinator();
materializationFailures.recordOutcome('youtube', {
  status: 'unavailable',
  reason: 'materialization-failed',
  attempts: 1,
  elapsed_ms: 1,
});
materializationFailures.recordOutcome('youtube', {
  status: 'unavailable',
  reason: 'materialization-failed',
  attempts: 1,
  elapsed_ms: 1,
});
assert.equal(materializationFailures.isBlocked('youtube'), false);

// blockedOutcome() surfaces the outcome that tripped the circuit.
const blockedOutcomeCoordinator = new BrowserCoordinator();
blockedOutcomeCoordinator.recordOutcome('reddit', {
  status: 'blocked',
  reason: 'challenge',
  attempts: 2,
  elapsed_ms: 9,
});
assert.equal(blockedOutcomeCoordinator.blockedOutcome('reddit')?.reason, 'challenge');
assert.equal(blockedOutcomeCoordinator.blockedOutcome('twitter'), undefined);

// A failed visitOnce() does not poison the URL: a later visitOnce() for the same
// canonical URL can retry and succeed (Ruling 2: failed visits are retryable;
// successful visits stay cached for the rest of the run).
const retryCoordinator = new BrowserCoordinator();
const retryUrl = 'https://www.reddit.com/r/test/comments/abc/post/';
let retryAttempts = 0;
await assert.rejects(
  retryCoordinator.visitOnce('reddit', retryUrl, 'inspect', async () => {
    retryAttempts++;
    throw new Error('boom');
  }),
  /boom/,
);
const retryResult = await retryCoordinator.visitOnce('reddit', retryUrl, 'inspect', async () => {
  retryAttempts++;
  return 'recovered';
});
assert.equal(retryResult, 'recovered');
assert.equal(retryAttempts, 2);

// A resolved visit stays cached for the rest of the run: a second visitOnce()
// for the same canonical URL after success does NOT invoke acquire again.
const cachedCoordinator = new BrowserCoordinator();
const cachedUrl = 'https://www.youtube.com/watch?v=ABC123';
let cachedAttempts = 0;
const cachedFirst = await cachedCoordinator.visitOnce('youtube', cachedUrl, 'inspect', async () => {
  cachedAttempts++;
  return 'first';
});
const cachedSecond = await cachedCoordinator.visitOnce(
  'youtube',
  cachedUrl,
  'inspect',
  async () => {
    cachedAttempts++;
    return 'second';
  },
);
assert.equal(cachedFirst, 'first');
assert.equal(cachedSecond, 'first');
assert.equal(cachedAttempts, 1);

// Same URL, DIFFERENT purpose: the cached promise belongs to the first purpose and is a
// different payload shape entirely, so handing it back (through visitOnce's `as Promise<T>`)
// silently mistypes the second caller's result. Refuse, naming both purposes — and do not
// navigate a second time either (one navigation per canonical URL per run still holds).
const aliasCoordinator = new BrowserCoordinator();
const aliasUrl = 'https://www.instagram.com/p/ABC123/';
let aliasAttempts = 0;
const aliasFirst = await aliasCoordinator.visitOnce(
  'instagram',
  aliasUrl,
  'ig-item-frame',
  async () => {
    aliasAttempts++;
    return { frameB64: 'aGk=' };
  },
);
assert.deepEqual(aliasFirst, { frameB64: 'aGk=' });
await assert.rejects(
  aliasCoordinator.visitOnce('instagram', aliasUrl, 'inspect', async () => {
    aliasAttempts++;
    return { post_id: 'ABC123' };
  }),
  (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /ig-item-frame/);
    assert.match(message, /inspect/);
    assert.match(message, /ABC123/);
    return true;
  },
);
// The refusal must not have navigated again to serve the second purpose.
assert.equal(aliasAttempts, 1);

console.log('ok browser_coordinator additional assertions');
