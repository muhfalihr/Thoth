import { describe, expect, test } from "bun:test";

import { safePreviewSource } from "@thoth/remotion-composition/media";

import { parseRenderBundle } from "./contracts";
import {
  RENDER_PRESET,
  assetSourceUrl,
  compositionInputProps,
  rendererWebpackOverride,
} from "./remotion-adapter";

function bundleWithAssets(): ReturnType<typeof parseRenderBundle> {
  return parseRenderBundle({
    bundle_version: 1,
    render_job_id: "rj_001",
    project_id: "project_001",
    document_id: "doc_001",
    document_revision: 3,
    dispatch_id: "dsp_001",
    document: {
      schema_version: 2,
      document_id: "doc_001",
      project_id: "project_001",
      revision: 3,
      canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
      template: { template_id: "vertical_text_story", version: 1 },
      scenes: [],
      tracks: [],
    },
    template_id: "vertical_text_story",
    template_version: 1,
    preset_id: "standard_vertical_mp4_v1",
    renderer_version: "remotion-4.0.523",
    composition_id: "advanced_timeline_v1",
    width: 1080,
    height: 1920,
    fps: 30,
    duration_in_frames: 300,
    assets: [
      {
        asset_id: "asset_1",
        relative_name: "assets/asset_1.mp4",
        size_bytes: 7,
        checksum: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
}

describe("the server render adapter", () => {
  test("serves a staged asset at a location the shared composition will load", () => {
    const source = assetSourceUrl("assets/asset_1.mp4");
    expect(source).toBe("/public/asset_1.mp4");
    expect(safePreviewSource(source)).toBe(source);
  });

  test("passes the document and one source per staged asset, and nothing else", () => {
    const bundle = bundleWithAssets();
    const props = compositionInputProps(bundle);
    expect(Object.keys(props).sort()).toEqual(["document", "previewSources"]);
    expect(props.document).toBe(bundle.document);
    expect(props.previewSources).toEqual({ asset_1: "/public/asset_1.mp4" });
  });

  test("pins one server-owned output preset the browser cannot influence", () => {
    expect(RENDER_PRESET).toEqual({
      codec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      imageFormat: "jpeg",
      enforceAudioTrack: false,
      muted: false,
    });
    expect(Object.isFrozen(RENDER_PRESET)).toBe(true);
  });

  test("resolves the shared composition and this service's modules when bundling", () => {
    const overridden = rendererWebpackOverride({
      resolve: { alias: { existing: "/kept" } },
      module: { rules: [] },
    });
    expect(overridden.module).toEqual({ rules: [] });
    expect(overridden.resolve.alias.existing).toBe("/kept");
    expect(overridden.resolve.alias["@thoth/remotion-composition"]).toContain(
      "remotion-composition",
    );
    expect(overridden.resolve.modules.some((entry) => entry.includes("node_modules"))).toBe(true);
  });
});
