/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import type { EditDocumentV2 } from "@/api/control-plane";

// Remotion primitives need a composition context that no unit test provides, so
// they are replaced with inert markers that keep the real rendering decisions
// (ordering, ranges, source lookup) under test.
mock.module("remotion", () => ({
  AbsoluteFill: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
  Sequence: ({
    children,
    from,
    durationInFrames,
    name,
  }: {
    children?: ReactNode;
    from: number;
    durationInFrames: number;
    name?: string;
  }) => (
    <div data-testid="sequence" data-name={name} data-from={from} data-duration={durationInFrames}>
      {children}
    </div>
  ),
  Video: (props: Record<string, unknown>) => <div data-testid="video" {...props} />,
  Audio: (props: Record<string, unknown>) => <div data-testid="audio" {...props} />,
  Img: (props: Record<string, unknown>) => <div data-testid="img" {...props} />,
}));

const { AdvancedTimelineComposition } = await import("./AdvancedTimelineComposition");

afterEach(cleanup);

function documentV2(): EditDocumentV2 {
  return {
    schema_version: 2,
    document_id: "document_002",
    project_id: "project_001",
    revision: 4,
    canvas: { width: 1080, height: 1920, fps: 30, duration_in_frames: 300 },
    template: { template_id: "vertical_text_story", version: 1 },
    scenes: [
      {
        scene_id: "scene_001",
        role: "source",
        start_frame: 0,
        duration_in_frames: 300,
        clip_ids: ["clip_video"],
      },
    ],
    asset_refs: [
      {
        asset_id: "asset_video",
        project_id: "project_001",
        kind: "video",
        has_audio: true,
        validation_state: "ready",
      },
    ],
    tracks: [
      {
        track_id: "track_overlay",
        kind: "overlay",
        label: "Overlay",
        order: 2,
        hidden: false,
        muted: false,
        locked: false,
        clip_ids: ["clip_overlay", "clip_text"],
      },
      {
        track_id: "track_main",
        kind: "main_video",
        label: "Main",
        order: 0,
        hidden: false,
        muted: false,
        locked: true,
        clip_ids: ["clip_video"],
      },
      {
        track_id: "track_music",
        kind: "music",
        label: "Music",
        order: 1,
        hidden: false,
        muted: true,
        locked: false,
        clip_ids: ["clip_music"],
      },
      {
        track_id: "track_hidden",
        kind: "caption",
        label: "Captions",
        order: 3,
        hidden: true,
        muted: false,
        locked: false,
        clip_ids: ["clip_caption"],
      },
    ],
    clips: [
      {
        kind: "video",
        clip_id: "clip_video",
        track_id: "track_main",
        asset_id: "asset_video",
        from_frame: 0,
        duration_in_frames: 300,
        source_from_frame: 30,
        ownership: "ai_managed",
        hidden: false,
        locked: true,
        fit: "cover",
      },
      {
        kind: "audio",
        clip_id: "clip_music",
        track_id: "track_music",
        asset_id: "asset_video",
        from_frame: 0,
        duration_in_frames: 120,
        source_from_frame: 0,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
        volume: 0.8,
        fade_in_frames: 0,
        fade_out_frames: 0,
      },
      {
        kind: "overlay",
        clip_id: "clip_overlay",
        track_id: "track_overlay",
        preset_id: "badge",
        parameters: { text: "Sumber", accent_slot: "title" },
        from_frame: 10,
        duration_in_frames: 40,
        ownership: "ai_managed",
        hidden: false,
        locked: false,
      },
      {
        kind: "text",
        clip_id: "clip_text",
        track_id: "track_overlay",
        from_frame: 60,
        duration_in_frames: 60,
        heading: "<script>alert(1)</script>",
        body: "Body & tail",
        style_slot: "title",
        ownership: "ai_managed",
        hidden: false,
        locked: false,
      },
      {
        kind: "caption",
        clip_id: "clip_caption",
        track_id: "track_hidden",
        from_frame: 0,
        duration_in_frames: 90,
        style_slot: "source",
        cues: [{ from_frame: 0, duration_in_frames: 30, text: "Hidden cue" }],
        ownership: "ai_managed",
        hidden: false,
        locked: false,
      },
    ],
  };
}

