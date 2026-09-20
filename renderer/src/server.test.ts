import { describe, expect, test } from "bun:test";

import { ArtifactUnavailable } from "./artifact-root";
import type { RendererConfig } from "./config";
import { RenderBundleInvalid } from "./contracts";
import {
  type EngineRequest,
  type RenderEvent,
  createExecution,
  createFetchHandler,
  credentialMatches,
} from "./server";

const CREDENTIAL = "internal-credential-value";

const CONFIG: RendererConfig = {
  port: 8080,
  credential: CREDENTIAL,
  controlPlaneUrl: "http://api:8000",
  artifactRoot: "/srv/artifacts",
  rendererVersion: "remotion-4.0.523",
  deadlineSeconds: 900,
  compositionEntryPoint: "/app/packages/remotion-composition/src/register.tsx",
};

const BUNDLE = {
  bundle_version: 1,
  render_job_id: "rj_001",
  project_id: "project_001",
  document_id: "doc_001",
  document_revision: 3,
  dispatch_id: "dsp_001",
  document: {
    schema_version: 2,
    document_id: "doc_001",
    project_id: "project_001",
    revision: 3,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
    template: { template_id: "vertical_text_story", version: 1 },
    scenes: [],
    tracks: [],
  },
  template_id: "vertical_text_story",
  template_version: 1,
  preset_id: "standard_vertical_mp4_v1",
  renderer_version: "remotion-4.0.523",
  composition_id: "advanced_timeline_v1",
  width: 1080,
  height: 1920,
  fps: 30,
  duration_in_frames: 300,
  assets: [],
};

const FACTS = {
  media_type: "video/mp4",
  size_bytes: 2048,
  checksum: `sha256:${"b".repeat(64)}`,
  codec: "h264",
  width: 1080,
  height: 1920,
  fps: 30,
  duration_seconds: 10,
  has_audio: false,
} as const;

type Harness = ReturnType<typeof harness>;

function harness(
  options: {
    bundle?: unknown;
    bundleError?: Error;
    assetError?: Error;
    outputError?: Error;
    render?: (request: EngineRequest) => Promise<void>;
    config?: Partial<RendererConfig>;
  } = {},
) {
  const events: RenderEvent[] = [];
  const removed: string[] = [];
  const requests: EngineRequest[] = [];
  let release = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  let begin = () => {};
  /** Resolves once the engine has actually been handed a render to run. */
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });

  const execution = createExecution({
    config: { ...CONFIG, ...options.config },
    now: () => new Date("2026-09-20T10:00:00.000Z"),
    client: {
      fetchBundle: async (renderJobId: string) => {
        if (options.bundleError) {
          throw options.bundleError;
        }
        // The control plane serves each bundle from the job's own route.
        return options.bundle ?? { ...BUNDLE, render_job_id: renderJobId };
      },
      publishEvent: async (event: RenderEvent) => {
        events.push(event);
      },
    },
    artifacts: {
      prepare: async () => {},
      verifyStagedAssets: async () => {
        if (options.assetError) {
          throw options.assetError;
        }
      },
      assetsDirectory: (job: string) => `/srv/artifacts/work/${job}/assets`,
      bundleDirectory: (job: string) => `/srv/artifacts/temp/${job}/bundle`,
      temporaryOutput: (job: string) => `/srv/artifacts/temp/${job}/output.mp4`,
      removeTemporaryOutput: async (job: string) => {
        removed.push(job);
      },
      verifyTemporaryOutput: async () => {
        if (options.outputError) {
          throw options.outputError;
        }
        return FACTS;
      },
    },
    engine: {
      render: async (request: EngineRequest) => {
        requests.push(request);
        begin();
        if (options.render) {
          await options.render(request);
        }
      },
    },
  });

  return { events, removed, requests, execution, finished, release, started };
}

async function run(subject: Harness, job = "rj_001", dispatch = "dsp_001"): Promise<void> {
  await subject.execution.start(job, dispatch);
  await subject.execution.whenIdle();
}

function statuses(subject: Harness): string[] {
  return subject.events.map((event) => event.status);
}

