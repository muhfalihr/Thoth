/**
 * One render bundle the control plane could really have written.
 *
 * The document is validated against the published `EditDocumentV2` schema, so
 * every test that needs a bundle builds it here rather than hand-rolling a
 * shape the renderer would now reject.
 */

export const FIXTURE_IDENTITY = Object.freeze({
  renderJobId: "rj_001",
  dispatchId: "dsp_001",
  rendererVersion: "remotion-4.0.523",
});

type Fields = Record<string, unknown>;

/** A visible video clip on a main track, plus whatever the caller overrides. */
export function testDocument(overrides: Fields = {}): Fields {
  return {
    schema_version: 2,
    document_id: "doc_001",
    project_id: "project_001",
    revision: 3,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
    template: { template_id: "vertical_text_story", version: 1 },
    scenes: [
      {
        scene_id: "scene_001",
        role: "source",
        start_frame: 0,
        duration_in_frames: 300,
        clip_ids: ["clip_main"],
      },
    ],
    asset_refs: [
      {
        asset_id: "asset_1",
        project_id: "project_001",
        kind: "video",
        has_audio: true,
        validation_state: "ready",
      },
    ],
    tracks: [
      {
        track_id: "track_main",
        kind: "main_video",
        label: "Main video",
        order: 0,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_main"],
      },
    ],
    clips: [
      {
        kind: "video",
        clip_id: "clip_main",
        track_id: "track_main",
        asset_id: "asset_1",
        from_frame: 0,
        duration_in_frames: 300,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        fit: "cover",
      },
    ],
    ...overrides,
  };
}

export function testStagedAsset(overrides: Fields = {}): Fields {
  return {
    asset_id: "asset_1",
    relative_name: "assets/asset_1.mp4",
    size_bytes: 7,
    checksum: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

export function testBundle(overrides: Fields = {}): Fields {
  return {
    bundle_version: 1,
    render_job_id: FIXTURE_IDENTITY.renderJobId,
    project_id: "project_001",
    document_id: "doc_001",
    document_revision: 3,
    dispatch_id: FIXTURE_IDENTITY.dispatchId,
    document: testDocument(),
    template_id: "vertical_text_story",
    template_version: 1,
    preset_id: "standard_vertical_mp4_v1",
    renderer_version: FIXTURE_IDENTITY.rendererVersion,
    composition_id: "advanced_timeline_v1",
    width: 1080,
    height: 1920,
    fps: 30,
    duration_in_frames: 300,
    assets: [testStagedAsset()],
    ...overrides,
  };
}
