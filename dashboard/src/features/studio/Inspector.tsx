import { useId } from "react";

import type { EditDocument } from "@/api/control-plane";

type Scene = EditDocument["scenes"][number];
type TextClip = EditDocument["clips"][number];
type Ownership = TextClip["ownership"];

type Props = {
  scene?: Scene;
  clip?: TextClip;
  onTextChange: (clipId: string, field: "heading" | "body", value: string) => void;
  onOwnershipChange: (clipId: string, ownership: Ownership) => void;
  onDurationChange: (sceneId: string, durationInFrames: number) => void;
};

const fieldClass =
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function Inspector({ scene, clip, onTextChange, onOwnershipChange, onDurationChange }: Props) {
  const headingId = useId();
  const headingErrorId = useId();
  const bodyId = useId();
  const ownershipId = useId();
  const durationId = useId();
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
              onChange={(event) => onTextChange(clip.clip_id, "body", event.target.value)}
            />
          </div>
          <div>
            <label htmlFor={ownershipId} className="text-sm font-medium">Ownership</label>
            <select
              id={ownershipId}
              className={fieldClass}
              value={clip.ownership}
              onChange={(event) => onOwnershipChange(clip.clip_id, event.target.value as Ownership)}
            >
              <option value="ai_managed">AI managed</option>
              <option value="user_edited">User edited</option>
              <option value="locked">Locked</option>
            </select>
          </div>
          <div>
            <label htmlFor={durationId} className="text-sm font-medium">Duration (frames)</label>
            <input
              id={durationId}
              type="number"
              min={1}
              step={1}
              className={fieldClass}
              value={scene.duration_in_frames}
              onChange={(event) => {
                const value = event.target.valueAsNumber;
                if (Number.isInteger(value) && value > 0) onDurationChange(scene.scene_id, value);
              }}
            />
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Select a scene to edit.</p>
      )}
    </aside>
  );
}
