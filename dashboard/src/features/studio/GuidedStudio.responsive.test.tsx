/// <reference types="bun-types" />

import { afterEach, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import {
  StudioReviewRequestError,
  type CreateComment,
  type EditDocument,
  type EditDocumentPatch,
  type ReviewComment,
  type ReviewDecision,
} from "@/api/control-plane";
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

async function renderStudio(
  width: number,
  editDocument: EditDocument = document,
  patchEditDocument = pendingSave,
  extraClient: object = {},
) {
  resize(width);
  const { GuidedStudio } = await import("./GuidedStudio");
  render(
    <GuidedStudio
      client={{ ...promptClientBase, getEditDocument: mock(async () => editDocument), patchEditDocument, ...extraClient }}
      projectId="project_001"
      documentId={editDocument.document_id}
      onBack={() => {}}
    />,
  );
  await screen.findByLabelText("Draft preview");
}

// Bun pretty-prints a mismatched DOM node without bound, so assertions compare booleans.
const isHidden = (element: Element) => element.closest("[hidden]") !== null;
const job = (name: string) =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "Studio jobs" })).getByRole("button", { name }));
const pane = (name: string) =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "Studio panes" })).getByRole("button", { name }));

test("offers the four jobs at every width and compact Edit panes only below desktop width", async () => {
  await renderStudio(375);
  expect(screen.getByRole("navigation", { name: "Studio jobs" })).toBeDefined();
  const panes = within(screen.getByRole("navigation", { name: "Studio panes" })).getAllByRole("button");
  expect(panes.map((button) => button.textContent)).toEqual(["Scenes", "Preview", "Controls"]);
  expect(screen.queryByRole("tablist") === null).toBe(true);
  expect(screen.queryByLabelText("Scene board width") === null).toBe(true);
  expect(screen.getByText("Saved")).toBeDefined();

  resize(768);
  expect(screen.getByRole("navigation", { name: "Studio panes" })).toBeDefined();
  expect(screen.queryByLabelText("Inspector width") === null).toBe(true);

  resize(1024);
  expect(screen.queryByRole("navigation", { name: "Studio panes" }) === null).toBe(true);
  expect(screen.getByRole("navigation", { name: "Studio jobs" })).toBeDefined();
  expect(screen.queryByRole("tablist") === null).toBe(true);
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

test("reaches every job at phone and desktop widths", async () => {
  await renderStudio(375);
  for (const width of [375, 1440]) {
    resize(width);
    job("Prompt");
    expect(isHidden(await screen.findByRole("region", { name: "Prompt Lab" }))).toBe(false);
    expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(true);
    job("Review");
    expect(isHidden(screen.getByText("Reviewing saved revision 1"))).toBe(false);
    expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(false);
    job("Render");
    expect(isHidden(screen.getByText(/Rendering is not available/))).toBe(false);
    expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(true);
    job("Edit");
    expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(false);
    const current = within(screen.getByRole("navigation", { name: "Studio jobs" }))
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-current") === "page");
    expect(current.map((button) => button.textContent)).toEqual(["Edit"]);
  }
  expect(previewMounts).toBe(1);
});

test("explains a missing review or render capability instead of hiding the job", async () => {
  await renderStudio(1440);
  job("Review");
  expect(screen.getByRole("status").textContent).toContain("Review is not available");
  job("Render");
  expect(screen.getByRole("status").textContent).toContain("Rendering is not available");
});

test("shows one pane at a time on a phone and keeps hidden panes out of the tab order", async () => {
  await renderStudio(375);
  const heading = screen.getByLabelText("Heading");
  expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-current")).toBe("page");
  expect(isHidden(heading)).toBe(true);
  expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(false);

  pane("Controls");
  expect(isHidden(heading)).toBe(false);
  expect(isHidden(screen.getByLabelText("Draft preview"))).toBe(true);
});

test("keeps an unsaved Prompt Lab edit across pane and viewport changes", async () => {
  await renderStudio(375);
  job("Prompt");
  const override = (await screen.findByLabelText("Project override")) as HTMLTextAreaElement;
  fireEvent.change(override, { target: { value: "Local draft" } });

  job("Edit");
  job("Review");
  job("Prompt");
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Local draft");

  resize(1440);
  expect(screen.getByRole("button", { name: "Prompt" }).getAttribute("aria-current")).toBe("page");
  expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Local draft");
});

test("pauses the preview when its pane is hidden and does not resume on return", async () => {
  previewPlayer = new FakePlayer();
  await renderStudio(375);
  const player = previewPlayer;

  pane("Controls");
  expect(player.calls).toEqual(["pause"]);
  pane("Preview");
  job("Review");
  expect(player.calls).toEqual(["pause"]);
  job("Render");
  expect(player.calls).toEqual(["pause", "pause"]);
});

test("reviews the saved revision while the draft keeps its unsaved edit", async () => {
  await renderStudio(375);
  pane("Controls");
  fireEvent.change(screen.getByLabelText("Heading"), { target: { value: "Draft heading" } });
  expect(screen.getByText("Unsaved changes")).toBeDefined();

  job("Review");
  expect(screen.getByLabelText("Draft preview").textContent).toBe("Original heading");
  expect(screen.getByText("Reviewing saved revision 1")).toBeDefined();

  job("Edit");
  pane("Preview");
  expect(screen.getByLabelText("Draft preview").textContent).toBe("Draft heading");
});

test("reviews the saved revision on desktop and returns to the draft heading in Edit", async () => {
  await renderStudio(1440);
  fireEvent.change(screen.getByLabelText("Heading"), { target: { value: "Draft heading" } });

  job("Review");
  expect(screen.getByLabelText("Draft preview").textContent).toBe("Original heading");
  expect(isHidden(screen.getByLabelText("Heading"))).toBe(true);
  expect(isHidden(screen.getByLabelText("Scene board"))).toBe(true);

  job("Edit");
  expect(screen.getByLabelText("Draft preview").textContent).toBe("Draft heading");
  expect((screen.getByLabelText("Heading") as HTMLInputElement).value).toBe("Draft heading");
  expect(previewMounts).toBe(1);
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
  pane("Controls");
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
  job("Prompt");
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
  const trigger = screen.getByRole("button", { name: "Render" });
  trigger.focus();
  job("Render");
  await screen.findByText("Starting, retrying, cancelling, and deleting renders need a wider screen.");
  expect(window.document.activeElement === trigger).toBe(true);
  expect(screen.queryByRole("button", { name: "Render video" }) === null).toBe(true);
  // The empty workstation must not push render status off the first screen.
  expect(isHidden(screen.getByLabelText("Guided editing workstation"))).toBe(true);
  expect(screen.getAllByLabelText("Draft preview").length).toBe(1);

  resize(900);
  expect(screen.getByRole("button", { name: "Render video" })).toBeDefined();
});

function reviewClient() {
  return {
    listStudioReviewComments: mock(async () => ({ comments: [] as ReviewComment[], next_cursor: null })),
    listStudioReviewDecisions: mock(async () => ({ decisions: [] as ReviewDecision[], next_cursor: null })),
    createStudioReviewComment: mock(async () => { throw new Error("unused"); }),
    createStudioReviewDecision: mock(async () => { throw new Error("unused"); }),
  };
}

test("reviews the saved preview on a phone and blocks review while a draft is unsaved", async () => {
  await renderStudio(375, document, pendingSave, reviewClient());
  pane("Controls");
  fireEvent.change(screen.getByLabelText("Heading"), { target: { value: "Draft heading" } });

  job("Review");
  const panel = await screen.findByRole("region", { name: "Review" });
  expect(isHidden(panel)).toBe(false);
  expect(screen.getByLabelText("Draft preview").textContent).toBe("Original heading");
  expect(screen.getByText("Review applies to saved revision 1.")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Phone note" } });
  expect((screen.getByRole("button", { name: "Post comment" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Wait for your changes to save/)).toBeDefined();
});

test("keeps unsent review text across pane and viewport changes beside one preview", async () => {
  await renderStudio(375, document, pendingSave, reviewClient());
  job("Review");
  const panel = await screen.findByRole("region", { name: "Review" });
  fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Phone note" } });

  job("Edit");
  expect(isHidden(panel)).toBe(true);
  job("Review");
  expect((screen.getByLabelText("Review comment") as HTMLTextAreaElement).value).toBe("Phone note");

  resize(1440);
  expect(isHidden(screen.getByRole("region", { name: "Review" }))).toBe(false);
  expect((screen.getByLabelText("Review comment") as HTMLTextAreaElement).value).toBe("Phone note");
  expect(screen.getAllByLabelText("Draft preview").length).toBe(1);
  expect(previewMounts).toBe(1);
});

test("keeps a stale review comment until the newer revision is loaded, then resubmits by hand", async () => {
  const review = reviewClient();
  review.listStudioReviewDecisions.mockImplementation(async () => ({
    decisions: [{
      decision_id: "decision_1",
      project_id: "project_001",
      document_id: "document_001",
      document_revision: 1,
      actor: { actor_id: "owner", actor_type: "user", display_name: null },
      decision: "approved" as const,
      reason: null,
      created_at: "2026-09-24T09:00:00Z",
    }],
    next_cursor: null,
  }));
  const posted = mock(async (_projectId: string, _documentId: string, request: CreateComment): Promise<ReviewComment> => {
    if (request.base_revision === 1) throw new StudioReviewRequestError("review_revision_conflict", 2);
    return {
      comment_id: "comment_1",
      project_id: "project_001",
      document_id: "document_001",
      document_revision: request.base_revision,
      actor: { actor_id: "owner", actor_type: "user", display_name: null },
      text: request.text,
      frame: request.frame ?? null,
      created_at: "2026-09-24T09:00:00Z",
    };
  });
  const revisions = [document, { ...document, revision: 2 }];
  const getEditDocument = mock(async () => revisions.shift() ?? document);
  await renderStudio(375, document, pendingSave, { ...review, createStudioReviewComment: posted, getEditDocument });
  job("Review");
  await screen.findByText("Current decision: Approved on revision 1");
  fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Phone note" } });
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));

  fireEvent.click(await screen.findByRole("button", { name: "Load revision 2" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reload Latest" }));
  expect(screen.getByText("Review applies to saved revision 2.")).toBeDefined();
  expect(screen.getByText("No decision on revision 2 yet.")).toBeDefined();
  expect(screen.getByText(/Approved on revision 1/)).toBeDefined();
  expect((screen.getByLabelText("Review comment") as HTMLTextAreaElement).value).toBe("Phone note");
  expect(posted).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await screen.findByText("Comment posted.");
  const [stale, resubmitted] = posted.mock.calls.map((call) => call[2]);
  expect(resubmitted!.base_revision).toBe(2);
  expect(resubmitted!.operation_id === stale!.operation_id).toBe(false);
});
