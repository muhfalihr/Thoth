import type { EditDocument, EditDocumentV1 } from "@/api/control-plane";
import { AdvancedTimelineComposition, type PreviewSources } from "./AdvancedTimelineComposition";
import { VerticalTextStory } from "./VerticalTextStory";
import { isTimelineDocument } from "./timeline_domain";

/** The only shape a preview source may take: a same-origin capability-cookie path. */
const PREVIEW_SOURCE =
  /^\/api\/v1\/projects\/[A-Za-z0-9_-]+\/editor-assets\/[A-Za-z0-9_-]+\/preview$/;

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
 * Narrow an arbitrary string to a preview source the composition may load.
 *
 * Anything with a scheme, host, query, fragment, or traversal is dropped, so a
 * document or an API response can never steer a media element off-origin or
 * smuggle a capability through the URL.
 */
export function safePreviewSource(source: string | undefined): string | undefined {
  return source && PREVIEW_SOURCE.test(source) ? source : undefined;
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
