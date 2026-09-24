import { useId, useState } from "react";

import type { EditableTextClip } from "./editor_state";
import { formatSceneSeconds, parseSceneSeconds } from "./studio_time";

/** Only the fields the guided controls read, so both document versions fit. */
type Scene = { scene_id: string; duration_in_frames: number };
type TextClip = EditableTextClip;
type Ownership = TextClip["ownership"];

type Props = {
  scene?: Scene;
  clip?: TextClip;
  onTextChange: (clipId: string, field: "heading" | "body", value: string) => void;
  onOwnershipChange: (clipId: string, ownership: Ownership) => void;
  onDurationChange: (sceneId: string, durationInFrames: number) => void;
  /** The document's frame rate, for showing durations in seconds. */
  fps: number;
  /** True while another request owns the document, such as a running upgrade. */
  disabled?: boolean;
  /** Phone light edits: heading and body only. */
  textOnly?: boolean;
};

const fieldClass =
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function Inspector({
  scene,
  clip,
  onTextChange,
  onOwnershipChange,
  onDurationChange,
  fps,
  disabled = false,
  textOnly = false,
}: Props) {
  const headingId = useId();
  const headingErrorId = useId();
  const bodyId = useId();
  const ownershipId = useId();
  const headingInvalid = Boolean(clip && !clip.heading.trim());

  return (
    <aside className="min-h-0 overflow-auto border-l border-border bg-card/60 p-4" aria-label="Inspector">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Inspector
      </h2>
      {scene && clip ? (
        <div className="mt-4 space-y-5">
          <div>
            <label htmlFor={headingId} className="text-sm font-medium">Heading</label>
            <input
              id={headingId}
              className={fieldClass}
              value={clip.heading}
              maxLength={300}
              required
              disabled={disabled}
              aria-invalid={headingInvalid}
              aria-describedby={headingInvalid ? headingErrorId : undefined}
              onChange={(event) => onTextChange(clip.clip_id, "heading", event.target.value)}
            />
            {headingInvalid && (
              <p id={headingErrorId} role="alert" className="mt-1 text-xs text-destructive">
                Heading is required before saving.
              </p>
            )}
          </div>
          <div>
            <label htmlFor={bodyId} className="text-sm font-medium">Body</label>
            <textarea
              id={bodyId}
              className={`${fieldClass} min-h-28 resize-y`}
              value={clip.body}
              maxLength={2_000}
              disabled={disabled}
              onChange={(event) => onTextChange(clip.clip_id, "body", event.target.value)}
            />
          </div>
          {textOnly ? null : (
            <>
            <div>
              <label htmlFor={ownershipId} className="text-sm font-medium">Ownership</label>
              <select
                id={ownershipId}
                className={fieldClass}
                value={clip.ownership}
                disabled={disabled}
                onChange={(event) => onOwnershipChange(clip.clip_id, event.target.value as Ownership)}
              >
                <option value="ai_managed">AI managed</option>
                <option value="user_edited">User edited</option>
                <option value="locked">Locked</option>
              </select>
            </div>
            <DurationField
              key={scene.scene_id}
              scene={scene}
              fps={fps}
              disabled={disabled}
              onDurationChange={onDurationChange}
            />
            </>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Select a scene to edit.</p>
      )}
    </aside>
  );
}

/** Holds typed seconds until an explicit commit, so no keystroke or echo edits the document. */
function DurationField({
  scene,
  fps,
  disabled,
  onDurationChange,
}: {
  scene: Scene;
  fps: number;
  disabled: boolean;
  onDurationChange: Props["onDurationChange"];
}) {
  const inputId = useId();
  const errorId = useId();
  const [input, setInput] = useState(() => formatSceneSeconds(scene.duration_in_frames, fps));
  const [durationError, setDurationError] = useState<string | null>(null);
  // A duration changed elsewhere (undo, redo, reload) replaces what is shown.
  const [shownFrames, setShownFrames] = useState(scene.duration_in_frames);
  if (shownFrames !== scene.duration_in_frames) {
    setShownFrames(scene.duration_in_frames);
    setInput(formatSceneSeconds(scene.duration_in_frames, fps));
    setDurationError(null);
  }

  const commit = () => {
    const frames = parseSceneSeconds(input, fps);
    if (frames === null) {
      setDurationError("Enter a duration greater than zero seconds.");
    } else {
      setDurationError(null);
      if (frames !== scene.duration_in_frames) onDurationChange(scene.scene_id, frames);
    }
  };

  return (
    <div>
      <label htmlFor={inputId} className="text-sm font-medium">Duration (seconds)</label>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        className={fieldClass}
        value={input}
        disabled={disabled}
        aria-invalid={durationError !== null}
        aria-describedby={durationError ? errorId : undefined}
        onChange={(event) => setInput(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {durationError ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          {durationError}
        </p>
      ) : null}
    </div>
  );
}
