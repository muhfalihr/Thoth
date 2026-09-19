/// <reference types="bun-types" />

import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EditDocument, EditDocumentPatch, EditDocumentV1 } from "@/api/control-plane";
import { createC2ClientFixtureBase } from "./prompt-proposal-test-fixtures";

mock.module("./StudioPreview", () => ({
  StudioPreview: ({ document }: { document: EditDocumentV1 }) => (
    <div aria-label="Draft preview">{document.clips[0]?.heading}</div>
  ),
}));

const promptClientBase = createC2ClientFixtureBase();

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

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test("renders labelled Inspector fields and keyboard-visible editing controls", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const client = {
    ...promptClientBase,
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
      client={{ ...promptClientBase, getEditDocument: mock(async () => document), patchEditDocument }}
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
      client={{ ...promptClientBase, getEditDocument: mock(async () => document), patchEditDocument }}
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
        ...promptClientBase,
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

test("associates a safe inline validation message with a blank heading", async () => {
  const patchEditDocument = mock(async () => ({ kind: "saved" as const, document }));
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ ...promptClientBase, getEditDocument: mock(async () => document), patchEditDocument }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  jest.useFakeTimers();
  try {
    fireEvent.change(heading, { target: { value: "   " } });
    const message = screen.getByText("Heading is required before saving.");
    expect(heading.getAttribute("aria-invalid")).toBe("true");
    expect(heading.getAttribute("aria-describedby")).toBe(message.id);
    act(() => jest.advanceTimersByTime(500));
    expect(patchEditDocument).toHaveBeenCalledTimes(0);
  } finally {
    jest.useRealTimers();
  }
});

test("switches between Scenes and Prompt Lab tabs and preserves both drafts", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  const patchEditDocument = mock(async (_projectId: string, _documentId: string, patch: EditDocumentPatch) => {
    let saved: EditDocument = { ...document, revision: document.revision + 1 };
    for (const op of patch.operations) {
      if (op.kind === "replace_text") {
        saved = {
          ...saved,
          clips: saved.clips.map((c) =>
            c.clip_id === op.clip_id
              ? { ...c, [op.field]: op.value, ownership: "user_edited" as const }
              : c,
          ),
        };
      }
    }
    return { kind: "saved" as const, document: saved };
  });
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument,
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  const heading = await screen.findByLabelText("Heading");
  const scenesTab = screen.getByRole("tab", { name: "Scenes" });
  const promptTab = screen.getByRole("tab", { name: "Prompt Lab" });

  expect(scenesTab.getAttribute("aria-selected")).toBe("true");
  expect(promptTab.getAttribute("aria-selected")).toBe("false");
  expect(scenesTab.tagName).toBe("BUTTON");
  expect(promptTab.tagName).toBe("BUTTON");

  await user.type(heading, "Kept heading");
  await user.click(promptTab);

  expect(promptTab.getAttribute("aria-selected")).toBe("true");
  expect(scenesTab.getAttribute("aria-selected")).toBe("false");
  const override = (await screen.findByLabelText(
    "Project override",
  )) as HTMLTextAreaElement;
  await user.clear(override);
  await user.type(override, "Keep it concise");

  await user.click(scenesTab);
  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Original headingKept heading");

  await user.click(promptTab);
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Keep it concise");
});

test("keeps both tab panels mounted and toggles only the native hidden attribute", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const user = userEvent.setup();
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  await screen.findByLabelText("Heading");
  const scenesPanel = screen.getByRole("tabpanel", { name: "Scenes", hidden: true });
  const promptPanel = globalThis.document.getElementById(
    "studio-panel-prompts",
  ) as HTMLElement;

  expect(scenesPanel.hidden).toBe(false);
  expect(promptPanel.hidden).toBe(true);
  expect(globalThis.document.getElementById("studio-panel-scenes")).toBe(scenesPanel);
  expect(globalThis.document.getElementById("studio-panel-prompts")).toBe(promptPanel);

  await user.click(screen.getByRole("tab", { name: "Prompt Lab" }));

  expect(scenesPanel.hidden).toBe(true);
  expect(promptPanel.hidden).toBe(false);
  expect(globalThis.document.getElementById("studio-panel-scenes")).toBe(scenesPanel);
  expect(globalThis.document.getElementById("studio-panel-prompts")).toBe(promptPanel);
});

test("offers an explicit upgrade for a version 1 document and writes nothing on open", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const upgradeEditDocument = mock(async () => ({ kind: "saved" as const, document }));
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
        upgradeEditDocument,
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );

  expect(await screen.findByRole("button", { name: "Enable advanced timeline" })).toBeDefined();
  expect(screen.getByText(/scenes, text, and history/i)).toBeDefined();
  expect(upgradeEditDocument).toHaveBeenCalledTimes(0);
  expect(screen.queryByLabelText("Timeline")).toBeNull();
});

