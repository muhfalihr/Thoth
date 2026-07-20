import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LogPane, type LogLine } from "@/components/LogPane";
import {
  getContentSetData,
  putContentSet,
  scoutImageUrl,
  scoutValidate,
  scoutStatus,
  streamScout,
  type ContentSetData,
  type ScoutLogLine,
} from "@/api";

// The curate surface only touches these shapes; everything else in `content` is
// preserved verbatim on save.
type Main = { title?: string; description?: string; thumbnail?: string; image_path?: string; profile?: any };
type Footage = { url?: string; title?: string; platform?: string; thumbnail?: string; image_path?: string };
type Comment = { author?: string; text?: string; likes?: number; image_path?: string };
type Figure = { name?: string; kind?: string; role?: string; description?: string };
type Reference = { term?: string; kind?: string; summary?: string };

export function ContentSet({ onSendToRender }: { onSendToRender: (path: string) => void }) {
  const [data, setData] = useState<ContentSetData | null>(null);
  const [content, setContent] = useState<any | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [lines, setLines] = useState<ScoutLogLine[]>([]);
  const esRef = useRef<EventSource | null>(null);

  // Load the content-set once on mount.
  useEffect(() => {
    let alive = true;
    getContentSetData()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setContent(d.content);
        setDirty(false);
      })
      .catch((e) => {
        // A failed initial fetch must not leave the view stuck on "Loading…".
        if (alive) setLoadErr(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // Poll scout status so Save is disabled while any scout command is in-flight
  // (the single slot means a running discover/validate could rewrite the file).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await scoutStatus();
        if (alive) setRunning(s?.run?.status === "running");
      } catch {
        // Transient status blip — keep the previous running state.
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Close any stream on unmount.
  useEffect(() => () => esRef.current?.close(), []);

  const outputRoot = data?.output_root ?? "";
  const imgSrc = (p?: string) => (p ? scoutImageUrl(p, outputRoot) : undefined);

  const mutate = (fn: (c: any) => void) => {
    setContent((prev: any) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const removeAt = (key: string, idx: number) =>
    mutate((c) => {
      if (Array.isArray(c[key])) c[key].splice(idx, 1);
    });

  const setMain = (field: "title" | "description", value: string) =>
    mutate((c) => {
      c.main = c.main ?? {};
      c.main[field] = value;
    });

  const save = async (): Promise<boolean> => {
    if (!content) return false;
    setSaving(true);
    setNotice(null);
    const res = await putContentSet(content);
    setSaving(false);
    if (!res.ok) {
      setNotice(res.error ?? "save failed");
      return false;
    }
    setDirty(false);
    setNotice("Saved. Validating…");
    // Reuse B's validate command; tail its log over SSE into the LogPane.
    setLines([]);
    esRef.current?.close();
    esRef.current = streamScout(0, (l) => setLines((prev) => [...prev, l]));
    const ack = await scoutValidate(res.path ?? data?.path ?? "");
    // Surface a rejected validate (e.g. 409 slot-busy) instead of leaving the
    // footer stuck on "Saved. Validating…" with no signal.
    if (!ack.ok) {
      setNotice(
        ack.status === 409
          ? "Saved. Validate skipped — scout is busy; try again shortly."
          : `Saved, but validate failed${ack.error ? `: ${ack.error}` : ""}.`,
      );
    }
    // Repaint from the canonical file after the write.
    const fresh = await getContentSetData();
    setData(fresh);
    setContent(fresh.content);
    setDirty(false);
    return true; // putContentSet succeeded — safe to hand off to render
  };

  // Sub-project D: save the on-screen edits (if any) then hand the canonical
  // content-set path to RunForm via the lifted App state. A running scout or an
  // empty/missing set disables the trigger; a failed save aborts the hand-off.
  const sendToRender = async () => {
    if (!data?.path || !content || running) return;
    if (dirty) {
      const ok = await save();
      if (!ok) return; // save failed → stay put; notice already shown
    }
    // `data.path` is the canonical content-set path; a save never changes it
    // (save() re-fetches the same file), so reading it from the pre-save
    // closure is safe. Revisit if a future path-picker lets save() relocate it.
    onSendToRender(data.path);
  };

  const logLines: LogLine[] = lines.map((l) => ({
    id: String(l.seq),
    ts: "",
    text: l.text,
    kind: l.stream === "err" ? "error" : "log",
  }));

  if (loadErr)
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-destructive">
        Couldn't load the content-set: {loadErr}
      </div>
    );
  if (!data)
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  if (!data.exists)
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        No content-set yet — run Discovery first.
      </div>
    );
  if (data.error === "malformed" || !content)
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-destructive">
        The content-set on disk isn't valid JSON ({data.path}).
      </div>
    );

  const main: Main = content.main ?? {};
  const footage: Footage[] = Array.isArray(content.footage) ? content.footage : [];
  const comments: Comment[] = Array.isArray(content.comments) ? content.comments : [];
  const figures: Figure[] = Array.isArray(content.figures) ? content.figures : [];
  const references: Reference[] = Array.isArray(content.references) ? content.references : [];
  const mainImg = imgSrc(main.thumbnail ?? main.image_path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {/* Main */}
        <Card size="sm" className="gap-2">
          <CardHeader>
            <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Main
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              {mainImg && (
                <img
                  src={mainImg}
                  alt=""
                  className="h-24 w-24 shrink-0 rounded object-cover"
                />
              )}
              <div className="flex-1 space-y-2">
                <Input
                  value={main.title ?? ""}
                  placeholder="title"
                  onChange={(e) => setMain("title", e.target.value)}
                />
                <Textarea
                  className="h-20"
                  value={main.description ?? ""}
                  placeholder="description"
                  onChange={(e) => setMain("description", e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Footage */}
        <Card size="sm" className="gap-2">
          <CardHeader>
            <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Footage ({footage.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {footage.map((f, i) => {
                const src = imgSrc(f.thumbnail ?? f.image_path);
                return (
                <div key={`${f.url ?? "f"}-${i}`} className="relative rounded border border-border bg-background p-2">
                  {src && (
                    <img src={src} alt="" className="mb-1 h-20 w-full rounded object-cover" />
                  )}
                  <div className="truncate text-xs">{f.title ?? f.url}</div>
                  <div className="text-xs text-muted-foreground">{f.platform}</div>
                  <Button
                    size="icon-xs"
                    variant="destructive"
                    aria-label="Remove footage"
                    className="absolute right-1 top-1"
                    onClick={() => removeAt("footage", i)}
                  >
                    ✕
                  </Button>
                </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Comments */}
        <Card size="sm" className="gap-2">
          <CardHeader>
            <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Comments ({comments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {comments.map((c, i) => {
                const src = imgSrc(c.image_path);
                return (
                <div key={`${c.image_path ?? c.author ?? "c"}-${i}`} className="relative rounded border border-border bg-background p-2">
                  {src && (
                    <img src={src} alt="" className="mb-1 w-full rounded object-contain" />
                  )}
                  <div className="truncate text-xs">{c.author}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">{c.text}</div>
                  <Button
                    size="icon-xs"
                    variant="destructive"
                    aria-label="Remove comment"
                    className="absolute right-1 top-1"
                    onClick={() => removeAt("comments", i)}
                  >
                    ✕
                  </Button>
                </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Figures + References */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                Figures ({figures.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {figures.map((f, i) => (
                <div key={`${f.name ?? "fig"}-${i}`} className="mb-1 flex items-center justify-between rounded border border-border bg-background px-2 py-1">
                  <span className="truncate text-xs">
                    {f.name} <span className="text-muted-foreground">· {f.kind} · {f.role}</span>
                  </span>
                  <Button size="icon-xs" variant="ghost" aria-label="Remove figure"
                    className="text-destructive" onClick={() => removeAt("figures", i)}>
                    ✕
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card size="sm" className="gap-2">
            <CardHeader>
              <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                References ({references.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {references.map((r, i) => (
                <div key={`${r.term ?? "ref"}-${i}`} className="mb-1 flex items-center justify-between rounded border border-border bg-background px-2 py-1">
                  <span className="truncate text-xs">
                    {r.term} <span className="text-muted-foreground">· {r.kind}</span>
                  </span>
                  <Button size="icon-xs" variant="ghost" aria-label="Remove reference"
                    className="text-destructive" onClick={() => removeAt("references", i)}>
                    ✕
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>

        {/* Validate log — lives in the scroll area, not squeezed into the footer. */}
        {logLines.length > 0 && (
          <div className="h-32">
            <LogPane lines={logLines} />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 border-t border-border p-3">
        <Button onClick={save} disabled={!dirty || saving || running}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outline"
          onClick={sendToRender}
          disabled={saving || running || !data?.path || !content}
        >
          Send to render →
        </Button>
        {dirty && <span className="text-xs text-muted-foreground">unsaved changes</span>}
        {running && <span className="text-xs text-muted-foreground">scout busy — save disabled</span>}
        {notice && <span className="text-xs">{notice}</span>}
      </div>
    </div>
  );
}
