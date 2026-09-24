/// <reference types="bun-types" />

import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { EditDocument, EditDocumentPatch } from "@/api/control-plane";
import { createC2ClientFixtureBase } from "./prompt-proposal-test-fixtures";
import { FakePlayer, timelineDocument, upgradedTextDocument } from "./timeline-test-fixtures";
import type { PlayerTimelineRef } from "./usePlayerTimeline";

let previewPlayer: FakePlayer | null = null;
let previewMounts = 0;

mock.module("./StudioPreview", () => ({
  StudioPreview: ({
    document,
    onPlayer,
  }: {
    document: EditDocument;
    onPlayer?: (player: PlayerTimelineRef | null) => void;
  }) => {
    useEffect(() => {
      previewMounts += 1;
    }, []);
    useEffect(() => {
      onPlayer?.(previewPlayer);
      return () => onPlayer?.(null);
    }, [onPlayer]);
    const text = document.clips?.find((clip) => clip.kind === "text");
    return <div aria-label="Draft preview">{text && "heading" in text ? text.heading : document.clips?.[0]?.kind}</div>;
  },
}));

const promptClientBase = createC2ClientFixtureBase();
const initialWidth = window.innerWidth;

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

function resize(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  previewPlayer = null;
  previewMounts = 0;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWidth });
});

/** A save that never settles keeps the draft dirty for as long as the test needs. */
const pendingSave = mock(
  (_projectId: string, _documentId: string, _patch: EditDocumentPatch) =>
    new Promise<{ kind: "saved"; document: EditDocument }>(() => {}),
);

async function renderStudio(width: number, editDocument: EditDocument = document, patchEditDocument = pendingSave) {
  resize(width);
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ ...promptClientBase, getEditDocument: mock(async () => editDocument), patchEditDocument }}
      projectId="project_001"
      documentId={editDocument.document_id}
      onBack={() => {}}
    />,
  );
  await screen.findByLabelText("Draft preview");
}

// Bun pretty-prints a mismatched DOM node without bound, so assertions compare booleans.
const isHidden = (element: Element) => element.closest("[hidden]") !== null;
const pane = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

test("offers compact panes only below desktop width and keeps width controls on desktop", async () => {
  await renderStudio(375);
  expect(screen.getByRole("navigation", { name: "Studio panes" })).toBeDefined();
  expect(screen.queryByRole("tablist", { name: "Studio workspace" }) === null).toBe(true);
  expect(screen.queryByLabelText("Scene board width") === null).toBe(true);
  expect(screen.getByText("Saved")).toBeDefined();

  resize(768);
  expect(screen.getByRole("navigation", { name: "Studio panes" })).toBeDefined();
  expect(screen.queryByLabelText("Inspector width") === null).toBe(true);

  resize(1024);
  expect(screen.queryByRole("navigation", { name: "Studio panes" }) === null).toBe(true);
  expect(screen.getByRole("tablist", { name: "Studio workspace" })).toBeDefined();
  expect(screen.getByLabelText("Scene board width")).toBeDefined();

  resize(1440);
  expect(screen.getByLabelText("Inspector width")).toBeDefined();
});

test("keeps one preview mounted across every viewport", async () => {
  await renderStudio(1024);
  for (const width of [375, 900, 1440, 1024]) {
    resize(width);
    expect(screen.getAllByLabelText("Draft preview").length).toBe(1);
  }
  expect(previewMounts).toBe(1);
});

test("shows one pane at a time on a phone and keeps hidden panes out of the tab order", async () => {
  await renderStudio(375);
  const heading = screen.getByLabelText("Heading");
  expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-current")).toBe("page");
  expect(isHidden(heading)).toBe(true);
  expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(false);

  pane("Edit");
  expect(isHidden(heading)).toBe(false);
  expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(true);
});

test("keeps an unsaved Prompt Lab edit across pane and viewport changes", async () => {
  await renderStudio(375);
  pane("Prompt Lab");
  const override = (await screen.findByLabelText("Project override")) as HTMLTextAreaElement;
  fireEvent.change(override, { target: { value: "Local draft" } });

  pane("Preview");
  pane("Prompt Lab");
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Local draft");

  resize(1440);
  expect(screen.getByRole("tab", { name: "Prompt Lab" }).getAttribute("aria-selected")).toBe("true");
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Local draft");
});

test("pauses the preview when its pane is hidden and does not resume on return", async () => {
  previewPlayer = new FakePlayer();
  await renderStudio(375);
  const player = previewPlayer;

  pane("Edit");
  expect(player.calls).toEqual(["pause"]);
  pane("Preview");
  pane("Review");
  expect(player.calls).toEqual(["pause"]);
});

test("reviews the saved revision while the draft keeps its unsaved edit", async () => {
  await renderStudio(375);
  pane("Edit");
  fireEvent.change(screen.getByLabelText("Heading"), { target: { value: "Draft heading" } });
  expect(screen.getByText("Unsaved changes")).toBeDefined();

  pane("Review");
  expect(screen.getByLabelText("Draft preview").textContent).toBe("Original heading");
  expect(screen.getByText("Reviewing saved revision 1")).toBeDefined();

  pane("Preview");
  expect(screen.getByLabelText("Draft preview").textContent).toBe("Draft heading");
});

