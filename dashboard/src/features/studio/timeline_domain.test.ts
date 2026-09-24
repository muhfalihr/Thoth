/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import type { EditDocumentV2, EditorAsset } from "@/api/control-plane";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  applyTimelineOperation,
  carrySceneClips,
  clampZoom,
  compatibleTrackIds,
  createAddClipFromAssetOperation,
  framesToPixels,
  isTimelineDocument,
  issueTarget,
  pixelsToFrames,
  snapCandidates,
  snapFrame,
  timelineIssues,
  visibleLanes,
} from "./timeline_domain";
import { sceneStripDocument } from "./timeline-test-fixtures";

function documentV2(): EditDocumentV2 {
  return {
    schema_version: 2,
    document_id: "edoc_001",
    project_id: "project_001",
    revision: 2,
    template: { template_id: "vertical_text_story", version: 1 },
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
    scenes: [
      {
        scene_id: "scene_001",
        start_frame: 0,
        duration_in_frames: 300,
        role: "source",
        clip_ids: ["clip_main"],
      },
    ],
    asset_refs: [
      {
        asset_id: "asset_video",
        project_id: "project_001",
        kind: "video",
        has_audio: true,
        validation_state: "ready",
      },
    ],
    tracks: [
      {
        track_id: "track_main",
        kind: "main_video",
        label: "Main",
        order: 0,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_main"],
      },
      {
        track_id: "track_music",
        kind: "music",
        label: "Music",
        order: 1,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_music"],
      },
      {
        track_id: "track_locked",
        kind: "b_roll",
        label: "Locked B-roll",
        order: 2,
        hidden: false,
        muted: false,
        locked: true,
        clip_ids: [],
      },
    ],
    clips: [
      {
        kind: "video",
        clip_id: "clip_main",
        track_id: "track_main",
        asset_id: "asset_video",
        from_frame: 0,
        duration_in_frames: 300,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        fit: "cover",
      },
      {
        kind: "audio",
        clip_id: "clip_music",
        track_id: "track_music",
        asset_id: "asset_video",
        from_frame: 0,
        duration_in_frames: 120,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        volume: 1,
        fade_in_frames: 0,
        fade_out_frames: 0,
      },
    ],
  };
}

const READY_ASSET: EditorAsset = {
  asset_id: "asset_new",
  project_id: "project_001",
  kind: "video",
  media_type: "video/mp4",
  has_audio: true,
  validation_state: "ready",
};

test("frames convert to pixels and back at the current zoom", () => {
  expect(framesToPixels(90, 2)).toBe(180);
  expect(pixelsToFrames(180, 2)).toBe(90);
  expect(pixelsToFrames(-40, 2)).toBe(0);
  expect(pixelsToFrames(45, 2)).toBe(23);
});

test("zoom stays inside its bounds and ignores unusable values", () => {
  expect(clampZoom(MIN_ZOOM / 10)).toBe(MIN_ZOOM);
  expect(clampZoom(MAX_ZOOM * 10)).toBe(MAX_ZOOM);
  expect(clampZoom(Number.NaN)).toBe(1);
  expect(clampZoom(1.5)).toBe(1.5);
});

test("snap chooses the nearest candidate then the stable lower frame", () => {
  expect(snapFrame(101, [100, 102], 2)).toBe(100);
  expect(snapFrame(104, [100], 2)).toBe(104);
  expect(snapFrame(103, [100, 106], 3)).toBe(100);
  expect(snapFrame(50, [], 4)).toBe(50);
});

test("snap candidates cover clip edges, canvas bounds, and the playhead", () => {
  expect(snapCandidates(documentV2(), { excludeClipId: "clip_main", playhead: 45 })).toEqual([
    0, 45, 120, 300,
  ]);
});

test("only track kinds that accept the clip kind are offered", () => {
  expect(compatibleTrackIds(documentV2(), "video")).toEqual(["track_main"]);
  expect(compatibleTrackIds(documentV2(), "audio")).toEqual(["track_music"]);
  expect(compatibleTrackIds(documentV2(), "caption")).toEqual([]);
});

