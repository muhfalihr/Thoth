import { expect, test } from "bun:test";

import type {
  EditDocument,
  EditDocumentOperation,
  EditDocumentV1,
  EditDocumentV2,
  EditorAsset,
} from "@/api/control-plane";
import type { EditorAction } from "./editor_state";
import { createEditorState, editorReducer, toEditDocumentPatch } from "./editor_state";
import { upgradedTextDocument } from "./timeline-test-fixtures";

const document = {
  schema_version: 1,
  document_id: "document_001",
  project_id: "project_001",
  revision: 3,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
  template: { template_id: "vertical_text_story", version: 1 },
  tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: ["clip_001", "clip_002"] }],
  scenes: [
    { scene_id: "scene_001", role: "title", start_frame: 0, duration_in_frames: 120, clip_ids: ["clip_001"] },
    { scene_id: "scene_002", role: "source", start_frame: 120, duration_in_frames: 180, clip_ids: ["clip_002"] },
  ],
  clips: [
    {
      kind: "text",
      clip_id: "clip_001",
      scene_id: "scene_001",
      track_id: "track_visual",
      start_frame: 0,
      duration_in_frames: 120,
      heading: "Original heading",
      body: "Original body",
      ownership: "ai_managed",
      style_slot: "title",
    },
    {
      kind: "text",
      clip_id: "clip_002",
      scene_id: "scene_002",
      track_id: "track_visual",
      start_frame: 120,
      duration_in_frames: 180,
      heading: "Second heading",
      body: "Second body",
      ownership: "locked",
      style_slot: "source",
    },
  ],
} satisfies EditDocument;

/** The guided-editing tests only ever drive schema-v1 text stories. */
const story = (value: EditDocument) => value as EditDocumentV1;

test("selection and guided edits update the draft and create typed pending operations", () => {
  let state = createEditorState(document);
  state = editorReducer(state, { type: "select_scene", sceneId: "scene_002" });
  state = editorReducer(state, {
    type: "edit_text",
    clipId: "clip_002",
    field: "heading",
    value: "Edited heading",
    operationId: "op_text",
  });
  state = editorReducer(state, {
    type: "edit_ownership",
    clipId: "clip_002",
    ownership: "locked",
    operationId: "op_owner",
  });
  state = editorReducer(state, {
    type: "edit_duration",
    sceneId: "scene_001",
    durationInFrames: 150,
    operationId: "op_duration",
  });

  expect(state.selectedSceneId).toBe("scene_002");
  expect(story(state.draft).clips[1]).toMatchObject({ heading: "Edited heading", ownership: "locked", start_frame: 150 });
  expect(state.draft.scenes[1].start_frame).toBe(150);
  expect(state.draft.canvas.duration_in_frames).toBe(330);
  expect(toEditDocumentPatch(state)).toEqual({
    base_revision: 3,
    operations: [
      {
        kind: "replace_text",
        operation_id: "op_text",
        clip_id: "clip_002",
        field: "heading",
        value: "Edited heading",
      },
      {
        kind: "set_ownership",
        operation_id: "op_owner",
        clip_id: "clip_002",
        ownership: "locked",
      },
      {
        kind: "set_scene_duration",
        operation_id: "op_duration",
        scene_id: "scene_001",
        duration_in_frames: 150,
      },
    ],
  });
});

test("undo and redo restore exact draft and pending-operation snapshots", () => {
  const initial = createEditorState(document);
  const edited = editorReducer(initial, {
    type: "edit_text",
    clipId: "clip_001",
    field: "body",
    value: "Changed body",
    operationId: "op_body",
  });
  const undone = editorReducer(edited, { type: "undo" });
  const redone = editorReducer(undone, { type: "redo" });

  expect(undone.draft).toEqual(initial.draft);
  expect(undone.pendingOperations).toEqual(initial.pendingOperations);
  expect(redone.draft).toEqual(edited.draft);
  expect(redone.pendingOperations).toEqual(edited.pendingOperations);
});

test("save outcomes reset saved history or preserve a conflicted local draft", () => {
  const edited = editorReducer(createEditorState(document), {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value: "Local heading",
    operationId: "op_local",
  });
  const latest = {
    ...document,
    revision: 4,
    clips: document.clips.map((clip) =>
      clip.clip_id === "clip_001" ? { ...clip, heading: "Remote heading" } : clip,
    ),
  };
  const conflicted = editorReducer(edited, { type: "save_conflicted", latest });

  expect(conflicted.saveStatus).toBe("conflict");
  expect(story(conflicted.draft).clips[0].heading).toBe("Local heading");
  expect(editorReducer(conflicted, { type: "reload_latest" }).draft).toEqual(latest);

  const saved = editorReducer(edited, { type: "save_succeeded", document: latest });
  expect(saved).toMatchObject({
    base: latest,
    draft: latest,
    pendingOperations: [],
    history: [],
    future: [],
    saveStatus: "saved",
  });
});

