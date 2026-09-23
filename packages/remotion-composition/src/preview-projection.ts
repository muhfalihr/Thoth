/**
 * The one projection both surfaces draw from.
 *
 * Studio's Player and the parity harness are only comparable if they are handed
 * the same component, the same props, and the same geometry, so that decision
 * lives here rather than in either caller.
 */

import { AdvancedTimelineComposition, type PreviewSources } from "./AdvancedTimelineComposition";
import type { EditDocumentV2 } from "./timeline";

/** Whatever carries a canvas: the projection needs nothing else from it. */
type CanvasDocument = {
  canvas: { width: number; height: number; fps: number; duration_in_frames: number };
};

export type PlayerProjection = {
  readonly durationInFrames: number;
  readonly fps: number;
  readonly compositionWidth: number;
  readonly compositionHeight: number;
};

/**
 * The Player's timing and geometry, taken only from the document's canvas.
 *
 * A canvas that cannot describe a real surface is refused rather than rounded,
 * because a Player and a renderer given different dimensions would disagree
 * about every pixel that follows.
 */
export function playerConfig(document: CanvasDocument): PlayerProjection {
  const { width, height, fps, duration_in_frames: durationInFrames } = document.canvas;
  if (![width, height, fps, durationInFrames].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("invalid Studio preview timing");
  }
  return { durationInFrames, fps, compositionWidth: width, compositionHeight: height };
}

/**
 * The trusted composition and the props it is drawn with.
 *
 * Preview sources travel beside the document instead of inside it, so a
 * capability can never be serialized into a revision.
 */
export function timelineComposition(
  document: EditDocumentV2,
  previewSources?: PreviewSources,
  onPreviewUnavailable?: (assetId: string) => void,
) {
  return {
    component: AdvancedTimelineComposition,
    inputProps: { document, previewSources, onPreviewUnavailable },
  };
}