describe("the one-slot renderer execution", () => {
  test("reports one monotonic sequence from preparing to completed", async () => {
    const subject = harness();
    await run(subject);

    expect(statuses(subject)).toEqual(["preparing", "rendering", "finalizing", "completed"]);
    expect(subject.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    for (const event of subject.events) {
      expect(event.render_job_id).toBe("rj_001");
      expect(event.dispatch_id).toBe("dsp_001");
    }
  });

  test("publishes validated output facts and never a path", async () => {
    const subject = harness();
    await run(subject);

    const completed = subject.events.at(-1)!;
    expect(completed.output).toEqual(FACTS);
    expect(JSON.stringify(completed)).not.toContain("/srv/artifacts");
    expect(Object.keys(completed)).not.toContain("output_relative_path");
  });

  test("renders the trusted composition from the bundle it fetched", async () => {
    const subject = harness();
    await run(subject);

    expect(subject.requests).toHaveLength(1);
    const request = subject.requests[0]!;
    expect(request.compositionId).toBe("advanced_timeline_v1");
    expect(request.outputPath).toBe("/srv/artifacts/temp/rj_001/output.mp4");
    expect(request.publicDir).toBe("/srv/artifacts/work/rj_001/assets");
    expect(request.outDir).toBe("/srv/artifacts/temp/rj_001/bundle");
    expect(request.entryPoint).toBe(CONFIG.compositionEntryPoint);
    expect(request.expected).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 300,
    });
  });

  test("reports bounded progress that never moves backwards", async () => {
    const subject = harness({
      render: async (request) => {
        request.onProgress(40);
        request.onProgress(10);
        request.onProgress(41);
        request.onProgress(90);
        request.onProgress(500);
      },
    });
    await run(subject);

    const progress = subject.events
      .filter((event) => event.status === "rendering")
      .map((event) => event.progress_percent);
    expect(progress).toEqual([0, 40, 90]);
  });

  test("turns each failure into its own fixed code and leaves no partial output", async () => {
    const bundleFailure = harness({ bundleError: new RenderBundleInvalid() });
    await run(bundleFailure);
    expect(statuses(bundleFailure).at(-1)).toBe("failed");
    expect(bundleFailure.events.at(-1)!.failure_code).toBe("render_bundle_invalid");
    expect(bundleFailure.removed).toContain("rj_001");

    const assetFailure = harness({ assetError: new ArtifactUnavailable() });
    await run(assetFailure);
    expect(statuses(assetFailure).at(-1)).toBe("failed");
    expect(assetFailure.events.at(-1)!.failure_code).toBe("render_asset_unavailable");
    expect(assetFailure.removed).toContain("rj_001");
  });

  test("maps an engine failure and an invalid output to their own codes", async () => {
    const engineFailure = harness({
      render: async () => {
        throw new Error("chrome crashed at /usr/lib/chromium with code 139");
      },
    });
    await run(engineFailure);
    expect(engineFailure.events.at(-1)!.failure_code).toBe("render_engine_failed");
    expect(JSON.stringify(engineFailure.events)).not.toContain("chromium");

    const badOutput = harness({ outputError: new ArtifactUnavailable() });
    await run(badOutput);
    expect(badOutput.events.at(-1)!.failure_code).toBe("render_output_invalid");
    expect(badOutput.removed).toContain("rj_001");
  });

  test("cancellation aborts the render, waits for it, and closes the job as cancelled", async () => {
    let aborted = false;
    const subject = harness({
      render: async (request) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => setTimeout(resolve, 5));
        });
        throw new Error("render cancelled");
      },
    });

    await subject.execution.start("rj_001", "dsp_001");
    await subject.started;
    await subject.execution.cancel("rj_001");
    await subject.execution.whenIdle();

    expect(aborted).toBe(true);
    expect(statuses(subject).at(-1)).toBe("cancelled");
    expect(subject.events.at(-1)!.failure_code).toBeUndefined();
    expect(subject.removed).toContain("rj_001");
  });

  test("the hard deadline aborts the render and reports the deadline code", async () => {
    const subject = harness({
      config: { deadlineSeconds: 0.02 },
      render: async (request) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve());
        });
        throw new Error("render timed out");
      },
    });
    await run(subject);

    expect(statuses(subject).at(-1)).toBe("failed");
    expect(subject.events.at(-1)!.failure_code).toBe("render_deadline_exceeded");
    expect(subject.removed).toContain("rj_001");
  });

  test("a late report from a finished render is never published", async () => {
    let late: ((percent: number) => void) | null = null;
    const subject = harness({
      render: async (request) => {
        late = request.onProgress;
      },
    });
    await run(subject);

    const published = subject.events.length;
    late!(99);
    expect(subject.events).toHaveLength(published);
  });

  test("holds exactly one slot and releases it once the job is terminal", async () => {
    const subject: Harness = harness({ render: () => subject.finished });

    await subject.execution.start("rj_001", "dsp_001");
    expect(subject.execution.status().active?.render_job_id).toBe("rj_001");
    await expect(subject.execution.start("rj_002", "dsp_002")).rejects.toMatchObject({
      code: "render_busy",
    });

    subject.release();
    await subject.execution.whenIdle();
    expect(subject.execution.status().active).toBeNull();
    await run(subject, "rj_002", "dsp_002");
    expect(subject.requests).toHaveLength(2);
  });

  test("a repeated start of the running dispatch is accepted without a second render", async () => {
    const subject: Harness = harness({ render: () => subject.finished });

    await subject.execution.start("rj_001", "dsp_001");
    await subject.execution.start("rj_001", "dsp_001");
    subject.release();
    await subject.execution.whenIdle();

    expect(subject.requests).toHaveLength(1);
  });

  test("a start for the running job under another dispatch is refused", async () => {
    const subject: Harness = harness({ render: () => subject.finished });

    await subject.execution.start("rj_001", "dsp_001");
    await expect(subject.execution.start("rj_001", "dsp_002")).rejects.toMatchObject({
      code: "render_busy",
    });
    subject.release();
    await subject.execution.whenIdle();
  });

  test("cancelling an unknown or finished job changes nothing", async () => {
    const subject = harness();
    await subject.execution.cancel("rj_404");
    await run(subject);
    const published = subject.events.length;
    await subject.execution.cancel("rj_001");
    expect(subject.events).toHaveLength(published);
  });
});

