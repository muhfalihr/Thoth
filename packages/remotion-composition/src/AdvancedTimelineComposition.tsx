import { AbsoluteFill, Audio, Img, Sequence, Video } from "remotion";
import type { CSSProperties, ReactNode } from "react";

import type { AssetKind, EditDocumentV2, TimelineClip } from "./timeline";
import { visibleLanes } from "./timeline";
import { safePreviewSource } from "./media";
import { COMPOSITION_FONT_FAMILY, useCompositionFonts } from "./fonts";

type OverlayClip = Extract<TimelineClip, { kind: "overlay" }>;
type AudioClip = Extract<TimelineClip, { kind: "audio" }>;

/** A style the document may select by name, resolved to a local style object. */
type TrustedStyle = { name: string; style: CSSProperties };

/** Preview media, keyed by asset ID. Never persisted into a document revision. */
export type PreviewSources = Record<string, string>;

type Props = {
  document: EditDocumentV2;
  previewSources?: PreviewSources;
  onPreviewUnavailable?: (assetId: string) => void;
};

/**
 * Styling is inline on purpose: the server bundle has no CSS pipeline, so a
 * class name would render in the browser and vanish in the rendered file.
 */
const CANVAS: CSSProperties = {
  backgroundColor: "#09090b",
  color: "#ffffff",
  // Set once at the root: every glyph below inherits the family this package
  // ships, so nothing drawn depends on what the host has installed.
  fontFamily: COMPOSITION_FONT_FAMILY,
};
const TEXT_CLIP: CSSProperties = {
  alignItems: "center",
  justifyContent: "center",
  gap: 24,
  padding: 64,
  textAlign: "center",
};
const HEADING: CSSProperties = { maxWidth: "80%", fontSize: 60, fontWeight: 700, lineHeight: 1.25 };
const BODY: CSSProperties = { maxWidth: "72%", fontSize: 30, color: "#d4d4d8" };
const CAPTION_LANE: CSSProperties = {
  alignItems: "center",
  justifyContent: "flex-end",
  padding: 64,
};
const UNAVAILABLE: CSSProperties = {
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "#18181b",
  fontSize: 24,
  color: "#a1a1aa",
};

/**
 * The only overlay presets the composition will draw. A document naming
 * anything else renders nothing, so a stored preset ID can never select
 * arbitrary markup.
 */
const OVERLAY_PRESETS: Record<string, (clip: OverlayClip, accent: TrustedStyle) => ReactNode> = {
  lower_third: (clip, accent) => (
    <div
      data-testid="overlay-lower_third"
      data-accent={accent.name}
      style={{
        position: "absolute",
        left: 64,
        right: 64,
        bottom: 128,
        borderRadius: 4,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        padding: "24px 32px",
        fontSize: 36,
        ...accent.style,
      }}
    >
      {clip.parameters?.text}
    </div>
  ),
  badge: (clip, accent) => (
    <div
      data-testid="overlay-badge"
      data-accent={accent.name}
      style={{
        position: "absolute",
        left: 64,
        top: 64,
        borderRadius: 9999,
        backgroundColor: "rgba(255, 255, 255, 0.9)",
        padding: "12px 24px",
        fontSize: 30,
        fontWeight: 600,
        ...accent.style,
      }}
    >
      {clip.parameters?.text}
    </div>
  ),
  progress_bar: (_clip, accent) => (
    <div
      data-testid="overlay-progress_bar"
      data-accent={accent.name}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 12,
        backgroundColor: "rgba(255, 255, 255, 0.8)",
      }}
    />
  ),
};

/**
 * Every style name the composition will honour. A document naming anything
 * else falls back, so a stored slot can never become arbitrary CSS or markup.
 */
const OVERLAY_ACCENTS: Record<string, CSSProperties> = {
  accent_primary: { color: "#fcd34d" },
  accent_secondary: { color: "#7dd3fc" },
  title: { color: "#ffffff" },
  source: { color: "#e4e4e7" },
};

const CAPTION_BASE: CSSProperties = {
  borderRadius: 4,
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  padding: "12px 24px",
  textAlign: "center",
};

const CAPTION_STYLES: Record<string, CSSProperties> = {
  caption_default: { ...CAPTION_BASE, fontSize: 36 },
  source: { ...CAPTION_BASE, fontSize: 30, color: "#e4e4e7" },
};

/** The caption styles a document may name; Studio offers exactly these. */
export const CAPTION_STYLE_IDS = Object.keys(CAPTION_STYLES);

/** Identity crop and placement, used when a clip stores neither. */
const FULL_CROP = { left: 0, top: 0, width: 1, height: 1 };
const NO_POSITION = { x: 0, y: 0, scale: 1 };

function trustedStyle(
  slot: string | null | undefined,
  registry: Record<string, CSSProperties>,
  fallback: CSSProperties,
): TrustedStyle {
  const style = slot ? registry[slot] : undefined;
  return style ? { name: slot as string, style } : { name: "default", style: fallback };
}

