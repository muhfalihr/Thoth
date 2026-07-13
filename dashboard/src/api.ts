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
  type: "progress" | "log" | "done" | "error";
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
// wrapper only surfaces the default-event progress/log/done/error stream;
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
