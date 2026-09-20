/**
 * The private, credentialed transport back to the control plane.
 *
 * One action is exactly one request: no redirect is followed, no retry is made,
 * and no transport detail survives. Every failure becomes the same fixed error,
 * so an address, a credential, or a driver message can never reach a log line
 * or an event body.
 */

/** Identical to the control plane's `OpaqueId`: one safe segment, never a path. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
/** A bundle is one document revision and its staged names; far below this. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export class ControlPlaneUnavailable extends Error {
  constructor() {
    super("control plane unavailable");
    this.name = "ControlPlaneUnavailable";
  }
}

export type FetchImpl = (request: Request) => Promise<Response>;

export class ControlPlaneClient {
  readonly #baseUrl: string;
  readonly #credential: string;
  readonly #fetch: FetchImpl;

  constructor(options: { baseUrl: string; credential: string; fetchImpl?: FetchImpl }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#credential = options.credential;
    this.#fetch = options.fetchImpl ?? ((request) => fetch(request));
  }

  /** Read the immutable bundle staged for exactly this job. */
  async fetchBundle(renderJobId: string): Promise<unknown> {
    const response = await this.#send(this.#url(renderJobId, "bundle"), { method: "GET" });
    const text = await this.#bounded(response);
    try {
      return JSON.parse(text);
    } catch {
      throw new ControlPlaneUnavailable();
    }
  }

  /** Report one sequenced event; the control plane decides what it means. */
  async publishEvent(event: unknown): Promise<void> {
    const response = await this.#send(this.#url(this.#jobOf(event), "events"), {
      method: "POST",
      body: JSON.stringify(event),
    });
    await this.#bounded(response);
  }

  #jobOf(event: unknown): string {
    const identity = (event as { render_job_id?: unknown }).render_job_id;
    return typeof identity === "string" ? identity : "";
  }

  #url(renderJobId: string, action: string): string {
    if (!IDENTIFIER.test(renderJobId)) {
      throw new ControlPlaneUnavailable();
    }
    return `${this.#baseUrl}/internal/render-jobs/${renderJobId}/${action}`;
  }

  async #send(url: string, init: { method: string; body?: string }): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(
        new Request(url, {
          method: init.method,
          body: init.body,
          headers: {
            Authorization: `Bearer ${this.#credential}`,
            "Content-Type": "application/json",
          },
          // A private route never moves: following one would send the internal
          // credential to whatever host answered.
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      );
    } catch {
      throw new ControlPlaneUnavailable();
    }
    if (!response.ok) {
      throw new ControlPlaneUnavailable();
    }
    return response;
  }

  async #bounded(response: Response): Promise<string> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ControlPlaneUnavailable();
    }
    if (text.length > MAX_BUNDLE_BYTES) {
      throw new ControlPlaneUnavailable();
    }
    return text;
  }
}
