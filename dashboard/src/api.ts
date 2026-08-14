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
  narration_enabled?: boolean;
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
  use_input_as_main?: boolean;
  main_coverage_target?: number;
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
export function scoutRun({ main_coverage_target, ...body }: ScoutRunBody): Promise<ScoutAck> {
  return scoutPost("/api/scout/run", {
    ...body,
    ...(main_coverage_target !== undefined && main_coverage_target !== 0.60
      ? { main_coverage_target }
      : {}),
  });
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

// ---- Projects, profiles & profile-first jobs -------------------------------
// Hand-synced with crates/thoth-jobs/src/profiles.rs (ProjectRecord,
// ProfileRecord, ProfileSettings, RunOverrides) and the thoth-server routes in
// crates/thoth-server/src/lib.rs. Keep field names byte-aligned with the Rust
// structs — the server rejects unknown JSON fields (`deny_unknown_fields`).

export type ProjectRecord = {
  id: string;
  name: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
};

export type ProfileSettings = {
  schema_version: number;
  narration: { enabled: boolean; language: string | null };
  visual_edit: {
    layout: string;
    clip_style: string;
    style_profile: string;
    social: string;
    bgm: string | null;
    bgm_volume: number;
    sfx_intro: string | null;
    headline_dur: number;
  };
  analysis: { provider: string; model: string; max_clips: number; keywords: string[] };
  ingest_source: { source: string | null; content_set: string | null };
  output: { directory: string | null };
  // Rust `AdvancedSettings` is `#[serde(deny_unknown_fields)] struct {}` — the
  // server accepts only `{}`, so keep this empty-object shape compile-time visible.
  advanced: Record<string, never>;
};

export type ProfileRecord = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  settings: ProfileSettings;
  credential_ref: string | null;
  created_at: string;
  updated_at: string;
};

export type ProfileRevision = {
  id: string;
  profile_id: string;
  revision: number;
  name: string;
  description: string;
  settings: ProfileSettings;
  credential_ref: string | null;
  created_at: string;
};

/** Typed one-off overrides. Each present field overrides the selected profile;
 * an omitted field keeps the profile's value. Note: the nullable fields decode
 * `null` as "keep" (not "clear") — the server's `RunOverrides` uses a plain
 * `Option<Option<T>>` without a present-vs-absent deserializer, so only a
 * concrete value overrides. Callers should omit, never send `null`. Field names
 * mirror `RunOverrides` in profiles.rs exactly. */
export type RunOverrides = {
  narration_enabled?: boolean;
  narration_language?: string | null;
  visual_edit_layout?: string;
  visual_edit_clip_style?: string;
  visual_edit_style_profile?: string;
  visual_edit_social?: string;
  visual_edit_bgm?: string | null;
  visual_edit_bgm_volume?: number;
  visual_edit_sfx_intro?: string | null;
  visual_edit_headline_dur?: number;
  analysis_provider?: string;
  analysis_model?: string;
  analysis_max_clips?: number;
  analysis_keywords?: string[];
  ingest_source_source?: string | null;
  ingest_source_content_set?: string | null;
  output_directory?: string | null;
};

export type CreateProfileBody = {
  name: string;
  description?: string;
  settings?: ProfileSettings;
  credential_ref?: string | null;
};

/** Partial profile update. Omit a field to leave it unchanged; for
 * `credential_ref`, omit = keep, `null` = clear, string = set (tri-state).
 * `JSON.stringify` drops `undefined` keys, so only provided fields are sent. */
export type ProfilePatch = {
  name?: string;
  description?: string;
  settings?: ProfileSettings;
  credential_ref?: string | null;
};

/** The redacted immutable snapshot for a job — never carries a credential. */
export type EffectiveSettings = { settings: ProfileSettings };

export type ProfileValidation = { valid: boolean; message?: string };

export type ConfigImportReport = { imported: boolean; warnings: string[] };

async function ok<T>(r: Response, label: string): Promise<T> {
  if (!r.ok) {
    // Surface the server's error envelope ({error:{message}} or {error:"..."})
    // instead of a bare status code, so callers show WHY a request failed.
    const body = await r.json().catch(() => null);
    // Server uses two envelopes: {error:{...,message}} and {error:"code", message}.
    const detail = body?.error?.message
      ?? body?.error?.code
      ?? body?.message
      ?? body?.error
      ?? r.status;
    throw new Error(`${label}: ${detail}`);
  }
  return r.json() as Promise<T>;
}

