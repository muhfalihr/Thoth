import { useEffect, useState } from "react";

import type { ControlPlaneClient, StylePreset, WorkflowRequest } from "@/api/control-plane";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type WizardClient = Pick<ControlPlaneClient, "listStylePresets"> & {
  createWorkflow: (request: WorkflowRequest) => Promise<{ workflow_id: string }>;
};

export function WorkflowWizard({
  client,
  onStarted,
}: {
  client: WizardClient;
  onStarted: (workflowId: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [styles, setStyles] = useState<StylePreset[]>([]);
  const [style, setStyle] = useState("");
  const [review, setReview] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    void client.listStylePresets().then(
      (presets) => {
        if (!live) return;
        setStyles(presets);
        setStyle((current) => current || presets[0]?.preset_id || "");
      },
      () => live && setError("Could not load video styles."),
    );
    return () => { live = false; };
  }, [client]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const request: WorkflowRequest = {
      source: { url, intent: "produce_video" },
      style: { preset_id: style },
      output: { format: "mp4", language: "id" },
      review: { require_publish_approval: review },
    };
    try {
      onStarted((await client.createWorkflow(request)).workflow_id);
    } catch {
      setError("Could not start the workflow. Check the source and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="m-3 max-w-2xl">
      <CardHeader><CardTitle>New video</CardTitle></CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="workflow-source">Source URL</Label>
            <Input id="workflow-source" value={url} onChange={(event) => setUrl(event.target.value)} required type="url" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workflow-style">Style</Label>
            <select id="workflow-style" aria-label="Style" value={style} onChange={(event) => setStyle(event.target.value)} required>
              {styles.map((preset) => <option key={preset.preset_id} value={preset.preset_id}>{preset.label}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm"><input checked={review} onChange={(event) => setReview(event.target.checked)} type="checkbox" /> Review before publishing</label>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button disabled={submitting || !style} type="submit">Start workflow</Button>
        </form>
      </CardContent>
    </Card>
  );
}
