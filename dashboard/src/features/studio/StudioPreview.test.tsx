/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import type { EditDocument, EditDocumentV2 } from "@/api/control-plane";
import { AdvancedTimelineComposition } from "./AdvancedTimelineComposition";
import { previewComposition } from "./preview";
import { VerticalTextStory } from "./VerticalTextStory";

// The view itself is not rendered here: GuidedStudio's tests replace the
// ./StudioPreview module for the whole test process. What matters is which
// composition a document selects and what travels with it.

const textStory = {
  schema_version: 1,
  document_id: "document_001",
  project_id: "project_001",
  revision: 3,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
  template: { template_id: "vertical_text_story", version: 1 },
  tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: ["clip_001"] }],
  scenes: [
    {
      scene_id: "scene_001",
      role: "title",
      start_frame: 0,
      duration_in_frames: 300,
      clip_ids: ["clip_001"],
    },
  ],
  clips: [
    {
      kind: "text",
      clip_id: "clip_001",
      scene_id: "scene_001",
      track_id: "track_visual",
      start_frame: 0,
      duration_in_frames: 300,
      heading: "Heading",
      body: "Body",
      ownership: "ai_managed",
      style_slot: "title",
    },
  ],
} as unknown as EditDocument;

const timeline = {
  ...textStory,
  schema_version: 2,
  tracks: [
    {
      track_id: "track_main",
      kind: "main_video",
      label: "Main",
      order: 0,
      hidden: false,
      muted: false,
      locked: false,
      clip_ids: [],
    },
  ],
  clips: [],
  asset_refs: [],
} as unknown as EditDocumentV2;

test("keeps rendering the version 1 story composition unchanged", () => {
  const chosen = previewComposition(textStory);
  expect(chosen.component).toBe(VerticalTextStory);
  expect(chosen.inputProps.document).toBe(textStory);
  expect(Object.keys(chosen.inputProps)).toEqual(["document"]);
});

test("renders the advanced composition for a version 2 document with its sources", () => {
  const sources = { asset_video: "/api/v1/projects/project_001/editor-assets/asset_video/preview" };
  const chosen = previewComposition(timeline, sources);
  expect(chosen.component).toBe(AdvancedTimelineComposition);
  expect(chosen.inputProps.document).toBe(timeline);
  expect((chosen.inputProps as { previewSources?: unknown }).previewSources).toBe(sources);
});

test("forwards a persistent preview error callback without exposing a locator", () => {
  const unavailable: string[] = [];
  const chosen = previewComposition(timeline, undefined, (assetId) => unavailable.push(assetId));
  const inputProps = chosen.inputProps as { onPreviewUnavailable?: (id: string) => void };

  inputProps.onPreviewUnavailable?.("asset_video");
  expect(unavailable).toEqual(["asset_video"]);
  expect(JSON.stringify(timeline)).not.toContain("editor-assets");
});
