/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createProfileJob, getEffectiveSettings, migrateConfigToml } from "./api";

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

test("getEffectiveSettings gets the job effective-settings route", async () => {
  stub({ settings: { schema_version: 1 } });

  const result = await getEffectiveSettings("job-9");

  expect(calls[0].url).toBe("/api/jobs/job-9/effective-settings");
  expect(calls[0].init?.method ?? "GET").toBe("GET");
  expect(result?.settings.schema_version).toBe(1);
});

test("migrateConfigToml posts to the migration route and returns the report", async () => {
  stub({ imported: true, warnings: ["dropped: bgm_vibe"] });

  const report = await migrateConfigToml();

  expect(calls[0].url).toBe("/api/migrations/config-toml");
  expect(calls[0].init?.method).toBe("POST");
  expect(report).toEqual({ imported: true, warnings: ["dropped: bgm_vibe"] });
});