test("lanes are ordered by track order and carry their clips in frame order", () => {
  const lanes = visibleLanes(documentV2());

  expect(lanes.map((lane) => lane.track.track_id)).toEqual([
    "track_main",
    "track_music",
    "track_locked",
  ]);
  expect(lanes[0].clips.map((clip) => clip.clip_id)).toEqual(["clip_main"]);
  expect(lanes[2].clips).toEqual([]);
});

test("a timeline document is distinguished from a version 1 document", () => {
  expect(isTimelineDocument(documentV2())).toBe(true);
  expect(isTimelineDocument({ schema_version: 1 } as never)).toBe(false);
});

test("a main-track gap and an over-long clip are reported as issues", () => {
  const document = documentV2();
  document.clips![0].from_frame = 30;
  document.clips![0].duration_in_frames = 270;
  document.clips![1].duration_in_frames = 400;

  expect(timelineIssues(document)).toEqual([
    {
      issue_id: "main_track_gap:clip_main",
      code: "main_track_gap",
      target: { kind: "clip", id: "clip_main", track_id: "track_main" },
    },
    {
      issue_id: "clip_exceeds_canvas:clip_music",
      code: "clip_exceeds_canvas",
      target: { kind: "clip", id: "clip_music", track_id: "track_music" },
    },
  ]);
});

test("an overlap on one track is reported once for the later clip", () => {
  const document = documentV2();
  document.clips!.push({ ...document.clips![1], clip_id: "clip_music_b", from_frame: 60 });
  document.tracks[1]!.clip_ids!.push("clip_music_b");

  expect(timelineIssues(document).map((issue) => issue.issue_id)).toEqual([
    "clip_overlap:clip_music_b",
  ]);
});

test("an issue maps to the selection that reveals it", () => {
  expect(
    issueTarget({
      issue_id: "clip_overlap:clip_a",
      code: "clip_overlap",
      target: { kind: "clip", id: "clip_a", track_id: "track_a" },
    }),
  ).toEqual({ selectedTrackId: "track_a", selectedClipId: "clip_a" });
  expect(
    issueTarget({
      issue_id: "track_empty:track_a",
      code: "track_empty",
      target: { kind: "track", id: "track_a", track_id: "track_a" },
    }),
  ).toEqual({ selectedTrackId: "track_a", selectedClipId: "" });
});

test("moving a clip retargets its track without mutating the source document", () => {
  const original = documentV2();
  const moved = applyTimelineOperation(
    original,
    {
      kind: "move_clip",
      operation_id: "op_001",
      clip_id: "clip_music",
      target_track_id: "track_music",
      from_frame: 60,
      ripple: false,
    },
    {},
  );

  expect(moved.clips!.find((clip) => clip.clip_id === "clip_music")!.from_frame).toBe(60);
  expect(original).toEqual(documentV2());
});

test("a ripple move repacks its track from the earliest start", () => {
  const document = documentV2();
  document.clips!.push({ ...document.clips![1], clip_id: "clip_music_b", from_frame: 200 });
  document.tracks[1]!.clip_ids!.push("clip_music_b");

  const rippled = applyTimelineOperation(
    document,
    {
      kind: "move_clip",
      operation_id: "op_001",
      clip_id: "clip_music_b",
      target_track_id: "track_music",
      from_frame: 0,
      ripple: true,
    },
    {},
  );

  expect(
    rippled
      .clips!.filter((clip) => clip.track_id === "track_music")
      .map((clip) => [clip.clip_id, clip.from_frame]),
  ).toEqual([
    ["clip_music", 120],
    ["clip_music_b", 0],
  ]);
});

