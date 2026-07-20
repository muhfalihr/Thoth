import { useEffect, useState } from "react";
import { createProject, listProjects, type ProjectRecord } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Selects the active project for the whole cockpit and creates new ones
 *  inline (no window.prompt/alert — stays inside the design system).
 *  Lifts selection to App so RunForm and ProfileStudio stay project-scoped. */
export function ProjectSwitcher({
  projectId,
  onSelect,
}: {
  projectId: string | null;
  onSelect: (id: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects().then((ps) => {
      setProjects(ps);
      if (ps.length && !projectId) onSelect(ps[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      const p = await createProject(name);
      setProjects((cur) => [...cur, p]);
      onSelect(p.id);
      setCreating(false);
      setNewName("");
      setError(null);
    } catch (err) {
      // Most commonly a 409 duplicate name — shown inline under the input.
      setError(err instanceof Error ? err.message : "could not create project");
    }
  }

  if (creating) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void confirmCreate();
        }}
      >
        <Label htmlFor="new-project" className="text-xs text-muted-foreground">
          New project name
        </Label>
        <Input
          id="new-project"
          className="w-44"
          value={newName}
          autoFocus
          onChange={(e) => setNewName(e.target.value)}
        />
        <Button size="sm" type="submit">Create</Button>
        <Button size="sm" variant="ghost" type="button"
          onClick={() => { setCreating(false); setError(null); }}>
          Cancel
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="project" className="text-xs text-muted-foreground">Project</Label>
      <Select value={projectId ?? null} onValueChange={(v) => v && onSelect(String(v))}>
        <SelectTrigger id="project" className="w-44">
          <SelectValue placeholder="No projects" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
        New project
      </Button>
    </div>
  );
}