describe("the private dispatch surface", () => {
  function requestTo(path: string, init: RequestInit = {}): Request {
    return new Request(`http://renderer:8080${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CREDENTIAL}`, "Content-Type": "application/json" },
      ...init,
    });
  }

  function handlerFor(subject: Harness) {
    return createFetchHandler(subject.execution, CREDENTIAL);
  }

  test("compares the internal credential without leaking its length or content", async () => {
    expect(credentialMatches(CREDENTIAL, CREDENTIAL)).toBe(true);
    expect(credentialMatches(CREDENTIAL, `${CREDENTIAL}x`)).toBe(false);
    expect(credentialMatches(CREDENTIAL, "internal-credential-valuX")).toBe(false);
    expect(credentialMatches(CREDENTIAL, null)).toBe(false);

    const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();
    expect(source).toContain("timingSafeEqual");
  });

  test("refuses every request that does not carry the internal credential", async () => {
    const subject = harness();
    const handle = handlerFor(subject);
    const unauthorized = [
      requestTo("/internal/render-jobs/rj_001/start", { headers: {} }),
      requestTo("/internal/render-jobs/rj_001/start", {
        headers: { Authorization: "Bearer creator-api-key" },
      }),
    ];
    for (const request of unauthorized) {
      const response = await handle(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: "renderer_unauthorized" });
    }
    expect(subject.requests).toHaveLength(0);
  });

  test("starts one job and reports the busy slot to a second caller", async () => {
    const subject: Harness = harness({ render: () => subject.finished });
    const handle = handlerFor(subject);

    const accepted = await handle(
      requestTo("/internal/render-jobs/rj_001/start", {
        body: JSON.stringify({ dispatch_id: "dsp_001" }),
      }),
    );
    expect(accepted.status).toBe(202);

    const busy = await handle(
      requestTo("/internal/render-jobs/rj_002/start", {
        body: JSON.stringify({ dispatch_id: "dsp_002" }),
      }),
    );
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ code: "render_busy" });

    subject.release();
    await subject.execution.whenIdle();
  });

  test("accepts a cancel for any identity and answers the same way twice", async () => {
    const subject = harness();
    const handle = handlerFor(subject);
    for (const _attempt of [0, 1]) {
      const response = await handle(requestTo("/internal/render-jobs/rj_001/cancel", { body: "" }));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true });
    }
  });

  test("refuses a body or identity it does not trust, with a fixed code", async () => {
    const subject = harness();
    const handle = handlerFor(subject);
    const rejected = [
      requestTo("/internal/render-jobs/rj_001/start", { body: "not json" }),
      requestTo("/internal/render-jobs/rj_001/start", { body: JSON.stringify({}) }),
      requestTo("/internal/render-jobs/rj_001/start", {
        body: JSON.stringify({ dispatch_id: "dsp_001", codec: "vp9" }),
      }),
      requestTo("/internal/render-jobs/..%2Fetc/start", {
        body: JSON.stringify({ dispatch_id: "dsp_001" }),
      }),
    ];
    for (const request of rejected) {
      const response = await handle(request);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ code: "renderer_request_invalid" });
    }
    expect(subject.requests).toHaveLength(0);
  });

  test("publishes no other route and never echoes the path it refused", async () => {
    const subject = harness();
    const handle = handlerFor(subject);
    const response = await handle(
      requestTo("/internal/render-jobs/rj_001/secret", { method: "GET" }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(JSON.stringify({ code: "renderer_route_unknown" }));
  });
});
