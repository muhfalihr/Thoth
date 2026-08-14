/// <reference types="bun-types" />

import "./test-setup";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import { Discovery } from "./components/Discovery";
import { createProfileJob, getEffectiveSettings, migrateConfigToml, scoutRun, updateProfile } from "./api";

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
  stub({ ok: true }, 202);
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
