import type { AcquisitionIntent, AcquisitionOutcome, Platform } from './types.ts';
import { AcquisitionError } from './types.ts';
import { canonicalizeUrl } from './url.ts';

const CIRCUIT_OPENING_REASONS = new Set(['rate-limited', 'auth-required', 'challenge']);
const INVALID_RESPONSE_THRESHOLD = 2;

interface UrlState {
  intents: Set<AcquisitionIntent>;
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

  visitOnce<T>(platform: Platform, url: string, acquire: () => Promise<T>): Promise<T> {
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
      return state.promise as Promise<T>;
    }

    state.started = true;
    const promise = this.enqueue(acquire).catch((error: unknown) => {
      // A failed visit must not permanently poison the URL (Ruling 2): clear
      // the cached state so a later visitOnce() for the same URL can retry.
      // A resolved visit stays cached for the rest of the run — "at most one
      // navigation per canonical post URL per run" only holds for successes.
      if (state.promise === promise) {
        state.promise = undefined;
        state.started = false;
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
