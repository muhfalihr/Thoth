/// <reference types="bun-types" />

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import type { EditDocumentV2 } from "@/api/control-plane";
import { previewComposition } from "./preview";
import { typedTimelineDocument } from "./timeline-test-fixtures";

/** Props the media primitives received, in render order, per test. */
const mediaProps: { audio: Record<string, unknown>[] } = { audio: [] };

/** Every composition the server root registered, in registration order. */
const registrations: Record<string, unknown>[] = [];

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
  // Volume is a frame callback, which no DOM attribute can carry, so it is
  // captured instead of spread.
  Audio: ({ volume, ...rest }: Record<string, unknown>) => {
    mediaProps.audio.push({ volume, ...rest });
    return <div data-testid="audio" {...rest} />;
  },
  Img: (props: Record<string, unknown>) => <div data-testid="img" {...props} />,
  // The server root registers compositions instead of rendering them, so the
  // registration itself is what the test inspects.
  Composition: (props: Record<string, unknown>) => {
    registrations.push(props);
    return null;
  },
  registerRoot: () => undefined,
}));

const { AdvancedTimelineComposition, COMPOSITION_ID } = await import("@thoth/remotion-composition");
const { RenderRoot } = await import("@thoth/remotion-composition/register");

afterEach(() => {
  mediaProps.audio.length = 0;
  registrations.length = 0;
  cleanup();
});

/** The rendered volume callback of the audio clip at `index`. */
function volumeOf(index: number): (frame: number) => number {
  const volume = mediaProps.audio[index]?.volume;
  if (typeof volume !== "function") throw new Error("audio volume must be a frame callback");
  return volume as (frame: number) => number;
}

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

test("the browser preview and the server registration share one component and one ID", () => {
  expect(COMPOSITION_ID).toBe("advanced-timeline-v1");
  expect(previewComposition(documentV2()).component).toBe(AdvancedTimelineComposition);

  render(<RenderRoot />);
  expect(registrations).toHaveLength(1);
  expect(registrations[0]!.id).toBe(COMPOSITION_ID);
  expect(registrations[0]!.component).toBe(AdvancedTimelineComposition);
});

// Remotion validates this at registration, inside the bundle, where the only
// thing that escapes is a fixed failure code. An ID it refuses therefore fails
// every render with no diagnosis attached, so it is checked here instead.
const REMOTION_ALLOWS = /^[a-zA-Z0-9-一-鿿]+$/;

test("the shared composition ID is one Remotion agrees to register", () => {
  expect(COMPOSITION_ID).toMatch(REMOTION_ALLOWS);
});

test("the registered composition takes its timing from the document, not from a default", () => {
  render(<RenderRoot />);
  const calculateMetadata = registrations[0]!.calculateMetadata as (input: {
    props: { document: EditDocumentV2 };
  }) => { width: number; height: number; fps: number; durationInFrames: number };

  expect(calculateMetadata({ props: { document: documentV2() } })).toEqual({
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 300,
  });
});

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
  expect(screen.getByTestId("audio")).toBeDefined();
  const volume = volumeOf(0);
  expect([volume(0), volume(60), volume(120)]).toEqual([0, 0, 0]);
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

const TYPED_SOURCES = {
  asset_video: "/api/v1/projects/project_001/editor-assets/asset_video/preview",
  asset_music: "/api/v1/projects/project_001/editor-assets/asset_music/preview",
};

test("fit, crop, and position shape how a video fills the canvas", () => {
  render(<AdvancedTimelineComposition document={typedTimelineDocument()} previewSources={TYPED_SOURCES} />);
  const [plain, shaped] = screen.getAllByTestId("video") as HTMLElement[];
  const frames = screen.getAllByTestId("clip-frame") as HTMLElement[];

  expect(plain!.style.objectFit).toBe("cover");
  expect([plain!.style.width, plain!.style.height, plain!.style.left, plain!.style.top]).toEqual([
    "100%",
    "100%",
    "0%",
    "0%",
  ]);
  expect(frames[0]!.style.transform).toBe("translate(0%, 0%) scale(1)");

  // A half-wide, 60%-tall crop has to enlarge the frame and shift it back.
  expect(shaped!.style.objectFit).toBe("contain");
  expect([shaped!.style.width, shaped!.style.height, shaped!.style.left, shaped!.style.top]).toEqual([
    "200%",
    "166.6667%",
    "-20%",
    "-33.3333%",
  ]);
  expect(frames[1]!.style.overflow).toBe("hidden");
  // Offsets are canvas fractions, so a quarter right and half up reads as a percentage.
  expect(frames[1]!.style.transform).toBe("translate(25%, -50%) scale(1.5)");
});

test("offsets at the edge of the stored range span the whole canvas", () => {
  const document = typedTimelineDocument();
  const clip = document.clips![1] as { position: { x: number; y: number; scale: number } };
  clip.position = { x: -1, y: 1, scale: 4 };
  render(<AdvancedTimelineComposition document={document} previewSources={TYPED_SOURCES} />);
  expect(screen.getAllByTestId("clip-frame")[1]!.style.transform).toBe(
    "translate(-100%, 100%) scale(4)",
  );
});

