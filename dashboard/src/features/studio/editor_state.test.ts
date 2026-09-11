import { expect, test } from "bun:test";

import type { EditDocument } from "@/api/control-plane";
import { createEditorState, editorReducer, toEditDocumentPatch } from "./editor_state";

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
  expect(state.draft.clips[1]).toMatchObject({ heading: "Edited heading", ownership: "locked", start_frame: 150 });
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
  expect(conflicted.draft.clips[0].heading).toBe("Local heading");
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
  const remoteDuration = editorReducer(createEditorState(document), {
    type: "edit_duration",
    sceneId: "scene_001",
    durationInFrames: 100,
    operationId: "op_remote_duration",
  }).draft;
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
