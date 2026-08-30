import { useEffect, useState } from "react";

import type { ControlPlaneClient, WorkflowSummary } from "@/api/control-plane";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type MonitorClient = Pick<
  ControlPlaneClient,
  "streamWorkflow" | "cancelWorkflow" | "retryWorkflow" | "approveWorkflow"
>;

function workflowProgress(workflow: WorkflowSummary | null): number {
  const stages = workflow?.stages ?? [];
  if (stages.length === 0) return 0;
  const completed = stages.reduce(
    (total, stage) => total + (stage.status === "completed" ? 1 : (stage.progress ?? 0)),
    0,
  );
  return (completed / stages.length) * 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The workflow action could not be completed.";
}

export function WorkflowMonitor({ workflowId, client }: { workflowId: string | null; client: MonitorClient }) {
  const [workflow, setWorkflow] = useState<WorkflowSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) {
      setWorkflow(null);
      setActionError(null);
      return;
    }
    let live = true;
    const stop = client.streamWorkflow(workflowId, (value) => {
      if (live) setWorkflow(value);
    });
    return () => {
      live = false;
      stop();
    };
  }, [client, workflowId]);

  const applyAction = async (action: () => Promise<WorkflowSummary>) => {
    try {
      setActionError(null);
      setWorkflow(await action());
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  if (!workflowId) {
    return <Card className="m-3"><CardContent className="py-6 text-sm text-muted-foreground">Start a workflow to follow its progress.</CardContent></Card>;
  }

  const approval = workflow?.approval;
  const artifacts = workflow?.artifacts ?? [];
  return <div className="m-3 flex max-w-2xl flex-col gap-3">
    <Card><CardHeader><CardTitle>Workflow {workflowId}</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-sm">{workflow?.status ?? "Loading workflow…"}</p>
      <p className="text-sm font-medium">Progress</p><Progress value={workflowProgress(workflow)} />
      <ul className="space-y-1 text-sm">{workflow?.stages.map((stage) => <li key={stage.id}>{stage.label} — {stage.status}</li>)}</ul>
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void applyAction(() => client.retryWorkflow(workflowId))}>Retry</Button><Button size="sm" variant="outline" onClick={() => void applyAction(() => client.cancelWorkflow(workflowId))}>Cancel</Button></div>
    </CardContent></Card>
    {approval && <Card><CardHeader><CardTitle>Needs your decision</CardTitle></CardHeader><CardContent className="space-y-2"><p>{approval.prompt}</p><div className="flex gap-2">{approval.allowed_decisions.map((decision) => <Button key={decision} size="sm" onClick={() => void applyAction(() => client.approveWorkflow(workflowId, { approval_id: approval.approval_id, decision }))}>{decision}</Button>)}</div></CardContent></Card>}
    <Card><CardHeader><CardTitle>Results</CardTitle></CardHeader><CardContent><ul className="text-sm">{artifacts.length > 0 ? artifacts.map((artifact) => <li key={artifact.artifact_id}>{artifact.label}</li>) : <li>No results yet.</li>}</ul></CardContent></Card>
    {workflow?.failure && <Button size="sm" variant="ghost" onClick={() => setDiagnostics((shown) => !shown)}>Diagnostics</Button>}
    {diagnostics && workflow?.failure && <Card><CardContent className="py-3 text-xs">{workflow.failure.message}</CardContent></Card>}
  </div>;
}
