import { useId } from "react";

import { MAX_ZOOM, MIN_ZOOM } from "./timeline_domain";

export type ClipAction = "move" | "trim_start" | "trim_end" | "split";

type Props = {
  zoom: number;
  snapping: boolean;
  ripple: boolean;
  /** Undefined when nothing is selected, true when the selection cannot move. */
  selectionLocked?: boolean;
  onZoom: (zoom: number) => void;
  onSnapping: (snapping: boolean) => void;
  onRipple: (ripple: boolean) => void;
  onClipAction: (action: ClipAction) => void;
};

const button =
  "rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

const CLIP_ACTIONS: [ClipAction, string][] = [
  ["move", "Move clip to playhead"],
  ["trim_start", "Trim start to playhead"],
  ["trim_end", "Trim end to playhead"],
  ["split", "Split clip at playhead"],
];

export function TimelineToolbar({
  zoom,
  snapping,
  ripple,
  selectionLocked,
  onZoom,
  onSnapping,
  onRipple,
  onClipAction,
}: Props) {
  const snappingId = useId();
  const rippleId = useId();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
      <button
        type="button"
        className={button}
        disabled={zoom <= MIN_ZOOM}
        onClick={() => onZoom(zoom / 2)}
      >
        Zoom out
      </button>
      <button
        type="button"
        className={button}
        disabled={zoom >= MAX_ZOOM}
        onClick={() => onZoom(zoom * 2)}
      >
        Zoom in
      </button>

      <label className="flex items-center gap-1 text-xs text-muted-foreground" htmlFor={snappingId}>
        <input
          id={snappingId}
          type="checkbox"
          checked={snapping}
          onChange={(event) => onSnapping(event.target.checked)}
          className="accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        Snapping
      </label>
      <label className="flex items-center gap-1 text-xs text-muted-foreground" htmlFor={rippleId}>
        <input
          id={rippleId}
          type="checkbox"
          checked={ripple}
          onChange={(event) => onRipple(event.target.checked)}
          className="accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        Ripple
      </label>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      {/* The same operations the pointer gestures emit, for keyboard and screen readers. */}
      {CLIP_ACTIONS.map(([action, label]) => (
        <button
          key={action}
          type="button"
          className={button}
          disabled={selectionLocked !== false}
          onClick={() => onClipAction(action)}
        >
          {label}
        </button>
      ))}
      {selectionLocked ? (
        <p className="text-xs text-muted-foreground">Locked — unlock the clip to edit it</p>
      ) : null}
    </div>
  );
}
