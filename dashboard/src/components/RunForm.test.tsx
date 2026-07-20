/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const P1_PROFILE = {
  id: "profile-1",
  project_id: "p1",
  name: "Default",
  description: "",
  credential_ref: null,
  settings: {
    schema_version: 1,
    narration: { language: null },
    visual_edit: {
      layout: "vertical",
      clip_style: "fade",
      style_profile: "auto",
      social: "",
      bgm: null,
      bgm_volume: 0.12,
      sfx_intro: null,
      headline_dur: 4,
    },
    analysis: { provider: "novita", model: "medium", max_clips: 3, keywords: [] },
    ingest_source: { source: null, content_set: null },
    output: { directory: null },
    advanced: {},
  },
  created_at: "",
  updated_at: "",
};

const listProfiles = mock(async () => [P1_PROFILE] as unknown[]);
const createProfileJob = mock(
  async (_projectId: string, _req: { profile_id: string; overrides: Record<string, unknown> }) => ({ job_id: "job-1" }),
);
const updateProfile = mock(async () => ({ id: "profile-1" }));

// Same alias gotcha as ProfileStudio.test: mock.module doesn't apply tsconfig
// path aliases to its own specifier, so target api.ts by the relative path that
// resolves to the same absolute file the component's `@/api` import resolves to.
mock.module("../api", () => ({
  listProfiles,
  createProfileJob,
  updateProfile,
  PROVIDERS: ["novita", "groq"],
  WHISPER_MODELS: ["medium", "large-v3"],
  LAYOUTS: ["vertical", "horizontal", "square"],
  CLIP_STYLES: ["fade", "flash"],
}));

afterEach(() => {
  cleanup();
  listProfiles.mockClear();
  createProfileJob.mockClear();
  updateProfile.mockClear();
});

test("run sends profile_id + typed overrides and never mutates the profile", async () => {
  const user = userEvent.setup();
  const onCreated = mock(() => {});
  const { RunForm } = await import("./RunForm");

  render(<RunForm projectId="p1" onCreated={onCreated} />);

  await user.selectOptions(await screen.findByLabelText("Profile"), "profile-1");
  await user.click(screen.getByRole("button", { name: /overrides for this run/i }));
  await user.selectOptions(screen.getByLabelText("Layout"), "horizontal");
  await user.click(screen.getByRole("button", { name: /^run$/i }));

  expect(createProfileJob).toHaveBeenCalledTimes(1);
  const [pid, req] = createProfileJob.mock.calls[0];
  expect(pid).toBe("p1");
  expect(req.profile_id).toBe("profile-1");
  // Only the changed field is sent; overrides never mutate the profile.
  expect(req.overrides).toEqual({ visual_edit_layout: "horizontal" });
  expect(updateProfile).not.toHaveBeenCalled();
  expect(onCreated).toHaveBeenCalledWith("job-1");
});
