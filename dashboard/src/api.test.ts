/// <reference types="bun-types" />

import "./test-setup";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import { Discovery } from "./components/Discovery";
import { ContentSet } from "./components/ContentSet";
import { JobMonitor } from "./components/JobMonitor";
import {
  cleanupJob,
  cleanupPackage,
  createProfileJob,
  describeCode,
  getEffectiveSettings,
  getPackageSummary,
  migrateConfigToml,
  packageIdFromManifestPath,
  scoutRun,
  updateProfile,
} from "./api";

const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

function stub(json: unknown, status = 200) {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
  localStorage.removeItem("use_input_as_main");
});

test("createProfileJob posts profile_id + real overrides to the project jobs route", async () => {
  stub({ job_id: "job-123" });

  // Real RunOverrides fields — the server rejects unknown fields, so a
  // fictional `output_format` would 422. This pins the client to the contract.
  const result = await createProfileJob("p1", {
    profile_id: "prof-1",
    overrides: { analysis_max_clips: 5, visual_edit_layout: "square" },
  });

  expect(result).toEqual({ job_id: "job-123" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("/api/projects/p1/jobs");
  expect(calls[0].init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    profile_id: "prof-1",
    overrides: { analysis_max_clips: 5, visual_edit_layout: "square" },
  });
});

test("createProfileJob surfaces authoritative forced-main error codes", async () => {
  stub({ error: { code: "forced_main_narration_required" } }, 422);

  await expect(
    createProfileJob("p1", { profile_id: "prof-1", overrides: {} }),
  ).rejects.toThrow("createProfileJob: forced_main_narration_required");
});

test("getEffectiveSettings gets the job effective-settings route", async () => {
  stub({ settings: { schema_version: 1 } });

  const result = await getEffectiveSettings("job-9");

  expect(calls[0].url).toBe("/api/jobs/job-9/effective-settings");
  expect(calls[0].init?.method ?? "GET").toBe("GET");
  expect(result?.settings.schema_version).toBe(1);
});

test("updateProfile sends tri-state credential_ref: null clears, omitted stays unchanged", async () => {
  // Explicit null must be serialized (clears the credential server-side).
  stub({ id: "prof-1" });
  await updateProfile("p1", "prof-1", { credential_ref: null });
  expect(calls[0].url).toBe("/api/projects/p1/profiles/prof-1");
  expect(calls[0].init?.method).toBe("PATCH");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ credential_ref: null });

  // An omitted credential_ref must NOT appear in the body (leaves it unchanged).
  calls = [];
  stub({ id: "prof-1" });
  await updateProfile("p1", "prof-1", { name: "Renamed" });
  const body = JSON.parse(String(calls[0].init?.body));
  expect(body).toEqual({ name: "Renamed" });
  expect("credential_ref" in body).toBe(false);
});

test("migrateConfigToml posts to the migration route and returns the report", async () => {
  stub({ imported: true, warnings: ["dropped: bgm_vibe"] });

  const report = await migrateConfigToml();

  expect(calls[0].url).toBe("/api/migrations/config-toml");
  expect(calls[0].init?.method).toBe("POST");
  expect(report).toEqual({ imported: true, warnings: ["dropped: bgm_vibe"] });
});

test("scoutRun omits forced-main fields for the legacy request and default target", async () => {
  stub({ ok: true }, 202);

  await scoutRun({
    url: "https://www.instagram.com/p/ABC/",
    main_coverage_target: 0.60,
  });

  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    url: "https://www.instagram.com/p/ABC/",
  });
});

test("scoutRun maps forced-main fields only when explicitly selected", async () => {
  stub({ ok: true }, 202);

  await scoutRun({
    url: "https://www.instagram.com/p/ABC/",
    use_input_as_main: true,
    main_coverage_target: 0.75,
  });

  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    url: "https://www.instagram.com/p/ABC/",
    use_input_as_main: true,
    main_coverage_target: 0.75,
  });
});

