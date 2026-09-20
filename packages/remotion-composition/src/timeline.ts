/**
 * The document shape and the one lane projection the composition draws.
 *
 * The document type comes from the generated control-plane contract, so the
 * renderer and the browser agree with the server by construction instead of by
 * a second handwritten schema.
 */

import type { components } from "../../../dashboard/src/api/generated/control-plane";

export type EditDocumentV2 = components["schemas"]["EditDocumentV2"];
export type TimelineTrack = EditDocumentV2["tracks"][number];
export type TimelineClip = NonNullable<EditDocumentV2["clips"]>[number];
export type AssetKind = NonNullable<EditDocumentV2["asset_refs"]>[number]["kind"];
export type TimelineLane = { track: TimelineTrack; clips: TimelineClip[] };

/**
 * Whether drawing this document actually produces sound.
 *
 * The rules are the composition's own: a hidden track or clip is not drawn, a
 * muted track plays every source at zero, an audio clip is silent at zero
 * volume, and a video clip only sounds when its asset carries an audio stream.
 * Both the preview and the renderer ask here so neither can drift from what
 * `AdvancedTimelineComposition` renders.
 */
export function hasAudibleContent(document: EditDocumentV2): boolean {
  const references = new Map((document.asset_refs ?? []).map((ref) => [ref.asset_id, ref]));
  return visibleLanes(document).some(({ track, clips }) => {
    if (track.hidden || track.muted === true) {
      return false;
    }
    return clips.some((clip) => {
      if (clip.hidden) {
        return false;
      }
      if (clip.kind === "audio") {
        return clip.volume > 0;
      }
      if (clip.kind !== "video") {
        return false;
      }
      const reference = references.get(clip.asset_id);
      return reference?.kind === "video" && reference.has_audio === true;
    });
  });
}

/** Tracks in draw order, each carrying its own clips in time order. */
export function visibleLanes(document: EditDocumentV2): TimelineLane[] {
  const clips = document.clips ?? [];
  return [...document.tracks]
    .sort((left, right) => left.order - right.order)
    .map((track) => ({
      track,
      clips: clips
        .filter((clip) => clip.track_id === track.track_id)
        .sort((left, right) => left.from_frame - right.from_frame),
    }));
}
