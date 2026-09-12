import { expect, test } from "bun:test";

import type { EditDocument } from "@/api/control-plane";
import { createEditorState, editorReducer } from "./editor_state";

const editDocument = {
  schema_version: 1,
  document_id: "document_001",
  project_id: "project_001",
  revision: 3,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 150 },
  template: { template_id: "vertical_text_story", version: 1 },
  tracks: [{ track_id: "track_visual", kind: "visual", clip_ids: ["clip_001"] }],
  scenes: [
    {
      scene_id: "scene_001",
      role: "title",
      start_frame: 0,
      duration_in_frames: 150,
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
      duration_in_frames: 150,
      heading: "Original heading",
      body: "Original body",
      ownership: "ai_managed",
      style_slot: "title",
    },
  ],
} satisfies EditDocument;

test("preserves conflict state through local edit undo and redo until explicit recovery", () => {
  const edited = editorReducer(createEditorState(editDocument), {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value: "Local heading",
    operationId: "op_local",
  });
  const latest = {
    ...editDocument,
    revision: 4,
    clips: [{ ...editDocument.clips[0], heading: "Remote heading" }],
  };
  const conflicted = editorReducer(edited, { type: "save_conflicted", latest });
  const locallyEdited = editorReducer(conflicted, {
    type: "edit_text",
    clipId: "clip_001",
    field: "body",
    value: "Local body",
    operationId: "op_local_body",
  });
  const undone = editorReducer(locallyEdited, { type: "undo" });
  const redone = editorReducer(undone, { type: "redo" });

  for (const state of [locallyEdited, undone, redone]) {
    expect(state.saveStatus).toBe("conflict");
    expect(state.latestConflict).toEqual(latest);
  }
  expect(editorReducer(redone, { type: "reload_latest" }).latestConflict).toBeUndefined();
});

test("offline retains pending draft and reconnect resumes dirty save eligibility", () => {
  let state = editorReducer(createEditorState(editDocument), { type: "went_offline" });
  state = editorReducer(state, {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value: "Offline heading",
    operationId: "op_offline",
  });

  expect(state.saveStatus).toBe("offline");
  expect(state.draft.clips[0].heading).toBe("Offline heading");
  expect(state.pendingOperations).toHaveLength(1);
  expect(
    editorReducer(state, {
      type: "save_succeeded",
      document: { ...editDocument, revision: 4 },
      operationIds: ["op_offline"],
    }).saveStatus,
  ).toBe("offline");

  state = editorReducer(state, { type: "went_online" });
  expect(state.saveStatus).toBe("dirty");
  expect(state.pendingOperations[0].operation_id).toBe("op_offline");
});

test("offline does not let undo overtake an in-flight save", () => {
  let state = editorReducer(createEditorState(editDocument), {
    type: "edit_text",
    clipId: "clip_001",
    field: "heading",
    value: "Sent heading",
    operationId: "op_sent",
  });
  state = editorReducer(state, { type: "save_started" });
  state = editorReducer(state, { type: "went_offline" });

  expect(state.saveStatus).toBe("saving");
  expect(editorReducer(state, { type: "undo" })).toEqual(state);

  state = editorReducer(state, {
    type: "save_succeeded",
    document: {
      ...editDocument,
      revision: 4,
      clips: [{ ...editDocument.clips[0], heading: "Sent heading", ownership: "user_edited" }],
    },
    operationIds: ["op_sent"],
  });
  expect(state.saveStatus).toBe("offline");
  expect(state.draft.clips[0].heading).toBe("Sent heading");

  expect(editorReducer(state, { type: "went_online" }).saveStatus).toBe("saved");
});