test("Discovery forced-main checkbox starts unchecked on each mount and is not stored", async () => {
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  let first!: ReturnType<typeof render>;
  await act(async () => {
    first = render(createElement(Discovery));
  });
  const firstCheckbox = first.getByRole("checkbox", {
    name: /Use URL media as main footage/,
  }) as HTMLInputElement;
  expect(firstCheckbox.checked).toBe(false);
  await act(async () => {
    first.unmount();
  });

  let remounted!: ReturnType<typeof render>;
  await act(async () => {
    remounted = render(createElement(Discovery));
  });
  const remountedCheckbox = remounted.getByRole("checkbox", {
    name: /Use URL media as main footage/,
  }) as HTMLInputElement;
  expect(remountedCheckbox.checked).toBe(false);
  expect(localStorage.getItem("use_input_as_main")).toBeNull();
});

test("Discovery resets forced-main selection after a successful run", async () => {
  // A ready server: the control is only operable when the planner is installed.
  stubRoutes({
    "/api/scout/status": { json: { main_footage_ready: true, run: null } },
    "/api/scout": { json: { ok: true }, status: 202 },
  });
  const user = userEvent.setup();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(Discovery));
  });
  const url = view.getByLabelText("topic url");
  const checkbox = view.getByRole("checkbox", {
    name: /Use URL media as main footage/,
  }) as HTMLInputElement;
  await user.type(url, "https://www.instagram.com/p/ABC/");
  await user.click(checkbox);
  expect(checkbox.checked).toBe(true);

  await user.click(view.getByRole("button", { name: "Run pipeline" }));
  const firstRun = calls.find((call) => call.url === "/api/scout/run");
  expect(JSON.parse(String(firstRun?.init?.body))).toMatchObject({ use_input_as_main: true });
  expect(checkbox.checked).toBe(false);

  calls = [];
  await user.click(view.getByRole("button", { name: "Run pipeline" }));
  const secondRun = calls.find((call) => call.url === "/api/scout/run");
  expect(JSON.parse(String(secondRun?.init?.body))).toMatchObject({ use_input_as_main: false });
});

/**
 * Readiness is the only thing standing between an operator and a run that dies
 * partway through, so an unready server has to refuse the control outright — not
 * accept the tick and fail later, which is the silent legacy fallback this mode
 * is not allowed to have.
 */
test("Discovery refuses forced main footage when the server reports it unready", async () => {
  stubRoutes({
    "/api/scout/status": { json: { main_footage_ready: false, run: null } },
    "/api/scout": { json: { ok: true }, status: 202 },
  });
  const user = userEvent.setup();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(Discovery));
  });
  const checkbox = view.getByRole("checkbox", {
    name: /Use URL media as main footage/,
  }) as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);

  await user.type(view.getByLabelText("topic url"), "https://www.instagram.com/p/ABC/");
  await user.click(checkbox);
  expect(checkbox.checked).toBe(false);

  calls = [];
  await user.click(view.getByRole("button", { name: "Run pipeline" }));
  const run = calls.find((call) => call.url === "/api/scout/run");
  expect(JSON.parse(String(run?.init?.body))).toMatchObject({ use_input_as_main: false });
});

// --- Task 14: package facts, job monitoring, explicit cleanup ----------------

