/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import type { EditDocument, EditDocumentV1, EditDocumentV2 } from "@/api/control-plane";
import { getOrderedTextClips, getPlayerConfig, safePreviewSource } from "./preview";

const document = {
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
  clips: [
    { kind: "text", clip_id: "clip_002", start_frame: 150, duration_in_frames: 150 },
    { kind: "text", clip_id: "clip_001", start_frame: 0, duration_in_frames: 150 },
  ],
} as unknown as EditDocumentV1;

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
  expect(getOrderedTextClips(document).map((clip) => clip.clip_id)).toEqual([
    "clip_001",
    "clip_002",
  ]);
});

test("accepts only same-origin editor-asset preview paths", () => {
  expect(safePreviewSource("/api/v1/projects/p1/editor-assets/a1/preview")).toBe(
    "/api/v1/projects/p1/editor-assets/a1/preview",
  );

  for (const hostile of [
    undefined,
    "",
    "https://cdn.example.test/leak.mp4",
    "//cdn.example.test/leak.mp4",
    "http://localhost/api/v1/projects/p1/editor-assets/a1/preview",
    "javascript:alert(1)",
    "data:video/mp4;base64,AAAA",
    "blob:https://example.test/abc",
    "/api/v1/../../etc/passwd",
    "/api/v1/projects/p1/editor-assets/a1/preview?token=secret",
    "/api/v1/projects/p1/editor-assets/a1/preview#token",
    "\\api\\v1\\projects",
    "/api/v2/projects/p1/editor-assets/a1/preview",
    "/api/v1/jobs/j1",
  ]) {
    expect(safePreviewSource(hostile)).toBeUndefined();
  }
});

test("a version 2 document is not mistaken for a version 1 text story", () => {
  const timeline = { ...document, schema_version: 2 } as unknown as EditDocumentV2;
  expect(() => getPlayerConfig(timeline)).not.toThrow();
});
