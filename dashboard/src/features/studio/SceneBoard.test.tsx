/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SceneBoard } from "./SceneBoard";

afterEach(cleanup);

const document = {
  canvas: { fps: 30 },
  scenes: [
    { scene_id: "scene_001", role: "title", duration_in_frames: 150, clip_ids: ["clip_001"] },
    { scene_id: "scene_002", role: "body", duration_in_frames: 151, clip_ids: ["clip_002"] },
  ],
  clips: [
    { clip_id: "clip_001", kind: "text", heading: "Original heading", ownership: "ai_managed" },
    { clip_id: "clip_002", kind: "video", ownership: "ai_managed" },
  ],
};

test("orders scenes in a strip labelled by heading or number with durations in seconds", () => {
  render(<SceneBoard document={document} selectedSceneId="scene_001" onSelect={() => {}} />);

  const list = within(screen.getByLabelText("Scene board")).getByRole("list");
  expect(list.tagName).toBe("OL");
  const [first, second] = within(list).getAllByRole("button");
  expect(first!.textContent).toContain("Original heading");
  expect(first!.textContent).toContain("5s");
  expect(second!.textContent).toContain("Scene 2");
  expect(second!.textContent).toContain("5.033s");
});

test("selects a scene through a native pressed button", () => {
  const onSelect = mock((_sceneId: string) => {});
  render(<SceneBoard document={document} selectedSceneId="scene_001" onSelect={onSelect} />);

  const [first, second] = screen.getAllByRole("button");
  expect(first!.getAttribute("type")).toBe("button");
  expect(first!.getAttribute("aria-pressed")).toBe("true");
  expect(second!.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(second!);
  expect(onSelect).toHaveBeenCalledWith("scene_002");
});

test("labels a scene by its first text heading even when media comes first", () => {
  const mediaFirst = {
    canvas: { fps: 30 },
    scenes: [
      { scene_id: "scene_001", role: "title", duration_in_frames: 150, clip_ids: ["clip_video", "clip_text"] },
      { scene_id: "scene_002", role: "body", duration_in_frames: 90, clip_ids: ["clip_video", "clip_blank"] },
      { scene_id: "scene_003", role: "body", duration_in_frames: 60, clip_ids: ["clip_video"] },
    ],
    clips: [
      { clip_id: "clip_video", kind: "video", ownership: "ai_managed" },
      { clip_id: "clip_text", kind: "text", heading: "Text second", ownership: "user_edited" },
      { clip_id: "clip_blank", kind: "text", heading: "   ", ownership: "ai_managed" },
    ],
  };
  const onSelect = mock((_sceneId: string) => {});
  render(<SceneBoard document={mediaFirst} selectedSceneId="scene_002" onSelect={onSelect} />);

  const buttons = within(screen.getByRole("list")).getAllByRole("button");
  expect(buttons.map((button) => button.querySelector("span")?.textContent)).toEqual(["Text second", "Scene 2", "Scene 3"]);
  expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  fireEvent.click(buttons[2]!);
  expect(onSelect.mock.calls).toEqual([["scene_003"]]);
});
