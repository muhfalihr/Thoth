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
    narration: { enabled: true, language: null },
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
    ingest_source: { source: "https://seed.test/v", content_set: null },
    output: { directory: null },
    advanced: {},
  },
  created_at: "",
  updated_at: "",
};

// Same profile with no stored source — a run must supply a URL/content-set.
const P1_NO_SOURCE = {
  ...P1_PROFILE,
  settings: { ...P1_PROFILE.settings, ingest_source: { source: null, content_set: null } },
};

const P1_NARRATION_DISABLED = {
  ...P1_NO_SOURCE,
  settings: {
    ...P1_NO_SOURCE.settings,
    narration: { ...P1_NO_SOURCE.settings.narration, enabled: false },
  },
};

let profileList: unknown[] = [P1_PROFILE];
const listProfiles = mock(async () => profileList);
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
  profileList = [P1_PROFILE];
  listProfiles.mockClear();
  createProfileJob.mockClear();
  updateProfile.mockClear();
});

test("run sends profile_id + typed overrides and never mutates the profile", async () => {
  const user = userEvent.setup();
  const onCreated = mock(() => {});
  const { RunForm } = await import("./RunForm");

  render(<RunForm projectId="p1" onCreated={onCreated} />);

  await user.click(await screen.findByLabelText("Profile"));
  await user.click(await screen.findByRole("option", { name: "Default" }));
  await user.click(screen.getByRole("button", { name: /overrides for this run/i }));
  await user.click(screen.getByLabelText("Layout"));
  await user.click(await screen.findByRole("option", { name: "horizontal" }));
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

test("run with no source (profile has none, no URL/content-set) shows an error and never posts", async () => {
  profileList = [P1_NO_SOURCE];
  const user = userEvent.setup();
  const { RunForm } = await import("./RunForm");
  render(<RunForm projectId="p1" onCreated={mock(() => {})} />);
  await screen.findByText("Default");

  await user.click(screen.getByRole("button", { name: /^run$/i }));

  expect(createProfileJob).not.toHaveBeenCalled();
  expect(await screen.findByText(/provide a URL or content-set/i)).toBeDefined();
});

test("forced handoff with effective narrator mode disabled is rejected locally", async () => {
  profileList = [P1_NARRATION_DISABLED];
  const user = userEvent.setup();
  const { RunForm } = await import("./RunForm");
  render(
    <RunForm
      projectId="p1"
      onCreated={() => {}}
      initialContentSet="scout/output/forced.json"
      initialContentSetForced
    />,
  );
  await screen.findByText("Default");

  await user.click(screen.getByRole("button", { name: /^run$/i }));

  expect(createProfileJob).not.toHaveBeenCalled();
  expect(
    await screen.findByText("Narrator mode is required for URL main footage."),
  ).toBeDefined();
});

test("forced handoff respects a one-off narrator disable override", async () => {
  profileList = [P1_NO_SOURCE];
  const user = userEvent.setup();
  const { RunForm } = await import("./RunForm");
  render(
    <RunForm
      projectId="p1"
      onCreated={() => {}}
      initialContentSet="scout/output/forced.json"
      initialContentSetForced
    />,
  );
  await screen.findByText("Default");
  await user.click(screen.getByRole("button", { name: /overrides for this run/i }));
  await user.click(screen.getByLabelText("Narrator mode"));
  await user.click(await screen.findByRole("option", { name: "disabled" }));

  await user.click(screen.getByRole("button", { name: /^run$/i }));

  expect(createProfileJob).not.toHaveBeenCalled();
  expect(
    await screen.findByText("Narrator mode is required for URL main footage."),
  ).toBeDefined();
});

test("forced handoff can enable narrator mode for one run", async () => {
  profileList = [P1_NARRATION_DISABLED];
  const user = userEvent.setup();
  const { RunForm } = await import("./RunForm");
  render(
    <RunForm
      projectId="p1"
      onCreated={() => {}}
      initialContentSet="scout/output/forced.json"
      initialContentSetForced
    />,
  );
  await screen.findByText("Default");
  await user.click(screen.getByRole("button", { name: /overrides for this run/i }));
  await user.click(screen.getByLabelText("Narrator mode"));
  await user.click(await screen.findByRole("option", { name: "enabled" }));

  await user.click(screen.getByRole("button", { name: /^run$/i }));

  expect(createProfileJob).toHaveBeenCalledTimes(1);
  expect(createProfileJob.mock.calls[0][1].overrides).toEqual({
    narration_enabled: true,
    ingest_source_content_set: "scout/output/forced.json",
  });
});

test("manual content-set paths map the authoritative narration error", async () => {
  profileList = [P1_NARRATION_DISABLED];
  createProfileJob.mockImplementationOnce(async () => {
    throw new Error("createProfileJob: forced_main_narration_required");
  });
  const user = userEvent.setup();
  const { RunForm } = await import("./RunForm");
  render(<RunForm projectId="p1" onCreated={() => {}} />);
  await screen.findByText("Default");
  await user.type(screen.getByLabelText(/content-set path/i), "scout/output/manual.json");

  await user.click(screen.getByRole("button", { name: /^run$/i }));

  expect(
    await screen.findByText("Narrator mode is required for URL main footage."),
  ).toBeDefined();
});
