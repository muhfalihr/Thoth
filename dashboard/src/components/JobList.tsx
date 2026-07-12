import { useEffect, useState } from "react";
import { listJobs, type JobRecord } from "@/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;

/** Polls the job list and lets the operator pick which one JobMonitor watches. */
export function JobList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<JobRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      listJobs().then((js) => {
        if (!cancelled) setJobs(js.sort((a, b) => b.created_at.localeCompare(a.created_at)));
      });
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <Card className="flex h-full flex-col gap-0 py-3">
      <CardHeader className="px-3">
        <CardTitle className="font-mono text-xs tracking-wide text-muted-foreground">
          Jobs
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-0">
        <ScrollArea className="h-full px-3">
          {jobs.length === 0 && (
            <p className="px-1 py-4 text-sm text-muted-foreground">No jobs yet.</p>
          )}
          <ul className="flex flex-col gap-1.5 pb-2">
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => onSelect(job.id)}
                  className={cn(
                    "w-full rounded-md border-l-2 bg-secondary/40 px-2.5 py-2 text-left transition-colors hover:bg-secondary",
                    job.id === selectedId
                      ? "border-l-spine bg-secondary"
                      : "border-l-transparent"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-foreground">
                      {job.spec.command} · {job.id.slice(0, 8)}
                    </span>
                    <StatusBadge status={job.status} />
                  </div>
                  <Progress value={job.pct * 100} className="mt-1.5 h-1" />
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
