import { expect, test } from "bun:test";

import type { EditDocument } from "@/api/control-plane";
import { getOrderedTextClips, getPlayerConfig } from "./preview";

const document = {
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
  clips: [
    { kind: "text", clip_id: "clip_002", start_frame: 150, duration_in_frames: 150 },
    { kind: "text", clip_id: "clip_001", start_frame: 0, duration_in_frames: 150 },
  ],
} as unknown as EditDocument;

test("derives only finite Player timing dimensions from an EditDocument", () => {
  expect(getPlayerConfig(document)).toEqual({
    durationInFrames: 300,
    fps: 30,
    compositionWidth: 1080,
    compositionHeight: 1920,
  });
  const invalid = { ...document, canvas: { ...document.canvas, fps: 0 } } as unknown as EditDocument;
  expect(() => getPlayerConfig(invalid)).toThrow();
});

test("orders trusted text clips by frame", () => {
  expect(getOrderedTextClips(document).map((clip) => clip.clip_id)).toEqual(["clip_001", "clip_002"]);
});
