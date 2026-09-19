import { TimelineClip, type GestureMode } from "./TimelineClip";
import { framesToPixels, type TimelineLane } from "./timeline_domain";

type Props = {
  lane: TimelineLane;
  zoom: number;
  widthInFrames: number;
  selectedClipId: string;
  onToggle: (field: "hidden" | "muted" | "locked", value: boolean) => void;
  onSelectClip: (clipId: string) => void;
  onGestureStart: (clipId: string, mode: GestureMode, clientX: number) => void;
  onNudge: (clipId: string, frames: number) => void;
};

const control =
  "rounded border border-border px-2 py-0.5 text-[0.7rem] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

export function TimelineTrack({
  lane,
  zoom,
  widthInFrames,
  selectedClipId,
  onToggle,
  onSelectClip,
  onGestureStart,
  onNudge,
}: Props) {
  const { track, clips } = lane;
  // A locked track keeps its own lock button live; everything else waits for it.
  const toggle = (field: "hidden" | "muted" | "locked", label: string, value: boolean) => (
    <button
      type="button"
      className={control}
      disabled={field !== "locked" && track.locked === true}
      aria-label={`${label} ${track.label}`}
      onClick={() => onToggle(field, !value)}
    >
      {label}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={`${track.label} track`}
      data-track-id={track.track_id}
      id={`timeline-track-${track.track_id}`}
      className="flex border-b border-border last:border-b-0"
    >
      <div className="flex w-48 shrink-0 flex-col gap-1 border-r border-border bg-card/60 p-2">
        <span className="truncate text-xs font-medium text-foreground">{track.label}</span>
        <div className="flex flex-wrap gap-1">
          {toggle("hidden", track.hidden ? "Show" : "Hide", track.hidden === true)}
          {toggle("muted", track.muted ? "Unmute" : "Mute", track.muted === true)}
          {toggle("locked", track.locked ? "Unlock" : "Lock", track.locked === true)}
        </div>
      </div>
      <div
        className="relative h-12 grow bg-background/40"
        style={{ minWidth: `${framesToPixels(widthInFrames, zoom)}px` }}
      >
        {clips.map((clip) => (
          <TimelineClip
            key={clip.clip_id}
            clip={clip}
            label={track.label}
            zoom={zoom}
            selected={clip.clip_id === selectedClipId}
            locked={clip.locked === true || track.locked === true}
            onSelect={() => onSelectClip(clip.clip_id)}
            onGestureStart={(mode, clientX) => onGestureStart(clip.clip_id, mode, clientX)}
            onNudge={(frames) => onNudge(clip.clip_id, frames)}
          />
        ))}
      </div>
    </div>
  );
}