export function AdvancedTimelineComposition({
  document,
  previewSources = {},
  onPreviewUnavailable,
}: Props) {
  useCompositionFonts();
  // Whether a clip is a still or a movie comes only from the document's own
  // validated asset reference, never from a preview URL or its suffix.
  const kinds = new Map((document.asset_refs ?? []).map((ref) => [ref.asset_id, ref.kind]));
  return (
    <AbsoluteFill style={CANVAS}>
      {/* Lanes are editor rows, so a hidden track still has one; the composition drops it. */}
      {visibleLanes(document)
        .filter(({ track }) => !track.hidden)
        .flatMap(({ track, clips }) =>
          clips
            .filter((clip) => !clip.hidden)
            .map((clip) => (
              <Sequence
                key={clip.clip_id}
                name={clip.clip_id}
                from={clip.from_frame}
                durationInFrames={clip.duration_in_frames}
              >
                {renderClip(clip, track.muted === true, kinds, previewSources, onPreviewUnavailable)}
              </Sequence>
            )),
        )}
    </AbsoluteFill>
  );
}

function renderClip(
  clip: TimelineClip,
  muted: boolean,
  kinds: Map<string, AssetKind>,
  sources: PreviewSources,
  onPreviewUnavailable?: (assetId: string) => void,
): ReactNode {
  switch (clip.kind) {
    case "text":
      return (
        <AbsoluteFill style={TEXT_CLIP}>
          <h1 style={HEADING}>{clip.heading}</h1>
          {clip.body && <p style={BODY}>{clip.body}</p>}
        </AbsoluteFill>
      );
    case "overlay": {
      const accent = trustedStyle(clip.parameters?.accent_slot, OVERLAY_ACCENTS, {
        color: "#ffffff",
      });
      return <AbsoluteFill>{OVERLAY_PRESETS[clip.preset_id]?.(clip, accent)}</AbsoluteFill>;
    }
    case "caption": {
      const style = trustedStyle(clip.style_slot, CAPTION_STYLES, CAPTION_STYLES.caption_default!);
      return (
        <AbsoluteFill style={CAPTION_LANE}>
          {/* Cue frames are relative to the caption clip, so they nest inside it. */}
          {clip.cues.map((cue, index) => (
            <Sequence
              key={`${clip.clip_id}_cue_${index}`}
              name={`${clip.clip_id}_cue_${index}`}
              from={cue.from_frame}
              durationInFrames={cue.duration_in_frames}
            >
              <p data-testid="caption-cue" data-caption-style={style.name} style={style.style}>
                {cue.text}
              </p>
            </Sequence>
          ))}
        </AbsoluteFill>
      );
    }
    case "video": {
      const kind = kinds.get(clip.asset_id);
      if (kind !== "video" && kind !== "image") {
        return <PreviewUnavailable label="Video preview unavailable" />;
      }
      const source = resolve(clip.asset_id, sources, onPreviewUnavailable);
      if (!source) return <PreviewUnavailable label="Video preview unavailable" />;
      const crop = clip.crop ?? FULL_CROP;
      const position = clip.position ?? NO_POSITION;
      const media: CSSProperties = {
        position: "absolute",
        width: percent(1 / span(crop.width)),
        height: percent(1 / span(crop.height)),
        left: percent(-crop.left / span(crop.width)),
        top: percent(-crop.top / span(crop.height)),
        objectFit: clip.fit,
      };
      return (
        // The frame clips the crop and carries the placement; the media itself
        // is enlarged and offset so the kept region fills that frame.
        <AbsoluteFill
          data-testid="clip-frame"
          style={{
            overflow: "hidden",
            // Offsets are canvas fractions, not pixels, so they project as percentages.
            transform: `translate(${percent(position.x)}, ${percent(position.y)}) scale(${position.scale})`,
          }}
        >
          {/* A still has no source timeline, so only a movie carries a trim. */}
          {kind === "image" ? (
            <Img src={source} style={media} />
          ) : (
            <Video src={source} startFrom={clip.source_from_frame} muted={muted} style={media} />
          )}
        </AbsoluteFill>
      );
    }
    case "audio": {
      const source = resolve(clip.asset_id, sources, onPreviewUnavailable);
      if (!source) return <PreviewUnavailable label="Audio preview unavailable" />;
      return (
        <Audio
          src={source}
          startFrom={clip.source_from_frame}
          volume={(frame) => (muted ? 0 : clip.volume * fadeMultiplier(frame, clip))}
        />
      );
    }
    default:
      return null;
  }
}

/** A CSS percentage with enough precision to survive a fractional crop. */
function percent(ratio: number): string {
  return `${Number((ratio * 100).toFixed(4))}%`;
}

/** A crop edge never divides by zero, however the document was written. */
function span(size: number): number {
  return size > 0 ? size : 1;
}

/**
 * How much of the stored volume a frame keeps, from 0 to 1.
 *
 * `frame` is relative to the clip, which is exactly how the document stores
 * its fades, so no canvas offset enters the calculation.
 */
function fadeMultiplier(frame: number, clip: AudioClip): number {
  const rise = clip.fade_in_frames > 0 ? frame / clip.fade_in_frames : 1;
  const fall =
    clip.fade_out_frames > 0 ? (clip.duration_in_frames - frame) / clip.fade_out_frames : 1;
  return Math.min(1, Math.max(0, Math.min(rise, fall)));
}

function resolve(
  assetId: string,
  sources: PreviewSources,
  onPreviewUnavailable?: (assetId: string) => void,
): string | undefined {
  const source = safePreviewSource(sources[assetId]);
  if (!source) onPreviewUnavailable?.(assetId);
  return source;
}

function PreviewUnavailable({ label }: { label: string }) {
  return (
    <AbsoluteFill data-testid="preview-unavailable" style={UNAVAILABLE}>
      {label}
    </AbsoluteFill>
  );
}
