import { useEffect, useState } from "react";
import { createProject, listProjects, type ProjectRecord } from "@/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const fieldClass =
  "h-8 min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/** Selects the active project for the whole cockpit and creates new ones.
 *  Lifts selection to App so RunForm and ProfileStudio stay project-scoped. */
export function ProjectSwitcher({
  projectId,
  onSelect,
}: {
  projectId: string | null;
  onSelect: (id: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);

  useEffect(() => {
    listProjects().then((ps) => {
      setProjects(ps);
      if (ps.length && !projectId) onSelect(ps[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function newProject() {
    const name = window.prompt("New project name")?.trim();
    if (!name) return;
    try {
      const p = await createProject(name);
      setProjects((cur) => [...cur, p]);
      onSelect(p.id);
    } catch (err) {
      // Most commonly a 409 duplicate name — surface it instead of an
      // unhandled rejection that leaves the user with no feedback.
      window.alert(err instanceof Error ? err.message : "could not create project");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="project" className="text-xs text-muted-foreground">Project</Label>
      <select id="project" className={`${fieldClass} w-44`}
        value={projectId ?? ""} onChange={(e) => onSelect(e.target.value)}>
        {projects.length === 0 && <option value="">No projects</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Button size="sm" variant="secondary" onClick={newProject}>New project</Button>
    </div>
  );
}
