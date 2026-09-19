import { AbsoluteFill, Audio, Sequence, Video } from "remotion";
import type { ReactNode } from "react";

import type { EditDocumentV2 } from "@/api/control-plane";
import { visibleLanes } from "./timeline_domain";
import { safePreviewSource } from "./preview";

type TimelineClip = NonNullable<EditDocumentV2["clips"]>[number];
type OverlayClip = Extract<TimelineClip, { kind: "overlay" }>;

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
const OVERLAY_PRESETS: Record<string, (clip: OverlayClip) => ReactNode> = {
  lower_third: (clip) => (
    <div
      data-testid="overlay-lower_third"
      className="absolute inset-x-16 bottom-32 rounded bg-black/70 px-8 py-6 text-4xl text-white"
    >
      {clip.parameters?.text}
    </div>
  ),
  badge: (clip) => (
    <div
      data-testid="overlay-badge"
      className="absolute left-16 top-16 rounded-full bg-white/90 px-6 py-3 text-3xl font-semibold text-black"
    >
      {clip.parameters?.text}
    </div>
  ),
  progress_bar: () => (
    <div data-testid="overlay-progress_bar" className="absolute inset-x-0 bottom-0 h-3 bg-white/80" />
  ),
};

export function AdvancedTimelineComposition({
  document,
  previewSources = {},
  onPreviewUnavailable,
}: Props) {
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
                {renderClip(clip, track.muted === true, previewSources, onPreviewUnavailable)}
              </Sequence>
            )),
        )}
    </AbsoluteFill>
  );
}

function renderClip(
  clip: TimelineClip,
  muted: boolean,
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
    case "overlay":
      return <AbsoluteFill>{OVERLAY_PRESETS[clip.preset_id]?.(clip)}</AbsoluteFill>;
    case "caption":
      return (
        <AbsoluteFill className="items-center justify-end p-16">
          {clip.cues.map((cue, index) => (
            <Sequence
              key={`${clip.clip_id}_cue_${index}`}
              name={`${clip.clip_id}_cue_${index}`}
              from={cue.from_frame}
              durationInFrames={cue.duration_in_frames}
            >
              <p className="rounded bg-black/70 px-6 py-3 text-center text-4xl">{cue.text}</p>
            </Sequence>
          ))}
        </AbsoluteFill>
      );
    case "video": {
      const source = resolve(clip.asset_id, sources, onPreviewUnavailable);
      if (!source) return <PreviewUnavailable label="Video preview unavailable" />;
      return (
        <AbsoluteFill className="items-center justify-center">
          <Video src={source} startFrom={clip.source_from_frame} muted={muted} />
        </AbsoluteFill>
      );
    }
    case "audio": {
      const source = resolve(clip.asset_id, sources, onPreviewUnavailable);
      if (!source) return <PreviewUnavailable label="Audio preview unavailable" />;
      return <Audio src={source} startFrom={clip.source_from_frame} volume={muted ? 0 : clip.volume} />;
    }
    default:
      return null;
  }
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
