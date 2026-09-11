/// <reference types="bun-types" />

import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EditDocument } from "@/api/control-plane";

mock.module("./StudioPreview", () => ({
  StudioPreview: ({ document }: { document: EditDocument }) => (
    <div aria-label="Draft preview">{document.clips[0]?.heading}</div>
  ),
}));

const document = {
  schema_version: 1,
  document_id: "document_001",
  project_id: "project_001",
  revision: 1,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 150 },
  template: { template_id: "vertical_text_story", version: 1 },
  tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: ["clip_001"] }],
  scenes: [{ scene_id: "scene_001", role: "title", start_frame: 0, duration_in_frames: 150, clip_ids: ["clip_001"] }],
  clips: [{
    kind: "text",
    clip_id: "clip_001",
    scene_id: "scene_001",
    track_id: "track_visual",
    start_frame: 0,
    duration_in_frames: 150,
    heading: "Original heading",
    body: "Original body",
    ownership: "ai_managed",
    style_slot: "title",
  }],
} satisfies EditDocument;

afterEach(() => cleanup());

test("renders labelled Inspector fields and keyboard-visible editing controls", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const client = {
    getEditDocument: mock(async () => document),
    patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
  };

  render(<GuidedStudio client={client} projectId="project_001" documentId="document_001" onBack={() => {}} />);

  expect(await screen.findByLabelText("Heading")).toBeDefined();
  expect(screen.getByLabelText("Body")).toBeDefined();
  expect(screen.getByLabelText("Ownership")).toBeDefined();
  expect(screen.getByLabelText("Duration (frames)")).toBeDefined();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Redo" })).toBeDefined();
  expect(screen.getByText("Saved")).toBeDefined();
});

test("autosaves after 500ms and reports Saving then Saved", async () => {
  let resolveSave: (value: { kind: "saved"; document: EditDocument }) => void = () => {};
  const patchEditDocument = mock(
    () => new Promise<{ kind: "saved"; document: EditDocument }>((resolve) => { resolveSave = resolve; }),
  );
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ getEditDocument: mock(async () => document), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  jest.useFakeTimers();
  try {
    fireEvent.change(heading, { target: { value: "Edited heading" } });
    act(() => jest.advanceTimersByTime(499));
    expect(patchEditDocument).toHaveBeenCalledTimes(0);
    act(() => jest.advanceTimersByTime(1));
    expect(patchEditDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saving")).toBeDefined();
    const savedDocument = {
      ...document,
      revision: 2,
      clips: [{ ...document.clips[0], heading: "Edited heading", ownership: "user_edited" as const }],
    };
    await act(async () => { resolveSave({ kind: "saved", document: savedDocument }); });
    expect(screen.getByText("Saved")).toBeDefined();
  } finally {
    jest.useRealTimers();
  }
});

test("shows safe Retry guidance after a failed save without rendering the raw error", async () => {
  const rawError = "database password=do-not-render";
  const patchEditDocument = mock(async () => { throw new Error(rawError); });
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  render(
    <GuidedStudio
      client={{ getEditDocument: mock(async () => document), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  await user.type(heading, " updated");

  expect((await screen.findByRole("alert", {}, { timeout: 1_000 })).textContent).toContain("Your edits are still here");
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  expect(screen.queryByText(rawError)).toBeNull();
});

test("keeps the local draft on conflict and offers both explicit recovery actions", async () => {
  const latest = {
    ...document,
    revision: 2,
    clips: [{ ...document.clips[0], heading: "Remote heading" }],
  };
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  render(
    <GuidedStudio
      client={{
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "conflict" as const, latest })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  await user.clear(heading);
  await user.type(heading, "Local heading");

  expect(await screen.findByText("Conflict", {}, { timeout: 1_000 })).toBeDefined();
  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Local heading");
  expect(screen.getByRole("button", { name: "Reload Latest" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Keep Editing Locally" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Reload Latest" }));
  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Remote heading");
});
