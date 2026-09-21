/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { RenderCapability, RenderJob } from "@/api/control-plane";
import {
  RENDER_HISTORY_LIMIT,
  canCancel,
  canCleanup,
  canDownload,
  canRetry,
  createRenderJobState,
  renderGate,
  renderJobReducer,
  selectedRenderJob,
  type RenderEditorFacts,
  type RenderJobAction,
  type RenderJobState,
} from "./render_job_state";

const AVAILABLE: RenderCapability = {
  available: true,
  preset_id: "standard_vertical_mp4_v1",
  renderer_version: "remotion-4.0.523",
};

function job(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    render_job_id: "rj_001",
    project_id: "project_001",
    document_id: "edoc_001",
    document_revision: 7,
    status: "preparing",
    template_id: "vertical_story",
    template_version: "1",
    preset_id: "standard_vertical_mp4_v1",
    renderer_version: "remotion-4.0.523",
    created_at: "2026-09-21T10:00:00Z",
    ...overrides,
  } as RenderJob;
}

const COMPLETED = job({
  render_job_id: "rj_done",
  status: "completed",
  finished_at: "2026-09-21T10:05:00Z",
  output: {
    media_type: "video/mp4",
    size_bytes: 2048,
    checksum: `sha256:${"b".repeat(64)}`,
    width: 1080,
    height: 1920,
    fps: 30,
    duration_seconds: 10,
    has_audio: false,
  },
} as Partial<RenderJob>);

const SAVED: RenderEditorFacts = { saveStatus: "saved", online: true, documentValid: true };

/** A state that has already loaded its capability and one page of history. */
function loaded(jobs: RenderJob[] = [], capability: RenderCapability = AVAILABLE): RenderJobState {
  const started = renderJobReducer(createRenderJobState(), { type: "load_started" });
  return renderJobReducer(started, {
    type: "loaded",
    generation: started.generation,
    capability,
    jobs,
  });
}

