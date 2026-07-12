import { useEffect, useRef, useState } from "react";
import {
  cancelJob,
  fetchArtifact,
  getJob,
  streamJob,
  type JobRecord,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/StatusBadge";
import { LogPane, type LogLine } from "@/components/LogPane";

// Well-known output filenames Thoth writes under a job's output_dir. There's
// no artifact-listing endpoint yet, so this is a fixed guess list rather
// than a directory browse — a 404 on click just means that file wasn't
// produced for this run (e.g. a scout-only job has no final.mp4).
const ARTIFACTS = ["final.mp4", "moments.json", "narration.json"];

let seq = 0;
function nextId() {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

/** Watches one job over SSE: stage/progress/status, cancel, artifact links, and feeds LogPane. */
export function JobMonitor({ jobId }: { jobId: string | null }) {
  const [record, setRecord] = useState<JobRecord | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    esRef.current?.close();
    setRecord(null);
    setLines([]);
    if (!jobId) return;

    let cancelled = false;
    getJob(jobId).then((rec) => {
      if (!cancelled) setRecord(rec);
    });

    const es = streamJob(jobId, (ev) => {
      if (ev.type === "progress") {
        setRecord((prev) =>
          prev ? { ...prev, stage: ev.stage ?? prev.stage, pct: ev.pct ?? prev.pct } : prev
        );
      } else if (ev.type === "log") {
        setLines((prev) => [...prev, { id: nextId(), ts: ev.ts, text: ev.message ?? "", kind: "log" }]);
      } else if (ev.type === "error") {
        setLines((prev) => [
          ...prev,
          { id: nextId(), ts: ev.ts, text: ev.message ?? "job failed", kind: "error" },
        ]);
        es.close();
        getJob(jobId).then((rec) => !cancelled && setRecord(rec));
      } else if (ev.type === "done") {
        es.close();
        getJob(jobId).then((rec) => !cancelled && setRecord(rec));
      }
    });
    // Connection drop (not a terminal event) — native EventSource retries on
    // its own; refresh the snapshot in case the job finished while we were
    // disconnected, per the reconnect contract.
    es.onerror = () => {
      getJob(jobId).then((rec) => !cancelled && setRecord(rec));
    };
    esRef.current = es;

    return () => {
      cancelled = true;
      es.close();
    };
  }, [jobId]);

  async function handleCancel() {
    if (jobId) await cancelJob(jobId);
  }

  async function handleArtifact(name: string) {
    if (!jobId) return;
    try {
      const blob = await fetchArtifact(jobId, name);
      window.open(URL.createObjectURL(blob), "_blank");
    } catch {
      setLines((prev) => [
        ...prev,
        { id: nextId(), ts: new Date().toISOString(), text: `artifact unavailable: ${name}`, kind: "error" },
      ]);
    }
  }

  if (!jobId) {
    return (
      <Card className="flex h-full items-center justify-center py-3">
        <p className="text-sm text-muted-foreground">Start a job or select one from the list.</p>
      </Card>
    );
  }

  const cancellable = record?.status === "queued" || record?.status === "running";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Card className="gap-3 py-3">
        <CardHeader className="flex flex-row items-center justify-between px-3">
          <CardTitle className="flex items-center gap-2 font-mono text-sm">
            <span className="text-muted-foreground">{jobId.slice(0, 8)}</span>
            {record && <StatusBadge status={record.status} />}
          </CardTitle>
          <Button variant="outline" size="sm" disabled={!cancellable} onClick={handleCancel}>
            Cancel
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-3">
          <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
            <span>{record?.stage ?? "—"}</span>
            <span>{Math.round((record?.pct ?? 0) * 100)}%</span>
          </div>
          <Progress value={(record?.pct ?? 0) * 100} />
          {record?.error && <p className="text-sm text-destructive">{record.error}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            {ARTIFACTS.map((name) => (
              <Button key={name} variant="secondary" size="sm" onClick={() => handleArtifact(name)}>
                {name}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="min-h-0 flex-1">
        <LogPane lines={lines} />
      </div>
    </div>
  );
}
