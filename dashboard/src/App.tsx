import { useState } from "react";
import { RunForm } from "@/components/RunForm";
import { JobList } from "@/components/JobList";
import { JobMonitor } from "@/components/JobMonitor";

/** Cockpit shell: RunForm on top, JobList left, JobMonitor + LogPane right. */
export default function App() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <RunForm onCreated={setSelectedJobId} />
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div className="w-72 shrink-0">
          <JobList selectedId={selectedJobId} onSelect={setSelectedJobId} />
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          <JobMonitor jobId={selectedJobId} />
        </div>
      </div>
    </div>
  );
}
