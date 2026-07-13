import { useEffect, useState } from "react";
import { fetchArtifact, getManifest, type Manifest } from "@/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type VisualScore = {
  humor: number;
  visual_impact: number;
  novelty: number;
  engagement: number;
  note?: string;
};
type Moment = {
  title: string;
  headline?: string;
  start_sec: number;
  end_sec: number;
  reason: string;
  hook: string;
  viral_type: string;
  energy: string;
  visual_score?: VisualScore | null;
};

// Only the numeric score fields — excludes `note` so bar widths type as `number`
// without a cast (a stray `note` in this loop would then be a compile error).
type ScoreKey = "humor" | "visual_impact" | "novelty" | "engagement";
const SCORE_KEYS: ScoreKey[] = ["humor", "visual_impact", "novelty", "engagement"];

/** Post-run Review: play the final video, inspect moments + scores (0–10). */
export function ReviewPanel({ jobId }: { jobId: string }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [moments, setMoments] = useState<Moment[] | null>(null);
  const [momentsErr, setMomentsErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let objUrl: string | null = null;
    getManifest(jobId).then(async (m) => {
      if (dead) return;
      setManifest(m);
      if (m.video) {
        try {
          const blob = await fetchArtifact(jobId, m.video);
          if (dead) return; // don't create an object URL nobody will revoke
          objUrl = URL.createObjectURL(blob);
          setVideoUrl(objUrl);
        } catch {
          if (!dead) setErr("final video unavailable");
        }
      }
      if (m.moments) {
        try {
          const blob = await fetchArtifact(jobId, m.moments);
          const data = JSON.parse(await blob.text()) as { moments?: Moment[] };
          if (!dead) setMoments(data.moments ?? []);
        } catch {
          // Distinguish a corrupt/unreadable moments.json from "0 moments":
          // the former surfaces a notice, the latter renders nothing.
          if (!dead) setMomentsErr("moments.json unreadable");
        }
      }
    });
    return () => {
      dead = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [jobId]);

  async function download(rel: string) {
    const blob = await fetchArtifact(jobId, rel);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    // Revoke after the new tab has had a tick to claim it (avoids per-click leak).
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (!manifest) return null;

  return (
    <Card className="gap-3 py-3">
      <CardHeader className="px-3">
        <CardTitle className="text-sm">Review</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-3">
        {videoUrl ? (
          <video controls src={videoUrl} className="w-full max-h-80 rounded bg-black" />
        ) : (
          <p className="text-xs text-muted-foreground">{err ?? "render not available"}</p>
        )}

        {momentsErr && (
          <p className="text-xs text-destructive">{momentsErr}</p>
        )}

        {moments && moments.length > 0 && (
          <div className="flex flex-col gap-2">
            {moments.map((m, i) => (
              <div key={i} className="rounded border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {i + 1}. {m.headline || m.title}
                  </span>
                  <span className="text-muted-foreground">
                    {m.start_sec.toFixed(1)}–{m.end_sec.toFixed(1)}s · {m.viral_type} · {m.energy}
                  </span>
                </div>
                {m.visual_score && (
                  <div className="mt-1 flex flex-col gap-0.5">
                    {SCORE_KEYS.map((k) => (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-24 shrink-0 text-muted-foreground">{k}</span>
                        <div className="h-2 flex-1 rounded bg-muted">
                          <div
                            className="h-2 rounded bg-primary"
                            style={{ width: `${m.visual_score![k] * 10}%` }}
                          />
                        </div>
                        <span className="w-6 text-right tabular-nums">{m.visual_score![k]}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-muted-foreground">{m.reason}</p>
                {m.hook && <p className="mt-0.5 italic text-muted-foreground">“{m.hook}”</p>}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {manifest.transcript && (
            <Button variant="secondary" size="sm" onClick={() => download(manifest.transcript!)}>
              transcript
            </Button>
          )}
          {manifest.narration && (
            <Button variant="secondary" size="sm" onClick={() => download(manifest.narration!)}>
              narration
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
