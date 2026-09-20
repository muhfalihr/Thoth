/**
 * Pure timeline helpers shared by the timeline, the Inspector, and the preview.
 *
 * Nothing here touches React, the network, or the DOM: the reducer applies the
 * same typed operations the control plane validates, so an optimistic draft and
 * the saved document stay in step.
 */

import type {
  EditDocument,
  EditDocumentOperation,
  EditDocumentV2,
  EditorAsset,
} from "@/api/control-plane";

type TimelineTrack = EditDocumentV2["tracks"][number];
type TimelineClip = NonNullable<EditDocumentV2["clips"]>[number];
type AssetRef = NonNullable<EditDocumentV2["asset_refs"]>[number];

// Lane selection is drawn as well as edited, so it lives with the composition
// the renderer shares; editing callers keep importing it from here.
import { visibleLanes } from "@thoth/remotion-composition";

export { visibleLanes, type TimelineLane } from "@thoth/remotion-composition";

export type TimelineIssueCode =
  | "main_track_gap"
  | "clip_overlap"
  | "clip_exceeds_canvas"
  | "track_empty";

export type TimelineIssue = {
  issue_id: string;
  code: TimelineIssueCode;
  target: { kind: "clip" | "track"; id: string; track_id: string };
};

/** Which clip kinds each track kind accepts, mirroring the server contract. */
export const TRACK_CLIP_KINDS: Record<TimelineTrack["kind"], readonly TimelineClip["kind"][]> = {
  main_video: ["video"],
  b_roll: ["video"],
  overlay: ["overlay", "text"],
  caption: ["caption"],
  narration: ["audio"],
  music: ["audio"],
  sfx: ["audio"],
};

/** Which asset kinds a media-backed clip kind accepts. */
const CLIP_ASSET_KINDS: Record<string, readonly EditorAsset["kind"][]> = {
  video: ["video", "image"],
  audio: ["audio"],
};

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

export function isTimelineDocument(document: EditDocument): document is EditDocumentV2 {
  return document.schema_version === 2;
}

export function framesToPixels(frame: number, zoom: number): number {
  return Math.round(frame * zoom);
}