test("upgrades once for a double click and then opens the advanced timeline", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const { timelineDocument } = await import("./timeline-test-fixtures");
  const upgraded = timelineDocument();
  let release: (value: { kind: "saved"; document: EditDocument }) => void = () => {};
  const upgradeEditDocument = mock(
    () =>
      new Promise<{ kind: "saved"; document: EditDocument }>((resolve) => {
        release = resolve;
      }),
  );
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
        upgradeEditDocument,
        listEditorAssets: mock(async () => ({ assets: [], next_cursor: null })),
        createEditorPreviewCapability: mock(async () => ({
          preview_url: "/api/v1/projects/project_001/editor-assets/asset_video/preview",
          expires_at: "2026-09-20T00:00:00Z",
        })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );

  const upgrade = await screen.findByRole("button", { name: "Enable advanced timeline" });
  fireEvent.click(upgrade);
  fireEvent.click(upgrade);
  expect(upgradeEditDocument).toHaveBeenCalledTimes(1);

  await act(async () => {
    release({ kind: "saved", document: upgraded });
  });
  expect(await screen.findByLabelText("Timeline")).toBeDefined();
  expect(screen.getByLabelText("Asset library")).toBeDefined();
  expect(screen.getByLabelText("Timeline inspector")).toBeDefined();
  expect(screen.queryByLabelText("Scene board")).toBeNull();
});

test("shows the conflict choice instead of upgrading over a newer revision", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const latest = { ...document, revision: 7 };
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
        upgradeEditDocument: mock(async () => ({ kind: "conflict" as const, latest })),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Enable advanced timeline" }));
  expect(await screen.findByText(/A newer version exists/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Reload Latest" })).toBeDefined();
});

test("keeps the version 1 document editable when the upgrade fails", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
        upgradeEditDocument: mock(async () => {
          throw new Error("offline");
        }),
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Enable advanced timeline" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not enable");

  const heading = screen.getByLabelText("Heading");
  fireEvent.change(heading, { target: { value: "Still editable" } });
  expect((heading as HTMLInputElement).value).toBe("Still editable");
  expect(screen.getByRole("button", { name: "Enable advanced timeline" })).toBeDefined();
});

test("keeps Prompt Lab reachable from an advanced document", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
  const { timelineDocument } = await import("./timeline-test-fixtures");
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => timelineDocument() as EditDocument),
        patchEditDocument: mock(async () => ({ kind: "saved" as const, document })),
        listEditorAssets: mock(async () => ({ assets: [], next_cursor: null })),
        createEditorPreviewCapability: mock(async () => ({
          preview_url: "/api/v1/projects/project_001/editor-assets/asset_video/preview",
          expires_at: "2026-09-20T00:00:00Z",
        })),
      }}
      projectId="project_001"
      documentId="document_002"
      onBack={() => {}}
    />,
  );

  expect(await screen.findByLabelText("Timeline")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Enable advanced timeline" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Prompt Lab" }));
  expect(screen.getByRole("tabpanel", { name: "Prompt Lab" }).hasAttribute("hidden")).toBe(false);
});

/** Mount an advanced document with a client that always answers. */
async function mountAdvanced(overrides: Record<string, unknown> = {}) {
  const { GuidedStudio } = await import("./GuidedStudio");
  const { timelineDocument } = await import("./timeline-test-fixtures");
  const patchEditDocument = mock(
    async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
      kind: "saved" as const,
      document: timelineDocument() as EditDocument,
    }),
  );
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        getEditDocument: mock(async () => timelineDocument() as EditDocument),
        patchEditDocument,
        listEditorAssets: mock(async () => ({ assets: [], next_cursor: null })),
        createEditorPreviewCapability: mock(async () => ({
          preview_url: "/api/v1/projects/project_001/editor-assets/asset_video/preview",
          expires_at: "2026-09-20T00:00:00Z",
        })),
        ...overrides,
      }}
      projectId="project_001"
      documentId="document_002"
      onBack={() => {}}
    />,
  );
  await screen.findByLabelText("Timeline");
  return { patchEditDocument };
}

test("autosaves a timeline edit through the same patch path", async () => {
  const { patchEditDocument } = await mountAdvanced();
  jest.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Mute Music" }));
    expect(screen.getByText("Unsaved changes")).toBeDefined();
    act(() => jest.advanceTimersByTime(500));
    expect(patchEditDocument).toHaveBeenCalledTimes(1);
    const patch = patchEditDocument.mock.calls[0]![2];
    expect(patch.operations.map((operation) => operation.kind)).toEqual(["set_track_muted"]);
  } finally {
    jest.useRealTimers();
  }
});

test("keeps an unsaved timeline edit across a Prompt Lab round trip", async () => {
  await mountAdvanced();
  fireEvent.click(screen.getByRole("button", { name: "Mute Music" }));
  fireEvent.click(screen.getByRole("tab", { name: "Prompt Lab" }));
  fireEvent.click(screen.getByRole("tab", { name: "Scenes" }));

  expect(screen.getByRole("button", { name: "Unmute Music" })).toBeDefined();
  expect(screen.getByText("Unsaved changes")).toBeDefined();
});

test("an unavailable asset library leaves the timeline editable", async () => {
  await mountAdvanced({
    listEditorAssets: mock(async () => {
      throw new Error("offline");
    }),
  });

  expect((await screen.findByRole("alert")).textContent).toContain("Assets are unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Mute Music" }));
  expect(screen.getByRole("button", { name: "Unmute Music" })).toBeDefined();
});
