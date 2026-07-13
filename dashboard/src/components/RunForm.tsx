import { useEffect, useState, type FormEvent } from "react";
import {
  createJob, getStyleProfiles,
  PROVIDERS, WHISPER_MODELS, LAYOUTS, CLIP_STYLES, type RunParams,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const COMMANDS = ["run"] as const;

/** Builds a JobSpec (url + content-set + per-run params) and starts a run. */
export function RunForm({ onCreated }: { onCreated: (jobId: string) => void }) {
  const [command, setCommand] = useState<string>("run");
  const [url, setUrl] = useState("");
  const [contentSet, setContentSet] = useState("");
  const [showOpts, setShowOpts] = useState(false);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-run knob fields (all optional; empty ⇒ omitted ⇒ clap default).
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [layout, setLayout] = useState("");
  const [clipStyle, setClipStyle] = useState("");
  const [styleProfile, setStyleProfile] = useState("");
  const [maxClips, setMaxClips] = useState("");
  const [language, setLanguage] = useState("");
  const [social, setSocial] = useState("");
  const [keywords, setKeywords] = useState("");
  const [bgm, setBgm] = useState("");
  const [bgmVolume, setBgmVolume] = useState("");
  const [sfxIntro, setSfxIntro] = useState("");
  const [headlineDur, setHeadlineDur] = useState("");
  const [extraArgs, setExtraArgs] = useState("");

  useEffect(() => {
    getStyleProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  function buildParams(): RunParams {
    const p: RunParams = {};
    if (provider) p.provider = provider;
    if (model) p.model = model;
    if (layout) p.layout = layout;
    if (clipStyle) p.clip_style = clipStyle;
    if (styleProfile) p.style_profile = styleProfile;
    if (language) p.language = language;
    if (social) p.social = social;
    if (bgm) p.bgm = bgm;
    if (sfxIntro) p.sfx_intro = sfxIntro;
    if (maxClips) p.max_clips = Number(maxClips);
    if (bgmVolume) p.bgm_volume = Number(bgmVolume);
    if (headlineDur) p.headline_dur = Number(headlineDur);
    const kw = keywords.split(",").map((s) => s.trim()).filter(Boolean);
    if (kw.length) p.keywords = kw;
    const ea = extraArgs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (ea.length) p.extra_args = ea;
    return p;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { job_id } = await createJob({
        command,
        url: url.trim() || undefined,
        content_set: contentSet.trim() || undefined,
        params: buildParams(),
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

  const enumField = (
    label: string, value: string, set: (v: string) => void, opts: readonly string[],
  ) => (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => set(v && v !== "__default" ? v : "")}>
        <SelectTrigger className="w-40 font-mono"><SelectValue placeholder="default" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__default" className="font-mono">default</SelectItem>
          {opts.map((o) => (
            <SelectItem key={o} value={o} className="font-mono">{o}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const textField = (
    label: string, value: string, set: (v: string) => void,
    placeholder = "", type = "text",
  ) => (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input className="w-40" type={type} placeholder={placeholder}
        value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );

  return (
    <form onSubmit={handleSubmit}
      className="flex flex-col gap-3 border-b border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg leading-none text-primary" aria-hidden>🪶</span>
          <span className="font-mono text-sm font-semibold tracking-wide text-foreground">Thoth</span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="command" className="text-xs text-muted-foreground">Command</Label>
          <Select value={command} onValueChange={(v) => v && setCommand(v)}>
            <SelectTrigger id="command" className="w-28 font-mono"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COMMANDS.map((c) => (
                <SelectItem key={c} value={c} className="font-mono">{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="url" className="text-xs text-muted-foreground">URL</Label>
          <Input id="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="content-set" className="text-xs text-muted-foreground">Content-set path (optional)</Label>
          <Input id="content-set" placeholder="scout/output/thoth_content_set.json"
            value={contentSet} onChange={(e) => setContentSet(e.target.value)} />
        </div>
        <Button type="button" variant="secondary" className="shrink-0"
          onClick={() => setShowOpts((s) => !s)}>
          {showOpts ? "Options ▲" : "Options ▼"}
        </Button>
        <Button type="submit" disabled={submitting} className="shrink-0">
          {submitting ? "Starting…" : "Start"}
        </Button>
      </div>

      {showOpts && (
        <div className="flex flex-wrap gap-3 border-t border-border pt-3">
          {enumField("provider", provider, setProvider, PROVIDERS)}
          {enumField("model", model, setModel, WHISPER_MODELS)}
          {enumField("layout", layout, setLayout, LAYOUTS)}
          {enumField("clip-style", clipStyle, setClipStyle, CLIP_STYLES)}
          {enumField("style-profile", styleProfile, setStyleProfile, profiles)}
          {textField("max-clips", maxClips, setMaxClips, "3", "number")}
          {textField("language", language, setLanguage, "id")}
          {textField("social", social, setSocial, "@acct")}
          {textField("keywords (csv)", keywords, setKeywords, "prabowo,AI")}
          {textField("bgm path", bgm, setBgm)}
          {textField("bgm-volume", bgmVolume, setBgmVolume, "0.12", "number")}
          {textField("sfx-intro path", sfxIntro, setSfxIntro)}
          {textField("headline-dur", headlineDur, setHeadlineDur, "4.0", "number")}
          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <Label className="text-xs text-muted-foreground">extra flags (space-separated)</Label>
            <Input placeholder="--font-dir ./fonts --social-icon x.png"
              value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} />
          </div>
        </div>
      )}

      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}
