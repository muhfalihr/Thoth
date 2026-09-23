/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import type { EditDocument, EditDocumentV1, EditDocumentV2 } from "@/api/control-plane";
import {
  getOrderedTextClips,
  getPlayerConfig,
  previewComposition,
  safePreviewSource,
} from "./preview";

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

test("accepts the server render's own staged static path and nothing beside it", () => {
  expect(safePreviewSource("/public/asset_1.mp4")).toBe("/public/asset_1.mp4");

  for (const hostile of [
    "/public/",
    "/public/../secret.mp4",
    "/public/nested/asset.mp4",
    "/public/asset.mp4?token=secret",
    "/publicity/asset.mp4",
    "public/asset.mp4",
    "//public/asset.mp4",
    "/public/.hidden",
  ]) {
    expect(safePreviewSource(hostile)).toBeUndefined();
  }
});

test("a version 2 document is not mistaken for a version 1 text story", () => {
  const timeline = { ...document, schema_version: 2 } as unknown as EditDocumentV2;
  expect(() => getPlayerConfig(timeline)).not.toThrow();
});

test("preview source narrowing has one implementation, shared with the renderer", async () => {
  const shared = await import("@thoth/remotion-composition");
  expect(safePreviewSource).toBe(shared.safePreviewSource);
});

test("Player timing has one implementation, shared with the parity harness", async () => {
  const shared = await import("@thoth/remotion-composition");
  // Identity, not equality: a second function with the same body could drift a
  // pixel apart from the one the harness captures with.
  expect(getPlayerConfig).toBe(shared.playerConfig);
});

test("a timeline document is paired by the shared composition projection", async () => {
  const shared = await import("@thoth/remotion-composition");
  const timeline = { ...document, schema_version: 2 } as unknown as EditDocumentV2;
  const sources = { asset_video: "/public/asset_video.mp4" };
  const unavailable = () => undefined;

  // The whole pairing, not just the component: the harness renders these exact
  // props, so a source or a callback the view added alone would be a difference
  // no comparison could attribute.
  expect(previewComposition(timeline, sources, unavailable)).toEqual(
    shared.timelineComposition(timeline, sources, unavailable),
  );
});
