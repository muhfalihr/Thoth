import type { EditDocument, EditDocumentV1 } from "@/api/control-plane";
import type { PreviewSources } from "./AdvancedTimelineComposition";
import { timelineComposition } from "@thoth/remotion-composition";
import { VerticalTextStory } from "./VerticalTextStory";
import { isTimelineDocument } from "./timeline_domain";

// The composition narrows its own sources, so the rule the renderer enforces
// is the rule the browser enforces; editing callers keep importing it from here.
export { safePreviewSource } from "@thoth/remotion-composition";

// Timing and geometry are the composition's, not this view's: the parity
// harness reads the same function, so the two surfaces cannot drift apart.
export { playerConfig as getPlayerConfig } from "@thoth/remotion-composition";

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
    ? timelineComposition(document, previewSources, onPreviewUnavailable)
    : { component: VerticalTextStory, inputProps: { document } };
}
