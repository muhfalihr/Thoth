import { useState } from "react";
import { RunForm } from "@/components/RunForm";
import { JobList } from "@/components/JobList";
import { JobMonitor } from "@/components/JobMonitor";
import { ProfileStudio } from "@/components/ProfileStudio";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { Discovery } from "@/components/Discovery";
import { ContentSet } from "@/components/ContentSet";
import { Button } from "@/components/ui/button";

/** Cockpit shell with a Runs/Profiles/Discovery/Content Set view toggle,
 *  scoped to the active project chosen in the ProjectSwitcher. */
export default function App() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [view, setView] = useState<"runs" | "profiles" | "discovery" | "contentset">("runs");
  // Sub-project D: one-shot content-set path handed from the Content-Set view to
  // RunForm (cleared by RunForm.onConsumed once consumed on mount).
  const [pendingContentSet, setPendingContentSet] = useState<string | null>(null);
  const handleSendToRender = (path: string) => {
    setPendingContentSet(path);
    setView("runs");
  };

  const needsProject = (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      Select or create a project to begin.
    </div>
  );

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-1">
        <Button size="sm" variant={view === "runs" ? "default" : "ghost"}
          onClick={() => setView("runs")}>Runs</Button>
        <Button size="sm" variant={view === "profiles" ? "default" : "ghost"}
          onClick={() => setView("profiles")}>Profiles</Button>
        <Button size="sm" variant={view === "discovery" ? "default" : "ghost"}
          onClick={() => setView("discovery")}>Discovery</Button>
        <Button size="sm" variant={view === "contentset" ? "default" : "ghost"}
          onClick={() => setView("contentset")}>Content Set</Button>
        <div className="ml-auto">
          <ProjectSwitcher projectId={projectId} onSelect={setProjectId} />
        </div>
      </div>
      {view === "profiles" ? (
        projectId
          ? <ProfileStudio projectId={projectId} onProfileChanged={() => {}} />
          : needsProject
      ) : view === "discovery" ? (
        <Discovery />
      ) : view === "contentset" ? (
        <ContentSet onSendToRender={handleSendToRender} />
      ) : projectId ? (
        <>
          <RunForm
            projectId={projectId}
            onCreated={setSelectedJobId}
            initialContentSet={pendingContentSet ?? undefined}
            onConsumed={() => setPendingContentSet(null)}
          />
          <div className="flex min-h-0 flex-1 gap-3 p-3">
            <div className="w-72 shrink-0">
              <JobList selectedId={selectedJobId} onSelect={setSelectedJobId} />
            </div>
            <div className="min-h-0 min-w-0 flex-1">
              <JobMonitor jobId={selectedJobId} />
            </div>
          </div>
        </>
      ) : (
        needsProject
      )}
    </div>
  );
}