test("keeps Advanced mode, a pending timeline edit, and the selection through a phone round trip", async () => {
  const saved = mock(async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
    kind: "saved" as const,
    document: timelineDocument() as EditDocument,
  }));
  await renderStudio(1440, timelineDocument() as EditDocument, saved);
  await screen.findByLabelText("Timeline");
  jest.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Music clip" }));
  fireEvent.click(screen.getByRole("button", { name: "Mute Music" }));
  expect(screen.getByText("Unsaved changes")).toBeDefined();

  resize(375);
  expect(screen.queryByLabelText("Timeline") === null).toBe(true);
  expect(screen.queryByRole("group", { name: "Editor mode" }) === null).toBe(true);
  expect(screen.getByText(/Advanced timeline editing needs a desktop-width screen/)).toBeDefined();
  expect(screen.getByText("Unsaved changes")).toBeDefined();

  resize(900);
  pane("Scenes");
  expect(screen.getByLabelText("Scene board")).toBeDefined();
  expect(screen.queryByLabelText("Asset library") === null).toBe(true);

  resize(1440);
  expect(screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Unmute Music" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Music clip" }).getAttribute("aria-pressed")).toBe("true");

  act(() => jest.advanceTimersByTime(500));
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0]![2].operations.map((operation) => operation.kind)).toEqual(["set_track_muted"]);
});

/** The upgraded text story plus one caption clip over its only scene. */
function captionDocument(): EditDocument {
  const document = upgradedTextDocument();
  document.tracks.push({
    track_id: "track_captions",
    kind: "caption",
    label: "Captions",
    order: 4,
    hidden: false,
    muted: false,
    locked: false,
    clip_ids: ["clip_caption"],
  });
  document.clips!.push({
    kind: "caption",
    clip_id: "clip_caption",
    track_id: "track_captions",
    from_frame: 0,
    duration_in_frames: 90,
    ownership: "ai_managed",
    hidden: false,
    locked: false,
    style_slot: "caption_default",
    cues: [{ from_frame: 0, duration_in_frames: 90, text: "First cue" }],
  });
  return document;
}

test("edits caption text on a tablet through the shared draft and keeps phone edits to copy", async () => {
  const saved = mock(async (_projectId: string, _documentId: string, _patch: EditDocumentPatch) => ({
    kind: "saved" as const,
    document: captionDocument(),
  }));
  await renderStudio(900, captionDocument(), saved);
  jest.useFakeTimers();
  pane("Edit");
  fireEvent.change(screen.getByLabelText("Caption cue 1 text"), { target: { value: "New subtitle" } });
  expect(screen.getByText("Unsaved changes")).toBeDefined();

  resize(375);
  expect(screen.queryByLabelText("Caption cue 1 text") === null).toBe(true);
  expect(isHidden(screen.getByLabelText("Heading"))).toBe(false);
  expect(isHidden(screen.getByLabelText("Body"))).toBe(false);
  expect(screen.queryByLabelText("Ownership") === null).toBe(true);
  expect(screen.queryByLabelText("Duration (frames)") === null).toBe(true);

  resize(900);
  expect((screen.getByLabelText("Caption cue 1 text") as HTMLTextAreaElement).value).toBe("New subtitle");
  act(() => jest.advanceTimersByTime(500));
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0]![2].operations.map((operation) => operation.kind)).toEqual(["set_caption_cue_text"]);
});

test("offers only saved prompt text on a phone and keeps the draft when the screen widens", async () => {
  await renderStudio(375);
  pane("Prompt Lab");
  const override = (await screen.findByLabelText("Project override")) as HTMLTextAreaElement;
  fireEvent.change(override, { target: { value: "Phone draft" } });
  expect(screen.queryByRole("button", { name: "Improve with AI" }) === null).toBe(true);
  expect(screen.getByText(/AI proposals, locks, and provider settings need a wider screen/)).toBeDefined();

  resize(900);
  expect(screen.getByRole("button", { name: "Improve with AI" })).toBeDefined();
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Phone draft");
});

test("collapses a compact-desktop side region from a trigger that keeps focus", async () => {
  await renderStudio(1024);
  const trigger = screen.getByRole("button", { name: "Scene board panel" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  trigger.focus();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(isHidden(screen.getByLabelText("Scene board"))).toBe(true);
  expect(window.document.activeElement === trigger).toBe(true);

  resize(1440);
  expect(screen.queryByRole("button", { name: "Scene board panel" }) === null).toBe(true);
  expect(isHidden(screen.getByLabelText("Scene board"))).toBe(false);
});

test("monitors renders on a phone without offering render mutations", async () => {
  const renderClient = {
    getRenderCapability: mock(async () => ({ available: true, preset_id: "standard_vertical_mp4_v1" as const, renderer_version: "r" })),
    listRenderJobs: mock(async () => ({ jobs: [], next_cursor: null })),
    createRenderJob: mock(async () => { throw new Error("unused"); }),
    getRenderJob: mock(async () => { throw new Error("unused"); }),
    cancelRenderJob: mock(async () => { throw new Error("unused"); }),
    retryRenderJob: mock(async () => { throw new Error("unused"); }),
    downloadRenderOutput: mock(async () => new Blob()),
    cleanupRenderArtifacts: mock(async () => { throw new Error("unused"); }),
  };
  resize(375);
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ ...promptClientBase, getEditDocument: mock(async () => document), patchEditDocument: pendingSave, ...renderClient }}
      projectId="project_001"
      documentId={document.document_id}
      onBack={() => {}}
    />,
  );
  await screen.findByLabelText("Draft preview");
  const trigger = screen.getByRole("button", { name: "Renders" });
  trigger.focus();
  pane("Renders");
  await screen.findByText("Starting, retrying, cancelling, and deleting renders need a wider screen.");
  expect(window.document.activeElement === trigger).toBe(true);
  expect(screen.queryByRole("button", { name: "Render video" }) === null).toBe(true);
  // The empty workstation must not push render status off the first screen.
  expect(isHidden(screen.getByLabelText("Guided editing workstation"))).toBe(true);
  expect(screen.getAllByLabelText("Draft preview").length).toBe(1);

  resize(900);
  expect(screen.getByRole("button", { name: "Render video" })).toBeDefined();
});
