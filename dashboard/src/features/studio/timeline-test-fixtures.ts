import type { EditDocumentV2 } from "@/api/control-plane";

/** One bounded version 2 document shared by the timeline and issues tests. */
export function timelineDocument(): EditDocumentV2 {
  return {
    schema_version: 2,
    document_id: "document_002",
    project_id: "project_001",
    revision: 4,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
    template: { template_id: "vertical_text_story", version: 1 },
    scenes: [
      {
        scene_id: "scene_001",
        role: "source",
        start_frame: 0,
        duration_in_frames: 300,
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
      {
        asset_id: "asset_music",
        project_id: "project_001",
        kind: "audio",
        has_audio: true,
        validation_state: "ready",
      },
    ],
    tracks: [
      {
        track_id: "track_main",
        kind: "main_video",
        label: "Main video",
        order: 0,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_main"],
      },
      {
        track_id: "track_broll",
        kind: "b_roll",
        label: "B-roll",
        order: 1,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_locked"],
      },
      {
        track_id: "track_music",
        kind: "music",
        label: "Music",
        order: 2,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_music"],
      },
      {
        track_id: "track_captions",
        kind: "caption",
        label: "Captions",
        order: 3,
        hidden: true,
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
        duration_in_frames: 120,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        fit: "cover",
      },
      {
        kind: "video",
        clip_id: "clip_locked",
        track_id: "track_broll",
        asset_id: "asset_video",
        from_frame: 150,
        duration_in_frames: 50,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: true,
        fit: "cover",
      },
      {
        kind: "audio",
        clip_id: "clip_music",
        track_id: "track_music",
        asset_id: "asset_music",
        from_frame: 150,
        duration_in_frames: 90,
        source_from_frame: 0,
        ownership: "user_edited",
        hidden: false,
        locked: false,
        volume: 0.8,
        fade_in_frames: 0,
        fade_out_frames: 0,
      },
    ],
  };
}

/** The version 2 projection of the guided text story, as the upgrade produces it. */
/** Every upgraded track starts visible, unmuted, unlocked, and empty. */
const lane = { clip_ids: [] as string[], hidden: false, muted: false, locked: false };

export function upgradedTextDocument(): EditDocumentV2 {
  return {
    schema_version: 2,
    document_id: "document_001",
    project_id: "project_001",
    revision: 2,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 150 },
    template: { template_id: "vertical_text_story", version: 1 },
    scenes: [
      {
        scene_id: "scene_001",
        role: "title",
        start_frame: 0,
        duration_in_frames: 150,
        clip_ids: ["clip_001"],
      },
    ],
    asset_refs: [],
    tracks: [
      { ...lane, track_id: "track_main", kind: "main_video", label: "Main video", order: 0 },
      { ...lane, track_id: "track_broll", kind: "b_roll", label: "B-roll", order: 1 },
      {
        ...lane,
        track_id: "track_overlay",
        kind: "overlay",
        label: "Overlay",
        order: 2,
        clip_ids: ["clip_001"],
      },
      { ...lane, track_id: "track_music", kind: "music", label: "Music", order: 3 },
    ],
    clips: [
      {
        kind: "text",
        clip_id: "clip_001",
        track_id: "track_overlay",
        scene_id: "scene_001",
        from_frame: 0,
        duration_in_frames: 150,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        heading: "Original heading",
        body: "Original body",
        style_slot: "title",
      },
    ],
  };
}

/** Minimal stand-in for Remotion's PlayerRef, counting every listener. */
export class FakePlayer {
  listeners: Record<string, Set<(event: unknown) => void>> = {};
  frame = 0;
  seeks: number[] = [];
  calls: string[] = [];

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= new Set()).add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type]?.delete(listener);
  }

  getCurrentFrame() {
    return this.frame;
  }

  seekTo(frame: number) {
    this.seeks.push(frame);
    this.frame = frame;
  }

  play() {
    this.calls.push("play");
  }

  pause() {
    this.calls.push("pause");
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }

  get listenerCount() {
    return Object.values(this.listeners).reduce((total, set) => total + set.size, 0);
  }
}

/**
 * Two of every media clip, each carrying the typed fields D1 persists but has no
 * operation to change, so the inspector can be checked across a selection change.
 */
