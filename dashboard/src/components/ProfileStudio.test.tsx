/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createProfile = mock(async (_projectId: string, body: Record<string, unknown>) => ({
  id: "new-1",
  ...body,
}));
const updateProfile = mock(async () => ({ id: "p" }));
const listProfiles = mock(async () => [] as unknown[]);
const duplicateProfile = mock(async () => ({ id: "dup" }));
const validateProfile = mock(async () => ({ valid: true }));
const listProfileRevisions = mock(async () => [] as unknown[]);
const restoreProfileRevision = mock(async () => ({ id: "p" }));

// bun's mock.module doesn't apply tsconfig path aliases to its own specifier,
// so target api.ts by a relative path that resolves to the same absolute file
// the component's `@/api` import resolves to.
mock.module("../api", () => ({
  createProfile,
  updateProfile,
  listProfiles,
  duplicateProfile,
  validateProfile,
  listProfileRevisions,
  restoreProfileRevision,
  PROVIDERS: ["novita", "groq"],
  WHISPER_MODELS: ["medium", "large-v3"],
  LAYOUTS: ["vertical", "horizontal", "square"],
  CLIP_STYLES: ["fade", "flash"],
}));

afterEach(() => {
  cleanup();
  createProfile.mockClear();
  listProfiles.mockClear();
});

test("creating a profile posts the typed name + settings via createProfile", async () => {
  const user = userEvent.setup();
  const onProfileChanged = mock(() => {});
  const { ProfileStudio } = await import("./ProfileStudio");

  render(<ProfileStudio projectId="p1" onProfileChanged={onProfileChanged} />);

  await user.click(await screen.findByRole("button", { name: /new profile/i }));
  expect(listProfiles).toHaveBeenCalled();
  const nameInput = screen.getByLabelText("Profile name") as HTMLInputElement;
  await user.type(nameInput, "Berita Indonesian");
  expect(nameInput.value).toBe("Berita Indonesian");
  await user.selectOptions(screen.getByLabelText("Layout"), "horizontal");
  await user.click(screen.getByRole("button", { name: /save profile/i }));

  expect(createProfile).toHaveBeenCalledTimes(1);
  const [projectId, body] = createProfile.mock.calls[0] as [string, Record<string, any>];
  expect(projectId).toBe("p1");
  expect(body).toMatchObject({ name: "Berita Indonesian" });
  expect(body.settings.visual_edit.layout).toBe("horizontal");
  expect(onProfileChanged).toHaveBeenCalled();
});

test("shows an empty state before any profile is selected", async () => {
  const { ProfileStudio } = await import("./ProfileStudio");
  render(<ProfileStudio projectId="p1" onProfileChanged={() => {}} />);

  expect(await screen.findByText(/no profile selected/i)).toBeDefined();
});
