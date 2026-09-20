import { describe, expect, test } from "bun:test";

import { RenderBundleInvalid, parseRenderBundle } from "./contracts";

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    assets: [],
    ...overrides,
  };
}

describe("parseRenderBundle", () => {
  test("accepts the one bundle shape the control plane writes", () => {
    const parsed = parseRenderBundle(bundle());
    expect(parsed.render_job_id).toBe("rj_001");
    expect(parsed.composition_id).toBe("advanced_timeline_v1");
    expect(parsed.assets).toEqual([]);
  });

  test("rejects an unknown top-level field instead of ignoring it", () => {
    expect(() => parseRenderBundle(bundle({ output_path: "/tmp/x.mp4" }))).toThrow(
      RenderBundleInvalid,
    );
  });

  test("rejects an unknown asset field instead of ignoring it", () => {
    const assets = [
      {
        asset_id: "asset_1",
        relative_name: "assets/asset_1.mp4",
        size_bytes: 10,
        checksum: `sha256:${"a".repeat(64)}`,
        source_path: "/var/lib/other.mp4",
      },
    ];
    expect(() => parseRenderBundle(bundle({ assets }))).toThrow(RenderBundleInvalid);
  });

  test("rejects a bundle version, template, preset, or composition it does not trust", () => {
    expect(() => parseRenderBundle(bundle({ bundle_version: 2 }))).toThrow(RenderBundleInvalid);
    expect(() => parseRenderBundle(bundle({ template_id: "other_template" }))).toThrow(
      RenderBundleInvalid,
    );
    expect(() => parseRenderBundle(bundle({ template_version: 2 }))).toThrow(RenderBundleInvalid);
    expect(() => parseRenderBundle(bundle({ preset_id: "custom_preset" }))).toThrow(
      RenderBundleInvalid,
    );
    expect(() => parseRenderBundle(bundle({ composition_id: "other_composition" }))).toThrow(
      RenderBundleInvalid,
    );
  });

  test("rejects frame geometry outside the bounds the preset renders", () => {
    expect(() => parseRenderBundle(bundle({ width: 0 }))).toThrow(RenderBundleInvalid);
    expect(() => parseRenderBundle(bundle({ height: 100_000 }))).toThrow(RenderBundleInvalid);
    expect(() => parseRenderBundle(bundle({ fps: 0 }))).toThrow(RenderBundleInvalid);
    expect(() => parseRenderBundle(bundle({ fps: 1000 }))).toThrow(RenderBundleInvalid);
    expect(() => parseRenderBundle(bundle({ duration_in_frames: 0 }))).toThrow(RenderBundleInvalid);
    expect(() => parseRenderBundle(bundle({ duration_in_frames: 10_000_000 }))).toThrow(
      RenderBundleInvalid,
    );
    expect(() => parseRenderBundle(bundle({ width: 1080.5 }))).toThrow(RenderBundleInvalid);
  });

  test("rejects geometry that contradicts the document canvas it claims to render", () => {
    expect(() => parseRenderBundle(bundle({ width: 720 }))).toThrow(RenderBundleInvalid);
  });

  test("rejects an identity that is not a single safe segment", () => {
    expect(() => parseRenderBundle(bundle({ render_job_id: "../escape" }))).toThrow(
      RenderBundleInvalid,
    );
    expect(() => parseRenderBundle(bundle({ dispatch_id: "dsp/001" }))).toThrow(RenderBundleInvalid);
  });

  test("rejects a staged asset name that is not a contained workspace name", () => {
    const named = (relative_name: string) => [
      {
        asset_id: "asset_1",
        relative_name,
        size_bytes: 10,
        checksum: `sha256:${"a".repeat(64)}`,
      },
    ];
    expect(() => parseRenderBundle(bundle({ assets: named("../../etc/passwd") }))).toThrow(
      RenderBundleInvalid,
    );
    expect(() => parseRenderBundle(bundle({ assets: named("/etc/passwd") }))).toThrow(
      RenderBundleInvalid,
    );
    expect(() => parseRenderBundle(bundle({ assets: named("assets\\win.mp4") }))).toThrow(
      RenderBundleInvalid,
    );
    expect(parseRenderBundle(bundle({ assets: named("assets/a.mp4") })).assets[0]?.asset_id).toBe(
      "asset_1",
    );
  });

  test("rejects a checksum that is not a sha256 digest", () => {
    const assets = [
      {
        asset_id: "asset_1",
        relative_name: "assets/asset_1.mp4",
        size_bytes: 10,
        checksum: "md5:abc",
      },
    ];
    expect(() => parseRenderBundle(bundle({ assets }))).toThrow(RenderBundleInvalid);
  });

  test("never repeats the offending value in the failure it raises", () => {
    try {
      parseRenderBundle(bundle({ render_job_id: "/var/secret/path" }));
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderBundleInvalid);
      expect(String(error)).not.toContain("/var/secret/path");
    }
  });
});
