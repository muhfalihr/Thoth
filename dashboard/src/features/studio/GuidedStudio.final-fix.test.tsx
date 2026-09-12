/// <reference types="bun-types" />

import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EditDocument, EditDocumentPatch } from "@/api/control-plane";

mock.module("./StudioPreview", () => ({
  StudioPreview: ({ document }: { document: EditDocument }) => (
    <div aria-label="Draft preview">{document.clips[0]?.heading}</div>
  ),
}));

const editDocument = {
  schema_version: 1,
  document_id: "document_001",
  project_id: "project_001",
  revision: 1,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 150 },
  template: { template_id: "vertical_text_story", version: 1 },
  tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: ["clip_001"] }],
  scenes: [
    {
      scene_id: "scene_001",
      role: "title",
      start_frame: 0,
      duration_in_frames: 150,
      clip_ids: ["clip_001"],
    },
  ],
  clips: [
    {
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
    },
  ],
} satisfies EditDocument;

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

afterEach(() => {
  cleanup();
  setOnline(true);
  jest.useRealTimers();
});

test("prefixes generated operation IDs for the backend OpaqueId contract", async () => {
  const patchEditDocument = mock(async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
    kind: "saved" as const,
    document: editDocument,
  }));
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ getEditDocument: mock(async () => editDocument), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");

  jest.useFakeTimers();
  fireEvent.change(heading, { target: { value: "Edited heading" } });
  act(() => jest.advanceTimersByTime(500));

  const patch = patchEditDocument.mock.calls[0][2];
  const operationId = patch.operations[0].operation_id;
  expect(operationId.startsWith("op_")).toBe(true);
  expect(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(operationId)).toBe(true);
});

test("keeps Back disabled for an unsaved draft and enables it only after save", async () => {
  let resolveSave: (value: { kind: "saved"; document: EditDocument }) => void = () => {};
  const savedDocument = {
    ...editDocument,
    revision: 2,
    clips: [{ ...editDocument.clips[0], heading: "Edited heading", ownership: "user_edited" as const }],
  };
  const patchEditDocument = mock(
    () =>
      new Promise<{ kind: "saved"; document: EditDocument }>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const onBack = mock(() => {});
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ getEditDocument: mock(async () => editDocument), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={onBack}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;

  jest.useFakeTimers();
  expect(back.disabled).toBe(false);
  fireEvent.change(heading, { target: { value: "Edited heading" } });
  expect(back.disabled).toBe(true);
  expect(globalThis.document.getElementById(back.getAttribute("aria-describedby") ?? "")?.textContent).toContain(
    "saved",
  );
  fireEvent.click(back);
  expect(onBack).toHaveBeenCalledTimes(0);

  act(() => jest.advanceTimersByTime(500));
  expect(back.disabled).toBe(true);
  await act(async () => {
    resolveSave({ kind: "saved", document: savedDocument });
    await Promise.resolve();
  });

  expect(back.disabled).toBe(false);
  fireEvent.click(back);
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("keeps conflict recovery active through local edit and undo without stale-base autosave", async () => {
  const latest = {
    ...editDocument,
    revision: 2,
    clips: [{ ...editDocument.clips[0], heading: "Remote heading" }],
  };
  const patchEditDocument = mock(async () => ({ kind: "conflict" as const, latest }));
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ getEditDocument: mock(async () => editDocument), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");

  jest.useFakeTimers();
  fireEvent.change(heading, { target: { value: "Local heading" } });
  await act(async () => {
    jest.advanceTimersByTime(500);
    await Promise.resolve();
  });
  expect(patchEditDocument).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Conflict")).toBeDefined();

  fireEvent.change(heading, { target: { value: "Local heading again" } });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  act(() => jest.advanceTimersByTime(1_000));

  expect(screen.getByText("Conflict")).toBeDefined();
  expect(screen.getByRole("button", { name: "Reload Latest" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Keep Editing Locally" })).toBeDefined();
  expect(patchEditDocument).toHaveBeenCalledTimes(1);
});

test("retains pending edits offline and resumes dirty autosave on reconnect", async () => {
  const patchEditDocument = mock(async () => ({ kind: "saved" as const, document: editDocument }));
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ getEditDocument: mock(async () => editDocument), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");

  jest.useFakeTimers();
  setOnline(false);
  act(() => window.dispatchEvent(new Event("offline")));
  expect(screen.getByText("Offline")).toBeDefined();

  fireEvent.change(heading, { target: { value: "Offline heading" } });
  expect((heading as HTMLInputElement).value).toBe("Offline heading");
  act(() => jest.advanceTimersByTime(1_000));
  expect(patchEditDocument).toHaveBeenCalledTimes(0);

  setOnline(true);
  act(() => window.dispatchEvent(new Event("online")));
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  act(() => jest.advanceTimersByTime(500));
  expect(patchEditDocument).toHaveBeenCalledTimes(1);
});

test("exposes native labelled controls for the resizable three-region workstation", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{
        getEditDocument: mock(async () => editDocument),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document: editDocument })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );

  await screen.findByLabelText("Heading");
  const workstation = screen.getByLabelText("Guided editing workstation");
  const sceneWidth = screen.getByLabelText("Scene board width") as HTMLInputElement;
  const inspectorWidth = screen.getByLabelText("Inspector width") as HTMLInputElement;
  expect(sceneWidth.type).toBe("range");
  expect(inspectorWidth.type).toBe("range");
  expect(screen.getByLabelText("Draft preview")).toBeDefined();

  fireEvent.change(sceneWidth, { target: { value: "18" } });
  fireEvent.change(inspectorWidth, { target: { value: "24" } });

  expect(workstation.getAttribute("style")).toContain("--scene-board-width: 18rem");
  expect(workstation.getAttribute("style")).toContain("--inspector-width: 24rem");
  expect(screen.getByLabelText("Draft preview")).toBeDefined();
});