test("Keep Editing Locally rebases the intact draft and resets stale history before saving", () => {
  let local = editorReducer(createEditorState(document), {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value: "Local heading",
    operationId: "op_local",
  });
  local = editorReducer(local, {
    type: "edit_ownership",
    clipId: "clip_001",
    ownership: "locked",
    operationId: "op_local_owner",
  });
  local = editorReducer(local, {
    type: "edit_duration",
    sceneId: "scene_001",
    durationInFrames: 150,
    operationId: "op_local_duration",
  });
  const remoteDuration = story(
    editorReducer(createEditorState(document), {
      type: "edit_duration",
      sceneId: "scene_001",
      durationInFrames: 100,
      operationId: "op_remote_duration",
    }).draft,
  );
  const latest = {
    ...remoteDuration,
    revision: 4,
    clips: remoteDuration.clips.map((clip) =>
      clip.clip_id === "clip_001"
        ? { ...clip, heading: "Remote heading", body: "Remote body", ownership: "ai_managed" as const }
        : clip,
    ),
  };
  const conflicted = editorReducer(local, { type: "save_conflicted", latest });
  const kept = editorReducer(conflicted, {
    type: "keep_editing_locally",
    operationIdPrefix: "op_rebase",
  });

  expect(kept.draft).toEqual(local.draft);
  expect(kept.base).toEqual(latest);
  expect(kept.history).toEqual([]);
  expect(kept.future).toEqual([]);
  expect(kept.saveStatus).toBe("dirty");
  expect(toEditDocumentPatch(kept)).toEqual({
    base_revision: 4,
    operations: [
      {
        kind: "replace_text",
        operation_id: "op_rebase_0",
        clip_id: "clip_001",
        field: "heading",
        value: "Local heading",
      },
      {
        kind: "replace_text",
        operation_id: "op_rebase_1",
        clip_id: "clip_001",
        field: "body",
        value: "Original body",
      },
      {
        kind: "set_ownership",
        operation_id: "op_rebase_2",
        clip_id: "clip_001",
        ownership: "locked",
      },
      {
        kind: "set_scene_duration",
        operation_id: "op_rebase_3",
        scene_id: "scene_001",
        duration_in_frames: 150,
      },
    ],
  });

  const afterUndo = editorReducer(kept, { type: "undo" });
  expect(afterUndo.draft).toEqual(local.draft);
  expect(afterUndo.saveStatus).toBe("dirty");

  const persisted = { ...local.draft, revision: 5 };
  const saved = editorReducer(kept, { type: "save_succeeded", document: persisted });
  expect(saved).toMatchObject({ base: persisted, draft: persisted, saveStatus: "saved" });
});

