import { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type LogLine = { id: string; ts: string; text: string; kind: "log" | "error" };

/** Scrolling terminal console for a job's log + terminal-error SSE messages. Newest at bottom, auto-scrolls. */
export function LogPane({ lines }: { lines: LogLine[] }) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <Card className="flex h-full flex-col gap-0 py-3">
      <CardHeader className="px-3">
        <CardTitle className="font-mono text-xs tracking-wide text-muted-foreground">
          Log
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-0">
        <ScrollArea viewportRef={viewportRef} className="h-full px-3">
          {lines.length === 0 && (
            <p className="py-4 font-mono text-xs text-muted-foreground">No logs yet.</p>
          )}
          <div className="flex flex-col gap-0.5 pb-3 font-mono text-xs leading-relaxed">
            {lines.map((line) => (
              <div
                key={line.id}
                className={cn(
                  "border-l-2 pl-2",
                  line.kind === "error" ? "border-l-status-failed text-status-failed" : "border-l-spine/40 text-foreground/90"
                )}
              >
                <span className="text-muted-foreground">{line.ts.slice(11, 19)}</span>{" "}
                {line.text}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
