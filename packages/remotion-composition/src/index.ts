/**
 * The one trusted composition, shared by the Studio preview and the renderer.
 *
 * Both surfaces import the same component under the same ID, so what a creator
 * approves in the browser is what the server renders.
 */

export { AdvancedTimelineComposition, type PreviewSources } from "./AdvancedTimelineComposition";
export { safePreviewSource } from "./media";
export {
  hasAudibleContent,
  visibleLanes,
  type AssetKind,
  type EditDocumentV2,
  type TimelineClip,
  type TimelineLane,
  type TimelineTrack,
} from "./timeline";

/** The only composition ID the renderer will accept. */
export const COMPOSITION_ID = "advanced-timeline-v1";
