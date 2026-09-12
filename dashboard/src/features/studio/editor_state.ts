import type { EditDocument, EditDocumentOperation, EditDocumentPatch } from "@/api/control-plane";

export type EditorSaveStatus = "saved" | "dirty" | "saving" | "failed" | "conflict" | "offline";

type EditorSnapshot = {
  draft: EditDocument;
  pendingOperations: EditDocumentOperation[];
};

export type EditorState = EditorSnapshot & {
  base: EditDocument;
  selectedSceneId: string;
  history: EditorSnapshot[];
  future: EditorSnapshot[];
  saveStatus: EditorSaveStatus;
  isOffline: boolean;
  latestConflict?: EditDocument;
};

export type EditorAction =
  | { type: "select_scene"; sceneId: string }
  | {
      type: "edit_text";
      clipId: string;
      field: "heading" | "body";
      value: string;
      operationId: string;
    }
  | {
      type: "edit_ownership";
      clipId: string;
      ownership: "ai_managed" | "user_edited" | "locked";
      operationId: string;
    }
  | { type: "edit_duration"; sceneId: string; durationInFrames: number; operationId: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "save_started" }
  | { type: "save_succeeded"; document: EditDocument; operationIds?: string[] }
  | { type: "save_failed" }
  | { type: "retry_save" }
  | { type: "went_offline" }
  | { type: "went_online" }
  | { type: "save_conflicted"; latest: EditDocument }
  | { type: "reload_latest" }
  | { type: "keep_editing_locally"; operationIdPrefix: string };

export function createEditorState(document: EditDocument): EditorState {
  return {
    base: document,
    draft: document,
    selectedSceneId: document.scenes[0]?.scene_id ?? "",
    history: [],
    future: [],
    saveStatus: "saved",
    isOffline: false,
    pendingOperations: [],
  };
}

function saveStatusAfterLocalChange(state: EditorState): EditorSaveStatus {
  if (state.latestConflict) return "conflict";
  if (state.isOffline) return "offline";
  return state.saveStatus === "saving" ? "saving" : "dirty";
}

function saveStatusAfterSnapshot(state: EditorState, snapshot: EditorSnapshot): EditorSaveStatus {
  if (state.latestConflict) return "conflict";
  if (state.isOffline) return "offline";
  return snapshot.pendingOperations.length ? "dirty" : "saved";
}

function edited(
  state: EditorState,
  draft: EditDocument,
  operation: EditDocumentOperation,
): EditorState {
  return {
    ...state,
    draft,
    history: [...state.history, { draft: state.draft, pendingOperations: state.pendingOperations }],
    future: [],
    pendingOperations: [...state.pendingOperations, operation],
    saveStatus: saveStatusAfterLocalChange(state),
  };
}

function resizeScene(document: EditDocument, sceneId: string, durationInFrames: number): EditDocument {
  const sceneIndex = document.scenes.findIndex((scene) => scene.scene_id === sceneId);
  if (sceneIndex < 0) return document;
  const delta = durationInFrames - document.scenes[sceneIndex].duration_in_frames;
  return {
    ...document,
    canvas: { ...document.canvas, duration_in_frames: document.canvas.duration_in_frames + delta },
    scenes: document.scenes.map((scene, index) =>
      index === sceneIndex
        ? { ...scene, duration_in_frames: durationInFrames }
        : index > sceneIndex
          ? { ...scene, start_frame: scene.start_frame + delta }
          : scene,
    ),
    clips: document.clips.map((clip) => {
      const clipSceneIndex = document.scenes.findIndex((scene) => scene.scene_id === clip.scene_id);
      if (clipSceneIndex === sceneIndex) return { ...clip, duration_in_frames: durationInFrames };
      return clipSceneIndex > sceneIndex ? { ...clip, start_frame: clip.start_frame + delta } : clip;
    }),
  };
}