/** Route-aware fetch stub: component tests hit several endpoints per render. */
function stubRoutes(routes: Record<string, { json: unknown; status?: number }>) {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const key = Object.keys(routes).find((route) => href.startsWith(route));
    const hit = key ? routes[key] : undefined;
    return Promise.resolve(
      new Response(JSON.stringify(hit ? hit.json : {}), {
        status: hit?.status ?? (hit ? 200 : 404),
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

const PACKAGE_SUMMARY = {
  package_id: "v001",
  platform: "instagram",
  canonical_url: "https://www.instagram.com/reel/post-123/",
  analysis_mode: "degraded",
  fingerprint: "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  usable_count: 2,
  skipped_count: 1,
  ignored_count: 1,
  total_duration_sec: 20,
  total_bytes: 3145728,
  file_count: 4,
  warnings: ["photo_slide_ignored", "source_video_skipped", "vision_degraded"],
};

const FORCED_CONTENT_SET = {
  path: "scout/output/thoth_content_set.json",
  exists: true,
  output_root: "scout/output",
  error: null,
  content: {
    main: { title: "A post" },
    footage: [],
    comments: [],
    main_footage: {
      mode: "forced_url_pool",
      package_manifest: "main-footage/v001/package.json",
      coverage_target: 0.6,
    },
  },
};

const JOB_MANIFEST = {
  video: "clips/final_concat.mp4",
  narration_timeline: "narration/timeline.json",
  source_package: "main-footage/source-package.json",
  active_plan: "plans/v002/main-footage-plan.json",
  cuts: "cuts/v002",
  main_footage: {
    active_plan_version: "v002",
    planning_mode: "degraded",
    coverage_target: 0.6,
    coverage_actual: 0.72,
    coverage_sec: 18,
    total_duration_sec: 25,
    beat_count: 3,
    cut_count: 2,
    reuse_count: 1,
    candidate_count: 9,
    transitions: { cross_dissolve: 1, match_cut: 1 },
    warnings: ["exact_scene_reused", "transition_fallback"],
    retained_bytes: 4096,
  },
};

const SUCCEEDED_JOB = {
  id: "job-mf",
  status: "succeeded",
  stage: "render",
  pct: 1,
  error: null,
};

test("getPackageSummary reads the typed package summary route", async () => {
  stub(PACKAGE_SUMMARY);

  const summary = await getPackageSummary("v001");

  expect(calls[0].url).toBe("/api/scout/packages/v001/summary");
  expect(calls[0].init?.method ?? "GET").toBe("GET");
  expect(summary?.usable_count).toBe(2);
  expect(summary?.fingerprint).toBe(PACKAGE_SUMMARY.fingerprint);
});

test("getPackageSummary returns null rather than throwing for an unknown package", async () => {
  stub({ error: { code: "package_not_found" } }, 404);

  expect(await getPackageSummary("v404")).toBeNull();
});

test("cleanupPackage repeats the package id as the confirmation", async () => {
  stub({ removed_files: 4, removed_bytes: 3145728, recoverable: false });

  const report = await cleanupPackage("v001");

  expect(calls[0].url).toBe("/api/scout/packages/v001/cleanup");
  expect(calls[0].init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ confirm: "v001" });
  expect(report.recoverable).toBe(false);
});

test("cleanupJob repeats the job id as the confirmation", async () => {
  stub({ removed_files: 9, removed_bytes: 4096, recoverable: false });

  const report = await cleanupJob("job-mf");

  expect(calls[0].url).toBe("/api/jobs/job-mf/cleanup");
  expect(calls[0].init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ confirm: "job-mf" });
  expect(report.removed_files).toBe(9);
});

test("cleanupJob surfaces the server's stable refusal code", async () => {
  stub({ error: { code: "job_not_terminal" } }, 409);

  await expect(cleanupJob("job-live")).rejects.toThrow("cleanupJob: job_not_terminal");
});

test("describeCode gives human copy for a known code and keeps the raw code visible", () => {
  expect(describeCode("vision_degraded")).toBe(
    "Vision analysis degraded; scenes were planned from transcript and metrics only (vision_degraded)",
  );
  // An unknown code must still reach the operator verbatim rather than vanish.
  expect(describeCode("brand_new_server_code")).toBe("brand_new_server_code");
});

test("packageIdFromManifestPath reads the generation id, and refuses anything else", () => {
  expect(packageIdFromManifestPath("main-footage/v001/package.json")).toBe("v001");
  expect(packageIdFromManifestPath("main-footage\\v001\\package.json")).toBe("v001");
  expect(packageIdFromManifestPath("package.json")).toBeNull();
  expect(packageIdFromManifestPath("main-footage/../escape/package.json")).toBeNull();
});

test("ContentSet shows forced-main package facts: counts, duration, size, mode, fingerprint, warnings", async () => {
  stubRoutes({
    "/api/scout/content-set/data": { json: FORCED_CONTENT_SET },
    "/api/scout/packages/v001/summary": { json: PACKAGE_SUMMARY },
    "/api/scout/status": { json: { run: { status: "idle" } } },
  });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(ContentSet, { onSendToRender: () => {} }));
  });

  const panel = await view.findByTestId("forced-main-facts");
  expect(view.getByText(/Forced main/i)).toBeTruthy();
  expect(panel.textContent).toContain("2 usable");
  expect(panel.textContent).toContain("1 skipped");
  expect(panel.textContent).toContain("1 ignored");
  expect(panel.textContent).toContain("20.0s");
  expect(panel.textContent).toContain("3.0 MB");
  expect(panel.textContent).toContain("degraded");
  expect(panel.textContent).toContain("00112233");
  expect(panel.textContent).toContain("vision_degraded");
});

