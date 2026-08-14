import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogPane, type LogLine } from "@/components/LogPane";
import {
  scoutStatus, scoutStartBrowser, scoutDiscover, scoutRun, scoutValidate, scoutCancel,
  scoutTopics, scoutContentSet, streamScout,
  type ScoutStatus, type ScoutTopic, type ScoutLogLine,
} from "@/api";

/** Discovery surface: drives the scout browser -> discover -> run -> validate flow. */
export function Discovery() {
  const [status, setStatus] = useState<ScoutStatus | null>(null);
  const [topics, setTopics] = useState<ScoutTopic[]>([]);
  const [lines, setLines] = useState<ScoutLogLine[]>([]);
  const [url, setUrl] = useState("");
  const [maxPer, setMaxPer] = useState("");
  const [hours, setHours] = useState("");
  const [include, setInclude] = useState("");
  const [tiktok, setTiktok] = useState(false);
  const [per, setPer] = useState("");
  const [max, setMax] = useState("");
  const [cap, setCap] = useState("");
  const [noComments, setNoComments] = useState(false);
  const [useInputAsMain, setUseInputAsMain] = useState(false);
  const [contentSet, setContentSet] = useState<{ path: string; exists: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const running = status?.run?.status === "running";

  // Poll status every 3s.
  useEffect(() => {
    let alive = true;
    const tick = async () => { const s = await scoutStatus(); if (alive) setStatus(s); };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // When a run finishes, refresh topics + content-set.
  useEffect(() => {
    let alive = true;
    if (status?.run && status.run.status !== "running") {
      scoutTopics().then((t) => { if (alive) setTopics(t); });
      scoutContentSet().then((c) => { if (alive) setContentSet(c); });
    }
    return () => { alive = false; };
  }, [status?.run?.status]);

  // Live log stream while running.
  useEffect(() => {
    if (!running) { esRef.current?.close(); esRef.current = null; return; }
    setLines([]);
    const es = streamScout(0, (l) => setLines((prev) => [...prev, l]));
    esRef.current = es;
    return () => { es.close(); };
  }, [running, status?.run?.started_at]);

  const num = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s));

  const ack = (label: string) => (r: { ok: boolean; status: number; error?: string }) => {
    if (!r.ok) setNotice(`${label}: ${r.status === 409 ? "already running" : r.error ?? r.status}`);
    else setNotice(null);
    scoutStatus().then(setStatus);
  };

  // ScoutLogLine -> LogPane's LogLine (no server timestamp; ts left blank).
  const logLines: LogLine[] = lines.map((l) => ({
    id: String(l.seq), ts: "", text: l.text, kind: l.stream === "err" ? "error" : "log",
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      {/* Header: browser status + start */}
      <div className="flex items-center gap-3 rounded border border-border bg-card px-3 py-2">
        <span className={`inline-block h-2 w-2 rounded-full ${status?.browser_attached ? "bg-status-succeeded" : "bg-status-failed"}`} />
        <span className="text-sm">
          Browser {status?.browser_attached ? "attached" : "not attached"}
          <span className="ml-2 text-xs text-muted-foreground">{status?.cdp_base}</span>
        </span>
        <Button size="sm" disabled={running} onClick={() => scoutStartBrowser().then(ack("browser"))}>
          Start browser
        </Button>
        {running && (
          <Button size="sm" variant="destructive" onClick={() => scoutCancel().then(ack("cancel"))}>
            Cancel ({status?.run?.kind})
          </Button>
        )}
        {notice && <span className="text-xs text-destructive">{notice}</span>}
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Left: flow controls */}
        <div className="w-80 shrink-0 space-y-4 overflow-y-auto">
          {/* 1. Discover */}
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                1. Discover
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="disc-max-per" className="text-xs text-muted-foreground">max_per</Label>
                <Input id="disc-max-per" placeholder="e.g. 5" value={maxPer} onChange={(e) => setMaxPer(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="disc-hours" className="text-xs text-muted-foreground">hours</Label>
                <Input id="disc-hours" placeholder="e.g. 24" value={hours} onChange={(e) => setHours(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="disc-include" className="text-xs text-muted-foreground">include (comma list)</Label>
                <Input id="disc-include" placeholder="prabowo,AI" value={include} onChange={(e) => setInclude(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary" checked={tiktok} onChange={(e) => setTiktok(e.target.checked)} /> tiktok
              </label>
              <Button size="sm" disabled={running} onClick={() =>
                scoutDiscover({ max_per: num(maxPer), hours: num(hours),
                  include: include.trim() || undefined, tiktok }).then(ack("discover"))}>
                Discover
              </Button>
            </CardContent>
          </Card>

          {/* 2. Topic picker */}
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                2. Topics ({topics.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {topics.map((t, i) => (
                  <button key={i} className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                    title={t.url} onClick={() => setUrl(t.url)}>
                    {t.title ?? t.url}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* 3. Run pipeline */}
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                3. Run pipeline
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="run-url" className="text-xs text-muted-foreground">topic url</Label>
                <Input id="run-url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="flex gap-1">
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor="run-per" className="text-xs text-muted-foreground">per</Label>
                  <Input id="run-per" value={per} onChange={(e) => setPer(e.target.value)} />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor="run-max" className="text-xs text-muted-foreground">max</Label>
                  <Input id="run-max" value={max} onChange={(e) => setMax(e.target.value)} />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor="run-cap" className="text-xs text-muted-foreground">cap</Label>
                  <Input id="run-cap" value={cap} onChange={(e) => setCap(e.target.value)} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary" checked={noComments} onChange={(e) => setNoComments(e.target.checked)} /> no-comments
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={useInputAsMain}
                  onChange={(e) => setUseInputAsMain(e.target.checked)}
                />
                <span>
                  Use URL media as main footage
                  <span className="block text-xs text-muted-foreground">
                    Download every video from this post, ignore photos, and build narration-aligned cuts.
                  </span>
                  <span className="block text-xs text-muted-foreground">Narrator mode is required.</span>
                </span>
              </label>
              <Button size="sm" disabled={running || url.trim() === ""} onClick={() =>
                scoutRun({ url: url.trim(), per: num(per), max: num(max), cap: num(cap),
                  no_comments: noComments, use_input_as_main: useInputAsMain }).then(ack("run"))}>
                Run pipeline
              </Button>
            </CardContent>
          </Card>

          {/* 4. Validate + hand-off */}
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                4. Validate
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button size="sm" disabled={running || !contentSet?.path} onClick={() =>
                contentSet?.path && scoutValidate(contentSet.path).then(ack("validate"))}>
                Validate content-set
              </Button>
              {contentSet && (
                <p className="break-all text-xs text-muted-foreground">
                  {contentSet.exists ? "content-set: " : "content-set (missing): "}
                  <code>{contentSet.path}</code>
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: live log */}
        <div className="min-h-0 min-w-0 flex-1">
          <LogPane lines={logLines} />
        </div>
      </div>
    </div>
  );
}
