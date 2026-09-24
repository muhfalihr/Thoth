import { useId, useState } from "react";

import type { EditDocumentOperation, EditDocumentV2, EditorAsset } from "@/api/control-plane";
import { applyTimelineOperation, compatibleTrackIds } from "./timeline_domain";

type SceneAudioInspectorProps = {
  document: EditDocumentV2;
  selectedSceneId: string;
  /** The project's ready assets; only audio is offered. */
  assets: EditorAsset[];
  /** The asset list could not be fetched, which is not the same as an empty project. */
  loadFailed?: boolean;
  onOperation: (operation: EditDocumentOperation) => void;
  disabled: boolean;
};

const fieldClass =
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const operationId = () => `op_${crypto.randomUUID()}`;

/**
 * Audio for the selected scene: volume and lane mute for what already plays
 * under it, and a ready audio asset attached to the scene on a chosen lane.
 */
export function SceneAudioInspector({
  document,
  selectedSceneId,
  assets,
  loadFailed = false,
  onOperation,
  disabled,
}: SceneAudioInspectorProps) {
  const id = useId();
  const [refusal, setRefusal] = useState<string>();
  const [assetId, setAssetId] = useState<string>();
  const [trackId, setTrackId] = useState<string>();
  const fps = document.canvas.fps;
  const seconds = (from: number, duration: number) =>
    `${(from / fps).toFixed(1)}s–${((from + duration) / fps).toFixed(1)}s`;
  const scene = document.scenes.find((entry) => entry.scene_id === selectedSceneId);
  const audio = scene
    ? (document.clips ?? []).flatMap((clip) =>
        clip.kind === "audio" &&
        clip.from_frame < scene.start_frame + scene.duration_in_frames &&
        scene.start_frame < clip.from_frame + clip.duration_in_frames
          ? [clip]
          : [],
      )
    : [];
  const ready = assets.filter((asset) => asset.kind === "audio" && asset.validation_state === "ready");
  const lanes = compatibleTrackIds(document, "audio");
  const asset = ready.find((entry) => entry.asset_id === assetId) ?? ready[0];
  const lane = trackId && lanes.includes(trackId) ? trackId : lanes[0];
  const label = (laneId: string) => document.tracks.find((track) => track.track_id === laneId)?.label ?? laneId;

  // A refused operation would be dropped silently by the draft, so say why here instead.
  const emit = (operation: EditDocumentOperation, resolved: Record<string, EditorAsset> = {}) => {
    try {
      applyTimelineOperation(document, operation, resolved);
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
      return;
    }
    setRefusal(undefined);
    onOperation(operation);
  };

  return (
    <section aria-label="Audio" className="border-l border-t border-border bg-card/60 p-4">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Audio</h2>
      {refusal ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
      {audio.length ? (
        audio.map((clip) => {
          const track = document.tracks.find((entry) => entry.track_id === clip.track_id);
          const locked = Boolean(clip.locked || track?.locked);
          return (
            <fieldset key={clip.clip_id} className="mt-4 space-y-2 text-sm">
              <legend className="font-medium">
                {`${track?.label ?? "Audio"} ${seconds(clip.from_frame, clip.duration_in_frames)}`}
              </legend>
              {locked ? (
                <p className="text-xs text-muted-foreground">
                  This audio is locked. Unlock it on a desktop timeline to edit.
                </p>
              ) : null}
              <p className="truncate text-xs text-muted-foreground">{clip.asset_id}</p>
              <label htmlFor={`${id}-${clip.clip_id}`} className="block text-xs text-muted-foreground">
                Volume
              </label>
              <input
                id={`${id}-${clip.clip_id}`}
                type="range"
                className="w-full"
                min={0}
                max={1}
                step={0.1}
                value={clip.volume ?? 1}
                disabled={disabled || locked}
                onChange={(event) =>
                  emit({
                    kind: "set_clip_volume",
                    operation_id: operationId(),
                    clip_id: clip.clip_id,
                    volume: Number(event.target.value),
                  })
                }
              />
              {track ? (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={track.muted === true}
                    disabled={disabled || track.locked === true}
                    onChange={(event) =>
                      emit({
                        kind: "set_track_muted",
                        operation_id: operationId(),
                        track_id: track.track_id,
                        muted: event.target.checked,
                      })
                    }
                  />
                  {`Mute ${track.label} lane`}
                </label>
              ) : null}
            </fieldset>
          );
        })
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No audio in this scene.</p>
      )}
      {!scene ? null : loadFailed && !asset ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Project audio could not be loaded. Reopen Studio to try again.
        </p>
      ) : !asset ? (
        <p className="mt-3 text-xs text-muted-foreground">No ready audio in this project yet.</p>
      ) : !lane ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No unlocked audio lane. Unlock one on a desktop timeline to add audio.
        </p>
      ) : (
        <div className="mt-4 space-y-2 text-sm">
          <label htmlFor={`${id}-asset`} className="block text-xs text-muted-foreground">
            Audio asset
          </label>
          <select
            id={`${id}-asset`}
            className={fieldClass}
            value={asset.asset_id}
            disabled={disabled}
            onChange={(event) => setAssetId(event.target.value)}
          >
            {ready.map((entry) => (
              <option key={entry.asset_id} value={entry.asset_id}>
                {entry.duration_in_frames
                  ? `${entry.asset_id} · ${(entry.duration_in_frames / fps).toFixed(1)}s`
                  : entry.asset_id}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-lane`} className="block text-xs text-muted-foreground">
            Audio lane
          </label>
          <select
            id={`${id}-lane`}
            className={fieldClass}
            value={lane}
            disabled={disabled}
            onChange={(event) => setTrackId(event.target.value)}
          >
            {lanes.map((laneId) => (
              <option key={laneId} value={laneId}>
                {label(laneId)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={disabled}
            onClick={() =>
              emit(
                {
                  kind: "add_clip_from_asset",
                  operation_id: operationId(),
                  clip_id: `clip_${crypto.randomUUID()}`,
                  track_id: lane,
                  asset_id: asset.asset_id,
                  scene_id: scene.scene_id,
                  from_frame: scene.start_frame,
                  // Audio longer than the scene is cut at the scene's end.
                  duration_in_frames: Math.min(
                    asset.duration_in_frames ?? scene.duration_in_frames,
                    scene.duration_in_frames,
                  ),
                  source_from_frame: 0,
                },
                { [asset.asset_id]: asset },
              )
            }
          >
            Add audio to scene
          </button>
        </div>
      )}
    </section>
  );
}