const SOURCES = { asset_video: "/api/v1/projects/project_001/editor-assets/asset_video/preview" };

test("renders visible lanes back to front in track order", () => {
  render(<AdvancedTimelineComposition document={documentV2()} previewSources={SOURCES} />);
  expect(
    screen.getAllByTestId("sequence").map((node) => node.getAttribute("data-name")),
  ).toEqual(["clip_video", "clip_music", "clip_overlay", "clip_text"]);
});

test("gives each clip its own frame range and keeps locked clips visible", () => {
  render(<AdvancedTimelineComposition document={documentV2()} previewSources={SOURCES} />);
  const ranges = Object.fromEntries(
    screen
      .getAllByTestId("sequence")
      .map((node) => [
        node.getAttribute("data-name"),
        [Number(node.getAttribute("data-from")), Number(node.getAttribute("data-duration"))],
      ]),
  );
  expect(ranges).toEqual({
    clip_video: [0, 300],
    clip_music: [0, 120],
    clip_overlay: [10, 40],
    clip_text: [60, 60],
  });
});

test("hidden tracks and hidden clips render nothing at all", () => {
  const document = documentV2();
  document.clips![3]!.hidden = true;
  render(<AdvancedTimelineComposition document={document} previewSources={SOURCES} />);
  const names = screen.getAllByTestId("sequence").map((node) => node.getAttribute("data-name"));
  expect(names).not.toContain("clip_caption");
  expect(names).not.toContain("clip_text");
});

test("a muted track silences its audio instead of dropping the clip", () => {
  render(<AdvancedTimelineComposition document={documentV2()} previewSources={SOURCES} />);
  expect(screen.getByTestId("audio").getAttribute("volume")).toBe("0");
});

test("clip text is rendered as text, never as markup", () => {
  render(<AdvancedTimelineComposition document={documentV2()} previewSources={SOURCES} />);
  expect(screen.getByText("<script>alert(1)</script>")).toBeDefined();
  expect(document.querySelector("script")).toBeNull();
});

test("only registered overlay presets render, unknown presets are dropped", () => {
  const edited = documentV2();
  render(<AdvancedTimelineComposition document={edited} previewSources={SOURCES} />);
  expect(screen.getByTestId("overlay-badge").textContent).toBe("Sumber");

  cleanup();
  const spoofed = documentV2();
  (spoofed.clips![2] as { preset_id: string }).preset_id = "../../etc/passwd";
  render(<AdvancedTimelineComposition document={spoofed} previewSources={SOURCES} />);
  expect(screen.queryByTestId("overlay-badge")).toBeNull();
  expect(screen.queryByText("../../etc/passwd")).toBeNull();
});

test("media sources are looked up by asset ID and trimmed at the source frame", () => {
  render(<AdvancedTimelineComposition document={documentV2()} previewSources={SOURCES} />);
  const video = screen.getByTestId("video");
  expect(video.getAttribute("src")).toBe(SOURCES.asset_video);
  expect(video.getAttribute("startFrom")).toBe("30");
  expect(video.getAttribute("crossOrigin")).toBeNull();
});

test("a missing or unsafe source becomes a placeholder and reports preview_unavailable", () => {
  const reported: string[] = [];
  render(
    <AdvancedTimelineComposition
      document={documentV2()}
      previewSources={{ asset_video: "https://cdn.example.test/leak.mp4" }}
      onPreviewUnavailable={(assetId) => reported.push(assetId)}
    />,
  );
  expect(screen.queryByTestId("video")).toBeNull();
  expect(screen.getAllByTestId("preview-unavailable")).toHaveLength(2);
  expect(reported).toEqual(["asset_video", "asset_video"]);
});
