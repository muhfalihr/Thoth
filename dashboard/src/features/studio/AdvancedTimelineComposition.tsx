import { AbsoluteFill, Audio, Img, Sequence, Video } from "remotion";
import type { CSSProperties, ReactNode } from "react";

import type { EditDocumentV2 } from "@/api/control-plane";
import { visibleLanes } from "./timeline_domain";
import { safePreviewSource } from "./preview";

type TimelineClip = NonNullable<EditDocumentV2["clips"]>[number];
type AssetKind = NonNullable<EditDocumentV2["asset_refs"]>[number]["kind"];
type OverlayClip = Extract<TimelineClip, { kind: "overlay" }>;
type AudioClip = Extract<TimelineClip, { kind: "audio" }>;

/** A style the document may select by name, resolved to a local class. */
type TrustedStyle = { name: string; className: string };

/** Preview media, keyed by asset ID. Never persisted into a document revision. */
export type PreviewSources = Record<string, string>;

type Props = {
  document: EditDocumentV2;
  previewSources?: PreviewSources;
  onPreviewUnavailable?: (assetId: string) => void;
};

/**
 * The only overlay presets the preview will draw. A document naming anything
 * else renders nothing, so a stored preset ID can never select arbitrary markup.
 */
const OVERLAY_PRESETS: Record<string, (clip: OverlayClip, accent: TrustedStyle) => ReactNode> = {
  lower_third: (clip, accent) => (
    <div
      data-testid="overlay-lower_third"
      data-accent={accent.name}
      className={`absolute inset-x-16 bottom-32 rounded bg-black/70 px-8 py-6 text-4xl ${accent.className}`}
    >
      {clip.parameters?.text}
    </div>
  ),
  badge: (clip, accent) => (
    <div
      data-testid="overlay-badge"
      data-accent={accent.name}
      className={`absolute left-16 top-16 rounded-full bg-white/90 px-6 py-3 text-3xl font-semibold ${accent.className}`}
    >
      {clip.parameters?.text}
    </div>
  ),
  progress_bar: (_clip, accent) => (
    <div
      data-testid="overlay-progress_bar"
      data-accent={accent.name}
      className="absolute inset-x-0 bottom-0 h-3 bg-white/80"
    />
  ),
};

/**
 * Every style name the preview will honour. A document naming anything else
 * falls back, so a stored slot can never become arbitrary CSS or markup.
 */
const OVERLAY_ACCENTS: Record<string, string> = {
  accent_primary: "text-amber-300",
  accent_secondary: "text-sky-300",
  title: "text-white",
  source: "text-zinc-200",
};

const CAPTION_STYLES: Record<string, string> = {
  caption_default: "rounded bg-black/70 px-6 py-3 text-center text-4xl",
  source: "rounded bg-black/70 px-6 py-3 text-center text-3xl text-zinc-200",
};

/** Identity crop and placement, used when a clip stores neither. */
const FULL_CROP = { left: 0, top: 0, width: 1, height: 1 };
const NO_POSITION = { x: 0, y: 0, scale: 1 };

function trustedStyle(
  slot: string | null | undefined,
  registry: Record<string, string>,
  fallback: string,
): TrustedStyle {
  const className = slot ? registry[slot] : undefined;
  return className ? { name: slot as string, className } : { name: "default", className: fallback };
}

export function AdvancedTimelineComposition({
  document,
  previewSources = {},
  onPreviewUnavailable,
}: Props) {
  // Whether a clip is a still or a movie comes only from the document's own
  // validated asset reference, never from a preview URL or its suffix.
  const kinds = new Map((document.asset_refs ?? []).map((ref) => [ref.asset_id, ref.kind]));
  return (
    <AbsoluteFill className="bg-zinc-950 text-white">
      {/* Lanes are editor rows, so a hidden track still has one; the preview drops it. */}
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
        <AbsoluteFill className="items-center justify-center gap-6 p-16 text-center">
          <h1 className="max-w-[80%] text-6xl font-bold leading-tight">{clip.heading}</h1>
          {clip.body && <p className="max-w-[72%] text-3xl text-zinc-300">{clip.body}</p>}
        </AbsoluteFill>
      );
    case "overlay": {
      const accent = trustedStyle(clip.parameters?.accent_slot, OVERLAY_ACCENTS, "text-white");
      return <AbsoluteFill>{OVERLAY_PRESETS[clip.preset_id]?.(clip, accent)}</AbsoluteFill>;
    }
    case "caption": {
      const style = trustedStyle(clip.style_slot, CAPTION_STYLES, CAPTION_STYLES.caption_default!);
      return (
        <AbsoluteFill className="items-center justify-end p-16">
          {/* Cue frames are relative to the caption clip, so they nest inside it. */}
          {clip.cues.map((cue, index) => (
            <Sequence
              key={`${clip.clip_id}_cue_${index}`}
              name={`${clip.clip_id}_cue_${index}`}
              from={cue.from_frame}
              durationInFrames={cue.duration_in_frames}
            >
              <p data-testid="caption-cue" data-caption-style={style.name} className={style.className}>
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
    <AbsoluteFill
      data-testid="preview-unavailable"
      className="items-center justify-center bg-zinc-900 text-2xl text-zinc-400"
    >
      {label}
    </AbsoluteFill>
  );
}
