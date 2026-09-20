/// <reference types="bun-types" />

import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import type { EditDocument, EditDocumentPatch } from "@/api/control-plane";
import { createC2ClientFixtureBase } from "./prompt-proposal-test-fixtures";
import { FakePlayer } from "./timeline-test-fixtures";
import type { PlayerTimelineRef } from "./usePlayerTimeline";

/** Installed by the player tests; the mocked preview hands it to Studio's ref. */
let previewPlayer: FakePlayer | null = null;

mock.module("./StudioPreview", () => ({
  StudioPreview: ({
    document,
    onPlayer,
  }: {
    document: EditDocument;
    onPlayer?: (player: PlayerTimelineRef | null) => void;
  }) => {
    // Published after commit, the way the real Player hands over its instance.
    useEffect(() => {
      onPlayer?.(previewPlayer);
      return () => onPlayer?.(null);
    }, [onPlayer]);
    return <div aria-label="Draft preview">{document.clips?.[0]?.kind}</div>;
  },
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
  previewPlayer = null;
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

const advancedClientBase = {
  listEditorAssets: mock(async () => ({ assets: [], next_cursor: null })),
  createEditorPreviewCapability: mock(async () => ({
    preview_url: "/api/v1/projects/project_001/editor-assets/asset_video/preview",
    expires_at: "2026-09-20T00:00:00Z",
  })),
};

async function renderTimelineStudio(
  document: EditDocument,
  patchEditDocument = mock(
    async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
      kind: "saved" as const,
      document,
    }),
  ),
) {
  const { GuidedStudio } = await import("./GuidedStudio");
  const view = render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        ...advancedClientBase,
        getEditDocument: mock(async () => document),
        patchEditDocument,
      }}
      projectId="project_001"
      documentId="document_001"
      onBack={() => {}}
    />,
  );
  await screen.findByLabelText("Timeline");
  // The preview publishes its player after commit, so let that render settle.
  await act(async () => {});
  return { view, patchEditDocument };
}

test("offers labelled Simple and Advanced modes for a version 2 document", async () => {
  const { upgradedTextDocument } = await import("./timeline-test-fixtures");
  await renderTimelineStudio(upgradedTextDocument() as EditDocument);

  const simple = screen.getByRole("button", { name: "Simple" });
  const advanced = screen.getByRole("button", { name: "Advanced" });
  expect(screen.getByLabelText("Editor mode")).toBeDefined();
  expect(advanced.getAttribute("aria-pressed")).toBe("true");
  expect(simple.getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(simple);

  expect(simple.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Scene board")).toBeDefined();
  expect(screen.getByLabelText("Heading")).toBeDefined();
  expect(screen.queryByLabelText("Timeline")).toBeNull();
  expect(screen.queryByLabelText("Asset library")).toBeNull();
});

test("hides the mode control for a version 1 document", async () => {
  const { GuidedStudio } = await import("./GuidedStudio");
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
  expect(screen.queryByLabelText("Editor mode")).toBeNull();
});

test("edits a version 2 text clip from Simple mode through the existing operations", async () => {
  const { upgradedTextDocument } = await import("./timeline-test-fixtures");
  const upgraded = upgradedTextDocument() as EditDocument;
  const patchEditDocument = mock(
    async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
      kind: "saved" as const,
      document: upgraded,
    }),
  );
  await renderTimelineStudio(upgraded, patchEditDocument);

  fireEvent.click(screen.getByRole("button", { name: "Simple" }));
  const heading = screen.getByLabelText("Heading") as HTMLInputElement;

  jest.useFakeTimers();
  fireEvent.change(heading, { target: { value: "Simple heading" } });
  expect(heading.value).toBe("Simple heading");
  act(() => jest.advanceTimersByTime(500));

  expect(patchEditDocument).toHaveBeenCalledTimes(1);
  const patch = patchEditDocument.mock.calls[0]![2];
  expect(patch.operations).toHaveLength(1);
  expect(patch.operations[0]).toMatchObject({
    kind: "replace_text",
    clip_id: "clip_001",
    field: "heading",
    value: "Simple heading",
  });
  expect(JSON.stringify(patch)).not.toContain("mode");
});

test("keeps unsaved version 2 edits across Simple, Advanced, and Prompt Lab", async () => {
  const { upgradedTextDocument } = await import("./timeline-test-fixtures");
  const upgraded = upgradedTextDocument() as EditDocument;
  const patchEditDocument = mock(() => new Promise<{ kind: "saved"; document: EditDocument }>(() => {}));
  await renderTimelineStudio(upgraded, patchEditDocument);

  fireEvent.click(screen.getByRole("button", { name: "Hide Overlay" }));
  fireEvent.click(screen.getByRole("button", { name: "Simple" }));
  fireEvent.change(screen.getByLabelText("Heading"), { target: { value: "Round trip heading" } });

  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("tab", { name: "Prompt Lab" }));
  fireEvent.click(screen.getByRole("tab", { name: "Scenes" }));
  fireEvent.click(screen.getByRole("button", { name: "Simple" }));

  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Round trip heading");
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  expect(screen.getByRole("button", { name: "Show Overlay" })).toBeDefined();
});

