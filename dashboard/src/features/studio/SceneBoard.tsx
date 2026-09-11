import type { EditDocument } from "@/api/control-plane";

type Props = {
  document: EditDocument;
  selectedSceneId: string;
  onSelect: (sceneId: string) => void;
};

export function SceneBoard({ document, selectedSceneId, onSelect }: Props) {
  return (
    <aside className="min-h-0 overflow-auto border-r border-border bg-card/60 p-3" aria-label="Scene board">
      <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Scenes
      </h2>
      <div className="space-y-2">
        {document.scenes.map((scene, index) => {
          const clip = document.clips.find((candidate) => candidate.clip_id === scene.clip_ids[0]);
          const selected = scene.scene_id === selectedSceneId;
          return (
            <button
              key={scene.scene_id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(scene.scene_id)}
              className={`w-full rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <span className="block text-sm font-medium text-foreground">Scene {index + 1}</span>
              <span className="mt-1 flex items-center justify-between gap-2 text-xs">
                <span className="capitalize">{scene.role}</span>
                <span className="font-mono">{scene.duration_in_frames}f</span>
              </span>
              <span className="mt-2 block truncate text-xs">
                {clip?.ownership === "user_edited" ? "Edited" : clip?.ownership.replace("_", " ")}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
