/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "./Inspector";
import type { EditableTextClip } from "./editor_state";

afterEach(cleanup);

const clip = {
  kind: "text",
  clip_id: "clip_001",
  heading: "Original heading",
  body: "Original body",
  ownership: "ai_managed",
} as EditableTextClip;

function renderInspector(frames: number) {
  const onDurationChange = mock((_sceneId: string, _frames: number) => {});
  const view = render(
    <Inspector
      scene={{ scene_id: "scene_001", duration_in_frames: frames }}
      clip={clip}
      fps={30}
      onTextChange={() => {}}
      onOwnershipChange={() => {}}
      onDurationChange={onDurationChange}
    />,
  );
  const duration = screen.getByLabelText("Duration (seconds)") as HTMLInputElement;
  return { onDurationChange, duration, view };
}

test("shows the duration in seconds and leaves an untouched duration alone", () => {
  const { onDurationChange, duration } = renderInspector(151);
  expect(duration.value).toBe("5.033");
  fireEvent.blur(duration);
  fireEvent.keyDown(duration, { key: "Enter" });
  expect(onDurationChange).toHaveBeenCalledTimes(0);
});

test("commits an explicit duration in frames on blur and on Enter, not per keystroke", () => {
  const { onDurationChange, duration } = renderInspector(150);
  fireEvent.change(duration, { target: { value: "5.033" } });
  expect(onDurationChange).toHaveBeenCalledTimes(0);
  fireEvent.blur(duration);
  expect(onDurationChange.mock.calls).toEqual([["scene_001", 151]]);

  fireEvent.change(duration, { target: { value: "6" } });
  fireEvent.keyDown(duration, { key: "Enter" });
  expect(onDurationChange.mock.calls[1]).toEqual(["scene_001", 180]);
});

test("keeps invalid input with an associated inline error and commits nothing", () => {
  const { onDurationChange, duration } = renderInspector(150);
  for (const value of ["0", "abc", ""]) {
    fireEvent.change(duration, { target: { value } });
    fireEvent.blur(duration);
    expect(duration.value).toBe(value);
    const error = globalThis.document.getElementById(duration.getAttribute("aria-describedby") ?? "");
    expect(error?.textContent).toBe("Enter a duration greater than zero seconds.");
    expect(duration.getAttribute("aria-invalid")).toBe("true");
  }
  expect(onDurationChange).toHaveBeenCalledTimes(0);

  fireEvent.change(duration, { target: { value: "4" } });
  fireEvent.blur(duration);
  expect(duration.hasAttribute("aria-describedby")).toBe(false);
  expect(onDurationChange.mock.calls).toEqual([["scene_001", 120]]);
});

test("follows a duration the document changes elsewhere, such as undo", () => {
  const { duration, view } = renderInspector(150);
  view.rerender(
    <Inspector
      scene={{ scene_id: "scene_001", duration_in_frames: 151 }}
      clip={clip}
      fps={30}
      onTextChange={() => {}}
      onOwnershipChange={() => {}}
      onDurationChange={() => {}}
    />,
  );
  expect(duration.value).toBe("5.033");
});
