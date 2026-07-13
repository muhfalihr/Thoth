import { useState } from "react";
import { RunForm } from "@/components/RunForm";
import { JobList } from "@/components/JobList";
import { JobMonitor } from "@/components/JobMonitor";
import { ConfigEditor } from "@/components/ConfigEditor";
import { Button } from "@/components/ui/button";

/** Cockpit shell with a Runs/Config view toggle. */
export default function App() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [view, setView] = useState<"runs" | "config">("runs");

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-1">
        <Button size="sm" variant={view === "runs" ? "default" : "ghost"}
          onClick={() => setView("runs")}>Runs</Button>
        <Button size="sm" variant={view === "config" ? "default" : "ghost"}
          onClick={() => setView("config")}>Config</Button>
      </div>
      {view === "config" ? (
        <ConfigEditor />
      ) : (
        <>
          <RunForm onCreated={setSelectedJobId} />
          <div className="flex min-h-0 flex-1 gap-3 p-3">
            <div className="w-72 shrink-0">
              <JobList selectedId={selectedJobId} onSelect={setSelectedJobId} />
            </div>
            <div className="min-h-0 min-w-0 flex-1">
              <JobMonitor jobId={selectedJobId} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