test("ContentSet package cleanup needs the typed id, calls the endpoint once, and refreshes the facts", async () => {
  stubRoutes({
    "/api/scout/content-set/data": { json: FORCED_CONTENT_SET },
    "/api/scout/packages/v001/summary": { json: PACKAGE_SUMMARY },
    "/api/scout/packages/v001/cleanup": {
      json: { removed_files: 4, removed_bytes: 3145728, recoverable: false },
    },
    "/api/scout/status": { json: { run: { status: "idle" } } },
  });
  const user = userEvent.setup();

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(ContentSet, { onSendToRender: () => {} }));
  });
  await view.findByTestId("forced-main-facts");

  await user.click(view.getByRole("button", { name: /Delete package/i }));
  const confirmButton = view.getByRole("button", { name: /^Delete forever$/i }) as HTMLButtonElement;
  expect(confirmButton.disabled).toBe(true);

  const field = view.getByLabelText(/type v001 to confirm/i);
  await user.type(field, "v00");
  expect(confirmButton.disabled).toBe(true);
  await user.type(field, "1");
  expect(confirmButton.disabled).toBe(false);

  calls = [];
  await act(async () => {
    await user.click(confirmButton);
  });

  const cleanupCalls = calls.filter((c) => c.url === "/api/scout/packages/v001/cleanup");
  expect(cleanupCalls).toHaveLength(1);
  const result = view.getByTestId("cleanup-result").textContent ?? "";
  expect(result).toContain("4 files");
  expect(result).toMatch(/cannot be undone/i);
  // Facts are re-read after a destructive change.
  expect(calls.some((c) => c.url === "/api/scout/packages/v001/summary")).toBe(true);
});

test("ContentSet package cleanup deletes nothing when the operator cancels", async () => {
  stubRoutes({
    "/api/scout/content-set/data": { json: FORCED_CONTENT_SET },
    "/api/scout/packages/v001/summary": { json: PACKAGE_SUMMARY },
    "/api/scout/status": { json: { run: { status: "idle" } } },
  });
  const user = userEvent.setup();

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(ContentSet, { onSendToRender: () => {} }));
  });
  await view.findByTestId("forced-main-facts");

  await user.click(view.getByRole("button", { name: /Delete package/i }));
  await user.type(view.getByLabelText(/type v001 to confirm/i), "v001");
  calls = [];
  await user.click(view.getByRole("button", { name: /^Cancel$/i }));

  expect(calls.filter((c) => c.url.includes("/cleanup"))).toHaveLength(0);
  expect(view.queryByRole("button", { name: /^Delete forever$/i })).toBeNull();
});

