/**
 * One installation, one active render, one private dispatch surface.
 *
 * This is not a queue: the renderer holds exactly one execution object, and a
 * second request for a different job is refused outright rather than parked.
 * Nothing here retries, schedules, or remembers a backlog; the control plane
 * owns durability, and this service owns only the render it is running now.
 *
 * Every reply is a fixed code. A path, a command, a stream, or an exception
 * message never leaves this module, in an event or in a response.
 */

import { timingSafeEqual } from "node:crypto";

import type { ExpectedOutput, OutputFacts } from "./artifact-root";
import { ArtifactPathInvalid, ArtifactUnavailable, RendererArtifactRoot, probeWithFfprobe } from "./artifact-root";
import type { RendererConfig } from "./config";
import { loadRendererConfig } from "./config";
import type { RenderBundleAsset } from "./contracts";
import { parseRenderBundle } from "./contracts";
import { ControlPlaneClient } from "./control-plane-client";
import { compositionInputProps, createRemotionEngine } from "./remotion-adapter";

export type RenderStatus =
  | "preparing"
  | "rendering"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type RenderFailureCode =
  | "render_asset_unavailable"
  | "render_bundle_invalid"
  | "render_deadline_exceeded"
  | "render_engine_failed"
  | "render_output_invalid";

/** Exactly the Task 1 event JSON: identity, sequence, status, and safe facts. */
export type RenderEvent = {
  render_job_id: string;
  dispatch_id: string;
  sequence: number;
  status: RenderStatus;
  progress_percent?: number;
  failure_code?: RenderFailureCode;
  output?: OutputFacts;
  occurred_at: string;
};

export type EngineRequest = {
  readonly entryPoint: string;
  readonly outDir: string;
  readonly publicDir: string;
  readonly outputPath: string;
  readonly compositionId: string;
  readonly inputProps: Record<string, unknown>;
  readonly expected: ExpectedOutput;
  readonly onProgress: (percent: number) => void;
  readonly signal: AbortSignal;
};

export type RenderEngine = {
  render(request: EngineRequest): Promise<void>;
};

export type ControlPlanePort = {
  fetchBundle(renderJobId: string): Promise<unknown>;
  publishEvent(event: RenderEvent): Promise<void>;
};

export type ArtifactPort = {
  prepare(renderJobId: string): Promise<void>;
  verifyStagedAssets(renderJobId: string, assets: readonly RenderBundleAsset[]): Promise<void>;
  assetsDirectory(renderJobId: string): string;
  bundleDirectory(renderJobId: string): string;
  temporaryOutput(renderJobId: string): string;
  removeTemporaryOutput(renderJobId: string): Promise<void>;
  verifyTemporaryOutput(renderJobId: string, expected: ExpectedOutput): Promise<OutputFacts>;
};

export type ExecutionDeps = {
  readonly config: RendererConfig;
  readonly client: ControlPlanePort;
  readonly artifacts: ArtifactPort;
  readonly engine: RenderEngine;
  readonly now: () => Date;
};

export type ActiveRender = { readonly render_job_id: string; readonly dispatch_id: string };

export type RendererExecution = {
  start(renderJobId: string, dispatchId: string): Promise<void>;
  cancel(renderJobId: string): Promise<void>;
  status(): { active: ActiveRender | null };
  /** Resolve once the render this service owns has finished reporting. */
  whenIdle(): Promise<void>;
};

export class RendererBusy extends Error {
  readonly code = "render_busy";

  constructor() {
    super("render busy");
    this.name = "RendererBusy";
  }
}

/** Identical to the control plane's `OpaqueId`: one safe segment, never a path. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
/** Report a step, not every frame: progress is a signal, not a stream. */
const PROGRESS_STEP = 10;

type AbortReason = "cancel" | "deadline";
type Stage = "preparing" | "rendering" | "finalizing";