test("drives and follows the preview player from the timeline", async () => {
  const { timelineDocument } = await import("./timeline-test-fixtures");
  previewPlayer = new FakePlayer();
  await renderTimelineStudio(timelineDocument() as EditDocument);
  const player = previewPlayer;

  act(() => player.emit("frameupdate", { detail: { frame: 42 } }));
  expect((screen.getByLabelText("Playhead") as HTMLInputElement).value).toBe("42");

  fireEvent.change(screen.getByLabelText("Playhead"), { target: { value: "75" } });
  expect(player.seeks).toEqual([75]);
  expect((screen.getByLabelText("Playhead") as HTMLInputElement).value).toBe("75");

  fireEvent.click(screen.getByRole("button", { name: "Play preview" }));
  act(() => player.emit("play"));
  expect(player.calls).toEqual(["play"]);
  fireEvent.click(screen.getByRole("button", { name: "Pause preview" }));
  act(() => player.emit("pause"));
  expect(player.calls).toEqual(["play", "pause"]);
});

test("detaches every player listener when Studio unmounts", async () => {
  const { timelineDocument } = await import("./timeline-test-fixtures");
  previewPlayer = new FakePlayer();
  const { view } = await renderTimelineStudio(timelineDocument() as EditDocument);
  const player = previewPlayer;
  expect(player.listenerCount).toBeGreaterThan(0);

  view.unmount();

  expect(player.listenerCount).toBe(0);
});

const assetPage = (assetId: string, cursor: string | null) => ({
  assets: [
    {
      asset_id: assetId,
      project_id: "project_001",
      kind: "video" as const,
      media_type: "video/mp4",
      has_audio: true,
      validation_state: "ready" as const,
      duration_in_frames: 60,
    },
  ],
  next_cursor: cursor,
});

/** Two ready assets, one per page, in a Studio whose saves always succeed. */
async function renderPagedAssetStudio() {
  const { timelineDocument } = await import("./timeline-test-fixtures");
  const upgraded = timelineDocument() as EditDocument;
  const listEditorAssets = mock(async (_projectId: string, cursor?: string) =>
    cursor ? assetPage("asset_second", null) : assetPage("asset_first", "cursor_2"),
  );
  const patchEditDocument = mock(
    async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
      kind: "saved" as const,
      document: upgraded,
    }),
  );
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{
        ...promptClientBase,
        ...advancedClientBase,
        listEditorAssets,
        getEditDocument: mock(async () => upgraded),
        patchEditDocument,
      }}
      projectId="project_001"
      documentId="document_002"
      onBack={() => {}}
    />,
  );
  return { listEditorAssets, patchEditDocument };
}

/** Let the debounced autosave fire and its response settle. */
async function completeAutosave(act_: () => void) {
  jest.useFakeTimers();
  try {
    act_();
    act(() => jest.advanceTimersByTime(500));
  } finally {
    jest.useRealTimers();
  }
  await act(async () => {});
}

test("keeps a first-page asset addable after a second page loads", async () => {
  const { patchEditDocument } = await renderPagedAssetStudio();

  fireEvent.click(await screen.findByRole("button", { name: "Load more assets" }));
  expect(await screen.findByText("asset_second")).toBeDefined();
  expect(screen.getByText("asset_first")).toBeDefined();

  jest.useFakeTimers();
  try {
    fireEvent.click(screen.getByLabelText("Add asset_first to timeline"));
    act(() => jest.advanceTimersByTime(500));
    const patch = patchEditDocument.mock.calls[0]![2];
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({
      kind: "add_clip_from_asset",
      asset_id: "asset_first",
      track_id: "track_main",
    });
  } finally {
    jest.useRealTimers();
  }
});

test("stays in Simple mode after a version 2 autosave completes", async () => {
  const { upgradedTextDocument } = await import("./timeline-test-fixtures");
  const upgraded = upgradedTextDocument() as EditDocument;
  const patchEditDocument = mock(
    async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
      kind: "saved" as const,
      document: { ...upgraded, revision: upgraded.revision + 1 },
    }),
  );
  await renderTimelineStudio(upgraded, patchEditDocument);
  fireEvent.click(screen.getByRole("button", { name: "Simple" }));

  await completeAutosave(() =>
    fireEvent.change(screen.getByLabelText("Heading"), { target: { value: "Saved heading" } }),
  );

  expect(patchEditDocument).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
  expect(screen.getByRole("button", { name: "Simple" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Heading")).toBeDefined();
});

test("keeps a loaded asset addable after an earlier asset edit saves", async () => {
  const { patchEditDocument } = await renderPagedAssetStudio();
  fireEvent.click(await screen.findByRole("button", { name: "Load more assets" }));
  expect(await screen.findByText("asset_second")).toBeDefined();

  await completeAutosave(() => fireEvent.click(screen.getByLabelText("Add asset_first to timeline")));
  expect(patchEditDocument).toHaveBeenCalledTimes(1);

  await completeAutosave(() => fireEvent.click(screen.getByLabelText("Add asset_second to timeline")));

  expect(patchEditDocument).toHaveBeenCalledTimes(2);
  expect(patchEditDocument.mock.calls[1]![2].operations[0]).toMatchObject({
    kind: "add_clip_from_asset",
    asset_id: "asset_second",
  });
});