function operationsToRetainDraft(
  base: EditDocument,
  draft: EditDocument,
  operationIdPrefix: string,
): EditDocumentOperation[] {
  const operations: EditDocumentOperation[] = [];
  const operationId = () => `${operationIdPrefix}_${operations.length}`;

  for (const baseClip of base.clips) {
    const draftClip = draft.clips.find((clip) => clip.clip_id === baseClip.clip_id);
    if (!draftClip) continue;
    let replacesText = false;
    for (const field of ["heading", "body"] as const) {
      if (draftClip[field] === baseClip[field]) continue;
      replacesText = true;
      operations.push({
        kind: "replace_text",
        operation_id: operationId(),
        clip_id: draftClip.clip_id,
        field,
        value: draftClip[field],
      });
    }
    const ownershipAfterText = replacesText ? "user_edited" : baseClip.ownership;
    if (draftClip.ownership !== ownershipAfterText) {
      operations.push({
        kind: "set_ownership",
        operation_id: operationId(),
        clip_id: draftClip.clip_id,
        ownership: draftClip.ownership,
      });
    }
  }
  for (const baseScene of base.scenes) {
    const draftScene = draft.scenes.find((scene) => scene.scene_id === baseScene.scene_id);
    if (draftScene && draftScene.duration_in_frames !== baseScene.duration_in_frames) {
      operations.push({
        kind: "set_scene_duration",
        operation_id: operationId(),
        scene_id: draftScene.scene_id,
        duration_in_frames: draftScene.duration_in_frames,
      });
    }
  }
  return operations;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "select_scene":
      return state.draft.scenes.some((scene) => scene.scene_id === action.sceneId)
        ? { ...state, selectedSceneId: action.sceneId }
        : state;
    case "edit_text": {
      const current = state.draft.clips.find((clip) => clip.clip_id === action.clipId);
      if (!current || current[action.field] === action.value) return state;
      const draft = {
        ...state.draft,
        clips: state.draft.clips.map((clip) =>
          clip.clip_id === action.clipId
            ? { ...clip, [action.field]: action.value, ownership: "user_edited" as const }
            : clip,
        ),
      };
      return edited(state, draft, {
        kind: "replace_text",
        operation_id: action.operationId,
        clip_id: action.clipId,
        field: action.field,
        value: action.value,
      });
    }
    case "edit_ownership": {
      const current = state.draft.clips.find((clip) => clip.clip_id === action.clipId);
      if (!current || current.ownership === action.ownership) return state;
      return edited(
        state,
        {
          ...state.draft,
          clips: state.draft.clips.map((clip) =>
            clip.clip_id === action.clipId ? { ...clip, ownership: action.ownership } : clip,
          ),
        },
        {
          kind: "set_ownership",
          operation_id: action.operationId,
          clip_id: action.clipId,
          ownership: action.ownership,
        },
      );
    }
    case "edit_duration": {
      const current = state.draft.scenes.find((scene) => scene.scene_id === action.sceneId);
      if (
        !current ||
        !Number.isInteger(action.durationInFrames) ||
        action.durationInFrames <= 0 ||
        current.duration_in_frames === action.durationInFrames
      ) return state;
      return edited(state, resizeScene(state.draft, action.sceneId, action.durationInFrames), {
        kind: "set_scene_duration",
        operation_id: action.operationId,
        scene_id: action.sceneId,
        duration_in_frames: action.durationInFrames,
      });
    }
    case "undo": {
      if (state.saveStatus === "saving") return state;
      const previous = state.history.at(-1);
      if (!previous) return state;
      return {
        ...state,
        ...previous,
        history: state.history.slice(0, -1),
        future: [{ draft: state.draft, pendingOperations: state.pendingOperations }, ...state.future],
        saveStatus: saveStatusAfterSnapshot(state, previous),
      };
    }
    case "redo": {
      if (state.saveStatus === "saving") return state;
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        ...next,
        history: [...state.history, { draft: state.draft, pendingOperations: state.pendingOperations }],
        future: state.future.slice(1),
        saveStatus: saveStatusAfterSnapshot(state, next),
      };
    }
    case "save_started":
      return state.pendingOperations.length && !state.isOffline && !state.latestConflict
        ? { ...state, saveStatus: "saving" }
        : state;
    case "save_succeeded": {
      const sent = new Set(action.operationIds ?? state.pendingOperations.map((operation) => operation.operation_id));
      const remaining = state.pendingOperations.filter((operation) => !sent.has(operation.operation_id));
      if (remaining.length) {
        return {
          ...state,
          base: action.document,
          history: [],
          future: [],
          pendingOperations: remaining,
          saveStatus: state.isOffline ? "offline" : "dirty",
          latestConflict: undefined,
        };
      }
      const saved = createEditorState(action.document);
      return {
        ...saved,
        isOffline: state.isOffline,
        saveStatus: state.isOffline ? "offline" : saved.saveStatus,
        selectedSceneId: action.document.scenes.some((scene) => scene.scene_id === state.selectedSceneId)
          ? state.selectedSceneId
          : saved.selectedSceneId,
      };
    }
    case "save_failed":
      return state.isOffline ? { ...state, saveStatus: "offline" } : { ...state, saveStatus: "failed" };
    case "retry_save":
      return state.pendingOperations.length && !state.isOffline ? { ...state, saveStatus: "dirty" } : state;
    case "went_offline":
      return {
        ...state,
        isOffline: true,
        saveStatus: state.saveStatus === "saving" ? "saving" : state.latestConflict ? "conflict" : "offline",
      };
    case "went_online":
      return state.saveStatus === "offline"
        ? { ...state, isOffline: false, saveStatus: state.pendingOperations.length ? "dirty" : "saved" }
        : { ...state, isOffline: false };
    case "save_conflicted":
      return { ...state, saveStatus: "conflict", latestConflict: action.latest };
    case "reload_latest": {
      if (!state.latestConflict) return state;
      const reloaded = createEditorState(state.latestConflict);
      return {
        ...reloaded,
        selectedSceneId: state.latestConflict.scenes.some((scene) => scene.scene_id === state.selectedSceneId)
          ? state.selectedSceneId
          : reloaded.selectedSceneId,
      };
    }
    case "keep_editing_locally": {
      if (!state.latestConflict) return state;
      const pendingOperations = operationsToRetainDraft(
        state.latestConflict,
        state.draft,
        action.operationIdPrefix,
      );
      return {
        ...state,
        base: state.latestConflict,
        history: [],
        future: [],
        pendingOperations,
        saveStatus: state.isOffline ? "offline" : pendingOperations.length ? "dirty" : "saved",
        latestConflict: undefined,
      };
    }
  }
}

export function toEditDocumentPatch(
  state: Pick<EditorState, "base" | "pendingOperations">,
): EditDocumentPatch {
  return { base_revision: state.base.revision, operations: state.pendingOperations };
}
