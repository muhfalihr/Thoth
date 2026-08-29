import { useState } from "react";
import { RunForm } from "@/components/RunForm";
import { JobList } from "@/components/JobList";
import { JobMonitor } from "@/components/JobMonitor";
import { ProfileStudio } from "@/components/ProfileStudio";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { Discovery } from "@/components/Discovery";
import { ContentSet } from "@/components/ContentSet";
import { WorkflowMonitor } from "@/components/WorkflowMonitor";
import { WorkflowWizard } from "@/components/WorkflowWizard";
import { controlPlaneClient } from "@/api/control-plane";
import { Button } from "@/components/ui/button";

/** Cockpit shell with a Runs/Profiles/Discovery/Content Set view toggle,
 *  scoped to the active project chosen in the ProjectSwitcher. */
export default function App() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [view, setView] = useState<"workflows" | "runs" | "profiles" | "discovery" | "contentset">("workflows");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  // Sub-project D: one-shot content-set path handed from the Content-Set view to
  // RunForm (cleared by RunForm.onConsumed once consumed on mount).
  const [pendingContentSet, setPendingContentSet] = useState<{
    path: string;
    forced: boolean;
  } | null>(null);
  const handleSendToRender = (path: string, forced: boolean) => {
    setPendingContentSet({ path, forced });
    setView("runs");
  };

  const needsProject = (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-sm text-muted-foreground">
      <p>Select or create a project to begin.</p>
      <p className="text-xs">Use “New project” at the top right.</p>
    </div>
  );

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-1.5">
        <span className="font-mono text-lg leading-none text-primary" aria-hidden>🪶</span>
        <span className="font-mono text-sm font-semibold tracking-wide text-foreground">Thoth</span>
        <div className="ml-3 flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          {([
            ["workflows", "Workflows"],
            ["runs", "Legacy console"],
            ["profiles", "Profiles"],
            ["discovery", "Discovery"],
            ["contentset", "Content Set"],
          ] as const).map(([id, label]) => (
            <Button key={id} size="sm" variant={view === id ? "secondary" : "ghost"}
              onClick={() => setView(id)}>
              {label}
            </Button>
          ))}
        </div>
        <div className="ml-auto border-l border-border pl-3">
          <ProjectSwitcher projectId={projectId} onSelect={setProjectId} />
        </div>
      </div>
      {view === "workflows" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <WorkflowWizard client={controlPlaneClient} onStarted={setWorkflowId} />
          <WorkflowMonitor workflowId={workflowId} client={controlPlaneClient} />
        </div>
      ) : view === "profiles" ? (
        projectId ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
            <ProfileStudio projectId={projectId} onProfileChanged={() => {}} />
          </div>
        ) : (
          needsProject
        )
      ) : view === "discovery" ? (
        <Discovery />
      ) : view === "contentset" ? (
        <ContentSet onSendToRender={handleSendToRender} />
      ) : projectId ? (
        <>
          <RunForm
            projectId={projectId}
            onCreated={setSelectedJobId}
            initialContentSet={pendingContentSet?.path}
            initialContentSetForced={pendingContentSet?.forced}
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