test("splitting uses the supplied IDs and preserves the source range", () => {
  const split = applyTimelineOperation(
    documentV2(),
    {
      kind: "split_clip",
      operation_id: "op_001",
      clip_id: "clip_main",
      split_frame: 90,
      left_clip_id: "clip_left",
      right_clip_id: "clip_right",
    },
    {},
  );

  expect(
    split
      .clips!.filter((clip) => clip.track_id === "track_main")
      .map((clip) => [clip.clip_id, clip.from_frame, clip.duration_in_frames]),
  ).toEqual([
    ["clip_left", 0, 90],
    ["clip_right", 90, 210],
  ]);
  expect(split.tracks[0].clip_ids).toEqual(["clip_left", "clip_right"]);
});

test("trimming the start advances the source and keeps the end frame", () => {
  const trimmed = applyTimelineOperation(
    documentV2(),
    { kind: "trim_clip_start", operation_id: "op_001", clip_id: "clip_main", from_frame: 40 },
    {},
  );
  const clip = trimmed.clips!.find((entry) => entry.clip_id === "clip_main")!;

  expect([clip.from_frame, clip.duration_in_frames]).toEqual([40, 260]);
  expect((clip as { source_from_frame: number }).source_from_frame).toBe(40);
});

test("a clip added from a ready asset copies only the safe projection", () => {
  const added = applyTimelineOperation(
    documentV2(),
    {
      kind: "add_clip_from_asset",
      operation_id: "op_001",
      track_id: "track_main",
      clip_id: "clip_added",
      asset_id: "asset_new",
      from_frame: 0,
      duration_in_frames: 60,
      source_from_frame: 0,
    },
    { asset_new: READY_ASSET },
  );

  expect(added.asset_refs!.map((asset) => asset.asset_id)).toEqual(["asset_video", "asset_new"]);
  expect(JSON.stringify(added)).not.toContain("media_type");
  expect(added.tracks[0].clip_ids).toEqual(["clip_main", "clip_added"]);
});

test.each([
  [
    "a locked clip",
    { kind: "trim_clip_end", operation_id: "op", clip_id: "clip_locked", end_frame: 10 },
    "clip is locked",
  ],
  [
    "a locked track",
    {
      kind: "move_clip",
      operation_id: "op",
      clip_id: "clip_main",
      target_track_id: "track_locked",
      from_frame: 0,
      ripple: false,
    },
    "track is locked",
  ],
  [
    "an unknown clip",
    { kind: "remove_clip", operation_id: "op", clip_id: "clip_missing" },
    "operation references an unknown clip",
  ],
  [
    "a zero-length trim",
    { kind: "trim_clip_end", operation_id: "op", clip_id: "clip_main", end_frame: 0 },
    "trim must leave a positive duration",
  ],
  [
    "a split at the clip edge",
    {
      kind: "split_clip",
      operation_id: "op",
      clip_id: "clip_main",
      split_frame: 0,
      left_clip_id: "clip_a",
      right_clip_id: "clip_b",
    },
    "split frame must fall inside the clip",
  ],
  [
    "volume on a non-audio clip",
    { kind: "set_clip_volume", operation_id: "op", clip_id: "clip_main", volume: 0.5 },
    "volume applies only to audio clips",
  ],
  [
    "an unavailable asset",
    {
      kind: "add_clip_from_asset",
      operation_id: "op",
      track_id: "track_main",
      clip_id: "clip_added",
      asset_id: "asset_missing",
      from_frame: 0,
      duration_in_frames: 60,
      source_from_frame: 0,
    },
    "operation references an unavailable asset",
  ],
])("%s is refused", (_name, operation, message) => {
  const document = documentV2();
  document.clips!.push({
    ...document.clips![0],
    clip_id: "clip_locked",
    locked: true,
    from_frame: 0,
  });
  document.tracks[0]!.clip_ids!.push("clip_locked");

  expect(() => applyTimelineOperation(document, operation as never, {})).toThrow(message);
});

test("a cross-project asset never enters the document", () => {
  expect(() =>
    applyTimelineOperation(
      documentV2(),
      {
        kind: "add_clip_from_asset",
        operation_id: "op",
        track_id: "track_main",
        clip_id: "clip_added",
        asset_id: "asset_new",
        from_frame: 0,
        duration_in_frames: 60,
        source_from_frame: 0,
      },
      { asset_new: { ...READY_ASSET, project_id: "project_other" } },
    ),
  ).toThrow("asset belongs to another project");
});