export function pixelsToFrames(pixels: number, zoom: number): number {
  return Math.max(0, Math.round(pixels / zoom));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Snap to the nearest candidate within `threshold`, preferring the lower frame on a tie. */
export function snapFrame(frame: number, candidates: readonly number[], threshold: number): number {
  let best = frame;
  let bestDistance = threshold;
  for (const candidate of [...candidates].sort((left, right) => left - right)) {
    const distance = Math.abs(candidate - frame);
    if (distance <= bestDistance && (best === frame || distance < bestDistance)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function snapCandidates(
  document: EditDocumentV2,
  options: { excludeClipId?: string; playhead?: number } = {},
): number[] {
  const frames = new Set<number>([0, document.canvas.duration_in_frames]);
  if (options.playhead !== undefined) frames.add(options.playhead);
  for (const clip of document.clips ?? []) {
    if (clip.clip_id === options.excludeClipId) continue;
    frames.add(clip.from_frame);
    frames.add(clip.from_frame + clip.duration_in_frames);
  }
  return [...frames].sort((left, right) => left - right);
}

export function compatibleTrackIds(
  document: EditDocumentV2,
  clipKind: TimelineClip["kind"],
): string[] {
  return document.tracks
    .filter((track) => !track.locked && TRACK_CLIP_KINDS[track.kind].includes(clipKind))
    .sort((left, right) => left.order - right.order)
    .map((track) => track.track_id);
}

/**
 * The operation that drops `asset` onto the first track that accepts it.
 *
 * Returns nothing when no unlocked track takes the asset, so the caller can
 * leave the document alone instead of emitting an operation the server refuses.
 */
export function createAddClipFromAssetOperation(
  document: EditDocumentV2,
  asset: EditorAsset,
  playheadFrame: number,
  ids: { operationId: string; clipId: string },
): EditDocumentOperation | undefined {
  const [trackId] = compatibleTrackIds(document, asset.kind === "audio" ? "audio" : "video");
  if (!trackId) return undefined;
  return {
    kind: "add_clip_from_asset",
    operation_id: ids.operationId,
    clip_id: ids.clipId,
    track_id: trackId,
    asset_id: asset.asset_id,
    from_frame: Math.max(0, Math.round(playheadFrame)),
    // A still has no duration of its own; one canvas second reads as deliberate.
    duration_in_frames: asset.duration_in_frames ?? document.canvas.fps,
    source_from_frame: 0,
  };
}

export function timelineIssues(document: EditDocumentV2): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  const add = (code: TimelineIssueCode, kind: "clip" | "track", id: string, trackId: string) =>
    issues.push({ issue_id: `${code}:${id}`, code, target: { kind, id, track_id: trackId } });

  for (const { track, clips } of visibleLanes(document)) {
    let expectedStart = 0;
    for (const clip of clips) {
      if (track.kind === "main_video" && clip.from_frame > expectedStart) {
        add("main_track_gap", "clip", clip.clip_id, track.track_id);
      }
      if (clip.from_frame < expectedStart) {
        add("clip_overlap", "clip", clip.clip_id, track.track_id);
      }
      if (clip.from_frame + clip.duration_in_frames > document.canvas.duration_in_frames) {
        add("clip_exceeds_canvas", "clip", clip.clip_id, track.track_id);
      }
      expectedStart = Math.max(expectedStart, clip.from_frame + clip.duration_in_frames);
    }
  }
  return issues;
}

/** Map one issue onto the selection that brings its target on screen. */
export function issueTarget(issue: TimelineIssue): {
  selectedTrackId: string;
  selectedClipId: string;
} {
  return {
    selectedTrackId: issue.target.track_id,
    selectedClipId: issue.target.kind === "clip" ? issue.target.id : "",
  };
}

// --------------------------------------------------------------------------
// Operation application
// --------------------------------------------------------------------------

/**
 * Apply one typed operation to a copy of `document`.
 *
 * The rules mirror `thoth_control_plane.domain.timeline_operations`, so an
 * operation the reducer accepts is one the control plane will accept too. A
 * refusal throws and the caller keeps the untouched original.
 */
export function applyTimelineOperation(
  document: EditDocumentV2,
  operation: EditDocumentOperation,
  resolvedAssets: Record<string, EditorAsset>,
): EditDocumentV2 {
  const next = structuredClone(document);
  next.clips ??= [];
  next.asset_refs ??= [];

  switch (operation.kind) {
    case "add_track": {
      if (next.tracks.some((track) => track.track_id === operation.track_id)) {
        throw new Error("operation reuses an existing track ID");
      }
      next.tracks.push({
        track_id: operation.track_id,
        kind: operation.track_kind,
        label: operation.label,
        order: operation.order,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: [],
      });
      break;
    }
    case "remove_empty_track": {
      const track = unlockedTrack(next, operation.track_id);
      if (track.clip_ids?.length) throw new Error("only an empty track can be removed");
      next.tracks.splice(next.tracks.indexOf(track), 1);
      break;
    }
    case "reorder_track":
      unlockedTrack(next, operation.track_id).order = operation.order;
      break;
    case "add_clip_from_asset":
      addClipFromAsset(next, operation, resolvedAssets);
      break;
    case "remove_clip": {
      const clip = unlockedClip(next, operation.clip_id);
      next.clips.splice(next.clips.indexOf(clip), 1);
      removeClipId(track(next, clip.track_id), clip.clip_id);
      break;
    }
    case "move_clip":
      moveClip(next, operation);
      break;
    case "trim_clip_start":
      trimClipStart(next, operation);
      break;
    case "trim_clip_end": {
      const clip = unlockedClip(next, operation.clip_id);
      if (operation.end_frame <= clip.from_frame) {
        throw new Error("trim must leave a positive duration");
      }
      clip.duration_in_frames = operation.end_frame - clip.from_frame;
      break;
    }
    case "split_clip":
      splitClip(next, operation);
      break;
    case "set_clip_hidden":
      unlockedClip(next, operation.clip_id).hidden = operation.hidden;
      break;
    case "set_clip_locked":
      clipOf(next, operation.clip_id).locked = operation.locked;
      break;
    case "set_clip_volume": {
      const clip = unlockedClip(next, operation.clip_id);
      if (clip.kind !== "audio") throw new Error("volume applies only to audio clips");
      clip.volume = operation.volume;
      break;
    }
    case "set_track_visibility":
      unlockedTrack(next, operation.track_id).hidden = operation.hidden;
      break;
    case "set_track_muted":
      unlockedTrack(next, operation.track_id).muted = operation.muted;
      break;
    case "set_track_locked":
      track(next, operation.track_id).locked = operation.locked;
      break;
    default:
      throw new Error("operation is not a timeline operation");
  }
  return next;
}

function track(document: EditDocumentV2, trackId: string): TimelineTrack {
  const found = document.tracks.find((entry) => entry.track_id === trackId);
  if (!found) throw new Error("operation references an unknown track");
  return found;
}

function clipOf(document: EditDocumentV2, clipId: string): TimelineClip {
  const found = (document.clips ?? []).find((entry) => entry.clip_id === clipId);
  if (!found) throw new Error("operation references an unknown clip");
  return found;
}

function unlockedTrack(document: EditDocumentV2, trackId: string): TimelineTrack {
  const found = track(document, trackId);
  if (found.locked) throw new Error("track is locked");
  return found;
}

function unlockedClip(document: EditDocumentV2, clipId: string): TimelineClip {
  const clip = clipOf(document, clipId);
  if (clip.locked) throw new Error("clip is locked");
  unlockedTrack(document, clip.track_id);
  return clip;
}

function removeClipId(entry: TimelineTrack, clipId: string): void {
  entry.clip_ids = (entry.clip_ids ?? []).filter((known) => known !== clipId);
}

function addClipFromAsset(
  document: EditDocumentV2,
  operation: Extract<EditDocumentOperation, { kind: "add_clip_from_asset" }>,
  resolvedAssets: Record<string, EditorAsset>,
): void {
  const target = unlockedTrack(document, operation.track_id);
  if ((document.clips ?? []).some((clip) => clip.clip_id === operation.clip_id)) {
    throw new Error("operation reuses an existing clip ID");
  }
  const asset = resolvedAssets[operation.asset_id];
  if (!asset) throw new Error("operation references an unavailable asset");
  if (asset.project_id !== document.project_id) throw new Error("asset belongs to another project");
  if (asset.validation_state !== "ready") throw new Error("asset is not ready for use");

  const clipKind = asset.kind === "audio" ? "audio" : "video";
  if (!TRACK_CLIP_KINDS[target.kind].includes(clipKind)) {
    throw new Error("clip kind is incompatible with track");
  }
  if (!CLIP_ASSET_KINDS[clipKind].includes(asset.kind)) {
    throw new Error("clip kind is incompatible with asset");
  }
  if (!(document.asset_refs ?? []).some((known) => known.asset_id === asset.asset_id)) {
    document.asset_refs = [...(document.asset_refs ?? []), assetRef(asset)];
  }

  const shared = {
    clip_id: operation.clip_id,
    track_id: target.track_id,
    from_frame: operation.from_frame,
    duration_in_frames: operation.duration_in_frames,
    source_from_frame: operation.source_from_frame,
    asset_id: asset.asset_id,
    ownership: "user_edited" as const,
    hidden: false,
    locked: false,
  };
  document.clips = [
    ...(document.clips ?? []),
    clipKind === "audio"
      ? { ...shared, kind: "audio" as const, volume: 1, fade_in_frames: 0, fade_out_frames: 0 }
      : { ...shared, kind: "video" as const, fit: "cover" as const },
  ];
  target.clip_ids = [...(target.clip_ids ?? []), operation.clip_id];
}

/** Copy only the document-embeddable fields; the catalog projection carries more. */
function assetRef(asset: EditorAsset): AssetRef {
  return {
    asset_id: asset.asset_id,
    project_id: asset.project_id,
    kind: asset.kind,
    duration_in_frames: asset.duration_in_frames,
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    has_audio: asset.has_audio,
    validation_state: asset.validation_state,
    checksum: asset.checksum,
  };
}

function moveClip(
  document: EditDocumentV2,
  operation: Extract<EditDocumentOperation, { kind: "move_clip" }>,
): void {
  const clip = unlockedClip(document, operation.clip_id);
  const target = unlockedTrack(document, operation.target_track_id);

  if (target.track_id !== clip.track_id) {
    if (!TRACK_CLIP_KINDS[target.kind].includes(clip.kind)) {
      throw new Error("clip kind is incompatible with track");
    }
    removeClipId(track(document, clip.track_id), clip.clip_id);
    target.clip_ids = [...(target.clip_ids ?? []), clip.clip_id];
    clip.track_id = target.track_id;
  }
  clip.from_frame = operation.from_frame;

  if (operation.ripple) repack(document, target, clip.clip_id);
}

/** Close gaps and overlaps on `entry`, letting the moved clip claim its slot. */
function repack(document: EditDocumentV2, entry: TimelineTrack, movedClipId: string): void {
  const clips = (document.clips ?? [])
    .filter((clip) => clip.track_id === entry.track_id)
    .sort(
      (left, right) =>
        left.from_frame - right.from_frame ||
        Number(left.clip_id !== movedClipId) - Number(right.clip_id !== movedClipId),
    );
  let start = Math.min(...clips.map((clip) => clip.from_frame));
  for (const clip of clips) {
    clip.from_frame = start;
    start += clip.duration_in_frames;
  }
}

function trimClipStart(
  document: EditDocumentV2,
  operation: Extract<EditDocumentOperation, { kind: "trim_clip_start" }>,
): void {
  const clip = unlockedClip(document, operation.clip_id);
  const endFrame = clip.from_frame + clip.duration_in_frames;
  if (operation.from_frame >= endFrame) throw new Error("trim must leave a positive duration");

  const delta = operation.from_frame - clip.from_frame;
  if ("source_from_frame" in clip) {
    if (clip.source_from_frame + delta < 0) throw new Error("trim cannot start before the source");
    clip.source_from_frame += delta;
  }
  clip.from_frame = operation.from_frame;
  clip.duration_in_frames = endFrame - operation.from_frame;
}

function splitClip(
  document: EditDocumentV2,
  operation: Extract<EditDocumentOperation, { kind: "split_clip" }>,
): void {
  const clip = unlockedClip(document, operation.clip_id);
  const endFrame = clip.from_frame + clip.duration_in_frames;
  if (!(clip.from_frame < operation.split_frame && operation.split_frame < endFrame)) {
    throw new Error("split frame must fall inside the clip");
  }
  if (operation.left_clip_id === operation.right_clip_id) {
    throw new Error("split requires two distinct new clip IDs");
  }
  const taken = new Set(
    (document.clips ?? [])
      .filter((other) => other.clip_id !== clip.clip_id)
      .map((other) => other.clip_id),
  );
  if (taken.has(operation.left_clip_id) || taken.has(operation.right_clip_id)) {
    throw new Error("operation reuses an existing clip ID");
  }

  const leftDuration = operation.split_frame - clip.from_frame;
  const right = structuredClone(clip);
  right.clip_id = operation.right_clip_id;
  right.from_frame = operation.split_frame;
  right.duration_in_frames = endFrame - operation.split_frame;
  if ("source_from_frame" in right) right.source_from_frame += leftDuration;

  const entry = track(document, clip.track_id);
  const ids = [...(entry.clip_ids ?? [])];
  ids[ids.indexOf(clip.clip_id)] = operation.left_clip_id;
  entry.clip_ids = [...ids, right.clip_id];
  clip.clip_id = operation.left_clip_id;
  clip.duration_in_frames = leftDuration;
  document.clips = [...(document.clips ?? []), right];
}