test("fade in and fade out bound the volume at start, middle, and end", () => {
  render(<AdvancedTimelineComposition document={typedTimelineDocument()} previewSources={TYPED_SOURCES} />);
  const volume = volumeOf(0);
  // Stored volume 0.4, 150 frames, 12 in, 24 out.
  expect(volume(0)).toBe(0);
  expect(volume(6)).toBeCloseTo(0.2, 6);
  expect(volume(12)).toBeCloseTo(0.4, 6);
  expect(volume(75)).toBeCloseTo(0.4, 6);
  expect(volume(138)).toBeCloseTo(0.2, 6);
  expect(volume(150)).toBe(0);
  expect(volume(400)).toBe(0);
});

test("a clip without fades keeps its stored volume from the first frame", () => {
  const document = typedTimelineDocument();
  const audio = document.clips![4] as { fade_in_frames: number; fade_out_frames: number };
  audio.fade_in_frames = 0;
  audio.fade_out_frames = 0;
  render(<AdvancedTimelineComposition document={document} previewSources={TYPED_SOURCES} />);
  const volume = volumeOf(0);
  expect([volume(0), volume(75), volume(150)]).toEqual([0.4, 0.4, 0.4]);
});

test("overlay parameters reach only the registered preset and a trusted accent", () => {
  render(<AdvancedTimelineComposition document={typedTimelineDocument()} previewSources={TYPED_SOURCES} />);
  const overlay = screen.getByTestId("overlay-lower_third");
  expect(overlay.textContent).toBe("Headline");
  expect(overlay.getAttribute("data-accent")).toBe("accent_primary");
});

test("an unknown accent slot falls back and never becomes markup or style", () => {
  const document = typedTimelineDocument();
  (document.clips![2] as { parameters: { accent_slot: string } }).parameters.accent_slot =
    "url(javascript:alert(1))";
  render(<AdvancedTimelineComposition document={document} previewSources={TYPED_SOURCES} />);
  const overlay = screen.getByTestId("overlay-lower_third");
  expect(overlay.getAttribute("data-accent")).toBe("default");
  // Styling is a registry lookup, so the stored slot never reaches the style attribute.
  expect(overlay.getAttribute("style") ?? "").not.toContain("javascript");
  expect(overlay.style.color).toBe("#ffffff");
});

test("caption cues use a trusted style and stay timed inside their clip", () => {
  render(<AdvancedTimelineComposition document={typedTimelineDocument()} previewSources={TYPED_SOURCES} />);
  const cues = screen.getAllByTestId("caption-cue") as HTMLElement[];
  expect(cues.map((cue) => cue.textContent)).toEqual(["First cue", "Second cue"]);
  expect(cues.every((cue) => cue.getAttribute("data-caption-style") === "caption_default")).toBe(true);

  const ranges = screen
    .getAllByTestId("sequence")
    .filter((node) => node.getAttribute("data-name")?.startsWith("clip_caption_cue"))
    .map((node) => [
      Number(node.getAttribute("data-from")),
      Number(node.getAttribute("data-duration")),
    ]);
  expect(ranges).toEqual([
    [0, 30],
    [30, 60],
  ]);
});

test("an unregistered caption style falls back instead of taking the raw string", () => {
  const document = typedTimelineDocument();
  (document.clips![3] as { style_slot: string }).style_slot = "background:url(x);color:red";
  render(<AdvancedTimelineComposition document={document} previewSources={TYPED_SOURCES} />);
  const cue = (screen.getAllByTestId("caption-cue") as HTMLElement[])[0]!;
  expect(cue.getAttribute("data-caption-style")).toBe("default");
  // The unregistered slot is dropped whole; none of it survives as CSS.
  expect(cue.getAttribute("style") ?? "").not.toContain("url(");
});

const STILL_SOURCE = "/api/v1/projects/project_001/editor-assets/asset_still/preview";

test("an image asset renders through Img and a video asset through Video", () => {
  render(
    <AdvancedTimelineComposition
      document={typedTimelineDocument()}
      previewSources={{ ...TYPED_SOURCES, asset_still: STILL_SOURCE }}
    />,
  );

  const image = screen.getByTestId("img");
  expect(image.getAttribute("src")).toBe(STILL_SOURCE);
  // A still has no source timeline, so it never carries a trim.
  expect(image.getAttribute("startFrom")).toBeNull();
  expect(image.style.objectFit).toBe("contain");
  expect(screen.getAllByTestId("video")).toHaveLength(2);
});

test("a visual clip whose asset reference is missing or not visual stays unavailable", () => {
  const document = typedTimelineDocument();
  document.asset_refs = document.asset_refs!.filter((ref) => ref.asset_id !== "asset_still");
  const sources = { ...TYPED_SOURCES, asset_still: STILL_SOURCE };
  render(<AdvancedTimelineComposition document={document} previewSources={sources} />);
  expect(screen.queryByTestId("img")).toBeNull();
  expect(screen.getAllByTestId("preview-unavailable")).toHaveLength(1);

  cleanup();
  const mismatched = typedTimelineDocument();
  mismatched.asset_refs = mismatched.asset_refs!.map((ref) =>
    ref.asset_id === "asset_still" ? { ...ref, kind: "audio" as const } : ref,
  );
  render(<AdvancedTimelineComposition document={mismatched} previewSources={sources} />);
  expect(screen.queryByTestId("img")).toBeNull();
  expect(screen.getAllByTestId("preview-unavailable")).toHaveLength(1);
});
