import { useEffect, useState } from "react";
import { getConfig, putConfig } from "@/api";
import { Button } from "@/components/ui/button";

/** Raw config.toml editor. Save validates as TOML server-side (400 → inline
 *  error). Edits apply to the next enqueued job (worker reloads per job). */
export function ConfigEditor() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "err"; msg?: string }>({ kind: "idle" });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    getConfig().then((t) => {
      if (!dead) { setText(t); setLoading(false); }
    });
    return () => { dead = true; };
  }, []);

  async function save() {
    setStatus({ kind: "idle" });
    const r = await putConfig(text);
    setStatus(r.ok
      ? { kind: "ok", msg: "saved — applies to next run" }
      : { kind: "err", msg: r.error });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm font-semibold">config.toml</span>
        <Button size="sm" onClick={save} disabled={loading}>Save</Button>
        {status.kind === "ok" && <span className="text-xs text-primary">{status.msg}</span>}
        {status.kind === "err" && <span className="text-xs text-destructive">{status.msg}</span>}
      </div>
      <textarea
        className="min-h-0 flex-1 resize-none rounded border border-border bg-background p-2 font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}
