// Hand-kept typed client mirroring the Rust types in crates/thoth-server/src/job.rs.
// This is the manual half of the interface-sync contract — keep byte-aligned
// with JobSpec/JobRecord/SseEvent when the server changes.

const KEY = import.meta.env.VITE_THOTH_API_KEY ?? "dev-key";
const H = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

export type JobSpec = {
  command: string;
  url?: string;
  content_set?: string;
  params?: Record<string, unknown>;
};
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobRecord = {
  id: string;
  spec: JobSpec;
  status: JobStatus;
  stage?: string;
  pct: number;
  error?: string;
  created_at: string;
  updated_at: string;
  output_dir: string;
};
export type SseEvent = {
  type: "progress" | "log" | "done" | "error" | "cancelled";
  job_id: string;
  stage?: string;
  pct?: number;
  message?: string;
  ts: string;
};

/** The API key currently in use, for building authenticated artifact links. */
export function apiKey(): string {
  return KEY;
}

export async function createJob(spec: JobSpec): Promise<{ job_id: string }> {
  const r = await fetch("/api/jobs", { method: "POST", headers: H, body: JSON.stringify(spec) });
  if (!r.ok) throw new Error(`createJob ${r.status}`);
  return r.json();
}

export async function listJobs(): Promise<JobRecord[]> {
  const r = await fetch("/api/jobs", { headers: H });
  return r.ok ? r.json() : [];
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const r = await fetch(`/api/jobs/${id}`, { headers: H });
  return r.ok ? r.json() : null;
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}/cancel`, { method: "POST", headers: H });
}

// EventSource can't set headers → token via query param. The server's first
// frame is a named "snapshot" event (a JobRecord, not an SseEvent) — this
// wrapper only surfaces the default-event progress/log/done/error/cancelled stream;
// JobMonitor gets its initial state from getJob() instead, per the brief's
// reconnect guidance.
export function streamJob(id: string, onEvent: (e: SseEvent) => void): EventSource {
  const es = new EventSource(`/api/jobs/${id}/stream?token=${encodeURIComponent(KEY)}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as SseEvent);
    } catch {
      /* drop */
    }
  };
  return es;
}

/**
 * Fetch an artifact as a Blob. A plain `<a href>` can't carry the bearer
 * header (and unlike /stream, this route has no ?token= escape hatch), so
 * artifact links go through this + an object URL instead of a raw href.
 */
export async function fetchArtifact(jobId: string, relPath: string): Promise<Blob> {
  const r = await fetch(`/api/artifacts/${jobId}/${relPath}`, { headers: H });
  if (!r.ok) throw new Error(`fetchArtifact ${r.status}`);
  return r.blob();
}

export type Manifest = {
  video?: string;
  thumbnail?: string;
  moments?: string;
  narration?: string;
  transcript?: string;
};

export async function getManifest(id: string): Promise<Manifest> {
  const r = await fetch(`/api/jobs/${id}/manifest`, { headers: H });
  return r.ok ? r.json() : {};
}

// Per-run knobs the dashboard sends in JobSpec.params. Mirrors the flag mapping
// in crates/thoth-core/src/worker/mod.rs::push_params — keep in sync by hand.
export type RunParams = {
  provider?: string;
  model?: string;
  max_clips?: number;
  layout?: string;
  language?: string;
  keywords?: string[];
  clip_style?: string;
  style_profile?: string;
  social?: string;
  bgm?: string;
  bgm_volume?: number;
  sfx_intro?: string;
  headline_dur?: number;
  extra_args?: string[];
};

// Static enum value lists — mirror the Rust enums in cli.rs (LlmProviderName,
// WhisperModelSize, OutputLayout, ClipStyleArg). Update when a variant is added.
export const PROVIDERS = [
  "groq", "openai", "claude", "gemini", "vllm", "ollama", "novita", "together", "fireworks",
] as const;
export const WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3"] as const;
export const LAYOUTS = ["vertical", "horizontal", "square"] as const;
export const CLIP_STYLES = ["fade", "flash", "zoom", "smooth", "none"] as const;

export async function getStyleProfiles(): Promise<string[]> {
  const r = await fetch("/api/style-profiles", { headers: H });
  return r.ok ? r.json() : [];
}

export async function getConfig(): Promise<string> {
  const r = await fetch("/api/config", { headers: H });
  if (!r.ok) return "";
  const j = await r.json();
  return typeof j.text === "string" ? j.text : "";
}

export async function putConfig(text: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch("/api/config", {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ text }),
  });
  if (r.ok) return { ok: true };
  const j = await r.json().catch(() => ({}));
  return { ok: false, error: typeof j.error === "string" ? j.error : `PUT ${r.status}` };
}

// ---- Scout orchestration (Operator Console sub-project B) ----
// Hand-synced to crates/thoth-server/src/scout.rs + routes.rs::scout_*.
// Keep byte-aligned when the Rust route bodies change.
export type ScoutKind = "browser" | "discover" | "run" | "validate";
export type ScoutRunStatus = "idle" | "running" | "done" | "failed";
export type ScoutRunSummary = {
  kind: ScoutKind;
  status: ScoutRunStatus;
  started_at: number | null;
  exit_code: number | null;
};
export type ScoutStatus = {
  browser_attached: boolean;
  cdp_base: string;
  run: ScoutRunSummary | null;
};
// reel_topics.json entries are returned raw; these are the fields the UI reads.
export type ScoutTopic = { url: string; title?: string; score?: number; platform?: string };
export type ScoutLogLine = { seq: number; stream: "out" | "err"; text: string };