export function createExecution(deps: ExecutionDeps): RendererExecution {
  let active: ActiveRender | null = null;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let reason: AbortReason | null = null;

  async function execute(renderJobId: string, dispatchId: string): Promise<void> {
    let sequence = 0;
    let terminal = false;
    let reported = -1;
    let stage: Stage = "preparing";
    const signal = controller!.signal;

    const publish = async (
      status: RenderStatus,
      extra: Partial<RenderEvent> = {},
    ): Promise<void> => {
      if (terminal) {
        return;
      }
      sequence += 1;
      const event: RenderEvent = {
        render_job_id: renderJobId,
        dispatch_id: dispatchId,
        sequence,
        status,
        occurred_at: deps.now().toISOString(),
        ...extra,
      };
      try {
        await deps.client.publishEvent(event);
      } catch {
        // The control plane's own deadline closes a job it stops hearing about;
        // a report that cannot be delivered is not worth failing the render for.
      }
    };

    try {
      await publish("preparing");

      const bundle = parseRenderBundle(await deps.client.fetchBundle(renderJobId));
      // The control plane already binds each bundle to its job and dispatch;
      // this only refuses to spend a render on a document it did not ask for.
      if (bundle.render_job_id !== renderJobId) {
        throw new ArtifactPathInvalid();
      }
      await deps.artifacts.prepare(renderJobId);
      await deps.artifacts.verifyStagedAssets(renderJobId, bundle.assets);

      const expected: ExpectedOutput = {
        width: bundle.width,
        height: bundle.height,
        fps: bundle.fps,
        durationInFrames: bundle.duration_in_frames,
      };

      stage = "rendering";
      reported = 0;
      await publish("rendering", { progress_percent: 0 });

      // A cancel that arrived during preparation must not start a browser.
      if (signal.aborted) {
        throw new Error("render aborted");
      }
      await deps.engine.render({
        entryPoint: deps.config.compositionEntryPoint,
        outDir: deps.artifacts.bundleDirectory(renderJobId),
        publicDir: deps.artifacts.assetsDirectory(renderJobId),
        outputPath: deps.artifacts.temporaryOutput(renderJobId),
        compositionId: bundle.composition_id,
        inputProps: compositionInputProps(bundle),
        expected,
        signal,
        onProgress: (percent: number) => {
          if (terminal || !Number.isFinite(percent)) {
            return;
          }
          const bounded = Math.round(percent);
          if (bounded < 0 || bounded > 100 || bounded < reported + PROGRESS_STEP) {
            return;
          }
          reported = bounded;
          void publish("rendering", { progress_percent: bounded });
        },
      });
      if (signal.aborted) {
        throw new Error("render aborted");
      }

      stage = "finalizing";
      await publish("finalizing");
      const output = await deps.artifacts.verifyTemporaryOutput(renderJobId, expected);

      terminal = true;
      sequence += 1;
      await deps.client.publishEvent({
        render_job_id: renderJobId,
        dispatch_id: dispatchId,
        sequence,
        status: "completed",
        output,
        occurred_at: deps.now().toISOString(),
      });
    } catch (error) {
      const closing = closingEvent(stage, error, reason);
      terminal = true;
      sequence += 1;
      await safely(() => deps.artifacts.removeTemporaryOutput(renderJobId));
      await safely(() =>
        deps.client.publishEvent({
          render_job_id: renderJobId,
          dispatch_id: dispatchId,
          sequence,
          status: closing.status,
          ...(closing.failure_code ? { failure_code: closing.failure_code } : {}),
          occurred_at: deps.now().toISOString(),
        }),
      );
    }
  }

  return {
    async start(renderJobId: string, dispatchId: string): Promise<void> {
      if (!IDENTIFIER.test(renderJobId) || !IDENTIFIER.test(dispatchId)) {
        throw new RendererBusy();
      }
      if (active) {
        // A repeated dispatch of the running render is the same request; any
        // other identity is refused rather than remembered.
        if (active.render_job_id === renderJobId && active.dispatch_id === dispatchId) {
          return;
        }
        throw new RendererBusy();
      }

      active = { render_job_id: renderJobId, dispatch_id: dispatchId };
      controller = new AbortController();
      reason = null;
      const deadline = setTimeout(() => {
        reason = "deadline";
        controller?.abort();
      }, deps.config.deadlineSeconds * 1000);

      running = (async () => {
        try {
          await execute(renderJobId, dispatchId);
        } finally {
          clearTimeout(deadline);
          active = null;
          controller = null;
          running = null;
        }
      })();
    },

    async cancel(renderJobId: string): Promise<void> {
      if (active?.render_job_id !== renderJobId) {
        return;
      }
      reason = "cancel";
      controller?.abort();
    },

    status(): { active: ActiveRender | null } {
      return { active };
    },

    whenIdle(): Promise<void> {
      return running ?? Promise.resolve();
    },
  };
}