export function typedTimelineDocument(): EditDocumentV2 {
  return {
    schema_version: 2,
    document_id: "document_003",
    project_id: "project_001",
    revision: 1,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 600 },
    template: { template_id: "vertical_text_story", version: 1 },
    scenes: [
      {
        scene_id: "scene_001",
        role: "source",
        start_frame: 0,
        duration_in_frames: 600,
        clip_ids: ["clip_a"],
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
      {
        asset_id: "asset_music",
        project_id: "project_001",
        kind: "audio",
        has_audio: true,
        validation_state: "ready",
      },
      {
        asset_id: "asset_still",
        project_id: "project_001",
        kind: "image",
        has_audio: false,
        validation_state: "ready",
      },
    ],
    tracks: [
      { ...lane, track_id: "track_main", kind: "main_video", label: "Main video", order: 0, clip_ids: ["clip_a", "clip_b", "clip_still"] },
      { ...lane, track_id: "track_overlay", kind: "overlay", label: "Overlay", order: 1, clip_ids: ["clip_overlay"] },
      { ...lane, track_id: "track_captions", kind: "caption", label: "Captions", order: 2, clip_ids: ["clip_caption"] },
      { ...lane, track_id: "track_music", kind: "music", label: "Music", order: 3, clip_ids: ["clip_audio"] },
    ],
    clips: [
      {
        kind: "video",
        clip_id: "clip_a",
        track_id: "track_main",
        scene_id: "scene_001",
        asset_id: "asset_video",
        from_frame: 0,
        duration_in_frames: 60,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        fit: "cover",
        crop: { left: 0, top: 0, width: 1, height: 1 },
        position: { x: 0, y: 0, scale: 1 },
      },
      {
        kind: "video",
        clip_id: "clip_b",
        track_id: "track_main",
        asset_id: "asset_video",
        from_frame: 90,
        duration_in_frames: 120,
        source_from_frame: 30,
        ownership: "user_edited",
        hidden: false,
        locked: false,
        fit: "contain",
        crop: { left: 0.1, top: 0.2, width: 0.5, height: 0.6 },
        position: { x: 0.25, y: -0.5, scale: 1.5 },
      },
      {
        kind: "overlay",
        clip_id: "clip_overlay",
        track_id: "track_overlay",
        from_frame: 0,
        duration_in_frames: 45,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        preset_id: "lower_third",
        parameters: { text: "Headline", accent_slot: "accent_primary" },
      },
      {
        kind: "caption",
        clip_id: "clip_caption",
        track_id: "track_captions",
        from_frame: 0,
        duration_in_frames: 90,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        style_slot: "caption_default",
        cues: [
          { from_frame: 0, duration_in_frames: 30, text: "First cue" },
          { from_frame: 30, duration_in_frames: 60, text: "Second cue" },
        ],
      },
      {
        kind: "audio",
        clip_id: "clip_audio",
        track_id: "track_music",
        asset_id: "asset_music",
        from_frame: 0,
        duration_in_frames: 150,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        volume: 0.4,
        fade_in_frames: 12,
        fade_out_frames: 24,
      },
      {
        kind: "video",
        clip_id: "clip_still",
        track_id: "track_main",
        asset_id: "asset_still",
        from_frame: 240,
        duration_in_frames: 60,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        fit: "contain",
      },
    ],
  };
}

/** Three text scenes of unequal length; scene_002 also holds a still at an offset. */
export function sceneStripDocument(): EditDocumentV2 {
  const base = upgradedTextDocument();
  const text = (index: number, fromFrame: number, duration: number) => ({
    kind: "text" as const,
    clip_id: `clip_00${index}`,
    track_id: "track_overlay",
    scene_id: `scene_00${index}`,
    from_frame: fromFrame,
    duration_in_frames: duration,
    ownership: "ai_managed" as const,
    hidden: false,
    locked: false,
    heading: `Heading ${index}`,
    body: "",
    style_slot: index === 1 ? ("title" as const) : ("source" as const),
  });
  return {
    ...base,
    canvas: { ...base.canvas, duration_in_frames: 180 },
    scenes: [
      { scene_id: "scene_001", role: "title", start_frame: 0, duration_in_frames: 30, clip_ids: ["clip_001"] },
      { scene_id: "scene_002", role: "source", start_frame: 30, duration_in_frames: 60, clip_ids: ["clip_002"] },
      { scene_id: "scene_003", role: "source", start_frame: 90, duration_in_frames: 90, clip_ids: ["clip_003"] },
    ],
    asset_refs: [
      { asset_id: "asset_still", project_id: "project_001", kind: "image", has_audio: false, validation_state: "ready" },
    ],
    tracks: base.tracks.map((entry) =>
      entry.track_id === "track_overlay"
        ? { ...entry, clip_ids: ["clip_001", "clip_002", "clip_003"] }
        : entry.track_id === "track_broll"
          ? { ...entry, clip_ids: ["clip_still"] }
          : entry,
    ),
    clips: [
      text(1, 0, 30),
      text(2, 30, 60),
      text(3, 90, 90),
      {
        kind: "video",
        clip_id: "clip_still",
        track_id: "track_broll",
        scene_id: "scene_002",
        asset_id: "asset_still",
        from_frame: 40,
        duration_in_frames: 20,
        source_from_frame: 0,
        ownership: "user_edited",
        hidden: false,
        locked: false,
        fit: "cover",
      },
    ],
  };
}