describe("the render job state", () => {
  test("owns render lifecycle facts and never the editor draft", () => {
    expect(Object.keys(createRenderJobState()).sort()).toEqual([
      "attemptKey",
      "capability",
      "generation",
      "history",
      "isOffline",
      "lastError",
      "mutation",
      "selectedJobId",
    ]);
  });

  test("loads capability and history and selects nothing by itself", () => {
    const state = loaded([job()]);
    expect(state.capability).toEqual(AVAILABLE);
    expect(state.history).toHaveLength(1);
    expect(state.selectedJobId).toBeNull();
    expect(state.lastError).toBeNull();
  });

  test("keeps history newest-first, deduplicated, and bounded", () => {
    const many = Array.from({ length: RENDER_HISTORY_LIMIT + 5 }, (_, index) =>
      job({
        render_job_id: `rj_${String(index).padStart(3, "0")}`,
        created_at: `2026-09-21T10:${String(index).padStart(2, "0")}:00Z`,
      }),
    );
    const state = loaded([...many, many[0]]);

    expect(state.history).toHaveLength(RENDER_HISTORY_LIMIT);
    expect(state.history[0].render_job_id).toBe(many[many.length - 1].render_job_id);
    expect(new Set(state.history.map((entry) => entry.render_job_id)).size).toBe(
      RENDER_HISTORY_LIMIT,
    );
    const times = state.history.map((entry) => entry.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("selects and refreshes one job by identity", () => {
    const state = renderJobReducer(loaded([job()]), { type: "job_selected", renderJobId: "rj_001" });
    expect(selectedRenderJob(state)?.render_job_id).toBe("rj_001");

    const refreshed = renderJobReducer(state, {
      type: "job_refreshed",
      generation: state.generation,
      job: job({ status: "rendering", progress_percent: 40 } as Partial<RenderJob>),
    });
    expect(refreshed.history).toHaveLength(1);
    expect(selectedRenderJob(refreshed)?.status).toBe("rendering");
  });

  test("a refresh never regresses a terminal job to an active one", () => {
    const terminal = renderJobReducer(loaded([]), {
      type: "job_refreshed",
      generation: 1,
      job: job({ status: "completed", finished_at: "2026-09-21T10:05:00Z" } as Partial<RenderJob>),
    });
    const late = renderJobReducer(terminal, {
      type: "job_refreshed",
      generation: 1,
      job: job({ status: "rendering", progress_percent: 60 } as Partial<RenderJob>),
    });

    expect(late.history[0].status).toBe("completed");
    expect(late.history[0].progress_percent).toBeUndefined();
  });

  test("never invents a progress percentage", () => {
    const state = renderJobReducer(loaded([]), {
      type: "job_refreshed",
      generation: 1,
      job: job({ status: "rendering" }),
    });
    expect(state.history[0].progress_percent).toBeUndefined();
  });

  test("a response from an older generation is dropped", () => {
    const first = loaded([job()]);
    const reloading = renderJobReducer(first, { type: "load_started" });

    const stale = renderJobReducer(reloading, {
      type: "loaded",
      generation: first.generation,
      capability: { ...AVAILABLE, renderer_version: "remotion-0.0.1" },
      jobs: [job({ render_job_id: "rj_stale" })],
    });
    expect(stale.history.map((entry) => entry.render_job_id)).toEqual(["rj_001"]);
    expect(stale.capability).toEqual(AVAILABLE);

    const staleRefresh = renderJobReducer(reloading, {
      type: "job_refreshed",
      generation: first.generation,
      job: job({ status: "completed" } as Partial<RenderJob>),
    });
    expect(staleRefresh.history[0].status).toBe("preparing");
  });

  test("one mutation attempt is held until it settles", () => {
    const started = renderJobReducer(loaded([]), {
      type: "mutation_started",
      mutation: "create",
      attemptKey: "attempt_001",
    });
    expect(started.mutation).toBe("create");
    expect(started.attemptKey).toBe("attempt_001");

    // A second press replays the same attempt; the key must survive it.
    const replayed = renderJobReducer(started, {
      type: "mutation_started",
      mutation: "create",
      attemptKey: "attempt_002",
    });
    expect(replayed.attemptKey).toBe("attempt_001");
    expect(replayed).toBe(started);
  });

  test("a settled mutation releases the attempt and records the job", () => {
    const started = renderJobReducer(loaded([]), {
      type: "mutation_started",
      mutation: "create",
      attemptKey: "attempt_001",
    });
    const done = renderJobReducer(started, {
      type: "mutation_succeeded",
      generation: started.generation,
      job: job(),
    });

    expect(done.mutation).toBeNull();
    expect(done.attemptKey).toBeNull();
    expect(done.selectedJobId).toBe("rj_001");
    expect(done.history.map((entry) => entry.render_job_id)).toEqual(["rj_001"]);
  });

  test("a failed mutation keeps only a safe code", () => {
    const started = renderJobReducer(loaded([]), {
      type: "mutation_started",
      mutation: "create",
      attemptKey: "attempt_001",
    });
    const failed = renderJobReducer(started, {
      type: "mutation_failed",
      generation: started.generation,
      code: "render_busy",
    });

    expect(failed.mutation).toBeNull();
    expect(failed.attemptKey).toBeNull();
    expect(failed.lastError).toBe("render_busy");
  });

  test("a download or cleanup mutation settles without a job of its own", () => {
    const downloading = renderJobReducer(loaded([COMPLETED]), {
      type: "mutation_started",
      mutation: "download",
    });
    const settled = renderJobReducer(downloading, {
      type: "mutation_succeeded",
      generation: downloading.generation,
    });

    expect(settled.mutation).toBeNull();
    expect(settled.history).toEqual(downloading.history);
  });

  test("offline pauses rendering and coming back online restores it", () => {
    const offline = renderJobReducer(loaded([]), { type: "went_offline" });
    expect(offline.isOffline).toBe(true);
    expect(renderGate(SAVED, offline)).toEqual({ allowed: false, reason: "offline" });

    const online = renderJobReducer(offline, { type: "went_online" });
    expect(online.isOffline).toBe(false);
    expect(renderGate(SAVED, online)).toEqual({ allowed: true });
  });
});

describe("the render gate", () => {
  test("allows a render of a saved, valid document on an available renderer", () => {
    expect(renderGate(SAVED, loaded([]))).toEqual({ allowed: true });
  });

  test("names one safe reason for every condition that blocks a render", () => {
    const state = loaded([]);
    const busy: RenderCapability = { ...AVAILABLE, available: false, reason: "render_busy" };
    const notConfigured: RenderCapability = {
      ...AVAILABLE,
      available: false,
      reason: "renderer_not_configured",
    };

    expect(renderGate({ ...SAVED, online: false }, state).reason).toBe("offline");
    expect(renderGate({ ...SAVED, saveStatus: "saving" }, state).reason).toBe("saving");
    expect(renderGate({ ...SAVED, saveStatus: "conflict" }, state).reason).toBe("conflict");
    expect(renderGate({ ...SAVED, saveStatus: "dirty" }, state).reason).toBe("dirty");
    expect(renderGate({ ...SAVED, documentValid: false }, state).reason).toBe("document_invalid");
    expect(renderGate(SAVED, createRenderJobState()).reason).toBe("renderer_unavailable");
    expect(renderGate(SAVED, loaded([], notConfigured)).reason).toBe("renderer_unavailable");
    expect(renderGate(SAVED, loaded([], busy)).reason).toBe("render_busy");
    expect(
      renderGate(
        SAVED,
        renderJobReducer(state, { type: "mutation_started", mutation: "create", attemptKey: "a" }),
      ).reason,
    ).toBe("mutation_in_progress");
  });
});

describe("the per-job action gates", () => {
  test("cancel is offered once, for an active job only", () => {
    expect(canCancel(job({ status: "rendering" }))).toBe(true);
    expect(canCancel(job({ status: "rendering", cancel_requested_at: "2026-09-21T10:01:00Z" } as Partial<RenderJob>))).toBe(false);
    expect(canCancel(COMPLETED)).toBe(false);
  });

  test("retry is offered for a failed or cancelled job only", () => {
    expect(canRetry(job({ status: "failed", failure_code: "render_engine_failed" } as Partial<RenderJob>))).toBe(true);
    expect(canRetry(job({ status: "cancelled" }))).toBe(true);
    expect(canRetry(COMPLETED)).toBe(false);
    expect(canRetry(job({ status: "rendering" }))).toBe(false);
  });

  test("download and cleanup follow the output and the cleanup stamp", () => {
    expect(canDownload(COMPLETED)).toBe(true);
    expect(canCleanup(COMPLETED)).toBe(true);

    const cleaned = { ...COMPLETED, artifacts_cleaned_at: "2026-09-21T11:00:00Z" } as RenderJob;
    expect(canDownload(cleaned)).toBe(false);
    expect(canCleanup(cleaned)).toBe(false);

    expect(canDownload(job({ status: "rendering" }))).toBe(false);
    expect(canCleanup(job({ status: "rendering" }))).toBe(false);
    expect(canCleanup(job({ status: "failed" }))).toBe(true);
  });
});

test("no private route, path, credential, or renderer address enters render state", () => {
  const state = renderJobReducer(loaded([COMPLETED]), {
    type: "job_selected",
    renderJobId: "rj_done",
  });
  const serialised = JSON.stringify(state);

  for (const forbidden of [
    "dispatch_id",
    "internal/render-jobs",
    "artifact_root",
    "output_relative_path",
    "renderer_url",
    "credential",
    "/srv/",
    "C:\\",
  ]) {
    expect(serialised).not.toContain(forbidden);
  }
  expect(Object.keys(state.history[0]).sort()).toEqual(Object.keys(COMPLETED).sort());
});

describe("the render job lifecycle", () => {
  const rendering = job({ status: "rendering", progress_percent: 80 } as Partial<RenderJob>);

  test("an active status never moves backwards", () => {
    const state = loaded([rendering]);

    const backwards = renderJobReducer(state, {
      type: "job_refreshed",
      generation: state.generation,
      job: job({ status: "preparing" }),
    });
    expect(backwards.history[0].status).toBe("rendering");

    const finalizing = renderJobReducer(state, {
      type: "job_refreshed",
      generation: state.generation,
      job: job({ status: "finalizing" }),
    });
    const regressed = renderJobReducer(finalizing, {
      type: "job_refreshed",
      generation: finalizing.generation,
      job: job({ status: "rendering" }),
    });
    expect(regressed.history[0].status).toBe("finalizing");
  });

  test("progress never decreases inside one status", () => {
    const state = loaded([rendering]);
    const lower = renderJobReducer(state, {
      type: "job_refreshed",
      generation: state.generation,
      job: job({ status: "rendering", progress_percent: 20 } as Partial<RenderJob>),
    });
    expect(lower.history[0].progress_percent).toBe(80);
  });

  test("an update without progress does not erase what is already known", () => {
    const state = loaded([rendering]);
    const silent = renderJobReducer(state, {
      type: "job_refreshed",
      generation: state.generation,
      job: job({ status: "rendering" }),
    });
    expect(silent.history[0].progress_percent).toBe(80);
  });

  test("a forward transition may drop progress the new status does not carry", () => {
    const state = loaded([rendering]);
    const forward = renderJobReducer(state, {
      type: "job_refreshed",
      generation: state.generation,
      job: job({ status: "finalizing" }),
    });
    expect(forward.history[0].status).toBe("finalizing");
    expect(forward.history[0].progress_percent).toBeUndefined();
  });

  test("a terminal status is final", () => {
    const completed = loaded([job({ status: "completed" } as Partial<RenderJob>)]);
    const toFailed = renderJobReducer(completed, {
      type: "job_refreshed",
      generation: completed.generation,
      job: job({ status: "failed", failure_code: "render_engine_failed" } as Partial<RenderJob>),
    });
    expect(toFailed.history[0].status).toBe("completed");

    const failed = loaded([job({ status: "failed" } as Partial<RenderJob>)]);
    const toCancelled = renderJobReducer(failed, {
      type: "job_refreshed",
      generation: failed.generation,
      job: job({ status: "cancelled" }),
    });
    expect(toCancelled.history[0].status).toBe("failed");
  });

  test("a terminal job still records the cleanup it just accepted", () => {
    const completed = loaded([COMPLETED]);
    const cleaned = renderJobReducer(completed, {
      type: "job_refreshed",
      generation: completed.generation,
      job: { ...COMPLETED, artifacts_cleaned_at: "2026-09-21T11:00:00Z" } as RenderJob,
    });
    expect(cleaned.history[0].artifacts_cleaned_at).toBe("2026-09-21T11:00:00Z");
    expect(canCleanup(cleaned.history[0])).toBe(false);
  });
});

describe("going offline", () => {
  /** A state with one create attempt and one load already in flight. */
  function inFlight(): RenderJobState {
    return renderJobReducer(loaded([job()]), {
      type: "mutation_started",
      mutation: "create",
      attemptKey: "attempt_001",
    });
  }

  test("every response still in flight is invalidated", () => {
    const before = inFlight();
    const offline = renderJobReducer(before, { type: "went_offline" });

    const stale = renderJobReducer(offline, {
      type: "loaded",
      generation: before.generation,
      capability: { ...AVAILABLE, renderer_version: "remotion-0.0.1" },
      jobs: [job({ render_job_id: "rj_stale" })],
    });
    expect(stale.capability).toEqual(AVAILABLE);
    expect(stale.history.map((entry) => entry.render_job_id)).toEqual(["rj_001"]);

    const staleRefresh = renderJobReducer(offline, {
      type: "job_refreshed",
      generation: before.generation,
      job: job({ status: "completed" } as Partial<RenderJob>),
    });
    expect(staleRefresh.history[0].status).toBe("preparing");

    const staleSuccess = renderJobReducer(offline, {
      type: "mutation_succeeded",
      generation: before.generation,
      job: job({ render_job_id: "rj_ghost" }),
    });
    expect(staleSuccess.history.map((entry) => entry.render_job_id)).toEqual(["rj_001"]);
    expect(staleSuccess.selectedJobId).toBeNull();
    expect(staleSuccess.mutation).toBe("create");

    const staleFailure = renderJobReducer(offline, {
      type: "mutation_failed",
      generation: before.generation,
      code: "render_busy",
    });
    expect(staleFailure.lastError).toBeNull();
    expect(staleFailure.attemptKey).toBe("attempt_001");
  });

  test("an ambiguous attempt survives with its original key", () => {
    const offline = renderJobReducer(inFlight(), { type: "went_offline" });
    expect(offline.mutation).toBe("create");
    expect(offline.attemptKey).toBe("attempt_001");
  });

  test("a read-only mutation is simply released", () => {
    const downloading = renderJobReducer(loaded([COMPLETED]), {
      type: "mutation_started",
      mutation: "download",
    });
    const offline = renderJobReducer(downloading, { type: "went_offline" });
    expect(offline.mutation).toBeNull();
    expect(offline.attemptKey).toBeNull();
  });

  test("coming back online is a state change and nothing more", () => {
    const offline = renderJobReducer(inFlight(), { type: "went_offline" });
    const online = renderJobReducer(offline, { type: "went_online" });
    expect(online.isOffline).toBe(false);
    expect(online.generation).toBe(offline.generation);
    expect(online.mutation).toBe("create");
    expect(online.attemptKey).toBe("attempt_001");
    expect(online.history).toEqual(offline.history);
  });
});

describe("the mutation attempt contract", () => {
  test("the action shape requires a key for create and forbids one elsewhere", () => {
    const create: RenderJobAction = {
      type: "mutation_started",
      mutation: "create",
      attemptKey: "attempt_001",
    };
    // @ts-expect-error a create attempt without its idempotency key is not expressible
    const keyless: RenderJobAction = { type: "mutation_started", mutation: "create" };
    const cancel: RenderJobAction = {
      type: "mutation_started",
      mutation: "cancel",
      // @ts-expect-error a cancel owns no attempt and therefore no key
      attemptKey: "attempt_001",
    };
    expect([create, keyless, cancel]).toHaveLength(3);
  });

  test("an attempt without a real key never starts", () => {
    const state = loaded([]);
    const empty = renderJobReducer(state, {
      type: "mutation_started",
      mutation: "retry",
      attemptKey: "   ",
    });
    expect(empty).toBe(state);
  });

  test("a settled attempt is cleared exactly once", () => {
    const started = renderJobReducer(loaded([]), {
      type: "mutation_started",
      mutation: "create",
      attemptKey: "attempt_001",
    });
    const settled = renderJobReducer(started, {
      type: "mutation_succeeded",
      generation: started.generation,
      job: job(),
    });
    const again = renderJobReducer(settled, {
      type: "mutation_succeeded",
      generation: settled.generation,
      job: job(),
    });

    expect(settled.mutation).toBeNull();
    expect(settled.attemptKey).toBeNull();
    expect(again.mutation).toBeNull();
    expect(again.attemptKey).toBeNull();
  });
});

describe("the safe error contract", () => {
  test("a raw failure value becomes one fixed code", () => {
    const state = loaded([]);
    const started = renderJobReducer(state, { type: "mutation_started", mutation: "cancel" });

    const raw = renderJobReducer(started, {
      type: "mutation_failed",
      generation: started.generation,
      code: new Error("EACCES C:/srv/artifacts/rj_001 at https://renderer.internal:9000"),
    });
    expect(raw.lastError).toBe("render_request_failed");

    const loadRaw = renderJobReducer(state, {
      type: "load_failed",
      generation: state.generation,
      code: "connect ECONNREFUSED C:/srv/proxy.pem",
    });
    expect(loadRaw.lastError).toBe("render_request_failed");

    const known = renderJobReducer(state, {
      type: "load_failed",
      generation: state.generation,
      code: "render_unavailable",
    });
    expect(known.lastError).toBe("render_unavailable");
  });
});
