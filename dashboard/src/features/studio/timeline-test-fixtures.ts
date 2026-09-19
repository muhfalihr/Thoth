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
