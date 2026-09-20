/**
 * The server-side registration of the one trusted composition.
 *
 * The renderer selects this composition by ID and never names a component, and
 * every dimension comes from the document the control plane staged, so a render
 * request carries no knob that could change what is drawn.
 */

import { Composition, registerRoot } from "remotion";
import type { CalculateMetadataFunction } from "remotion";

import { AdvancedTimelineComposition, COMPOSITION_ID, type PreviewSources } from "./index";
import type { EditDocumentV2 } from "./timeline";

export type RenderProps = {
  document: EditDocumentV2;
  previewSources?: PreviewSources;
};

/** Never rendered: the real document always arrives as input props. */
const PLACEHOLDER_DOCUMENT: EditDocumentV2 = {
  schema_version: 2,
  document_id: "placeholder",
  project_id: "placeholder",
  revision: 0,
  canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 1 },
  template: { template_id: "vertical_text_story", version: 1 },
  scenes: [],
  tracks: [],
};

export const calculateMetadata: CalculateMetadataFunction<RenderProps> = ({ props }) => ({
  width: props.document.canvas.width,
  height: props.document.canvas.height,
  fps: props.document.canvas.fps,
  durationInFrames: props.document.canvas.duration_in_frames,
});

export function RenderRoot() {
  return (
    <Composition
      id={COMPOSITION_ID}
      component={AdvancedTimelineComposition}
      defaultProps={{ document: PLACEHOLDER_DOCUMENT }}
      width={PLACEHOLDER_DOCUMENT.canvas.width}
      height={PLACEHOLDER_DOCUMENT.canvas.height}
      fps={PLACEHOLDER_DOCUMENT.canvas.fps}
      durationInFrames={PLACEHOLDER_DOCUMENT.canvas.duration_in_frames}
      calculateMetadata={calculateMetadata}
    />
  );
}

registerRoot(RenderRoot);
