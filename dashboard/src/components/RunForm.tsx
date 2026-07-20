import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createProfileJob, listProfiles,
  PROVIDERS, WHISPER_MODELS, LAYOUTS, CLIP_STYLES,
  type ProfileRecord, type RunOverrides,
} from "@/api";
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

/** Trim + empty→undefined so blank overrides are omitted (profile value kept). */
const s = (v: string) => (v.trim() ? v.trim() : undefined);
const n = (v: string) => (v.trim() ? Number(v) : undefined);

// base-ui Select has no native empty option; sentinel maps back to "" in setters.
const KEEP = "__keep__";

/**
 * Profile-first run composer. Picks a project profile, shows its effective
 * settings, and starts a job via `createProfileJob`. Per-run overrides live in
 * a drawer and never mutate the profile (server resolves them per job).
 */
export function RunForm({
  projectId,
  onCreated,
  initialContentSet,
  onConsumed,
}: {
  projectId: string;
  onCreated: (jobId: string) => void;
  initialContentSet?: string;
  onConsumed?: () => void;
}) {
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [profileId, setProfileId] = useState("");
  const [url, setUrl] = useState("");
  const [contentSet, setContentSet] = useState("");
  const [showOverrides, setShowOverrides] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Typed per-run override fields (all optional; empty ⇒ omitted ⇒ profile value).
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [layout, setLayout] = useState("");
  const [clipStyle, setClipStyle] = useState("");
  const [language, setLanguage] = useState("");
  const [social, setSocial] = useState("");
  const [maxClips, setMaxClips] = useState("");
  const [bgmVolume, setBgmVolume] = useState("");
  const [headlineDur, setHeadlineDur] = useState("");
  const [keywords, setKeywords] = useState("");

  useEffect(() => {
    let alive = true;
    listProfiles(projectId)
      .then((ps) => {
        if (!alive) return;
        setProfiles(ps);
        setProfileId((cur) => cur || ps[0]?.id || "");
      })
      .catch(() => alive && setProfiles([]));
    return () => {
      alive = false;
    };
  }, [projectId]);

  // One-shot prefill from a "Send to render" hand-off (Content-Set view).
  useEffect(() => {
    if (initialContentSet) {
      setContentSet(initialContentSet);
      onConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId],
  );

  function buildOverrides(): RunOverrides {
    const o: RunOverrides = {};
    if (s(url)) o.ingest_source_source = s(url);
    if (s(contentSet)) o.ingest_source_content_set = s(contentSet);
    if (s(provider)) o.analysis_provider = s(provider);
    if (s(model)) o.analysis_model = s(model);
    if (s(layout)) o.visual_edit_layout = s(layout);
    if (s(clipStyle)) o.visual_edit_clip_style = s(clipStyle);
    if (s(language)) o.narration_language = s(language);
    if (s(social)) o.visual_edit_social = s(social);
    if (n(maxClips) !== undefined) o.analysis_max_clips = n(maxClips);
    if (n(bgmVolume) !== undefined) o.visual_edit_bgm_volume = n(bgmVolume);
    if (n(headlineDur) !== undefined) o.visual_edit_headline_dur = n(headlineDur);
    const kw = keywords.split(",").map((k) => k.trim()).filter(Boolean);
    if (kw.length) o.analysis_keywords = kw;
    return o;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!profileId) {
      setError("select a profile first");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { job_id } = await createProfileJob(projectId, {
        profile_id: profileId,
        overrides: buildOverrides(),
      });
      setUrl("");
      setContentSet("");
      onCreated(job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start run");
    } finally {
      setSubmitting(false);
    }
  }

  const enumField = (
    id: string, label: string, value: string, set: (v: string) => void, opts: readonly string[],
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value === "" ? KEEP : value}
        onValueChange={(v) => set(v === KEEP ? "" : String(v))}>
        <SelectTrigger id={id} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={KEEP}>(keep profile)</SelectItem>
          {opts.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  const textField = (
    id: string, label: string, value: string, set: (v: string) => void,
    placeholder = "", type = "text",
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input id={id} className="w-40" type={type} placeholder={placeholder}
        value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );

  const v = selected?.settings;

  return (
    <form onSubmit={handleSubmit}
      className="flex flex-col gap-3 border-b border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg leading-none text-primary" aria-hidden>🪶</span>
          <span className="font-mono text-sm font-semibold tracking-wide text-foreground">Thoth</span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="profile" className="text-xs text-muted-foreground">Profile</Label>
          <Select value={profileId === "" ? null : profileId}
            onValueChange={(v) => setProfileId(String(v))}>
            <SelectTrigger id="profile" className="w-52">
              <SelectValue placeholder="No profiles — create one in Profiles" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="url" className="text-xs text-muted-foreground">URL (optional — overrides profile source)</Label>
          <Input id="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="content-set" className="text-xs text-muted-foreground">Content-set path (optional)</Label>
          <Input id="content-set" placeholder="scout/output/thoth_content_set.json"
            value={contentSet} onChange={(e) => setContentSet(e.target.value)} />
        </div>
        <Button type="button" variant="secondary" className="shrink-0"
          onClick={() => setShowOverrides((o) => !o)}>
          {showOverrides ? "Overrides for this run ▲" : "Overrides for this run ▼"}
        </Button>
        <Button type="submit" disabled={submitting || !profileId} className="shrink-0">
          {submitting ? "Starting…" : "Run"}
        </Button>
      </div>

      {v && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Effective:</span>
          <span>provider <b className="text-foreground">{provider || v.analysis.provider}</b></span>
          <span>model <b className="text-foreground">{model || v.analysis.model}</b></span>
          <span>layout <b className="text-foreground">{layout || v.visual_edit.layout}</b></span>
          <span>clip-style <b className="text-foreground">{clipStyle || v.visual_edit.clip_style}</b></span>
          <span>max-clips <b className="text-foreground">{maxClips || v.analysis.max_clips}</b></span>
          <span>language <b className="text-foreground">{language || v.narration.language || "auto"}</b></span>
        </div>
      )}

      {showOverrides && (
        <div className="flex flex-wrap gap-3 border-t border-border pt-3">
          {enumField("ov-provider", "provider", provider, setProvider, PROVIDERS)}
          {enumField("ov-model", "model", model, setModel, WHISPER_MODELS)}
          {enumField("ov-layout", "Layout", layout, setLayout, LAYOUTS)}
          {enumField("ov-clip-style", "clip-style", clipStyle, setClipStyle, CLIP_STYLES)}
          {textField("ov-max-clips", "max-clips", maxClips, setMaxClips, "3", "number")}
          {textField("ov-language", "language", language, setLanguage, "id")}
          {textField("ov-social", "social", social, setSocial, "@acct")}
          {textField("ov-keywords", "keywords (csv)", keywords, setKeywords, "prabowo,AI")}
          {textField("ov-bgm-volume", "bgm-volume", bgmVolume, setBgmVolume, "0.12", "number")}
          {textField("ov-headline-dur", "headline-dur", headlineDur, setHeadlineDur, "4.0", "number")}
        </div>
      )}

      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}
