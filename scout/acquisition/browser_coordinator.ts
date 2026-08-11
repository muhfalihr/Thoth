import type { AcquisitionIntent, AcquisitionOutcome, Platform } from './types.ts';
import { AcquisitionError } from './types.ts';
import { canonicalizeUrl } from './url.ts';

const CIRCUIT_OPENING_REASONS = new Set(['rate-limited', 'auth-required', 'challenge']);
const INVALID_RESPONSE_THRESHOLD = 2;

interface UrlState {
  intents: Set<AcquisitionIntent>;
  // True once ANY purpose has begun visiting this URL. Only gates registerIntent;
  // the navigation budget itself lives in `visits`, keyed per (url, purpose).
  started: boolean;
}

interface VisitState {
  started: boolean;
  promise?: Promise<unknown>;
}

/**
 * Run-scoped, in-memory coordinator: serializes all browser navigations
 * globally (one at a time), deduplicates concurrent visits to the same
 * canonical URL, and trips a per-platform circuit breaker on outcomes that
 * indicate the platform is rate-limiting, challenging, or otherwise
 * rejecting us. Pure in-memory bookkeeping — no CDP, no network, no I/O.
 */
export class BrowserCoordinator {
  private readonly urls = new Map<string, UrlState>();
  // Keyed `${canonicalUrl}::${purpose}` — the navigation budget is per (url, purpose).
  private readonly visits = new Map<string, VisitState>();
  private readonly blocked = new Map<Platform, AcquisitionOutcome>();
  private readonly invalidResponseStreak = new Map<Platform, number>();
  private tail: Promise<void> = Promise.resolve();

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private stateFor(canonicalUrl: string): UrlState {
    let state = this.urls.get(canonicalUrl);
    if (!state) {
      state = { intents: new Set(), started: false };
      this.urls.set(canonicalUrl, state);
    }
    return state;
  }

  private visitFor(canonicalUrl: string, purpose: string): VisitState {
    const key = `${canonicalUrl}::${purpose}`;
    let visit = this.visits.get(key);
    if (!visit) {
      visit = { started: false };
      this.visits.set(key, visit);
    }
    return visit;
  }

  registerIntent(url: string, intent: AcquisitionIntent): void {
    const canonicalUrl = canonicalizeUrl(url);
    const state = this.stateFor(canonicalUrl);
    if (state.started) {
      throw new Error(
        `cannot register intent "${intent}" for ${canonicalUrl}: visit already started`,
      );
    }
    state.intents.add(intent);
  }

  intents(url: string): ReadonlySet<AcquisitionIntent> {
    const canonicalUrl = canonicalizeUrl(url);
    return this.urls.get(canonicalUrl)?.intents ?? new Set();
  }

  // `purpose` is a short stable label identifying WHAT the caller is visiting
  // this URL for ('inspect', 'comments', 'social-card', 'ig-grid', ...). It is
  // required, not optional, and it is PART OF THE MEMO KEY.
  //
  // Two rules are in tension here and the key resolves both:
  //
  //  1. Never alias one purpose's result to another purpose's caller. Keyed by
  //     canonical URL alone, itemFrame()'s browse() cached a frame object under
  //     a post URL, then inspectPost()'s adapter.inspect() visited the SAME URL
  //     expecting a PostRecord and silently got the frame object back instead,
  //     force-cast through `as Promise<T>`. Distinct purposes now hold distinct
  //     memo entries, so that cross-typed hand-off cannot occur at all.
  //
  //  2. Don't re-navigate redundantly. The budget is ONE navigation per
  //     (canonical URL, purpose) per run — not one per URL. The stricter
  //     per-URL form was tried and is not implementable: the pipeline has to
  //     inspect a post AND scrape its comments, and discovery has to visit a
  //     profile for both reels and the post grid. Refusing the second purpose
  //     did not prevent a navigation, it just lost the data — seed-post
  //     comments and all Instagram curator discovery, silently, because both
  //     callers sit in required:false stages. Repeat work for the SAME purpose
  //     is still deduped, which is what the rule was protecting against.
  visitOnce<T>(
    platform: Platform,
    url: string,
    purpose: string,
    acquire: () => Promise<T>,
  ): Promise<T> {
    const blockedOutcome = this.blocked.get(platform);
    if (blockedOutcome) {
      return Promise.reject(
        new AcquisitionError(
          `browser coordinator: ${platform} circuit is open (${blockedOutcome.reason})`,
          blockedOutcome,
        ),
      );
    }

    const canonicalUrl = canonicalizeUrl(url);
    // `started` on the URL gates registerIntent() only. Intents describe what the
    // run wants from a post and are meant to be declared up front, so the first
    // navigation for ANY purpose closes registration.
    this.stateFor(canonicalUrl).started = true;

    const visit = this.visitFor(canonicalUrl, purpose);
    // Same URL AND same purpose, already in flight or done: hand back the memo.
    // The result type matches by construction, because the purpose is in the key.
    if (visit.started && visit.promise) return visit.promise as Promise<T>;

    visit.started = true;
    const promise = this.enqueue(acquire).catch((error: unknown) => {
      // A failed visit must not permanently poison the URL (Ruling 2): clear
      // the cached state so a later visitOnce() for the same (url, purpose) can
      // retry. A resolved visit stays cached for the rest of the run — the
      // one-navigation-per-(url, purpose) budget only holds for successes.
      if (visit.promise === promise) {
        visit.promise = undefined;
        visit.started = false;
      }
      throw error;
    });
    visit.promise = promise;
    return promise;
  }

  recordOutcome(platform: Platform, outcome: AcquisitionOutcome): void {
    if (outcome.reason && CIRCUIT_OPENING_REASONS.has(outcome.reason)) {
      this.blocked.set(platform, outcome);
      return;
    }

    if (outcome.reason === 'invalid-response') {
      const streak = (this.invalidResponseStreak.get(platform) ?? 0) + 1;
      this.invalidResponseStreak.set(platform, streak);
      if (streak >= INVALID_RESPONSE_THRESHOLD) {
        this.blocked.set(platform, outcome);
      }
      return;
    }

    if (outcome.status === 'resolved') {
      this.invalidResponseStreak.set(platform, 0);
    }
  }

  isBlocked(platform: Platform): boolean {
    return this.blocked.has(platform);
  }

  blockedOutcome(platform: Platform): AcquisitionOutcome | undefined {
    return this.blocked.get(platform);
  }
}
