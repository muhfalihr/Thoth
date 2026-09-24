import type {
  EditDocument,
  EditDocumentOperation,
  EditDocumentPatch,
  EditDocumentV1,
  EditDocumentV2,
  EditorAsset,
} from "@/api/control-plane";

import {
  applyTimelineOperation,
  carrySceneClips,
  clampZoom,
  isTimelineDocument,
  timelineIssues,
} from "./timeline_domain";

export type EditorSaveStatus = "saved" | "dirty" | "saving" | "failed" | "conflict" | "offline";

export type EditorMode = "simple" | "advanced";

export type UpgradeStatus = "idle" | "running" | "failed";

type EditorSnapshot = {
  draft: EditDocument;
  pendingOperations: EditDocumentOperation[];
};

export type EditorState = EditorSnapshot & {
  base: EditDocument;
  selectedSceneId: string;
  selectedTrackId: string;
  selectedClipId: string;
  selectedIssueId: string;
  mode: EditorMode;
  playheadFrame: number;
  playing: boolean;
  zoom: number;
  snapping: boolean;
  ripple: boolean;
  assets: Record<string, EditorAsset>;
  /** Pre-gesture snapshot, present only while a drag preview is on screen. */
  preview?: EditorSnapshot;
  history: EditorSnapshot[];
  future: EditorSnapshot[];
  saveStatus: EditorSaveStatus;
  isOffline: boolean;
  inFlightOperationIds: string[];
  latestConflict?: EditDocument;
  upgradeStatus: UpgradeStatus;
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
  | { type: "save_started"; operationIds?: string[] }
  | { type: "save_succeeded"; document: EditDocument; operationIds?: string[] }
  | { type: "save_failed" }
  | { type: "retry_save" }
  | { type: "went_offline" }
  | { type: "went_online" }
  | { type: "save_conflicted"; latest: EditDocument }
  | { type: "reload_latest" }
  | { type: "keep_editing_locally"; operationIdPrefix: string }
  | { type: "assets_loaded"; assets: EditorAsset[]; replace: boolean }
  | { type: "set_editor_mode"; mode: EditorMode }
  | { type: "select_track"; trackId: string }
  | { type: "select_clip"; clipId: string }
  | { type: "select_issue"; issueId: string }
  | { type: "set_playhead"; frame: number }
  | { type: "set_playing"; playing: boolean }
  | { type: "set_zoom"; zoom: number }
  | { type: "set_snapping"; snapping: boolean }
  | { type: "set_ripple"; ripple: boolean }
  | { type: "upgrade_started" }
  | { type: "upgrade_succeeded"; document: EditDocument }
  | { type: "upgrade_conflicted"; latest: EditDocument }
  | { type: "upgrade_failed" }
  | { type: "preview_timeline_operation"; operation: EditDocumentOperation }
  | { type: "commit_timeline_operation"; operation: EditDocumentOperation }
  | { type: "cancel_timeline_preview" };

export function createEditorState(
  document: EditDocument,
  assets: Record<string, EditorAsset> = {},
): EditorState {
  return {
    base: document,
    draft: document,
    selectedSceneId: document.scenes[0]?.scene_id ?? "",
    selectedTrackId: "",
    selectedClipId: "",
    selectedIssueId: "",
    mode: isTimelineDocument(document) ? "advanced" : "simple",
    playheadFrame: 0,
    playing: false,
    zoom: 1,
    snapping: true,
    ripple: false,
    assets,
    history: [],
    future: [],
    saveStatus: "saved",
    isOffline: false,
    inFlightOperationIds: [],
    pendingOperations: [],
    upgradeStatus: "idle",
  };
}

/** Upgrade replaces the whole document, so it may only start from settled, online state. */
export function canStartUpgrade(state: EditorState): boolean {
  return (
    !isTimelineDocument(state.draft) &&
    !state.preview &&
    state.upgradeStatus !== "running" &&
    state.saveStatus === "saved" &&
    !state.isOffline &&
    !state.latestConflict &&
    !state.pendingOperations.length &&
    !state.inFlightOperationIds.length
  );
}

/** Actions that read or write the document; an in-flight upgrade owns it exclusively. */
const DOCUMENT_ACTIONS = new Set<EditorAction["type"]>([
  "edit_text",
  "edit_ownership",
  "edit_duration",
  "undo",
  "redo",
  "save_started",
  "save_succeeded",
  "save_failed",
  "retry_save",
  "save_conflicted",
  "reload_latest",
  "keep_editing_locally",
  "preview_timeline_operation",
  "commit_timeline_operation",
  "cancel_timeline_preview",
]);

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

/**
 * Relay out the scene strip exactly as `set_scene_duration` does on the server,
 * so the local draft matches the revision the backend returns.
 */
function resizeScene(
  document: EditDocument,
  sceneId: string,
  durationInFrames: number,
): EditDocument {
  const startField = isTimelineDocument(document) ? "from_frame" : "start_frame";
  const clips = documentClips(document).map((clip) => ({ ...clip }));
  const byId = new Map(clips.map((clip) => [clip.clip_id, clip]));
  const previousStarts = new Map(document.scenes.map((scene) => [scene.scene_id, scene.start_frame]));
  let startFrame = 0;
  const scenes = document.scenes.map((scene) => {
    const duration = scene.scene_id === sceneId ? durationInFrames : scene.duration_in_frames;
    const clip = byId.get(scene.clip_ids[0]);
    if (clip) {
      clip[startField] = startFrame;
      clip.duration_in_frames = duration;
    }
    const resized = { ...scene, start_frame: startFrame, duration_in_frames: duration };
    startFrame += duration;
    return resized;
  });
  if (isTimelineDocument(document)) {
    // The scene's own clip was laid out above; its other clips keep their offsets.
    const laidOut = new Set(scenes.map((scene) => scene.clip_ids[0]!));
    carrySceneClips({ scenes, clips } as unknown as EditDocumentV2, previousStarts, laidOut);
  }
  // A version 2 canvas also has to hold every clip outside the scene strip.
  const lastFrame = clips.reduce(
    (end, clip) => Math.max(end, Number(clip[startField] ?? 0) + clip.duration_in_frames),
    startFrame,
  );
  return {
    ...withClips(document, clips),
    scenes,
    canvas: { ...document.canvas, duration_in_frames: lastFrame },
  } as EditDocument;
}

function operationsToRetainDraft(
  base: EditDocumentV1,
  draft: EditDocumentV1,
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

/** The guided actions only describe schema-v1 text stories. */
function textStoryDraft(state: EditorState): EditDocumentV1 | undefined {
  return isTimelineDocument(state.draft) ? undefined : state.draft;
}

/** The smallest clip shape both document versions share for guided text editing. */
export type EditableTextClip = {
  clip_id: string;
  kind: string;
  heading: string;
  body: string;
  ownership: "ai_managed" | "user_edited" | "locked";
};

type StructuralClip = { clip_id: string; kind: string; duration_in_frames: number } & Record<
  string,
  unknown
>;

function documentClips(document: EditDocument): StructuralClip[] {
  return (document.clips ?? []) as StructuralClip[];
}

/** The scene's text clip, whichever schema version holds it. */
export function findTextClip(
  document: EditDocument,
  clipId: string | undefined,
): EditableTextClip | undefined {
  const clip = documentClips(document).find((candidate) => candidate.clip_id === clipId);
  return clip?.kind === "text" ? (clip as unknown as EditableTextClip) : undefined;
}

/** The text a guided edit targets: the scene's first text clip, listed or bound. */
export function sceneTextClip(
  document: EditDocument,
  scene: EditDocument["scenes"][number] | undefined,
): EditableTextClip | undefined {
  if (!scene) return undefined;
  const bound = documentClips(document).filter((clip) => clip.scene_id === scene.scene_id);
  return [...scene.clip_ids, ...bound.map((clip) => clip.clip_id)]
    .map((clipId) => findTextClip(document, clipId))
    .find(Boolean);
}

/** Every text clip carries a heading the backend refuses to store empty. */
export function hasValidText(document: EditDocument): boolean {
  return documentClips(document).every((clip) => {
    if (clip.kind !== "text") return true;
    const { heading, body } = clip as unknown as EditableTextClip;
    return heading.trim().length > 0 && heading.length <= 300 && body.length <= 2_000;
  });
}

function withClips(document: EditDocument, clips: StructuralClip[]): EditDocument {
  return { ...document, clips } as EditDocument;
}

function replaceClip(
  document: EditDocument,
  clipId: string,
  change: (clip: EditableTextClip) => EditableTextClip,
): EditDocument {
  return withClips(
    document,
    documentClips(document).map((clip) =>
      clip.clip_id === clipId
        ? (change(clip as unknown as EditableTextClip) as unknown as StructuralClip)
        : clip,
    ),
  );
}

/** Apply one timeline operation, or return undefined when the document refuses it. */
function timelineDraft(
  snapshot: EditorSnapshot,
  operation: EditDocumentOperation,
  assets: Record<string, EditorAsset>,
): EditDocument | undefined {
  if (!isTimelineDocument(snapshot.draft)) return undefined;
  try {
    return applyTimelineOperation(snapshot.draft, operation, assets);
  } catch {
    return undefined;
  }
}

/**
 * The session state a save keeps. The revision the server returns owns the
 * data; mode, selection, and playback belong to the editor that is still open,
 * so they survive unless the returned document no longer holds them.
 */
function sessionAfterSave(
  state: EditorState,
  document: EditDocument,
  saved: EditorState,
): Partial<EditorState> {
  const clip = documentClips(document).find((entry) => entry.clip_id === state.selectedClipId);
  const trackExists = document.tracks.some((track) => track.track_id === state.selectedTrackId);
  const lastFrame = Math.max(document.canvas.duration_in_frames - 1, 0);
  // An issue belongs to the revision that produced it, so a saved fix clears it.
  const issues = isTimelineDocument(document) ? timelineIssues(document) : [];
  return {
    mode: isTimelineDocument(document) ? state.mode : saved.mode,
    selectedSceneId: document.scenes.some((scene) => scene.scene_id === state.selectedSceneId)
      ? state.selectedSceneId
      : saved.selectedSceneId,
    selectedTrackId: clip ? String(clip.track_id) : trackExists ? state.selectedTrackId : "",
    selectedClipId: clip ? state.selectedClipId : "",
    selectedIssueId: issues.some((issue) => issue.issue_id === state.selectedIssueId)
      ? state.selectedIssueId
      : saved.selectedIssueId,
    playheadFrame: Math.min(state.playheadFrame, lastFrame),
    playing: state.playing,
    zoom: state.zoom,
    snapping: state.snapping,
    ripple: state.ripple,
  };
}

function gestureOrigin(state: EditorState): EditorSnapshot {
  return state.preview ?? { draft: state.draft, pendingOperations: state.pendingOperations };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  // One gate for keyboard, pointer, Inspector, and delayed callbacks alike.
  if (state.upgradeStatus === "running" && DOCUMENT_ACTIONS.has(action.type)) return state;
  switch (action.type) {
    case "select_scene":
      return state.draft.scenes.some((scene) => scene.scene_id === action.sceneId)
        ? { ...state, selectedSceneId: action.sceneId }
        : state;
    case "edit_text": {
      const current = findTextClip(state.draft, action.clipId);
      if (!current || current[action.field] === action.value) return state;
      const draft = replaceClip(state.draft, action.clipId, (clip) => ({
        ...clip,
        [action.field]: action.value,
        ownership: "user_edited",
      }));
      return edited(state, draft, {
        kind: "replace_text",
        operation_id: action.operationId,
        clip_id: action.clipId,
        field: action.field,
        value: action.value,
      });
    }
    case "edit_ownership": {
      const current = findTextClip(state.draft, action.clipId);
      if (!current || current.ownership === action.ownership) return state;
      return edited(
        state,
        replaceClip(state.draft, action.clipId, (clip) => ({ ...clip, ownership: action.ownership })),
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
      if (state.inFlightOperationIds.length) return state;
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
      if (state.inFlightOperationIds.length) return state;
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
      return state.pendingOperations.length && !state.isOffline && !state.latestConflict && !state.inFlightOperationIds.length
        ? {
            ...state,
            saveStatus: "saving",
            inFlightOperationIds: action.operationIds ?? state.pendingOperations.map((operation) => operation.operation_id),
          }
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
          inFlightOperationIds: [],
          saveStatus: state.isOffline ? "offline" : "dirty",
          latestConflict: undefined,
        };
      }
      const saved = createEditorState(action.document, state.assets);
      return {
        ...saved,
        ...sessionAfterSave(state, action.document, saved),
        isOffline: state.isOffline,
        inFlightOperationIds: [],
        saveStatus: state.isOffline ? "offline" : saved.saveStatus,
      };
    }
    case "save_failed":
      return state.isOffline
        ? { ...state, inFlightOperationIds: [], saveStatus: "offline" }
        : { ...state, inFlightOperationIds: [], saveStatus: "failed" };
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
      return { ...state, inFlightOperationIds: [], saveStatus: "conflict", latestConflict: action.latest };
    case "upgrade_started":
      return canStartUpgrade(state) ? { ...state, upgradeStatus: "running" } : state;
    case "upgrade_succeeded": {
      if (state.upgradeStatus !== "running") return state;
      const upgraded = createEditorState(action.document, state.assets);
      return { ...upgraded, isOffline: state.isOffline };
    }
    case "upgrade_conflicted":
      return state.upgradeStatus === "running"
        ? { ...state, upgradeStatus: "idle", saveStatus: "conflict", latestConflict: action.latest }
        : state;
    case "upgrade_failed":
      return state.upgradeStatus === "running" ? { ...state, upgradeStatus: "failed" } : state;
    case "reload_latest": {
      if (!state.latestConflict) return state;
      const reloaded = createEditorState(state.latestConflict);
      return {
        ...reloaded,
        isOffline: state.isOffline,
        saveStatus: state.isOffline ? "offline" : reloaded.saveStatus,
        selectedSceneId: state.latestConflict.scenes.some((scene) => scene.scene_id === state.selectedSceneId)
          ? state.selectedSceneId
          : reloaded.selectedSceneId,
      };
    }
    case "keep_editing_locally": {
      if (!state.latestConflict) return state;
      // Timeline edits are already typed operations, so a rebase only swaps the base;
      // a text story has to be diffed back into operations against the newer revision.
      const conflict = state.latestConflict;
      const story = textStoryDraft(state);
      const pendingOperations =
        isTimelineDocument(conflict) || !story
          ? state.pendingOperations
          : operationsToRetainDraft(conflict, story, action.operationIdPrefix);
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
    case "assets_loaded": {
      // A continuation page adds to what is already addable; a reload replaces it.
      const page = Object.fromEntries(action.assets.map((asset) => [asset.asset_id, asset]));
      return { ...state, assets: action.replace ? page : { ...state.assets, ...page } };
    }
    case "set_editor_mode":
      return { ...state, mode: action.mode };
    case "select_track":
      return state.draft.tracks.some((track) => track.track_id === action.trackId)
        ? { ...state, selectedTrackId: action.trackId, selectedClipId: "" }
        : state;
    case "select_clip": {
      const clip = (state.draft.clips ?? []).find((entry) => entry.clip_id === action.clipId);
      return clip
        ? { ...state, selectedClipId: clip.clip_id, selectedTrackId: clip.track_id }
        : state;
    }
    case "select_issue":
      return { ...state, selectedIssueId: action.issueId };
    case "set_playhead": {
      const last = Math.max(state.draft.canvas.duration_in_frames - 1, 0);
      const frame = Math.min(Math.max(Math.round(action.frame), 0), last);
      return frame === state.playheadFrame ? state : { ...state, playheadFrame: frame };
    }
    case "set_playing":
      return state.playing === action.playing ? state : { ...state, playing: action.playing };
    case "set_zoom":
      return { ...state, zoom: clampZoom(action.zoom) };
    case "set_snapping":
      return { ...state, snapping: action.snapping };
    case "set_ripple":
      return { ...state, ripple: action.ripple };
    case "preview_timeline_operation": {
      const origin = gestureOrigin(state);
      const draft = timelineDraft(origin, action.operation, state.assets);
      return draft ? { ...state, preview: origin, draft } : state;
    }
    case "cancel_timeline_preview":
      return state.preview ? { ...state, ...state.preview, preview: undefined } : state;
    case "commit_timeline_operation": {
      const origin = gestureOrigin(state);
      const draft = timelineDraft(origin, action.operation, state.assets);
      if (!draft) return { ...state, ...origin, preview: undefined };
      return { ...edited({ ...state, ...origin }, draft, action.operation), preview: undefined };
    }
  }
}

export function toEditDocumentPatch(
  state: Pick<EditorState, "base" | "pendingOperations">,
): EditDocumentPatch {
  return { base_revision: state.base.revision, operations: state.pendingOperations };
}
