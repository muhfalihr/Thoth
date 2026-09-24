import { useId, useState } from "react";

import type { EditDocumentOperation, EditDocumentV2 } from "@/api/control-plane";
import { applyTimelineOperation, CAPTION_STYLE_LABELS, compatibleTrackIds } from "./timeline_domain";

type CaptionTextInspectorProps = {
  document: EditDocumentV2;
  selectedSceneId: string;
  onOperation: (operation: EditDocumentOperation) => void;
  disabled: boolean;
};

type CaptionStyle = keyof typeof CAPTION_STYLE_LABELS;
type CaptionClip = Extract<NonNullable<EditDocumentV2["clips"]>[number], { kind: "caption" }>;

const fieldClass =
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:opacity-70";

const operationId = () => `op_${crypto.randomUUID()}`;

/**
 * Captions for the selected scene: cue text, cue timing, and style, plus a first
 * caption when the scene has none. Each edit is one operation on the shared
 * draft, checked against the same rules the server applies before it is sent.
 */
export function CaptionTextInspector({ document, selectedSceneId, onOperation, disabled }: CaptionTextInspectorProps) {
  const lockedId = useId();
  const styleId = useId();
  const newCaptionId = useId();
  const [refusal, setRefusal] = useState<string>();
  const [newCaption, setNewCaption] = useState("");
  const fps = document.canvas.fps;
  const toSeconds = (frame: number) => String(Number((frame / fps).toFixed(2)));
  const seconds = (from: number, duration: number) =>
    `${(from / fps).toFixed(1)}s–${((from + duration) / fps).toFixed(1)}s`;
  const scene = document.scenes.find((entry) => entry.scene_id === selectedSceneId);
  const captions = scene
    ? (document.clips ?? []).flatMap((clip) =>
        clip.kind === "caption" &&
        clip.from_frame < scene.start_frame + scene.duration_in_frames &&
        scene.start_frame < clip.from_frame + clip.duration_in_frames
          ? [clip]
          : [],
      )
    : [];
  const [captionTrackId] = compatibleTrackIds(document, "caption");

  // A refused operation would be dropped silently by the draft, so say why here instead.
  const emit = (operation: EditDocumentOperation) => {
    try {
      applyTimelineOperation(document, operation, {});
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
      return;
    }
    setRefusal(undefined);
    onOperation(operation);
  };

  const commitTiming = (clip: CaptionClip, index: number, edge: "start" | "end", raw: string) => {
    const cue = clip.cues[index]!;
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value)) return setRefusal("Enter a time in seconds.");
    const frame = Math.round(value * fps) - clip.from_frame;
    const start = edge === "start" ? frame : cue.from_frame;
    const end = edge === "end" ? frame : cue.from_frame + cue.duration_in_frames;
    if (start === cue.from_frame && end === cue.from_frame + cue.duration_in_frames) return;
    if (start < 0) return setRefusal("caption cues must stay inside their clip");
    if (end <= start) return setRefusal("A cue must end after it starts.");
    emit({
      kind: "set_caption_cue_timing",
      operation_id: operationId(),
      clip_id: clip.clip_id,
      cue_index: index,
      from_frame: start,
      duration_in_frames: end - start,
    });
  };

  return (
    <section aria-label="Captions" className="border-l border-t border-border bg-card/60 p-4">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Captions</h2>
      {refusal ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
      {captions.length ? (
        captions.map((clip) => {
          const track = document.tracks.find((entry) => entry.track_id === clip.track_id);
          const locked = Boolean(clip.locked || track?.locked);
          const style = clip.style_slot ?? "caption_default";
          return (
            <fieldset key={clip.clip_id} className="mt-4 space-y-3">
              <legend className="text-sm font-medium">
                {`${track?.label ?? "Captions"} ${seconds(clip.from_frame, clip.duration_in_frames)}`}
              </legend>
              {locked ? (
                <p id={`${lockedId}-${clip.clip_id}`} className="text-xs text-muted-foreground">
                  This caption is locked. Unlock it on a desktop timeline to edit.
                </p>
              ) : null}
              <div className="text-sm">
                <label htmlFor={`${styleId}-${clip.clip_id}`} className="text-xs text-muted-foreground">
                  Caption style
                </label>
                <select
                  id={`${styleId}-${clip.clip_id}`}
                  className={fieldClass}
                  value={style}
                  disabled={disabled || locked}
                  onChange={(event) =>
                    emit({
                      kind: "set_caption_style",
                      operation_id: operationId(),
                      clip_id: clip.clip_id,
                      style_slot: event.target.value as CaptionStyle,
                    })
                  }
                >
                  {Object.entries(CAPTION_STYLE_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                  {style in CAPTION_STYLE_LABELS ? null : (
                    <option value={style} disabled>
                      {`${style} (not available)`}
                    </option>
                  )}
                </select>
              </div>
              {clip.cues.map((cue, index) => {
                const bounds = [
                  ["start", clip.from_frame + cue.from_frame],
                  ["end", clip.from_frame + cue.from_frame + cue.duration_in_frames],
                ] as const;
                return (
                  <div key={index} className="text-sm">
                    <p className="text-xs text-muted-foreground">
                      {`Cue ${index + 1} `}
                      <span className="font-mono">
                        {seconds(clip.from_frame + cue.from_frame, cue.duration_in_frames)}
                      </span>
                    </p>
                    <textarea
                      aria-label={`Caption cue ${index + 1} text`}
                      className={`${fieldClass} min-h-16 resize-y`}
                      value={cue.text}
                      maxLength={300}
                      readOnly={locked}
                      disabled={disabled}
                      aria-describedby={locked ? `${lockedId}-${clip.clip_id}` : undefined}
                      onChange={(event) => {
                        // The server refuses blank cue text, so a blank field is never sent.
                        if (locked || !event.target.value.trim()) return;
                        onOperation({
                          kind: "set_caption_cue_text",
                          operation_id: operationId(),
                          clip_id: clip.clip_id,
                          cue_index: index,
                          text: event.target.value,
                        });
                      }}
                    />
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {bounds.map(([edge, frame]) => (
                        <input
                          // Remount when the saved frame moves, so the field shows the draft again.
                          key={`${edge}-${frame}`}
                          type="number"
                          step="0.1"
                          min={0}
                          aria-label={`Caption cue ${index + 1} ${edge} (seconds)`}
                          className={fieldClass}
                          defaultValue={toSeconds(frame)}
                          readOnly={locked}
                          disabled={disabled}
                          onBlur={(event) => {
                            if (!locked) commitTiming(clip, index, edge, event.currentTarget.value);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !locked) {
                              commitTiming(clip, index, edge, event.currentTarget.value);
                            }
                          }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </fieldset>
          );
        })
      ) : (
        <>
          <p className="mt-4 text-sm text-muted-foreground">No captions in this scene.</p>
          {!scene ? null : captionTrackId ? (
            <div className="mt-3 text-sm">
              <label htmlFor={newCaptionId} className="text-xs text-muted-foreground">
                New caption
              </label>
              <textarea
                id={newCaptionId}
                className={`${fieldClass} min-h-16 resize-y`}
                value={newCaption}
                maxLength={300}
                disabled={disabled}
                onChange={(event) => setNewCaption(event.target.value)}
              />
              <button
                type="button"
                className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                disabled={disabled || !newCaption.trim()}
                onClick={() => {
                  emit({
                    kind: "add_caption_clip",
                    operation_id: operationId(),
                    clip_id: `clip_${crypto.randomUUID()}`,
                    track_id: captionTrackId,
                    scene_id: scene.scene_id,
                    text: newCaption,
                  });
                  setNewCaption("");
                }}
              >
                Add caption
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {document.tracks.some((track) => track.kind === "caption")
                ? "The caption lane is locked. Unlock it on a desktop timeline to add a caption."
                : "This draft has no caption lane."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
