import { useEffect, useState } from "react";

import type { ControlPlaneClient, WorkflowSummary } from "@/api/control-plane";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type MonitorClient = Pick<
  ControlPlaneClient,
  "getWorkflow" | "streamWorkflow" | "cancelWorkflow" | "retryWorkflow" | "approveWorkflow"
>;

export function WorkflowMonitor({ workflowId, client }: { workflowId: string | null; client: MonitorClient }) {
  const [workflow, setWorkflow] = useState<WorkflowSummary | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);

  useEffect(() => {
    if (!workflowId) { setWorkflow(null); return; }
    let live = true;
    const accept = (value: WorkflowSummary) => {
      if (live) setWorkflow(value);
    };
    void client.getWorkflow(workflowId).then(accept);
    const stop = client.streamWorkflow(workflowId, accept);
    return () => { live = false; stop(); };
  }, [client, workflowId]);

  if (!workflowId) return <Card className="m-3"><CardContent className="py-6 text-sm text-muted-foreground">Start a workflow to follow its progress.</CardContent></Card>;
  const maximumProgress = Math.max(0, ...workflow?.stages.map((stage) => stage.progress ?? 0) ?? []);
  const approval = workflow?.approval;
  return <div className="m-3 flex max-w-2xl flex-col gap-3">
    <Card><CardHeader><CardTitle>Workflow {workflowId}</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-sm">{workflow?.status ?? "Loading workflow…"}</p>
      <p className="text-sm font-medium">Progress</p><Progress value={maximumProgress * 100} />
      <ul className="space-y-1 text-sm">{workflow?.stages.map((stage) => <li key={stage.id}>{stage.label} — {stage.status}</li>)}</ul>
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void client.retryWorkflow(workflowId)}>Retry</Button><Button size="sm" variant="outline" onClick={() => void client.cancelWorkflow(workflowId)}>Cancel</Button></div>
    </CardContent></Card>
    {approval && <Card><CardHeader><CardTitle>Needs decision</CardTitle></CardHeader><CardContent className="space-y-2"><p>{approval.prompt}</p><div className="flex gap-2">{approval.allowed_decisions.map((decision) => <Button key={decision} size="sm" onClick={() => void client.approveWorkflow(workflowId, { approval_id: approval.approval_id, decision })}>{decision}</Button>)}</div></CardContent></Card>}
    <Card><CardHeader><CardTitle>Results</CardTitle></CardHeader><CardContent><ul className="text-sm">{workflow?.artifacts?.map((artifact) => <li key={artifact.artifact_id}>{artifact.label}</li>) ?? <li>No results yet.</li>}</ul></CardContent></Card>
    {workflow?.failure && <Button size="sm" variant="ghost" onClick={() => setDiagnostics((shown) => !shown)}>Diagnostics</Button>}
    {diagnostics && workflow?.failure && <Card><CardContent className="py-3 text-xs">{workflow.failure.message}</CardContent></Card>}
  </div>;
}
