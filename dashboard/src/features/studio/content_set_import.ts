// Projects a scout Content Set into the bounded, path-free source the Studio import API accepts.
// Every creative field is either mapped onto an item or reported as unsupported; nothing is truncated.

export type StudioSourceRole = "main" | "main_footage" | "footage" | "comment";

export type StudioSourceItem = {
  role: StudioSourceRole;
  order: number;
  title: string | null;
  text: string | null;
  platform: string | null;
  source_url: string | null;
  media_kind: "video" | "image" | "none";
  trim_start_seconds: number | null;
};

export type StudioUnsupportedField = {
  field: string;
  role: StudioSourceRole | null;
  order: number | null;
  reason: string;
  // SHA-256 of the field's value, so distinct choices never share an identity; the value itself never leaves.
  value_digest: string;
};

export type StudioSourceProjection = { items: StudioSourceItem[]; unsupported: StudioUnsupportedField[] };

export class StudioSourceError extends Error {}

const MAX_ITEMS = 400;
const MAX_UNSUPPORTED = 400;
const TITLE_LIMIT = 300;
const TEXT_LIMIT = 2000;
const NARRATION_CONTEXT = "Narration context is not used by Studio";
const UNRECOGNIZED = "Not recognized by Studio import";
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

// Fields Studio maps onto an item, per role.
const MAPPED: Record<StudioSourceRole, readonly string[]> = {
  main: ["url", "platform", "title", "description", "is_video", "image_path", "trim_start"],
  main_footage: [],
  footage: ["url", "platform", "title", "description", "is_video", "image_path", "trim_start"],
  comment: ["author", "text", "image_path"],
};

// Creative fields Studio cannot represent yet: reported whenever they carry a value.
const REPORTED: Record<StudioSourceRole, Readonly<Record<string, string>>> = {
  main: {
    profile: "Profile cards are not supported",
    mute_audio: "Per-clip mute is not supported",
    subtitle_blur: "Subtitle blur is not supported",
  },
  main_footage: {
    mode: "Main footage modes are not supported",
    package_manifest: "Main footage packages are not supported",
    external_sources_manifest: "External footage sources are not supported",
    coverage_target: "Footage coverage targets are not supported",
  },
  footage: {
    mute_audio: "Per-clip mute is not supported",
    subtitle_blur: "Subtitle blur is not supported",
  },
  comment: {
    likes: "Like counts are not shown",
    avatar_url: "Avatar images are not fetched",
    context: NARRATION_CONTEXT,
  },
};

// Search, analytics, and OCR bookkeeping that never reaches the rendered video.
const METADATA = new Set(["duration_sec", "snippet", "source", "published", "thumbnail", "views", "query", "relevance", "ocr"]);

const TOP_LEVEL: Readonly<Record<string, string | null>> = {
  main: null,
  main_footage: null,
  footage: null,
  comments: null,
  figures: NARRATION_CONTEXT,
  references: NARRATION_CONTEXT,
  discourse: NARRATION_CONTEXT,
  dossier: NARRATION_CONTEXT,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false || value === 0) return true;
  if (Array.isArray(value)) return value.every(isBlank);
  if (isRecord(value)) return Object.values(value).every(isBlank);
  return false;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new StudioSourceError(`${key} must be text`);
  return value.trim() || null;
}

function canonicalUrl(raw: string | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// Sorts object keys at every depth so equal values hash alike; arrays keep their order.
const sortedKeys = (_key: string, value: unknown) =>
  isRecord(value)
    ?Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value, sortedKeys)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function projectStudioSource(content: unknown): Promise<StudioSourceProjection> {
  if (!isRecord(content) || !isRecord(content.main)) throw new StudioSourceError("Content Set has no main post");
  const items: StudioSourceItem[] = [];
  const reported: { field: string; role: StudioSourceRole | null; order: number | null; reason: string; value: unknown }[] = [];
  const report = (field: string, role: StudioSourceRole | null, order: number | null, reason: string, value: unknown) =>
    reported.push({ field: FIELD_NAME.test(field) ? field : "unnamed_field", role, order, reason, value });

  const add = (role: StudioSourceRole, order: number, record: unknown) => {
    if (!isRecord(record)) throw new StudioSourceError(`${role} ${order + 1} is not an object`);
    for (const [key, value] of Object.entries(record)) {
      if (MAPPED[role].includes(key) || METADATA.has(key) || key.startsWith("ocr_") || isBlank(value)) continue;
      report(key, role, order, REPORTED[role][key] ?? UNRECOGNIZED, value);
    }
    if (role === "main_footage") {
      items.push({ role, order, title: null, text: null, platform: null, source_url: null, media_kind: "video", trim_start_seconds: null });
      return;
    }
    const comment = role === "comment";
    const bounded = (key: string, limit: number) => {
      const value = optionalString(record, key);
      if (value === null || value.length <= limit) return value;
      report(key, role, order, `Longer than ${limit} characters`, value);
      return null;
    };
    const title = bounded(comment ? "author" : "title", TITLE_LIMIT);
    const text = bounded(comment ? "text" : "description", TEXT_LIMIT);
    const platform = comment ? null : bounded("platform", 64);
    const imagePath = optionalString(record, "image_path");
    const url = comment ? null : optionalString(record, "url");
    const trim = record.trim_start;
    if (trim !== undefined && trim !== null && (typeof trim !== "number" || !Number.isFinite(trim) || trim < 0)) {
      throw new StudioSourceError(`${role} ${order + 1} has an invalid trim`);
    }
    const mediaKind = record.is_video === true ? "video" : imagePath || url ? "image" : "none";
    const trimmed = typeof trim === "number" && trim > 0;
    if (trimmed && mediaKind !== "video") report("trim_start", role, order, "Only a video can start at a trim", trim);
    items.push({
      role,
      order,
      title,
      text,
      platform,
      source_url: canonicalUrl(url),
      media_kind: mediaKind,
      trim_start_seconds: trimmed && mediaKind === "video" ? trim : null,
    });
  };

  const list = (key: string): unknown[] => {
    const value = content[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new StudioSourceError(`${key} must be a list`);
    return value;
  };

  add("main", 0, content.main);
  if (!isBlank(content.main_footage)) add("main_footage", 0, content.main_footage);
  list("footage").forEach((record, index) => add("footage", index, record));
  list("comments").forEach((record, index) => add("comment", index, record));
  for (const [key, value] of Object.entries(content)) {
    if (TOP_LEVEL[key] === null || isBlank(value)) continue;
    report(key, null, null, TOP_LEVEL[key] ?? UNRECOGNIZED, value);
  }
  if (items.length > MAX_ITEMS || reported.length > MAX_UNSUPPORTED) {
    throw new StudioSourceError("Content Set is too large for Studio import");
  }
  const unsupported = await Promise.all(
    reported.map(async ({ value, ...field }) => ({ ...field, value_digest: await digest(value) })),
  );
  return { items, unsupported };
}
