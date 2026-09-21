import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  FIXTURE_IDENTITY as EXPECTED,
  testBundle as bundle,
  testDocument as document,
  testStagedAsset as stagedAsset,
} from "./bundle-test-fixtures";
import { RenderBundleInvalid, parseRenderBundle } from "./contracts";

function rejects(overrides: Record<string, unknown>): void {
  expect(() => parseRenderBundle(bundle(overrides), EXPECTED)).toThrow(RenderBundleInvalid);
}

describe("parseRenderBundle", () => {
  test("accepts the one bundle shape the control plane writes", () => {
    const parsed = parseRenderBundle(bundle(), EXPECTED);
    expect(parsed.render_job_id).toBe("rj_001");
    expect(parsed.composition_id).toBe("advanced_timeline_v1");
    expect(parsed.assets).toHaveLength(1);
  });

  test("rejects an unknown top-level field instead of ignoring it", () => {
    rejects({ output_path: "/tmp/x.mp4" });
  });

  test("rejects an unknown asset field instead of ignoring it", () => {
    rejects({ assets: [stagedAsset({ source_path: "/var/lib/other.mp4" })] });
  });

  test("rejects a bundle version, template, preset, or composition it does not trust", () => {
    rejects({ bundle_version: 2 });
    rejects({ template_id: "other_template" });
    rejects({ template_version: 2 });
    rejects({ preset_id: "custom_preset" });
    rejects({ composition_id: "other_composition" });
  });

  test("rejects frame geometry outside the bounds the preset renders", () => {
    for (const geometry of [
      { width: 0 },
      { height: 100_000 },
      { fps: 0 },
      { fps: 1000 },
      { duration_in_frames: 0 },
      { duration_in_frames: 10_000_000 },
      { width: 1080.5 },
    ]) {
      rejects(geometry);
    }
  });

  test("rejects geometry that contradicts the document canvas it claims to render", () => {
    rejects({ width: 720 });
  });

  test("rejects an identity that is not a single safe segment", () => {
    rejects({ render_job_id: "../escape" });
    rejects({ dispatch_id: "dsp/001" });
  });

  test("accepts the UUID form of a project identity the control plane also allows", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const parsed = parseRenderBundle(
      bundle({ project_id: uuid, document: document({ project_id: uuid }) }),
      EXPECTED,
    );
    expect(parsed.project_id).toBe(uuid);
  });

  test("rejects a staged asset name that is not a contained workspace name", () => {
    for (const relative_name of ["../../etc/passwd", "/etc/passwd", "assets\\win.mp4"]) {
      rejects({ assets: [stagedAsset({ relative_name })] });
    }
    expect(
      parseRenderBundle(bundle({ assets: [stagedAsset({ relative_name: "assets/a.mp4" })] }), EXPECTED)
        .assets[0]?.asset_id,
    ).toBe("asset_1");
  });

  test("accepts only the one lowercase sha256 the staging check can match", () => {
    rejects({ assets: [stagedAsset({ checksum: "md5:abc" })] });
    rejects({ assets: [stagedAsset({ checksum: `sha256:${"a".repeat(63)}` })] });
    // The control plane writes hexdigest() and its staging check compares the
    // two strings, so an uppercase digest names a file that can never verify.
    rejects({ assets: [stagedAsset({ checksum: `sha256:${"A".repeat(64)}` })] });

    const digest = createHash("sha256").update("payload").digest("hex");
    expect(
      parseRenderBundle(
        bundle({ assets: [stagedAsset({ checksum: `sha256:${digest}` })] }),
        EXPECTED,
      ).assets[0]?.checksum,
    ).toBe(`sha256:${digest}`);
  });

  test("never repeats the offending value in the failure it raises", () => {
    try {
      parseRenderBundle(bundle({ render_job_id: "/var/secret/path" }), EXPECTED);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderBundleInvalid);
      expect(String(error)).not.toContain("/var/secret/path");
    }
  });
});

describe("the bundle's binding to the dispatch that asked for it", () => {
  test("rejects a bundle built for another job, dispatch, or renderer build", () => {
    rejects({ render_job_id: "rj_002" });
    rejects({ dispatch_id: "dsp_002" });
    rejects({ renderer_version: "remotion-4.0.400" });
  });

  test("rejects a renderer version that is blank or unsupported", () => {
    for (const renderer_version of ["", "   ", "latest", 1, null]) {
      rejects({ renderer_version });
    }
  });

  test("rejects a document whose own identity contradicts the bundle", () => {
    rejects({ document: document({ project_id: "project_002" }) });
    rejects({ document: document({ document_id: "doc_002" }) });
    rejects({ document: document({ revision: 4 }) });
  });
});

describe("the document the control plane published, revalidated here", () => {
  test("rejects a document with no scenes, no tracks, or an unknown field", () => {
    rejects({ document: document({ scenes: [] }) });
    rejects({ document: document({ tracks: [] }) });
    rejects({ document: document({ render_hint: "fast" }) });
  });

  test("rejects a malformed track, clip, or asset reference", () => {
    rejects({ document: document({ tracks: [{ track_id: "track_main" }] }) });
    rejects({
      document: document({
        clips: [{ kind: "video", clip_id: "clip_main", track_id: "track_main" }],
      }),
    });
    rejects({ document: document({ clips: [{ kind: "hologram", clip_id: "clip_main" }] }) });
    rejects({ document: document({ asset_refs: [{ asset_id: "asset_1" }] }) });
  });

  test("rejects document values outside the bounds the control plane enforces", () => {
    rejects({ document: document({ revision: 0 }) });
    rejects({
      document: document({
        canvas: { width: 720, height: 1280, fps: 30, duration_in_frames: 300 },
      }),
      width: 720,
      height: 1280,
    });
    rejects({
      document: document({
        scenes: [
          {
            scene_id: "scene_001",
            role: "chorus",
            start_frame: 0,
            duration_in_frames: 300,
            clip_ids: ["clip_main"],
          },
        ],
      }),
    });
  });
});

describe("the staged assets one render is allowed to read", () => {
  /** The same per-asset ceiling the control plane enforces when it stages. */
  const GIBIBYTE = 1024 * 1024 * 1024;

  test("rejects an empty or oversized asset", () => {
    rejects({ assets: [stagedAsset({ size_bytes: 0 })] });
    rejects({ assets: [stagedAsset({ size_bytes: GIBIBYTE + 1 })] });
    rejects({ assets: [stagedAsset({ size_bytes: Number.MAX_SAFE_INTEGER })] });
    expect(
      parseRenderBundle(bundle({ assets: [stagedAsset({ size_bytes: GIBIBYTE })] }), EXPECTED)
        .assets[0]?.size_bytes,
    ).toBe(GIBIBYTE);
  });

  test("rejects a duplicate asset identity or a duplicate staged name", () => {
    rejects({
      assets: [stagedAsset(), stagedAsset({ relative_name: "assets/other.mp4" })],
    });
    rejects({ assets: [stagedAsset(), stagedAsset({ asset_id: "asset_2" })] });
  });

  test("requires exactly the assets the document's clips actually play", () => {
    // The control plane stages one copy per referenced clip asset, so anything
    // else means the bundle and the document disagree about what is rendered.
    rejects({ assets: [] });
    rejects({ assets: [stagedAsset({ asset_id: "asset_9" })] });
    rejects({ assets: [stagedAsset(), stagedAsset({ asset_id: "asset_9", relative_name: "assets/nine.mp4" })] });
  });
});
