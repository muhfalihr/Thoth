/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { EditDocumentOperation } from "@/api/control-plane";
import { TimelineInspector } from "./TimelineInspector";
import { timelineDocument, typedTimelineDocument } from "./timeline-test-fixtures";

afterEach(cleanup);

/** Render the inspector over one selection and collect the operations it emits. */
function mount(
  selection: { clipId?: string; trackId?: string },
  document = timelineDocument(),
) {
  const operations: EditDocumentOperation[] = [];
  render(
    <TimelineInspector
      document={document}
      selectedClipId={selection.clipId ?? ""}
      selectedTrackId={selection.trackId ?? ""}
      onOperation={(operation) => operations.push(operation)}
    />,
  );
  return { operations };
}

const payload = (operation: EditDocumentOperation) => ({ ...operation, operation_id: "op" });

test("asks for a selection when nothing is selected", () => {
  mount({});
  expect(screen.getByText("Select a clip or track to edit it")).toBeDefined();
});

test("trims a media clip through typed operations", () => {
  const { operations } = mount({ clipId: "clip_main" });
  fireEvent.change(screen.getByLabelText("Start frame"), { target: { value: "20" } });
  fireEvent.change(screen.getByLabelText("End frame"), { target: { value: "100" } });

  expect(operations.map(payload)).toEqual([
    { kind: "trim_clip_start", operation_id: "op", clip_id: "clip_main", from_frame: 20 },
    { kind: "trim_clip_end", operation_id: "op", clip_id: "clip_main", end_frame: 100 },
  ]);
});

test("sets the volume of an audio clip", () => {
  const { operations } = mount({ clipId: "clip_music" });
  fireEvent.change(screen.getByLabelText("Volume"), { target: { value: "0.5" } });

  expect(payload(operations[0]!)).toEqual({
    kind: "set_clip_volume",
    operation_id: "op",
    clip_id: "clip_music",
    volume: 0.5,
  });
  expect(screen.queryByLabelText("Volume")).not.toBeNull();
});

test("keeps volume away from a clip that carries no audio", () => {
  mount({ clipId: "clip_main" });
  expect(screen.queryByLabelText("Volume")).toBeNull();
});

test("hides, locks, and re-owns the selected clip", () => {
  const { operations } = mount({ clipId: "clip_main" });
  fireEvent.click(screen.getByLabelText("Hidden"));
  fireEvent.click(screen.getByLabelText("Locked"));
  fireEvent.change(screen.getByLabelText("Ownership"), { target: { value: "user_edited" } });

  expect(operations.map(payload)).toEqual([
    { kind: "set_clip_hidden", operation_id: "op", clip_id: "clip_main", hidden: true },
    { kind: "set_clip_locked", operation_id: "op", clip_id: "clip_main", locked: true },
    {
      kind: "set_ownership",
      operation_id: "op",
      clip_id: "clip_main",
      ownership: "user_edited",
    },
  ]);
});

test("keeps a locked track read-only apart from its own lock", () => {
  mount({ trackId: "track_captions" });
  expect(screen.getByLabelText("Hidden").hasAttribute("disabled")).toBe(true);
  expect(screen.getByLabelText("Locked").hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("button", { name: "Remove empty track" })).toBeNull();
});

test("edits the selected track without touching its clips", () => {
  const { operations } = mount({ trackId: "track_music" });
  fireEvent.click(screen.getByLabelText("Hidden"));
  fireEvent.click(screen.getByLabelText("Muted"));
  fireEvent.click(screen.getByLabelText("Locked"));

  expect(operations.map(payload)).toEqual([
    { kind: "set_track_visibility", operation_id: "op", track_id: "track_music", hidden: true },
    { kind: "set_track_muted", operation_id: "op", track_id: "track_music", muted: true },
    { kind: "set_track_locked", operation_id: "op", track_id: "track_music", locked: true },
  ]);
});

