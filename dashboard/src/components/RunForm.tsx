import { useState, type FormEvent } from "react";
import { createJob } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Phase 1 drives only `run`. scout/analyze take different CLI arg shapes the
// server's worker_args does not build yet — add them back when it maps per-command.
const COMMANDS = ["run"] as const;

/** Builds a JobSpec and starts a run. Notifies the parent so it can jump
 * JobMonitor straight to the new job without waiting on JobList's next poll. */
export function RunForm({ onCreated }: { onCreated: (jobId: string) => void }) {
  const [command, setCommand] = useState<string>("run");
  const [url, setUrl] = useState("");
  const [contentSet, setContentSet] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { job_id } = await createJob({
        command,
        url: url.trim() || undefined,
        content_set: contentSet.trim() || undefined,
        params: {},
      });
      setUrl("");
      setContentSet("");
      onCreated(job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start job");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3 border-b border-border bg-card px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-lg leading-none text-primary" aria-hidden>
          🪶
        </span>
        <span className="font-mono text-sm font-semibold tracking-wide text-foreground">
          Thoth
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="command" className="text-xs text-muted-foreground">
          Command
        </Label>
        <Select value={command} onValueChange={(v) => v && setCommand(v)}>
          <SelectTrigger id="command" className="w-28 font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMMANDS.map((c) => (
              <SelectItem key={c} value={c} className="font-mono">
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-56 flex-1 flex-col gap-1">
        <Label htmlFor="url" className="text-xs text-muted-foreground">
          URL
        </Label>
        <Input
          id="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div className="flex min-w-56 flex-1 flex-col gap-1">
        <Label htmlFor="content-set" className="text-xs text-muted-foreground">
          Content-set path (optional)
        </Label>
        <Input
          id="content-set"
          placeholder="scout/output/thoth_content_set.json"
          value={contentSet}
          onChange={(e) => setContentSet(e.target.value)}
        />
      </div>

      <Button type="submit" disabled={submitting} className="shrink-0">
        {submitting ? "Starting…" : "Start"}
      </Button>

      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}
