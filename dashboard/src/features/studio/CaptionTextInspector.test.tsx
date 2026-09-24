/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EditDocumentOperation, EditDocumentV2 } from "@/api/control-plane";
import { CaptionTextInspector } from "./CaptionTextInspector";
import { typedTimelineDocument } from "./timeline-test-fixtures";

afterEach(() => cleanup());

type CaptionClip = Extract<NonNullable<EditDocumentV2["clips"]>[number], { kind: "caption" }>;

/** Two scenes: the fixture's caption clip covers the first; a second clip covers only the second. */
function twoSceneDocument(): EditDocumentV2 {
  const document = typedTimelineDocument();
  document.scenes = [
    { scene_id: "scene_001", role: "source", start_frame: 0, duration_in_frames: 300, clip_ids: ["clip_a"] },
    { scene_id: "scene_002", role: "source", start_frame: 300, duration_in_frames: 300, clip_ids: [] },
  ];
  const first = document.clips!.find((clip) => clip.clip_id === "clip_caption") as CaptionClip;
  document.clips!.push({ ...structuredClone(first), clip_id: "clip_caption_late", from_frame: 360, cues: [
    { from_frame: 0, duration_in_frames: 30, text: "Late cue" },
  ] });
  document.tracks.find((track) => track.track_id === "track_captions")!.clip_ids!.push("clip_caption_late");
  return document;
}

function renderInspector(document = twoSceneDocument(), selectedSceneId = "scene_001", disabled = false) {
  const onOperation = mock((_operation: EditDocumentOperation) => {});
  render(
    <CaptionTextInspector
      document={document}
      selectedSceneId={selectedSceneId}
      onOperation={onOperation}
      disabled={disabled}
    />,
  );
  return onOperation;
}

test("lists only caption clips that overlap the selected scene, with clip and time labels", () => {
  renderInspector();
  expect(screen.getByRole("group", { name: "Captions 0.0s–3.0s" })).toBeDefined();
  expect((screen.getByLabelText("Caption cue 1 text") as HTMLTextAreaElement).value).toBe("First cue");
  expect((screen.getByLabelText("Caption cue 2 text") as HTMLTextAreaElement).value).toBe("Second cue");
  expect(screen.getByText("0.0s–1.0s")).toBeDefined();
  expect(screen.queryByDisplayValue("Late cue") === null).toBe(true);

  cleanup();
  renderInspector(twoSceneDocument(), "scene_002");
  expect(screen.getByRole("group", { name: "Captions 12.0s–15.0s" })).toBeDefined();
  expect((screen.getByLabelText("Caption cue 1 text") as HTMLTextAreaElement).value).toBe("Late cue");
});

test("editing a cue emits a text-only operation for that clip and cue", () => {
  const onOperation = renderInspector();
  fireEvent.change(screen.getByLabelText("Caption cue 2 text"), { target: { value: "New subtitle" } });

  expect(onOperation).toHaveBeenCalledTimes(1);
  const [operation] = onOperation.mock.calls[0]!;
  expect(operation).toEqual({
    kind: "set_caption_cue_text",
    operation_id: expect.any(String),
    clip_id: "clip_caption",
    cue_index: 1,
    text: "New subtitle",
  });
});

test("a blank cue is never emitted because the server would refuse it", () => {
  const onOperation = renderInspector();
  fireEvent.change(screen.getByLabelText("Caption cue 1 text"), { target: { value: "   " } });
  expect(onOperation).toHaveBeenCalledTimes(0);
});

test("a locked caption clip or track is read-only and says why", () => {
  const document = twoSceneDocument();
  (document.clips!.find((clip) => clip.clip_id === "clip_caption") as CaptionClip).locked = true;
  const onOperation = renderInspector(document);

  const cue = screen.getByLabelText("Caption cue 1 text") as HTMLTextAreaElement;
  expect(cue.readOnly).toBe(true);
  expect(screen.getByText("This caption is locked. Unlock it on a desktop timeline to edit.")).toBeDefined();
  fireEvent.change(cue, { target: { value: "Changed" } });
  expect(onOperation).toHaveBeenCalledTimes(0);

  cleanup();
  const trackLocked = twoSceneDocument();
  trackLocked.tracks.find((track) => track.track_id === "track_captions")!.locked = true;
  renderInspector(trackLocked);
  expect((screen.getByLabelText("Caption cue 1 text") as HTMLTextAreaElement).readOnly).toBe(true);
});

test("a scene without captions says so", () => {
  const document = twoSceneDocument();
  document.clips = document.clips!.filter((clip) => clip.kind !== "caption");
  renderInspector(document);
  expect(screen.getByText("No captions in this scene.")).toBeDefined();
});