test("track settings flip without touching any clip", () => {
  const muted = applyTimelineOperation(
    documentV2(),
    { kind: "set_track_muted", operation_id: "op", track_id: "track_music", muted: true },
    {},
  );

  expect(muted.tracks[1].muted).toBe(true);
  expect(muted.clips).toEqual(documentV2().clips);
});

const IDS = { operationId: "op_asset", clipId: "clip_asset" };
const TIMED_ASSET: EditorAsset = { ...READY_ASSET, duration_in_frames: 600 };

test("an asset becomes an add operation on the first compatible unlocked track", () => {
  expect(createAddClipFromAssetOperation(documentV2(), TIMED_ASSET, 45, IDS)).toEqual({
    kind: "add_clip_from_asset",
    operation_id: "op_asset",
    clip_id: "clip_asset",
    track_id: "track_main",
    asset_id: "asset_new",
    from_frame: 45,
    duration_in_frames: 600,
    source_from_frame: 0,
  });

  expect(
    createAddClipFromAssetOperation(
      documentV2(),
      { ...TIMED_ASSET, kind: "audio", media_type: "audio/mpeg" },
      0,
      IDS,
    ),
  ).toMatchObject({ track_id: "track_music", from_frame: 0, duration_in_frames: 600 });
});

test("an image lands on a video track for one canvas second", () => {
  expect(
    createAddClipFromAssetOperation(
      documentV2(),
      { ...READY_ASSET, kind: "image", media_type: "image/png" },
      12,
      IDS,
    ),
  ).toMatchObject({ track_id: "track_main", duration_in_frames: 30, from_frame: 12 });
});

test("an asset with no unlocked compatible track produces no operation", () => {
  const document = documentV2();
  const locked = {
    ...document,
    tracks: document.tracks.map((track) => ({ ...track, locked: true })),
  };
  expect(createAddClipFromAssetOperation(locked, READY_ASSET, 0, IDS)).toBeUndefined();

  const withoutAudio = {
    ...document,
    tracks: document.tracks.filter((track) => track.kind !== "music"),
  };
  expect(
    createAddClipFromAssetOperation(
      withoutAudio,
      { ...READY_ASSET, kind: "audio", media_type: "audio/mpeg" },
      0,
      IDS,
    ),
  ).toBeUndefined();
});

function documentWithCaptions(locked = false): EditDocumentV2 {
  const document = documentV2();
  document.tracks.push({
    track_id: "track_caption",
    kind: "caption",
    label: "Captions",
    order: 3,
    hidden: false,
    muted: false,
    locked: false,
    clip_ids: ["clip_caption"],
  });
  document.clips!.push({
    kind: "caption",
    clip_id: "clip_caption",
    track_id: "track_caption",
    from_frame: 0,
    duration_in_frames: 120,
    ownership: "ai_managed",
    hidden: false,
    locked,
    style_slot: "caption_default",
    cues: [
      { from_frame: 0, duration_in_frames: 60, text: "hello" },
      { from_frame: 60, duration_in_frames: 60, text: "world" },
    ],
  });
  return document;
}

const captionText = (clipId: string, cueIndex: number) =>
  ({
    kind: "set_caption_cue_text",
    operation_id: "op_caption_1",
    clip_id: clipId,
    cue_index: cueIndex,
    text: "Corrected caption",
  }) as const;

test("a caption cue edit changes only that cue's text", () => {
  const source = documentWithCaptions();
  const next = applyTimelineOperation(source, captionText("clip_caption", 1), {});

  const expected = structuredClone(source);
  const caption = expected.clips!.at(-1)!;
  if (caption.kind === "caption") caption.cues[1]!.text = "Corrected caption";
  expect(next).toEqual(expected);
  expect(source.clips!.at(-1)).toEqual(documentWithCaptions().clips!.at(-1));
});