function timelineDocument(): EditDocumentV2 {
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

const moveMusic: EditDocumentOperation = {
  kind: "move_clip",
  operation_id: "op_move",
  clip_id: "clip_music",
  target_track_id: "track_music",
  from_frame: 60,
  ripple: false,
};

function timelineClip(state: { draft: EditDocument }, clipId: string) {
  const clip = (state.draft.clips ?? []).find((entry) => entry.clip_id === clipId);
  if (!clip) throw new Error("missing clip " + clipId);
  return clip as Extract<NonNullable<EditDocumentV2["clips"]>[number], { from_frame: number }>;
}

test("a timeline document opens in advanced mode and mode switching is view-only", () => {
  const state = createEditorState(timelineDocument());
  expect(state.mode).toBe("advanced");
  expect(createEditorState(document).mode).toBe("simple");

  const simple = editorReducer(state, { type: "set_editor_mode", mode: "simple" });
  expect(simple.mode).toBe("simple");
  expect(simple.draft).toBe(state.draft);
  expect(simple.pendingOperations).toEqual([]);
});

test("selection, playhead, zoom, snapping, and ripple stay outside the saved draft", () => {
  let state = createEditorState(timelineDocument());
  state = editorReducer(state, { type: "select_clip", clipId: "clip_music" });
  state = editorReducer(state, { type: "select_issue", issueId: "clip_overlap:clip_music" });
  state = editorReducer(state, { type: "set_playhead", frame: 1_000 });
  state = editorReducer(state, { type: "set_zoom", zoom: 99 });
  state = editorReducer(state, { type: "set_snapping", snapping: false });
  state = editorReducer(state, { type: "set_ripple", ripple: true });

  expect(state).toMatchObject({
    selectedClipId: "clip_music",
    selectedTrackId: "track_music",
    selectedIssueId: "clip_overlap:clip_music",
    playheadFrame: 299,
    zoom: 4,
    snapping: false,
    ripple: true,
  });
  expect(state.pendingOperations).toEqual([]);
  expect(state.history).toEqual([]);
  expect(state.saveStatus).toBe("saved");

  expect(editorReducer(state, { type: "select_clip", clipId: "clip_absent" })).toBe(state);
  expect(editorReducer(state, { type: "select_track", trackId: "track_absent" })).toBe(state);
  expect(editorReducer(state, { type: "set_playhead", frame: -5 }).playheadFrame).toBe(0);
});

test("a gesture preview is transient and one commit adds one history entry and operation", () => {
  const initial = createEditorState(timelineDocument());
  let state = editorReducer(initial, { type: "preview_timeline_operation", operation: moveMusic });
  expect(timelineClip(state, "clip_music").from_frame).toBe(60);
  expect(state.pendingOperations).toEqual([]);
  expect(state.history).toEqual([]);

  const cancelled = editorReducer(state, { type: "cancel_timeline_preview" });
  expect(cancelled.draft).toBe(initial.draft);
  expect(cancelled.preview).toBeUndefined();

  state = editorReducer(state, {
    type: "preview_timeline_operation",
    operation: { ...moveMusic, from_frame: 90 },
  });
  state = editorReducer(state, {
    type: "commit_timeline_operation",
    operation: { ...moveMusic, from_frame: 90 },
  });
  expect(timelineClip(state, "clip_music").from_frame).toBe(90);
  expect(state.preview).toBeUndefined();
  expect(state.history).toHaveLength(1);
  expect(state.history[0]?.draft).toBe(initial.draft);
  expect(state.pendingOperations).toEqual([{ ...moveMusic, from_frame: 90 }]);
  expect(state.saveStatus).toBe("dirty");
});

test("trim, split, volume, and track settings all flow through pending operations", () => {
  let state = createEditorState(timelineDocument());
  const commit = (operation: EditDocumentOperation) => {
    state = editorReducer(state, { type: "commit_timeline_operation", operation });
  };

  commit({ kind: "trim_clip_end", operation_id: "op_trim", clip_id: "clip_music", end_frame: 90 });
  commit({
    kind: "split_clip",
    operation_id: "op_split",
    clip_id: "clip_music",
    split_frame: 45,
    left_clip_id: "clip_music_a",
    right_clip_id: "clip_music_b",
  });
  commit({
    kind: "set_clip_volume",
    operation_id: "op_volume",
    clip_id: "clip_music_a",
    volume: 0.5,
  });
  commit({ kind: "set_track_muted", operation_id: "op_mute", track_id: "track_music", muted: true });

  expect(timelineClip(state, "clip_music_a")).toMatchObject({
    duration_in_frames: 45,
    volume: 0.5,
  });
  expect(timelineClip(state, "clip_music_b")).toMatchObject({
    from_frame: 45,
    duration_in_frames: 45,
  });
  expect(state.draft.tracks[1]).toMatchObject({ track_id: "track_music", muted: true });
  expect(state.pendingOperations.map((operation) => operation.operation_id)).toEqual([
    "op_trim",
    "op_split",
    "op_volume",
    "op_mute",
  ]);
  expect(toEditDocumentPatch(state).base_revision).toBe(4);
});

test("a refused operation leaves the draft and the pending queue untouched", () => {
  const state = editorReducer(createEditorState(timelineDocument()), {
    type: "commit_timeline_operation",
    operation: {
      kind: "set_track_visibility",
      operation_id: "op_locked",
      track_id: "track_locked",
      hidden: true,
    },
  });
  expect(state.draft).toEqual(timelineDocument());
  expect(state.pendingOperations).toEqual([]);
  expect(state.history).toEqual([]);
});

test("a refusal mid-gesture rolls the preview back instead of keeping it on screen", () => {
  const initial = createEditorState(timelineDocument());
  const previewing = editorReducer(initial, {
    type: "preview_timeline_operation",
    operation: moveMusic,
  });
  const state = editorReducer(previewing, {
    type: "commit_timeline_operation",
    operation: { kind: "remove_clip", operation_id: "op_gone", clip_id: "clip_absent" },
  });
  expect(state.draft).toBe(initial.draft);
  expect(state.preview).toBeUndefined();
  expect(state.pendingOperations).toEqual([]);
});

test("timeline edits undo, redo, and survive offline autosave cycles", () => {
  let state = createEditorState(timelineDocument());
  state = editorReducer(state, { type: "commit_timeline_operation", operation: moveMusic });
  const moved = state.draft;

  state = editorReducer(state, { type: "undo" });
  expect(timelineClip(state, "clip_music").from_frame).toBe(0);
  expect(state.pendingOperations).toEqual([]);
  expect(state.saveStatus).toBe("saved");

  state = editorReducer(state, { type: "redo" });
  expect(state.draft).toBe(moved);
  expect(state.pendingOperations).toEqual([moveMusic]);

  state = editorReducer(state, { type: "went_offline" });
  expect(state.saveStatus).toBe("offline");
  expect(editorReducer(state, { type: "save_started" }).saveStatus).toBe("offline");
  state = editorReducer(state, { type: "went_online" });
  expect(state.saveStatus).toBe("dirty");
});

test("a save keeps newer local timeline operations pending", () => {
  let state = createEditorState(timelineDocument());
  state = editorReducer(state, { type: "commit_timeline_operation", operation: moveMusic });
  state = editorReducer(state, { type: "save_started" });
  state = editorReducer(state, {
    type: "commit_timeline_operation",
    operation: {
      kind: "set_track_muted",
      operation_id: "op_later",
      track_id: "track_music",
      muted: true,
    },
  });

  const persisted = { ...timelineDocument(), revision: 5 };
  state = editorReducer(state, {
    type: "save_succeeded",
    document: persisted,
    operationIds: ["op_move"],
  });
  expect(state.base).toBe(persisted);
  expect(state.pendingOperations.map((operation) => operation.operation_id)).toEqual(["op_later"]);
  expect(state.saveStatus).toBe("dirty");
});

test("keeping timeline edits after a conflict rebases the same operations onto the newer base", () => {
  let state = createEditorState(timelineDocument());
  state = editorReducer(state, { type: "commit_timeline_operation", operation: moveMusic });
  const latest = { ...timelineDocument(), revision: 9 };
  state = editorReducer(state, { type: "save_conflicted", latest });
  expect(state.saveStatus).toBe("conflict");

  const kept = editorReducer(state, {
    type: "keep_editing_locally",
    operationIdPrefix: "op_rebase",
  });
  expect(kept.base).toBe(latest);
  expect(kept.pendingOperations).toEqual([moveMusic]);
  expect(kept.latestConflict).toBeUndefined();
  expect(toEditDocumentPatch(kept).base_revision).toBe(9);

  const reloaded = editorReducer(state, { type: "reload_latest" });
  expect(reloaded).toMatchObject({ base: latest, draft: latest, saveStatus: "saved" });
  expect(reloaded.pendingOperations).toEqual([]);
});

test("guided text actions are inert on a clip that holds no text", () => {
  const state = createEditorState(timelineDocument());
  const actions: EditorAction[] = [
    { type: "edit_text", clipId: "clip_main", field: "heading", value: "x", operationId: "op_a" },
    { type: "edit_ownership", clipId: "clip_main", ownership: "user_edited", operationId: "op_b" },
  ];
  for (const action of actions) {
    expect(editorReducer(state, action)).toBe(state);
  }
});

test("guided edits reach a timeline document through the same operations", () => {
  const upgraded = upgradedTextDocument();
  const edited = editorReducer(createEditorState(upgraded), {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value: "Advanced heading",
    operationId: "op_a",
  });
  const resized = editorReducer(edited, {
    type: "edit_duration",
    sceneId: "scene_001",
    durationInFrames: 90,
    operationId: "op_b",
  });

  expect(resized.pendingOperations).toEqual([
    {
      kind: "replace_text",
      operation_id: "op_a",
      clip_id: "clip_001",
      field: "heading",
      value: "Advanced heading",
    },
    {
      kind: "set_scene_duration",
      operation_id: "op_b",
      scene_id: "scene_001",
      duration_in_frames: 90,
    },
  ]);
  const draft = resized.draft as EditDocumentV2;
  expect(draft.clips?.[0]).toMatchObject({
    clip_id: "clip_001",
    heading: "Advanced heading",
    ownership: "user_edited",
    from_frame: 0,
    duration_in_frames: 90,
  });
  expect(draft.scenes[0].duration_in_frames).toBe(90);
  expect(draft.canvas.duration_in_frames).toBe(90);
  // The upgraded document itself is never mutated in place.
  expect(upgraded.canvas.duration_in_frames).toBe(150);
});

test("loaded assets are indexed by ID and gate local asset operations", () => {
  const asset: EditorAsset = {
    asset_id: "asset_new",
    project_id: "project_001",
    kind: "video",
    media_type: "video/mp4",
    has_audio: true,
    validation_state: "ready",
    duration_in_frames: 600,
  };
  const loaded = editorReducer(createEditorState(timelineDocument()), {
    type: "assets_loaded",
    assets: [asset],
    replace: true,
  });
  expect(loaded.assets).toEqual({ asset_new: asset });

  const second = { ...asset, asset_id: "asset_page_two" };
  const both = editorReducer(loaded, {
    type: "assets_loaded",
    assets: [second],
    replace: false,
  });
  expect(both.assets).toEqual({ asset_new: asset, asset_page_two: second });
  expect(
    editorReducer(both, { type: "assets_loaded", assets: [second], replace: true }).assets,
  ).toEqual({ asset_page_two: second });

  const added = editorReducer(loaded, {
    type: "commit_timeline_operation",
    operation: {
      kind: "add_clip_from_asset",
      operation_id: "op_add",
      clip_id: "clip_broll",
      track_id: "track_main",
      asset_id: "asset_new",
      from_frame: 150,
      duration_in_frames: 60,
      source_from_frame: 0,
    },
  });
  expect(timelineClip(added, "clip_broll")).toMatchObject({ asset_id: "asset_new", from_frame: 150 });
  expect((added.draft as EditDocumentV2).asset_refs?.map((ref) => ref.asset_id)).toEqual(["asset_video", "asset_new"]);

  const unknown = editorReducer(createEditorState(timelineDocument()), {
    type: "commit_timeline_operation",
    operation: {
      kind: "add_clip_from_asset",
      operation_id: "op_unknown",
      clip_id: "clip_broll",
      track_id: "track_main",
      asset_id: "asset_new",
      from_frame: 150,
      duration_in_frames: 60,
      source_from_frame: 0,
    },
  });
  expect(unknown.pendingOperations).toEqual([]);
});

const editHeading = (state: ReturnType<typeof createEditorState>, value: string) =>
  editorReducer(state, {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value,
    operationId: "op_local",
  });

test("upgrade starts only from a saved, online, operation-free state", () => {
  const clean = createEditorState(document);
  expect(editorReducer(clean, { type: "upgrade_started" }).upgradeStatus).toBe("running");

  const dirty = editHeading(clean, "Local draft");
  expect(editorReducer(dirty, { type: "upgrade_started" })).toEqual(dirty);

  const offline = editorReducer(clean, { type: "went_offline" });
  expect(editorReducer(offline, { type: "upgrade_started" })).toEqual(offline);

  const conflicted = editorReducer(clean, {
    type: "save_conflicted",
    latest: { ...document, revision: 9 },
  });
  expect(editorReducer(conflicted, { type: "upgrade_started" })).toEqual(conflicted);
});

test("upgrade success never acknowledges pending autosave operations", () => {
  const dirty = editHeading(createEditorState(document), "Local draft");
  const result = editorReducer(dirty, { type: "upgrade_succeeded", document: timelineDocument() });

  expect(result.draft).toEqual(dirty.draft);
  expect(result.pendingOperations).toEqual(dirty.pendingOperations);
});

test("document edits are blocked while upgrade is running", () => {
  const upgrading = editorReducer(createEditorState(document), { type: "upgrade_started" });

  expect(editHeading(upgrading, "late edit")).toEqual(upgrading);
  expect(editorReducer(upgrading, { type: "undo" })).toEqual(upgrading);
  // Selection and playback stay usable: they never touch the document.
  expect(editorReducer(upgrading, { type: "select_scene", sceneId: "scene_002" }).selectedSceneId).toBe(
    "scene_002",
  );
});

test("upgrade success adopts the version 2 document and opens advanced mode", () => {
  const upgrading = editorReducer(createEditorState(document), { type: "upgrade_started" });
  const upgraded = editorReducer(upgrading, {
    type: "upgrade_succeeded",
    document: timelineDocument(),
  });

  expect(upgraded.draft).toEqual(timelineDocument());
  expect(upgraded.base).toEqual(timelineDocument());
  expect(upgraded.mode).toBe("advanced");
  expect(upgraded.upgradeStatus).toBe("idle");
  expect(upgraded.saveStatus).toBe("saved");
  expect(upgraded.history).toEqual([]);
});

test("upgrade conflict and failure keep the local draft", () => {
  const upgrading = editorReducer(createEditorState(document), { type: "upgrade_started" });
  const latest = { ...document, revision: 9 };

  const conflicted = editorReducer(upgrading, { type: "upgrade_conflicted", latest });
  expect(conflicted.draft).toEqual(document);
  expect(conflicted.saveStatus).toBe("conflict");
  expect(conflicted.latestConflict).toEqual(latest);
  expect(conflicted.upgradeStatus).toBe("idle");

  const failed = editorReducer(upgrading, { type: "upgrade_failed" });
  expect(failed.draft).toEqual(document);
  expect(failed.upgradeStatus).toBe("failed");
  // A failed upgrade is retryable: editing is possible again.
  expect(editHeading(failed, "after failure").pendingOperations).toHaveLength(1);
});

const readyVideoAsset = (): EditorAsset => ({
  asset_id: "asset_new",
  project_id: "project_001",
  kind: "video",
  media_type: "video/mp4",
  has_audio: true,
  validation_state: "ready",
  duration_in_frames: 600,
});

test("save success preserves version 2 session state and loaded assets", () => {
  const asset = readyVideoAsset();
  let state = createEditorState(timelineDocument(), { [asset.asset_id]: asset });
  state = editorReducer(state, { type: "set_editor_mode", mode: "simple" });
  state = editorReducer(state, { type: "select_clip", clipId: "clip_music" });
  state = editorReducer(state, { type: "select_issue", issueId: "issue_001" });
  state = editorReducer(state, { type: "set_playhead", frame: 77 });
  state = editorReducer(state, { type: "set_playing", playing: true });
  state = editorReducer(state, { type: "set_zoom", zoom: 2 });
  state = editorReducer(state, { type: "set_snapping", snapping: false });
  state = editorReducer(state, { type: "set_ripple", ripple: true });

  const saved = editorReducer(state, {
    type: "save_succeeded",
    document: { ...timelineDocument(), revision: 5 },
  });

  expect(saved.mode).toBe("simple");
  expect(saved.selectedClipId).toBe("clip_music");
  expect(saved.selectedTrackId).toBe("track_music");
  expect(saved.selectedIssueId).toBe("issue_001");
  expect(saved.playheadFrame).toBe(77);
  expect(saved.playing).toBe(true);
  expect(saved.zoom).toBe(2);
  expect(saved.snapping).toBe(false);
  expect(saved.ripple).toBe(true);
  expect(saved.assets).toEqual({ [asset.asset_id]: asset });
  expect(saved.base).toMatchObject({ revision: 5 });
  expect(saved.saveStatus).toBe("saved");
});

test("save success drops session identities the returned document no longer holds", () => {
  let state = createEditorState(timelineDocument());
  state = editorReducer(state, { type: "select_clip", clipId: "clip_music" });
  state = editorReducer(state, { type: "set_playhead", frame: 250 });

  const shortened = timelineDocument();
  const persisted: EditDocumentV2 = {
    ...shortened,
    revision: 6,
    canvas: { ...shortened.canvas, duration_in_frames: 120 },
    scenes: [],
    tracks: shortened.tracks.filter((track) => track.track_id !== "track_music"),
    clips: shortened.clips?.filter((clip) => clip.clip_id !== "clip_music"),
  };
  const saved = editorReducer(state, { type: "save_succeeded", document: persisted });

  expect(saved.selectedClipId).toBe("");
  expect(saved.selectedTrackId).toBe("");
  expect(saved.selectedSceneId).toBe("");
  expect(saved.playheadFrame).toBe(119);
});

test("save success of a version 1 document stays in simple mode", () => {
  const state = editorReducer(createEditorState(document), {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value: "Edited heading",
    operationId: "op_text",
  });

  const saved = editorReducer(state, {
    type: "save_succeeded",
    document: { ...document, revision: 4 },
  });

  expect(saved.mode).toBe("simple");
  expect(saved.pendingOperations).toEqual([]);
});