test("ContentSet package cleanup is disabled while a Scout command is running", async () => {
  stubRoutes({
    "/api/scout/content-set/data": { json: FORCED_CONTENT_SET },
    "/api/scout/packages/v001/summary": { json: PACKAGE_SUMMARY },
    "/api/scout/status": { json: { run: { status: "running" } } },
  });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(ContentSet, { onSendToRender: () => {} }));
  });
  await view.findByTestId("forced-main-facts");

  const trigger = view.getByRole("button", { name: /Delete package/i }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
});

test("JobMonitor shows every post-plan metric for a forced-main job", async () => {
  stubRoutes({
    "/api/jobs/job-mf/manifest": { json: JOB_MANIFEST },
    "/api/jobs/job-mf": { json: SUCCEEDED_JOB },
  });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(JobMonitor, { jobId: "job-mf" }));
  });

  const panel = await view.findByTestId("main-footage-metrics");
  expect(panel.textContent).toContain("v002");
  expect(panel.textContent).toContain("degraded");
  expect(panel.textContent).toContain("72%");
  expect(panel.textContent).toContain("60%");
  expect(panel.textContent).toContain("18.0s");
  expect(panel.textContent).toContain("25.0s");
  expect(panel.textContent).toContain("3 beats");
  expect(panel.textContent).toContain("2 cuts");
  expect(panel.textContent).toContain("1 reuse");
  expect(panel.textContent).toContain("9 candidates");
  expect(panel.textContent).toContain("cross_dissolve");
  expect(panel.textContent).toContain("match_cut");
  expect(panel.textContent).toContain("transition_fallback");
  expect(panel.textContent).toContain("4.0 KB");
});

test("JobMonitor never renders an absolute artifact path", async () => {
  stubRoutes({
    "/api/jobs/job-mf/manifest": { json: JOB_MANIFEST },
    "/api/jobs/job-mf": { json: SUCCEEDED_JOB },
  });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(JobMonitor, { jobId: "job-mf" }));
  });
  await view.findByTestId("main-footage-metrics");

  const text = view.container.textContent ?? "";
  expect(text).not.toMatch(/[A-Za-z]:\\/);
  expect(text).not.toMatch(/(^|[^:\w])\/(home|Users|var|tmp)\//);
});

test("JobMonitor cleanup is disabled while the job is still running", async () => {
  stubRoutes({
    "/api/jobs/job-live/manifest": { json: {} },
    "/api/jobs/job-live": {
      json: { id: "job-live", status: "running", stage: "render", pct: 0.4, error: null },
    },
  });

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(JobMonitor, { jobId: "job-live" }));
  });

  const trigger = view.getByRole("button", { name: /Delete artifacts/i }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
});

test("JobMonitor cleanup calls the job endpoint once and reports irreversible removal", async () => {
  stubRoutes({
    "/api/jobs/job-mf/manifest": { json: JOB_MANIFEST },
    "/api/jobs/job-mf/cleanup": {
      json: { removed_files: 9, removed_bytes: 4096, recoverable: false },
    },
    "/api/jobs/job-mf": { json: SUCCEEDED_JOB },
  });
  const user = userEvent.setup();

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(createElement(JobMonitor, { jobId: "job-mf" }));
  });
  await view.findByTestId("main-footage-metrics");

  await user.click(view.getByRole("button", { name: /Delete artifacts/i }));
  await user.type(view.getByLabelText(/type job-mf to confirm/i), "job-mf");
  calls = [];
  await act(async () => {
    await user.click(view.getByRole("button", { name: /^Delete forever$/i }));
  });

  expect(calls.filter((c) => c.url === "/api/jobs/job-mf/cleanup")).toHaveLength(1);
  const result = view.getByTestId("cleanup-result").textContent ?? "";
  expect(result).toContain("9 files");
  expect(result).toMatch(/cannot be undone/i);
  // The manifest is re-read so the operator sees the now-empty artifact facts.
  expect(calls.some((c) => c.url === "/api/jobs/job-mf/manifest")).toBe(true);
});
