import { useId } from "react";

import type { EditDocumentOperation, EditDocumentV2 } from "@/api/control-plane";

type CaptionTextInspectorProps = {
  document: EditDocumentV2;
  selectedSceneId: string;
  onOperation: (operation: EditDocumentOperation) => void;
  disabled: boolean;
};

const fieldClass =
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:opacity-70";

/**
 * Cue text only: timing, style, and ownership stay with the desktop timeline.
 * Each edit is one `set_caption_cue_text` operation on the shared draft.
 */
export function CaptionTextInspector({ document, selectedSceneId, onOperation, disabled }: CaptionTextInspectorProps) {
  const lockedId = useId();
  const fps = document.canvas.fps;
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

  return (
    <section aria-label="Captions" className="border-l border-t border-border bg-card/60 p-4">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Captions</h2>
      {captions.length ? (
        captions.map((clip) => {
          const track = document.tracks.find((entry) => entry.track_id === clip.track_id);
          const locked = Boolean(clip.locked || track?.locked);
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
              {clip.cues.map((cue, index) => (
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
                        operation_id: `op_${crypto.randomUUID()}`,
                        clip_id: clip.clip_id,
                        cue_index: index,
                        text: event.target.value,
                      });
                    }}
                  />
                </div>
              ))}
            </fieldset>
          );
        })
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No captions in this scene.</p>
      )}
    </section>
  );
}
