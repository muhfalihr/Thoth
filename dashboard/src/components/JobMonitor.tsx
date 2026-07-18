import { useEffect, useRef, useState } from "react";
import {
  cancelJob,
  getJob,
  streamJob,
  type JobRecord,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/StatusBadge";
import { LogPane, type LogLine } from "@/components/LogPane";
import { ReviewPanel } from "@/components/ReviewPanel";
import { terminalEventIsFailure, terminalEventKind } from "@/lib/job-events";

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
      } else {
        const terminal = terminalEventKind(ev.type);
        if (!terminal) return;

        if (terminalEventIsFailure(terminal)) {
          setLines((prev) => [
            ...prev,
            { id: nextId(), ts: ev.ts, text: ev.message ?? "job failed", kind: "error" },
          ]);
        } else if (terminal === "cancelled") {
          setLines((prev) => [
            ...prev,
            { id: nextId(), ts: ev.ts, text: "Job cancelled", kind: "log" },
          ]);
        }
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
        </CardContent>
      </Card>

      {record?.status === "succeeded" && jobId && <ReviewPanel jobId={jobId} />}

      <div className="min-h-0 flex-1">
        <LogPane lines={lines} />
      </div>
    </div>
  );
}
