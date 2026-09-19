import { useEffect, useRef } from "react";

import type { EditDocumentOperation } from "@/api/control-plane";
import type { EditorAction, EditorState } from "./editor_state";
import type { GestureMode } from "./TimelineClip";
import { TimelineToolbar, type ClipAction } from "./TimelineToolbar";
import { TimelineTrack } from "./TimelineTrack";
import {
  framesToPixels,
  isTimelineDocument,
  snapCandidates,
  snapFrame,
  visibleLanes,
} from "./timeline_domain";

type Props = {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
  /** Preview transport, absent wherever the timeline renders without a player. */
  onSeek?: (frame: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
};

/** One pointer gesture in flight. Committed on pointer up, dropped on Escape. */
type Gesture = {
  clipId: string;
  trackId: string;
  mode: GestureMode;
  originX: number;
  anchor: number;
  operationId: string;
  previewed: boolean;
};

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/** Snap within a fixed screen distance, so zooming out does not widen the pull. */
const snapThreshold = (zoom: number) => Math.max(1, Math.round(8 / zoom));

export function Timeline({ state, dispatch, onSeek, onPlay, onPause }: Props) {
  const gesture = useRef<Gesture | null>(null);
  const timeline = isTimelineDocument(state.draft) ? state.draft : undefined;
  const clips = timeline?.clips ?? [];
  const selectedClip = clips.find((clip) => clip.clip_id === state.selectedClipId);
  const trackOf = (trackId: string) => timeline?.tracks.find((t) => t.track_id === trackId);
  const selectionLocked = selectedClip
    ? selectedClip.locked === true || trackOf(selectedClip.track_id)?.locked === true
    : undefined;

  // Keep the listeners' view of the editor current without re-attaching them.
  const latest = useRef({ state, dispatch, timeline });
  latest.current = { state, dispatch, timeline };

  /** Where a gesture lands, after snapping, for a pointer at `clientX`. */
  const frameAt = (active: Gesture, clientX: number) => {
    const { state: current, timeline: doc } = latest.current;
    if (!doc) return active.anchor;
    const raw = Math.max(0, active.anchor + Math.round((clientX - active.originX) / current.zoom));
    if (!current.snapping) return raw;
    const candidates = snapCandidates(doc, {
      excludeClipId: active.clipId,
      playhead: current.playheadFrame,
    });
    return snapFrame(raw, candidates, snapThreshold(current.zoom));
  };

  const operationFor = (active: Gesture, frame: number): EditDocumentOperation => {
    switch (active.mode) {
      case "trim_start":
        return {
          kind: "trim_clip_start",
          operation_id: active.operationId,
          clip_id: active.clipId,
          from_frame: frame,
        };
      case "trim_end":
        return {
          kind: "trim_clip_end",
          operation_id: active.operationId,
          clip_id: active.clipId,
          end_frame: frame,
        };
      default:
        return {
          kind: "move_clip",
          operation_id: active.operationId,
          clip_id: active.clipId,
          target_track_id: active.trackId,
          from_frame: frame,
          ripple: latest.current.state.ripple,
        };
    }
  };

  // Pointer and Escape handling lives on the window so a gesture survives the
  // pointer leaving the clip it started on.
  useEffect(() => {
    const end = () => {
      gesture.current = null;
    };
    const onMove = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active) return;
      active.previewed = true;
      latest.current.dispatch({
        type: "preview_timeline_operation",
        operation: operationFor(active, frameAt(active, event.clientX)),
      });
    };
    const onUp = (event: PointerEvent) => {
      const active = gesture.current;
      end();
      if (!active?.previewed) return;
      latest.current.dispatch({
        type: "commit_timeline_operation",
        operation: operationFor(active, frameAt(active, event.clientX)),
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const active = gesture.current;
      if (event.key !== "Escape" || !active) return;
      end();
      if (active.previewed) latest.current.dispatch({ type: "cancel_timeline_preview" });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listeners read `latest`.
  }, []);

  if (!timeline) return null;

  const duration = timeline.canvas.duration_in_frames;
  const lanes = visibleLanes(timeline);

  const startGesture = (clipId: string, mode: GestureMode, clientX: number) => {
    const clip = clips.find((candidate) => candidate.clip_id === clipId);
    if (!clip || clip.locked === true || trackOf(clip.track_id)?.locked === true) return;
    gesture.current = {
      clipId,
      trackId: clip.track_id,
      mode,
      originX: clientX,
      anchor: mode === "trim_end" ? clip.from_frame + clip.duration_in_frames : clip.from_frame,
      operationId: newId("op"),
      previewed: false,
    };
  };

  const commit = (operation: EditDocumentOperation) =>
    dispatch({ type: "commit_timeline_operation", operation });

  const clipAction = (action: ClipAction) => {
    if (!selectedClip || selectionLocked) return;
    const frame = state.playheadFrame;
    if (action === "split") {
      commit({
        kind: "split_clip",
        operation_id: newId("op"),
        clip_id: selectedClip.clip_id,
        split_frame: frame,
        left_clip_id: newId("clip"),
        right_clip_id: newId("clip"),
      });
      return;
    }
    commit(
      operationFor(
        {
          clipId: selectedClip.clip_id,
          trackId: selectedClip.track_id,
          mode: action,
          originX: 0,
          anchor: frame,
          operationId: newId("op"),
          previewed: false,
        },
        frame,
      ),
    );
  };

  return (
    <section className="flex min-h-0 flex-col" aria-label="Timeline">
      <TimelineToolbar
        zoom={state.zoom}
        snapping={state.snapping}
        ripple={state.ripple}
        selectionLocked={selectionLocked}
        onZoom={(zoom) => dispatch({ type: "set_zoom", zoom })}
        onSnapping={(snapping) => dispatch({ type: "set_snapping", snapping })}
        onRipple={(ripple) => dispatch({ type: "set_ripple", ripple })}
        onClipAction={clipAction}
      />

      <p className="px-3 py-2 text-xs text-muted-foreground lg:hidden">
        The timeline needs a wider screen. Use Guided mode on this device.
      </p>

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <input
          type="range"
          aria-label="Playhead"
          min={0}
          max={Math.max(0, duration - 1)}
          step={1}
          value={state.playheadFrame}
          onChange={(event) => {
            const frame = Number(event.target.value);
            dispatch({ type: "set_playhead", frame });
            onSeek?.(frame);
          }}
          className="h-2 w-full accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => (state.playing ? onPause?.() : onPlay?.())}
        >
          {state.playing ? "Pause preview" : "Play preview"}
        </button>
        <span className="font-mono text-xs text-muted-foreground">
          {state.playheadFrame}/{duration}f
        </span>
      </div>

      <div className="hidden min-h-0 overflow-auto lg:block">
        <div className="relative" style={{ width: `${framesToPixels(duration, state.zoom) + 192}px` }}>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-primary"
            style={{ left: `${192 + framesToPixels(state.playheadFrame, state.zoom)}px` }}
          />
          {lanes.map((lane) => (
            <TimelineTrack
              key={lane.track.track_id}
              lane={lane}
              zoom={state.zoom}
              widthInFrames={duration}
              selectedClipId={state.selectedClipId}
              onToggle={(field, value) =>
                commit(
                  field === "hidden"
                    ? {
                        kind: "set_track_visibility",
                        operation_id: newId("op"),
                        track_id: lane.track.track_id,
                        hidden: value,
                      }
                    : field === "muted"
                      ? {
                          kind: "set_track_muted",
                          operation_id: newId("op"),
                          track_id: lane.track.track_id,
                          muted: value,
                        }
                      : {
                          kind: "set_track_locked",
                          operation_id: newId("op"),
                          track_id: lane.track.track_id,
                          locked: value,
                        },
                )
              }
              onSelectClip={(clipId) => dispatch({ type: "select_clip", clipId })}
              onGestureStart={startGesture}
              onNudge={(clipId, frames) => {
                const clip = clips.find((candidate) => candidate.clip_id === clipId);
                if (!clip) return;
                commit({
                  kind: "move_clip",
                  operation_id: newId("op"),
                  clip_id: clipId,
                  target_track_id: clip.track_id,
                  from_frame: Math.max(0, clip.from_frame + frames),
                  ripple: state.ripple,
                });
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
