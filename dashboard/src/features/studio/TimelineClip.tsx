import type { PointerEvent } from "react";

import type { EditDocumentV2 } from "@/api/control-plane";
import { framesToPixels } from "./timeline_domain";

export type GestureMode = "move" | "trim_start" | "trim_end";

type Clip = NonNullable<EditDocumentV2["clips"]>[number];

type Props = {
  clip: Clip;
  /** The track label, so every control reads as "<track> clip". */
  label: string;
  zoom: number;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
  onGestureStart: (mode: GestureMode, clientX: number) => void;
  onNudge: (frames: number) => void;
};

const handle =
  "absolute top-0 h-full w-2 cursor-ew-resize bg-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

export function TimelineClip({
  clip,
  label,
  zoom,
  selected,
  locked,
  onSelect,
  onGestureStart,
  onNudge,
}: Props) {
  const name = `${label} clip`;
  const start = (mode: GestureMode) => (event: PointerEvent) => {
    if (event.button !== 0) return;
    onSelect();
    onGestureStart(mode, event.clientX);
  };

  return (
    <div
      className="absolute top-1 h-10"
      style={{
        left: `${framesToPixels(clip.from_frame, zoom)}px`,
        width: `${Math.max(8, framesToPixels(clip.duration_in_frames, zoom))}px`,
      }}
    >
      <button
        type="button"
        id={`timeline-clip-${clip.clip_id}`}
        aria-label={name}
        aria-pressed={selected}
        className={`h-full w-full truncate rounded border px-3 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          selected
            ? "border-primary bg-primary/20 text-foreground"
            : "border-border bg-background/60 text-muted-foreground hover:bg-accent"
        }`}
        onClick={onSelect}
        onPointerDown={start("move")}
        onKeyDown={(event) => {
          const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!step || locked) return;
          event.preventDefault();
          onNudge(step);
        }}
      >
        {clip.kind}
        {locked ? " · locked" : ""}
      </button>
      <button
        type="button"
        aria-label={`Trim start of ${name}`}
        disabled={locked}
        className={`${handle} left-0 rounded-l`}
        onPointerDown={start("trim_start")}
      />
      <button
        type="button"
        aria-label={`Trim end of ${name}`}
        disabled={locked}
        className={`${handle} right-0 rounded-r`}
        onPointerDown={start("trim_end")}
      />
    </div>
  );
}