test.each([
  ["a non-caption clip", documentWithCaptions(), "clip_main", 0, "caption cue unavailable"],
  ["an out-of-range cue", documentWithCaptions(), "clip_caption", 2, "caption cue unavailable"],
  ["a missing clip", documentWithCaptions(), "clip_missing", 0, "unknown clip"],
  ["a locked caption", documentWithCaptions(true), "clip_caption", 0, "clip is locked"],
] as const)("a caption cue edit on %s is refused", (_label, document, clipId, cueIndex, message) => {
  expect(() => applyTimelineOperation(document, captionText(clipId, cueIndex), {})).toThrow(message);
});

test("lane selection has one implementation, shared with the renderer", async () => {
  const shared = await import("@thoth/remotion-composition");
  expect(visibleLanes).toBe(shared.visibleLanes);
});

const reorder = (sceneId: string, toIndex: number) =>
  ({ kind: "reorder_scene", operation_id: "op_reorder", scene_id: sceneId, to_index: toIndex }) as const;

/** Each scene-bound clip as its scene and its offset inside that scene. */
function sceneMembership(document: EditDocumentV2): Record<string, [string, number]> {
  const starts = new Map(document.scenes.map((scene) => [scene.scene_id, scene.start_frame]));
  return Object.fromEntries(
    (document.clips ?? []).map((clip) => [
      clip.clip_id,
      [clip.scene_id!, clip.from_frame - starts.get(clip.scene_id!)!],
    ]),
  );
}

test.each([
  ["the last scene to the front", "scene_003", 0, ["scene_003", "scene_001", "scene_002"]],
  ["the first scene to the end", "scene_001", 2, ["scene_002", "scene_003", "scene_001"]],
  ["a middle scene to the front", "scene_002", 0, ["scene_002", "scene_001", "scene_003"]],
] as const)("moving %s carries its clips without drift", (_label, sceneId, toIndex, order) => {
  const source = sceneStripDocument();

  const next = applyTimelineOperation(source, reorder(sceneId, toIndex), {});

  expect(next.scenes.map((scene) => scene.scene_id)).toEqual([...order]);
  let frame = 0;
  for (const scene of next.scenes) {
    expect(scene.start_frame).toBe(frame);
    frame += scene.duration_in_frames;
  }
  expect(next.canvas.duration_in_frames).toBe(source.canvas.duration_in_frames);
  expect(sceneMembership(next)).toEqual(sceneMembership(source));
  expect(next.clips!.map((clip) => clip.duration_in_frames)).toEqual(
    source.clips!.map((clip) => clip.duration_in_frames),
  );
});

test.each([
  ["an unknown scene", reorder("scene_missing", 0), "unknown scene"],
  ["an index past the end", reorder("scene_001", 3), "scene index is out of range"],
] as const)("a scene reorder naming %s is refused", (_label, operation, message) => {
  expect(() => applyTimelineOperation(sceneStripDocument(), operation, {})).toThrow(message);
});

test("a scene reorder that would move a locked clip is refused", () => {
  const source = sceneStripDocument();
  source.clips!.find((clip) => clip.clip_id === "clip_still")!.locked = true;

  expect(() => applyTimelineOperation(source, reorder("scene_002", 0), {})).toThrow("clip is locked");
});

test("an asset added to a scene stays bound to that scene", () => {
  const next = applyTimelineOperation(
    documentV2(),
    {
      kind: "add_clip_from_asset",
      operation_id: "op_asset",
      clip_id: "clip_asset",
      track_id: "track_main",
      asset_id: "asset_new",
      from_frame: 0,
      duration_in_frames: 30,
      source_from_frame: 0,
      scene_id: "scene_001",
    },
    { asset_new: READY_ASSET },
  );

  expect(next.clips!.at(-1)!.scene_id).toBe("scene_001");
});

/** The scene strip plus an empty caption lane, as every upgraded draft has. */
function captionReadyStrip(): EditDocumentV2 {
  const document = sceneStripDocument();
  document.tracks.push({
    track_id: "track_caption",
    kind: "caption",
    label: "Captions",
    order: 4,
    hidden: false,
    muted: false,
    locked: false,
    clip_ids: [],
  });
  return document;
}