function closingEvent(
  stage: Stage,
  error: unknown,
  reason: AbortReason | null,
): { status: RenderStatus; failure_code?: RenderFailureCode } {
  if (reason === "cancel") {
    return { status: "cancelled" };
  }
  if (reason === "deadline") {
    return { status: "failed", failure_code: "render_deadline_exceeded" };
  }
  if (stage === "preparing") {
    const missing = error instanceof ArtifactUnavailable || error instanceof ArtifactPathInvalid;
    return {
      status: "failed",
      failure_code: missing ? "render_asset_unavailable" : "render_bundle_invalid",
    };
  }
  return {
    status: "failed",
    failure_code: stage === "rendering" ? "render_engine_failed" : "render_output_invalid",
  };
}

async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Closing a render must not fail on the way out.
  }
}

/** Compare the shared internal credential without revealing its length. */
export function credentialMatches(expected: string, provided: string | null): boolean {
  if (provided === null) {
    return false;
  }
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  // timingSafeEqual needs equal lengths, so compare a fixed-width digest of
  // each side's bytes instead of branching on the length itself.
  const width = Math.max(left.length, right.length);
  const padded = (value: Buffer): Buffer => Buffer.concat([value], width);
  return timingSafeEqual(padded(left), padded(right)) && left.length === right.length;
}

const DISPATCH_ROUTE = /^\/internal\/render-jobs\/([^/]+)\/(start|cancel)$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function createFetchHandler(
  execution: RendererExecution,
  credential: string,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { status: "ok" });
    }

    const header = request.headers.get("Authorization");
    const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!credentialMatches(credential, presented)) {
      return json(401, { code: "renderer_unauthorized" });
    }

    const route = request.method === "POST" ? DISPATCH_ROUTE.exec(url.pathname) : null;
    if (!route) {
      return json(404, { code: "renderer_route_unknown" });
    }
    const [, renderJobId, action] = route as unknown as [string, string, "start" | "cancel"];
    if (!IDENTIFIER.test(renderJobId)) {
      return json(422, { code: "renderer_request_invalid" });
    }

    if (action === "cancel") {
      await execution.cancel(renderJobId);
      return json(202, { accepted: true });
    }

    const dispatchId = await dispatchIdentity(request);
    if (dispatchId === null) {
      return json(422, { code: "renderer_request_invalid" });
    }
    try {
      await execution.start(renderJobId, dispatchId);
    } catch (error) {
      if (error instanceof RendererBusy) {
        return json(409, { code: "render_busy" });
      }
      return json(422, { code: "renderer_request_invalid" });
    }
    return json(202, { accepted: true });
  };
}

/** A start carries one bounded dispatch identity and nothing else. */
async function dispatchIdentity(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body);
  const dispatchId = (body as { dispatch_id?: unknown }).dispatch_id;
  if (keys.length !== 1 || typeof dispatchId !== "string" || !IDENTIFIER.test(dispatchId)) {
    return null;
  }
  return dispatchId;
}

if (import.meta.main) {
  const config = loadRendererConfig(process.env);
  const execution = createExecution({
    config,
    client: new ControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      credential: config.credential,
    }),
    artifacts: new RendererArtifactRoot(config.artifactRoot, { probe: probeWithFfprobe }),
    engine: createRemotionEngine(),
    now: () => new Date(),
  });

  Bun.serve({
    port: config.port,
    // The renderer is reachable only on the private network, never published.
    hostname: "0.0.0.0",
    fetch: createFetchHandler(execution, config.credential),
  });
}