export async function createProject(name: string): Promise<ProjectRecord> {
  const r = await fetch("/api/projects", { method: "POST", headers: H, body: JSON.stringify({ name }) });
  return ok(r, "createProject");
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const r = await fetch("/api/projects", { headers: H });
  return r.ok ? r.json() : [];
}

export async function getProject(projectId: string): Promise<ProjectRecord | null> {
  const r = await fetch(`/api/projects/${projectId}`, { headers: H });
  return r.ok ? r.json() : null;
}

export async function updateProject(projectId: string, name: string): Promise<ProjectRecord> {
  const r = await fetch(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ name }),
  });
  return ok(r, "updateProject");
}

export async function deleteProject(projectId: string): Promise<void> {
  const r = await fetch(`/api/projects/${projectId}`, { method: "DELETE", headers: H });
  if (!r.ok) throw new Error(`deleteProject ${r.status}`);
}

export async function createProfile(projectId: string, body: CreateProfileBody): Promise<ProfileRecord> {
  const r = await fetch(`/api/projects/${projectId}/profiles`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(body),
  });
  return ok(r, "createProfile");
}

export async function listProfiles(projectId: string): Promise<ProfileRecord[]> {
  const r = await fetch(`/api/projects/${projectId}/profiles`, { headers: H });
  return r.ok ? r.json() : [];
}

export async function getProfile(projectId: string, profileId: string): Promise<ProfileRecord | null> {
  const r = await fetch(`/api/projects/${projectId}/profiles/${profileId}`, { headers: H });
  return r.ok ? r.json() : null;
}

export async function updateProfile(
  projectId: string,
  profileId: string,
  patch: ProfilePatch,
): Promise<ProfileRecord> {
  const r = await fetch(`/api/projects/${projectId}/profiles/${profileId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify(patch),
  });
  return ok(r, "updateProfile");
}

export async function deleteProfile(projectId: string, profileId: string): Promise<void> {
  const r = await fetch(`/api/projects/${projectId}/profiles/${profileId}`, { method: "DELETE", headers: H });
  if (!r.ok) throw new Error(`deleteProfile ${r.status}`);
}

export async function duplicateProfile(
  projectId: string,
  profileId: string,
  name: string,
): Promise<ProfileRecord> {
  const r = await fetch(`/api/projects/${projectId}/profiles/${profileId}/duplicate`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name }),
  });
  return ok(r, "duplicateProfile");
}

export async function listProfileRevisions(projectId: string, profileId: string): Promise<ProfileRevision[]> {
  const r = await fetch(`/api/projects/${projectId}/profiles/${profileId}/revisions`, { headers: H });
  return r.ok ? r.json() : [];
}

export async function restoreProfileRevision(
  projectId: string,
  profileId: string,
  revisionId: string,
): Promise<ProfileRecord> {
  const r = await fetch(
    `/api/projects/${projectId}/profiles/${profileId}/revisions/${revisionId}/restore`,
    { method: "POST", headers: H },
  );
  return ok(r, "restoreProfileRevision");
}

export async function validateProfile(
  projectId: string,
  profileId: string,
  settings?: ProfileSettings,
): Promise<ProfileValidation> {
  const r = await fetch(`/api/projects/${projectId}/profiles/${profileId}/validate`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(settings ? { settings } : {}),
  });
  if (r.ok) return { valid: true };
  const body = await r.json().catch(() => ({}));
  return { valid: false, message: typeof body.message === "string" ? body.message : `validateProfile ${r.status}` };
}

export async function createProfileJob(
  projectId: string,
  req: { profile_id: string; overrides: RunOverrides },
): Promise<{ job_id: string }> {
  const r = await fetch(`/api/projects/${projectId}/jobs`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(req),
  });
  return ok(r, "createProfileJob");
}

export async function getEffectiveSettings(jobId: string): Promise<EffectiveSettings | null> {
  const r = await fetch(`/api/jobs/${jobId}/effective-settings`, { headers: H });
  return r.ok ? r.json() : null;
}

export async function migrateConfigToml(): Promise<ConfigImportReport> {
  const r = await fetch("/api/migrations/config-toml", { method: "POST", headers: H });
  return ok(r, "migrateConfigToml");
}