const addCaption = (overrides: Partial<{ scene_id: string; clip_id: string; track_id: string }> = {}) =>
  ({
    kind: "add_caption_clip",
    operation_id: "op_caption",
    clip_id: "clip_cap",
    track_id: "track_caption",
    scene_id: "scene_002",
    text: "Hello",
    ...overrides,
  }) as const;

const cueTiming = (fromFrame: number, duration: number, cueIndex = 0) =>
  ({
    kind: "set_caption_cue_timing",
    operation_id: "op_timing",
    clip_id: "clip_cap",
    cue_index: cueIndex,
    from_frame: fromFrame,
    duration_in_frames: duration,
  }) as const;

const captionStyle = (clipId: string) =>
  ({ kind: "set_caption_style", operation_id: "op_style", clip_id: clipId, style_slot: "source" }) as const;

const captioned = () => applyTimelineOperation(captionReadyStrip(), addCaption(), {});

test("a caption added to a scene spans it with one default cue", () => {
  const next = captioned();

  expect(next.clips!.at(-1)).toEqual({
    kind: "caption",
    clip_id: "clip_cap",
    track_id: "track_caption",
    scene_id: "scene_002",
    from_frame: 30,
    duration_in_frames: 60,
    ownership: "user_edited",
    hidden: false,
    locked: false,
    style_slot: "caption_default",
    cues: [{ from_frame: 0, duration_in_frames: 60, text: "Hello" }],
  });
  expect(next.tracks.find((track) => track.track_id === "track_caption")!.clip_ids).toEqual(["clip_cap"]);
});

test.each([
  ["an unknown scene", addCaption({ scene_id: "scene_missing" }), "unknown scene"],
  ["a reused clip ID", addCaption({ clip_id: "clip_001" }), "reuses an existing clip ID"],
  ["a non-caption track", addCaption({ track_id: "track_music" }), "clip kind is incompatible with track"],
] as const)("a caption naming %s is refused", (_label, operation, message) => {
  expect(() => applyTimelineOperation(captionReadyStrip(), operation, {})).toThrow(message);
});

test("cue timing moves a cue inside its caption and refuses one outside it", () => {
  const next = applyTimelineOperation(captioned(), cueTiming(10, 20), {});
  const caption = next.clips!.at(-1)!;

  expect(caption.kind === "caption" && caption.cues[0]).toEqual({ from_frame: 10, duration_in_frames: 20, text: "Hello" });
  expect(() => applyTimelineOperation(captioned(), cueTiming(50, 20), {})).toThrow(
    "caption cues must stay inside their clip",
  );
  expect(() => applyTimelineOperation(captioned(), cueTiming(0, 10, 1), {})).toThrow("caption cue unavailable");
});

test("a caption style applies only to an unlocked caption", () => {
  const styled = applyTimelineOperation(captioned(), captionStyle("clip_cap"), {});
  expect(styled.clips!.at(-1)).toMatchObject({ style_slot: "source" });

  expect(() => applyTimelineOperation(captioned(), captionStyle("clip_001"), {})).toThrow(
    "caption style applies only to caption clips",
  );
  const locked = captioned();
  locked.clips!.at(-1)!.locked = true;
  expect(() => applyTimelineOperation(locked, captionStyle("clip_cap"), {})).toThrow("clip is locked");
});

test("a scene-bound caption keeps its cues inside the caption when the scene shrinks", () => {
  const document = applyTimelineOperation(captioned(), cueTiming(50, 10), {});
  const previousStarts = new Map(document.scenes.map((scene) => [scene.scene_id, scene.start_frame]));
  document.scenes[1]!.duration_in_frames = 30;
  document.scenes[2]!.start_frame = 60;

  carrySceneClips(document, previousStarts);

  expect(document.clips!.at(-1)).toMatchObject({
    duration_in_frames: 30,
    cues: [{ from_frame: 29, duration_in_frames: 1, text: "Hello" }],
  });
});
