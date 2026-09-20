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
