import { describe, expect, test } from "bun:test";

import { safePreviewSource } from "@thoth/remotion-composition/media";

import { FIXTURE_IDENTITY, testBundle } from "./bundle-test-fixtures";
import { parseRenderBundle } from "./contracts";
import {
  RENDER_CHROMIUM_OPTIONS,
  RENDER_PRESET,
  assertCompositionGeometry,
  assetSourceUrl,
  compositionInputProps,
  rendererWebpackOverride,
} from "./remotion-adapter";

function bundleWithAssets(): ReturnType<typeof parseRenderBundle> {
  return parseRenderBundle(testBundle(), FIXTURE_IDENTITY);
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

  test("refuses a bundle whose composition is not the one that was authorized", () => {
    const expected = { width: 1080, height: 1920, fps: 30, durationInFrames: 120 };
    expect(() => assertCompositionGeometry(expected, expected)).not.toThrow();

    // Any one of them: a frame captured at another size or rate is another frame.
    for (const field of ["width", "height", "fps", "durationInFrames"] as const) {
      const drifted = { ...expected, [field]: expected[field] + 1 };
      expect(() => assertCompositionGeometry(drifted, expected)).toThrow(
        "composition geometry does not match the authorized bundle",
      );
    }
  });

  test("pins one browser configuration every surface renders through", () => {
    expect(RENDER_CHROMIUM_OPTIONS).toEqual({ enableMultiProcessOnLinux: true });
    expect(Object.isFrozen(RENDER_CHROMIUM_OPTIONS)).toBe(true);
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
