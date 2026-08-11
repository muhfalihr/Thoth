import type { AcquisitionIntent, AcquisitionOutcome, Platform } from './types.ts';
import { AcquisitionError } from './types.ts';
import { canonicalizeUrl } from './url.ts';

const CIRCUIT_OPENING_REASONS = new Set(['rate-limited', 'auth-required', 'challenge']);
const INVALID_RESPONSE_THRESHOLD = 2;

interface UrlState {
  intents: Set<AcquisitionIntent>;
  started: boolean;
  promise?: Promise<unknown>;
  purpose?: string;
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
  // required, not optional: visitOnce()'s memoization key is the canonical URL
  // ALONE, so without a purpose check a second, unrelated consumer visiting
  // the same URL would silently receive the FIRST consumer's result — same
  // canonical URL, different (and wrong) payload shape. That aliasing is the
  // Task 16 fix-round-1 defect (browser_coordinator.ts:74-76 in the original
  // report): itemFrame()'s browse() cached a frame object under a post URL,
  // then inspectPost()'s adapter.inspect() visited the SAME URL expecting a
  // PostRecord and silently got the frame object back instead, force-cast
  // through `as Promise<T>`. See discover_reels.ts for how the real call site
  // was fixed once this could no longer alias in silence.
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
    const state = this.stateFor(canonicalUrl);
    if (state.started && state.promise) {
      if (state.purpose !== purpose) {
        // Same URL, different purpose, visit already in flight or done: this
        // is exactly the aliasing shape above. Refuse loudly instead of
        // returning the (differently-typed) cached promise — and do NOT
        // navigate again either; the "at most one navigation per canonical
        // post URL per run" rule is not being relaxed to work around this.
        return Promise.reject(
          new Error(
            `browser coordinator: ${canonicalUrl} was already visited for purpose ` +
              `"${state.purpose}" — refusing to alias that result for purpose "${purpose}" ` +
              `(and refusing a second navigation to serve it)`,
          ),
        );
      }
      return state.promise as Promise<T>;
    }

    state.started = true;
    state.purpose = purpose;
    const promise = this.enqueue(acquire).catch((error: unknown) => {
      // A failed visit must not permanently poison the URL (Ruling 2): clear
      // the cached state so a later visitOnce() for the same URL can retry.
      // A resolved visit stays cached for the rest of the run — "at most one
      // navigation per canonical post URL per run" only holds for successes.
      if (state.promise === promise) {
        state.promise = undefined;
        state.started = false;
        state.purpose = undefined;
      }
      throw error;
    });
    state.promise = promise;
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
