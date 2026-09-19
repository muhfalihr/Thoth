import { useId } from "react";

import type { EditDocumentOperation, EditDocumentV2 } from "@/api/control-plane";

type Props = {
  document: EditDocumentV2;
  selectedClipId: string;
  selectedTrackId: string;
  onOperation: (operation: EditDocumentOperation) => void;
};

const field = "flex items-center justify-between gap-2 text-xs text-muted-foreground";
const input =
  "w-24 rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

const newId = () => `op_${crypto.randomUUID()}`;

/** Shown wherever a persisted optional field carries no value. */
const NOT_SET = "—";

/** Omit distributed over the operation union, so each member keeps its own fields. */
type OperationDraft = EditDocumentOperation extends infer T
  ? T extends EditDocumentOperation
    ? Omit<T, "operation_id">
    : never
  : never;

export function TimelineInspector({
  document,
  selectedClipId,
  selectedTrackId,
  onOperation,
}: Props) {
  const ids = {
    start: useId(),
    end: useId(),
    volume: useId(),
    hidden: useId(),
    muted: useId(),
    locked: useId(),
    ownership: useId(),
    fit: useId(),
    crop: useId(),
    position: useId(),
    fadeIn: useId(),
    fadeOut: useId(),
    overlayPreset: useId(),
    overlayText: useId(),
    overlayAccent: useId(),
    captionStyle: useId(),
    captionCues: useId(),
  };
  const clip = document.clips?.find((candidate) => candidate.clip_id === selectedClipId);
  const track = document.tracks.find(
    (candidate) => candidate.track_id === (clip?.track_id ?? selectedTrackId),
  );
  /** A persisted field D1 stores but has no operation to change. */
  const readOnlyField = (id: string, label: string, value: string) => (
    <div className={field} key={id}>
      <label htmlFor={id}>{label}</label>
      <input id={id} className={input} value={value} readOnly disabled />
    </div>
  );

  // Every control emits the same typed operation the timeline gestures emit.
  const emit = (operation: OperationDraft) =>
    onOperation({ ...operation, operation_id: newId() } as EditDocumentOperation);

  return (
    <aside className="min-h-0 overflow-auto border-l border-border bg-card/60 p-3" aria-label="Timeline inspector">
      <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Inspector
      </h2>

      {clip ? (
        <div className="space-y-2">
          <p className="text-xs text-foreground">{clip.kind} clip</p>
          <div className={field}>
            <label htmlFor={ids.start}>Start frame</label>
            <input
              id={ids.start}
              type="number"
              className={input}
              min={0}
              value={clip.from_frame}
              disabled={clip.locked === true || track?.locked === true}
              onChange={(event) =>
                emit({
                  kind: "trim_clip_start",
                  clip_id: clip.clip_id,
                  from_frame: Number(event.target.value),
                })
              }
            />
          </div>
          <div className={field}>
            <label htmlFor={ids.end}>End frame</label>
            <input
              id={ids.end}
              type="number"
              className={input}
              min={1}
              value={clip.from_frame + clip.duration_in_frames}
              disabled={clip.locked === true || track?.locked === true}
              onChange={(event) =>
                emit({
                  kind: "trim_clip_end",
                  clip_id: clip.clip_id,
                  end_frame: Number(event.target.value),
                })
              }
            />
          </div>
          {clip.kind === "audio" ? (
            <div className={field}>
              <label htmlFor={ids.volume}>Volume</label>
              <input
                id={ids.volume}
                type="range"
                className={input}
                min={0}
                max={1}
                step={0.1}
                value={clip.volume ?? 1}
                disabled={clip.locked === true || track?.locked === true}
                onChange={(event) =>
                  emit({
                    kind: "set_clip_volume",
                    clip_id: clip.clip_id,
                    volume: Number(event.target.value),
                  })
                }
              />
            </div>
          ) : null}
          <div className={field}>
            <label htmlFor={ids.hidden}>Hidden</label>
            <input
              id={ids.hidden}
              type="checkbox"
              checked={clip.hidden === true}
              disabled={clip.locked === true || track?.locked === true}
              onChange={(event) =>
                emit({
                  kind: "set_clip_hidden",
                  clip_id: clip.clip_id,
                  hidden: event.target.checked,
                })
              }
            />
          </div>
          <div className={field}>
            <label htmlFor={ids.locked}>Locked</label>
            <input
              id={ids.locked}
              type="checkbox"
              checked={clip.locked === true}
              onChange={(event) =>
                emit({
                  kind: "set_clip_locked",
                  clip_id: clip.clip_id,
                  locked: event.target.checked,
                })
              }
            />
          </div>
          <div className={field}>
            <label htmlFor={ids.ownership}>Ownership</label>
            <select
              id={ids.ownership}
              className={input}
              value={clip.ownership}
              disabled={clip.locked === true || track?.locked === true}
              onChange={(event) =>
                emit({
                  kind: "set_ownership",
                  clip_id: clip.clip_id,
                  ownership: event.target.value as "ai_managed" | "user_edited" | "locked",
                })
              }
            >
              <option value="ai_managed">AI managed</option>
              <option value="user_edited">User edited</option>
              <option value="locked">Locked</option>
            </select>
          </div>
          {clip.kind === "video" ? (
            <>
              {readOnlyField(ids.fit, "Fit", clip.fit)}
              {readOnlyField(
                ids.crop,
                "Crop",
                clip.crop
                  ? [clip.crop.left, clip.crop.top, clip.crop.width, clip.crop.height].join(", ")
                  : NOT_SET,
              )}
              {readOnlyField(
                ids.position,
                "Position",
                clip.position
                  ? `${clip.position.x}, ${clip.position.y} ×${clip.position.scale}`
                  : NOT_SET,
              )}
            </>
          ) : null}
          {clip.kind === "audio" ? (
            <>
              {readOnlyField(ids.fadeIn, "Fade in (frames)", String(clip.fade_in_frames ?? 0))}
              {readOnlyField(ids.fadeOut, "Fade out (frames)", String(clip.fade_out_frames ?? 0))}
            </>
          ) : null}
          {clip.kind === "overlay" ? (
            <>
              {readOnlyField(ids.overlayPreset, "Overlay preset", clip.preset_id)}
              {readOnlyField(ids.overlayText, "Overlay text", clip.parameters?.text ?? NOT_SET)}
              {readOnlyField(
                ids.overlayAccent,
                "Overlay accent",
                clip.parameters?.accent_slot ?? NOT_SET,
              )}
            </>
          ) : null}
          {clip.kind === "caption" ? (
            <>
              {readOnlyField(ids.captionStyle, "Caption style", clip.style_slot)}
              {readOnlyField(
                ids.captionCues,
                "Caption cues",
                clip.cues.length
                  ? clip.cues
                      .map(
                        (cue) =>
                          `${cue.from_frame}–${cue.from_frame + cue.duration_in_frames} ${cue.text}`,
                      )
                      .join(" · ")
                  : NOT_SET,
              )}
            </>
          ) : null}
        </div>
      ) : track ? (
        <div className="space-y-2">
          <p className="text-xs text-foreground">{track.label}</p>
          <div className={field}>
            <label htmlFor={ids.hidden}>Hidden</label>
            <input
              id={ids.hidden}
              type="checkbox"
              checked={track.hidden === true}
              disabled={track.locked === true}
              onChange={(event) =>
                emit({
                  kind: "set_track_visibility",
                  track_id: track.track_id,
                  hidden: event.target.checked,
                })
              }
            />
          </div>
          <div className={field}>
            <label htmlFor={ids.muted}>Muted</label>
            <input
              id={ids.muted}
              type="checkbox"
              checked={track.muted === true}
              disabled={track.locked === true}
              onChange={(event) =>
                emit({
                  kind: "set_track_muted",
                  track_id: track.track_id,
                  muted: event.target.checked,
                })
              }
            />
          </div>
          <div className={field}>
            <label htmlFor={ids.locked}>Locked</label>
            <input
              id={ids.locked}
              type="checkbox"
              checked={track.locked === true}
              onChange={(event) =>
                emit({
                  kind: "set_track_locked",
                  track_id: track.track_id,
                  locked: event.target.checked,
                })
              }
            />
          </div>
          {track.clip_ids?.length === 0 && track.locked !== true ? (
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => emit({ kind: "remove_empty_track", track_id: track.track_id })}
            >
              Remove empty track
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Select a clip or track to edit it</p>
      )}
    </aside>
  );
}