export type ScoutDiscoverBody = {
  max_per?: number;
  hours?: number;
  include?: string;
  tiktok?: boolean;
};
export type ScoutRunBody = {
  url: string;
  out?: string;
  per?: number;
  max?: number;
  cap?: number;
  no_comments?: boolean;
};

/** 202 -> {ok:true}; 409 (busy) / 400 -> {ok:false,status}. */
export type ScoutAck = { ok: boolean; status: number; error?: string };

async function scoutPost(path: string, body?: unknown): Promise<ScoutAck> {
  const r = await fetch(path, { method: "POST", headers: H, body: JSON.stringify(body ?? {}) });
  if (r.ok) return { ok: true, status: r.status };
  const j = await r.json().catch(() => ({}));
  return { ok: false, status: r.status, error: typeof j.error === "string" ? j.error : undefined };
}

export async function scoutStatus(): Promise<ScoutStatus | null> {
  const r = await fetch("/api/scout/status", { headers: H });
  return r.ok ? r.json() : null;
}
export function scoutStartBrowser(): Promise<ScoutAck> {
  return scoutPost("/api/scout/browser/start");
}
export function scoutDiscover(body: ScoutDiscoverBody): Promise<ScoutAck> {
  return scoutPost("/api/scout/discover", body);
}
export function scoutRun(body: ScoutRunBody): Promise<ScoutAck> {
  return scoutPost("/api/scout/run", body);
}
export function scoutValidate(set: string): Promise<ScoutAck> {
  return scoutPost("/api/scout/validate", { set });
}
export function scoutCancel(): Promise<ScoutAck> {
  return scoutPost("/api/scout/cancel");
}
export async function scoutTopics(): Promise<ScoutTopic[]> {
  const r = await fetch("/api/scout/topics", { headers: H });
  return r.ok ? r.json() : [];
}
export async function scoutContentSet(): Promise<{ path: string; exists: boolean }> {
  const r = await fetch("/api/scout/content-set", { headers: H });
  return r.ok ? r.json() : { path: "", exists: false };
}

/** Live scout log tail. Mirrors streamJob; resumes from `since`. */
export function streamScout(since: number, onLine: (l: ScoutLogLine) => void): EventSource {
  const es = new EventSource(
    `/api/scout/stream?token=${encodeURIComponent(KEY)}&since=${since}`,
  );
  es.onmessage = (m) => {
    try { onLine(JSON.parse(m.data) as ScoutLogLine); } catch { /* drop */ }
  };
  return es;
}

// ---- Content-set curation (Operator Console sub-project C) ----
// Hand-synced to crates/thoth-server/src/routes.rs::scout_content_set_data /
// scout_content_set_save / scout_output_file.

export type ContentSetData = {
  path: string;
  exists: boolean;
  output_root: string;
  // Opaque JSON — kept verbatim for lossless save; only pruned/edited in place.
  content: any | null;
  error: string | null;
};

export async function getContentSetData(): Promise<ContentSetData> {
  const r = await fetch("/api/scout/content-set/data", { headers: H });
  return r.json();
}

// NOTE on losslessness: the *server* persists received bytes verbatim, but this
// UI path is only lossless for JSON *fields*, not byte-formatting. `content`
// came from r.json() → structuredClone, so (a) we re-serialize with 2-space
// indent to keep the on-disk file human/diff-friendly (original whitespace/key
// order is not otherwise recoverable), and (b) any JSON number > 2^53 (e.g. a
// 64-bit ID stored as a *number*, not a string) has already been coerced to an
// f64 by r.json() and may round. Scout stores IDs as strings, so this is latent.
export async function putContentSet(
  content: unknown,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const r = await fetch("/api/scout/content-set", {
    method: "PUT",
    headers: H,
    body: JSON.stringify(content, null, 2),
  });
  if (r.ok) return r.json();
  const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return { ok: false, error: e.error ?? `HTTP ${r.status}` };
}

/** Map an absolute local `image_path` to a servable, token-authed image URL.
 *  Robust to Windows separators: strip the `output_root` prefix if present, else
 *  fall back to the `/scout/output/` marker, else the bare basename under the root. */
export function scoutImageUrl(imagePath: string, outputRoot: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const np = norm(imagePath);
  const root = norm(outputRoot).replace(/\/+$/, "");
  let tail: string;
  if (root && np.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    tail = np.slice(root.length + 1);
  } else {
    const marker = "/scout/output/";
    const i = np.toLowerCase().lastIndexOf(marker);
    tail = i >= 0 ? np.slice(i + marker.length) : np.replace(/^.*\//, "");
  }
  // Encode each path segment (a space/#/?/% in a filename would break the URL)
  // while preserving the "/" separators of a nested tail like "crops/x.png".
  const enc = tail.split("/").map(encodeURIComponent).join("/");
  return `/api/scout/output/${enc}?token=${encodeURIComponent(KEY)}`;
}
