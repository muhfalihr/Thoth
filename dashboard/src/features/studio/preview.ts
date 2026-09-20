import type { EditDocument, EditDocumentV1 } from "@/api/control-plane";
import { AdvancedTimelineComposition, type PreviewSources } from "./AdvancedTimelineComposition";
import { VerticalTextStory } from "./VerticalTextStory";
import { isTimelineDocument } from "./timeline_domain";

// The composition narrows its own sources, so the rule the renderer enforces
// is the rule the browser enforces; editing callers keep importing it from here.
export { safePreviewSource } from "@thoth/remotion-composition";

export function getPlayerConfig(document: EditDocument) {
  const { width, height, fps, duration_in_frames: durationInFrames } = document.canvas;
  if (![width, height, fps, durationInFrames].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("invalid Studio preview timing");
  }
  return { durationInFrames, fps, compositionWidth: width, compositionHeight: height };
}

export function getOrderedTextClips(document: EditDocumentV1) {
  return [...document.clips].sort((left, right) => left.start_frame - right.start_frame);
}

/**
 * Choose the composition for a document.
 *
 * The schema version is the only thing that decides this, and preview sources
 * travel beside the document instead of inside it so a capability can never be
 * serialized into a revision.
 */
export function previewComposition(
  document: EditDocument,
  previewSources?: PreviewSources,
  onPreviewUnavailable?: (assetId: string) => void,
) {
  return isTimelineDocument(document)
    ? {
        component: AdvancedTimelineComposition,
        inputProps: { document, previewSources, onPreviewUnavailable },
      }
    : { component: VerticalTextStory, inputProps: { document } };
}
