import { describe, expect, test } from "bun:test";

import { hasAudibleContent } from "@thoth/remotion-composition/timeline";
import type { EditDocumentV2 } from "@thoth/remotion-composition/timeline";

import { FIXTURE_IDENTITY, testBundle, testDocument } from "./bundle-test-fixtures";
import { expectedOutputOf, parseRenderBundle } from "./contracts";

/** The fixture plays one visible video clip whose asset carries audio. */
function document(overrides: Record<string, unknown> = {}): EditDocumentV2 {
  return testDocument(overrides) as unknown as EditDocumentV2;
}

const SILENT_TRACK = {
  track_id: "track_main",
  kind: "main_video",
  label: "Main video",
  order: 0,
  hidden: false,
  muted: false,
  locked: false,
  clip_ids: ["clip_main"],
};

function withTrack(overrides: Record<string, unknown>): EditDocumentV2 {
  return document({ tracks: [{ ...SILENT_TRACK, ...overrides }] });
}

const MUSIC_REF = {
  asset_id: "asset_music",
  project_id: "project_001",
  kind: "audio",
  has_audio: true,
  validation_state: "ready",
};

const MUSIC_CLIP = {
  kind: "audio",
  clip_id: "clip_main",
  track_id: "track_main",
  asset_id: "asset_music",
  from_frame: 0,
  duration_in_frames: 300,
  source_from_frame: 0,
  ownership: "ai_managed",
  hidden: false,
  locked: false,
  volume: 0.8,
  fade_in_frames: 0,
  fade_out_frames: 0,
};

describe("hasAudibleContent", () => {
  test("hears a video clip whose asset carries audio", () => {
    expect(hasAudibleContent(document())).toBe(true);
  });

  test("hears an audio clip the composition plays at a non-zero volume", () => {
    expect(
      hasAudibleContent(document({ asset_refs: [MUSIC_REF], clips: [MUSIC_CLIP] })),
    ).toBe(true);
  });

  test("hears nothing when the only source is silent, muted, or not drawn", () => {
    const silentAsset = {
      asset_id: "asset_1",
      project_id: "project_001",
      kind: "video",
      has_audio: false,
      validation_state: "ready",
    };
    expect(hasAudibleContent(document({ asset_refs: [silentAsset] }))).toBe(false);
    expect(hasAudibleContent(withTrack({ muted: true }))).toBe(false);
    expect(hasAudibleContent(withTrack({ hidden: true }))).toBe(false);
    expect(
      hasAudibleContent(
        document({
          clips: [{ ...document().clips![0], hidden: true }],
        }),
      ),
    ).toBe(false);
    expect(
      hasAudibleContent(
        document({ asset_refs: [MUSIC_REF], clips: [{ ...MUSIC_CLIP, volume: 0 }] }),
      ),
    ).toBe(false);
    expect(hasAudibleContent(document({ clips: [] }))).toBe(false);
  });

  test("hears nothing from a still image, whatever the asset claims", () => {
    const still = {
      asset_id: "asset_1",
      project_id: "project_001",
      kind: "image",
      has_audio: true,
      validation_state: "ready",
    };
    expect(hasAudibleContent(document({ asset_refs: [still] }))).toBe(false);
  });
});

describe("expectedOutputOf", () => {
  test("carries the audio the trusted composition will actually produce", () => {
    const audible = parseRenderBundle(testBundle(), FIXTURE_IDENTITY);
    expect(expectedOutputOf(audible)).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 300,
      hasAudio: true,
    });

    const muted = parseRenderBundle(
      testBundle({ document: withTrack({ muted: true }) }),
      FIXTURE_IDENTITY,
    );
    expect(expectedOutputOf(muted).hasAudio).toBe(false);
  });
});