test("offers to remove a track once it is empty and unlocked", () => {
  const unlocked = timelineDocument();
  unlocked.tracks[3]!.locked = false;
  const { operations } = mount({ trackId: "track_captions" }, unlocked);
  fireEvent.click(screen.getByRole("button", { name: "Remove empty track" }));
  expect(payload(operations[0]!)).toEqual({
    kind: "remove_empty_track",
    operation_id: "op",
    track_id: "track_captions",
  });
});

test("shows the newly selected clip's values without remounting", () => {
  const document = typedTimelineDocument();
  const view = render(
    <TimelineInspector
      document={document}
      selectedClipId="clip_a"
      selectedTrackId=""
      onOperation={() => {}}
    />,
  );
  expect((screen.getByLabelText("Start frame") as HTMLInputElement).value).toBe("0");

  view.rerender(
    <TimelineInspector
      document={document}
      selectedClipId="clip_b"
      selectedTrackId=""
      onOperation={() => {}}
    />,
  );

  expect((screen.getByLabelText("Start frame") as HTMLInputElement).value).toBe("90");
  expect((screen.getByLabelText("End frame") as HTMLInputElement).value).toBe("210");
  expect((screen.getByLabelText("Fit") as HTMLInputElement).value).toBe("contain");
  expect((screen.getByLabelText("Crop") as HTMLInputElement).value).toBe("0.1, 0.2, 0.5, 0.6");
  expect((screen.getByLabelText("Position") as HTMLInputElement).value).toBe("40, -20 ×1.5");
});

test("emits an edit against the clip that is selected now", () => {
  const document = typedTimelineDocument();
  const operations: EditDocumentOperation[] = [];
  const view = render(
    <TimelineInspector
      document={document}
      selectedClipId="clip_a"
      selectedTrackId=""
      onOperation={(operation) => operations.push(operation)}
    />,
  );
  view.rerender(
    <TimelineInspector
      document={document}
      selectedClipId="clip_b"
      selectedTrackId=""
      onOperation={(operation) => operations.push(operation)}
    />,
  );
  fireEvent.change(screen.getByLabelText("Start frame"), { target: { value: "95" } });

  expect(operations.map(payload)).toEqual([
    { kind: "trim_clip_start", operation_id: "op", clip_id: "clip_b", from_frame: 95 },
  ]);
});

test("reports an audio clip's volume and fades for the current selection", () => {
  const document = typedTimelineDocument();
  render(
    <TimelineInspector
      document={document}
      selectedClipId="clip_audio"
      selectedTrackId=""
      onOperation={() => {}}
    />,
  );

  expect((screen.getByLabelText("Volume") as HTMLInputElement).value).toBe("0.4");
  expect((screen.getByLabelText("Fade in (frames)") as HTMLInputElement).value).toBe("12");
  expect((screen.getByLabelText("Fade out (frames)") as HTMLInputElement).value).toBe("24");
});

test("reports persisted overlay and caption fields as read-only values", () => {
  const document = typedTimelineDocument();
  const view = render(
    <TimelineInspector
      document={document}
      selectedClipId="clip_overlay"
      selectedTrackId=""
      onOperation={() => {}}
    />,
  );

  const preset = screen.getByLabelText("Overlay preset") as HTMLInputElement;
  expect(preset.value).toBe("lower_third");
  expect(preset.disabled).toBe(true);
  expect((screen.getByLabelText("Overlay text") as HTMLInputElement).value).toBe("Headline");
  expect((screen.getByLabelText("Overlay accent") as HTMLInputElement).value).toBe("accent_primary");

  view.rerender(
    <TimelineInspector
      document={document}
      selectedClipId="clip_caption"
      selectedTrackId=""
      onOperation={() => {}}
    />,
  );

  expect((screen.getByLabelText("Caption style") as HTMLInputElement).value).toBe("caption_default");
  expect((screen.getByLabelText("Caption cues") as HTMLInputElement).value).toBe(
    "0–30 First cue · 30–90 Second cue",
  );
});
