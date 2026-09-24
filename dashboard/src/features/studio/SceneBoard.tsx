import { formatSceneSeconds } from "./studio_time";

/** The smallest scene strip shape both document versions share. */
type SceneBoardDocument = {
  canvas: { fps: number };
  scenes: { scene_id: string; role: string; duration_in_frames: number; clip_ids: string[] }[];
  clips?: { clip_id: string; ownership?: string; heading?: string }[];
};

type Props = {
  document: SceneBoardDocument;
  selectedSceneId: string;
  onSelect: (sceneId: string) => void;
  /** Offered only where the document can persist a scene reorder. */
  onMove?: (sceneId: string, toIndex: number) => void;
  moveDisabled?: boolean;
};

export function SceneBoard({ document, selectedSceneId, onSelect, onMove, moveDisabled = false }: Props) {
  return (
    <aside className="min-h-0 min-w-0 overflow-auto border-t border-border bg-card/60 p-3" aria-label="Scene board">
      <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Scenes
      </h2>
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {document.scenes.map((scene, index) => {
          const clip = document.clips?.find((candidate) => candidate.clip_id === scene.clip_ids[0]);
          // The first usable heading in clip order, so a media clip first does not hide the text.
          const heading = scene.clip_ids
            .map((clipId) => document.clips?.find((candidate) => candidate.clip_id === clipId)?.heading?.trim())
            .find(Boolean);
          const selected = scene.scene_id === selectedSceneId;
          const label = heading || `Scene ${index + 1}`;
          return (
            <li key={scene.scene_id} className="w-40 shrink-0">
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(scene.scene_id)}
                className={`w-full rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <span className="block truncate text-sm font-medium text-foreground">
                  {label}
                </span>
                <span className="mt-1 flex items-center justify-between gap-2 text-xs">
                  <span className="capitalize">{scene.role}</span>
                  <span className="font-mono">{formatSceneSeconds(scene.duration_in_frames, document.canvas.fps)}s</span>
                </span>
                <span className="mt-2 block truncate text-xs">
                  {clip?.ownership === "user_edited" ? "Edited" : clip?.ownership?.replace("_", " ")}
                </span>
              </button>
              {onMove && (
                <span className="mt-1 flex gap-1">
                  {([
                    ["earlier", -1, "←"],
                    ["later", 1, "→"],
                  ] as const).map(([direction, step, arrow]) => {
                    const toIndex = index + step;
                    return (
                      <button
                        key={direction}
                        type="button"
                        aria-label={`Move ${label} ${direction}`}
                        disabled={moveDisabled || toIndex < 0 || toIndex >= document.scenes.length}
                        onClick={() => onMove(scene.scene_id, toIndex)}
                        className="min-h-8 flex-1 rounded border border-border text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                      >
                        {arrow}
                      </button>
                    );
                  })}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
