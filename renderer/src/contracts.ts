/**
 * The immutable input one render job is allowed to see, validated again here.
 *
 * The control plane already built and bounded this bundle, so this module is
 * the second of two independent checks: it accepts exactly the fields it knows,
 * refuses anything it does not, and never repeats a rejected value, so a
 * malformed bundle can neither widen a render nor describe itself in a log.
 */

export class RenderBundleInvalid extends Error {
  constructor() {
    super("render bundle invalid");
    this.name = "RenderBundleInvalid";
  }
}

/** Identical to the control plane's `OpaqueId`: one safe segment, never a path. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
/** One staged copy inside the job workspace, addressed by its workspace name. */
const STAGED_NAME = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;

const TRUSTED_TEMPLATE_ID = "vertical_text_story";
const TRUSTED_TEMPLATE_VERSION = 1;
const TRUSTED_PRESET_ID = "standard_vertical_mp4_v1";
const TRUSTED_COMPOSITION_ID = "advanced_timeline_v1";
const BUNDLE_VERSION = 1;

const MAX_ASSETS = 200;
const MAX_DIMENSION = 7680;
const MIN_DIMENSION = 16;
const MAX_FPS = 240;
/** Two hours at 30fps: far above any Creator Studio document, still bounded. */
const MAX_DURATION_IN_FRAMES = 216_000;

export type RenderBundleAsset = {
  readonly asset_id: string;
  readonly relative_name: string;
  readonly size_bytes: number;
  readonly checksum: string;
};

export type RenderBundle = {
  readonly bundle_version: 1;
  readonly render_job_id: string;
  readonly project_id: string;
  readonly document_id: string;
  readonly document_revision: number;
  readonly dispatch_id: string;
  readonly document: Record<string, unknown>;
  readonly template_id: "vertical_text_story";
  readonly template_version: 1;
  readonly preset_id: "standard_vertical_mp4_v1";
  readonly renderer_version: string;
  readonly composition_id: "advanced_timeline_v1";
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration_in_frames: number;
  readonly assets: readonly RenderBundleAsset[];
};

const BUNDLE_FIELDS = [
  "bundle_version",
  "render_job_id",
  "project_id",
  "document_id",
  "document_revision",
  "dispatch_id",
  "document",
  "template_id",
  "template_version",
  "preset_id",
  "renderer_version",
  "composition_id",
  "width",
  "height",
  "fps",
  "duration_in_frames",
  "assets",
] as const;

const ASSET_FIELDS = ["asset_id", "relative_name", "size_bytes", "checksum"] as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RenderBundleInvalid();
  }
  return value as Record<string, unknown>;
}

/** Exactly these keys, no more and no fewer: an extra field is a rejection. */
function exactly(value: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every((field) => field in value)) {
    throw new RenderBundleInvalid();
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new RenderBundleInvalid();
  }
  return value;
}

function bounded(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RenderBundleInvalid();
  }
  return value;
}

function literal<T>(value: unknown, expected: T): T {
  if (value !== expected) {
    throw new RenderBundleInvalid();
  }
  return expected;
}

function asset(value: unknown): RenderBundleAsset {
  const raw = record(value);
  exactly(raw, ASSET_FIELDS);
  if (typeof raw.relative_name !== "string" || !STAGED_NAME.test(raw.relative_name)) {
    throw new RenderBundleInvalid();
  }
  if (typeof raw.checksum !== "string" || !CHECKSUM.test(raw.checksum)) {
    throw new RenderBundleInvalid();
  }
  return Object.freeze({
    asset_id: identifier(raw.asset_id),
    relative_name: raw.relative_name,
    size_bytes: bounded(raw.size_bytes, 0, Number.MAX_SAFE_INTEGER),
    checksum: raw.checksum,
  });
}

/**
 * The document itself stays the control plane's contract; only the facts this
 * service acts on are re-checked, so the two sides cannot disagree about what
 * frame geometry a render was authorized to produce.
 */
function canvasOf(document: Record<string, unknown>): Record<string, unknown> {
  literal(document.schema_version, 2);
  const template = record(document.template);
  literal(template.template_id, TRUSTED_TEMPLATE_ID);
  literal(template.version, TRUSTED_TEMPLATE_VERSION);
  return record(document.canvas);
}

export function parseRenderBundle(value: unknown): RenderBundle {
  const raw = record(value);
  exactly(raw, BUNDLE_FIELDS);

  const document = record(raw.document);
  const canvas = canvasOf(document);
  const width = bounded(raw.width, MIN_DIMENSION, MAX_DIMENSION);
  const height = bounded(raw.height, MIN_DIMENSION, MAX_DIMENSION);
  const fps = bounded(raw.fps, 1, MAX_FPS);
  const durationInFrames = bounded(raw.duration_in_frames, 1, MAX_DURATION_IN_FRAMES);
  if (
    canvas.width !== width ||
    canvas.height !== height ||
    canvas.fps !== fps ||
    canvas.duration_in_frames !== durationInFrames
  ) {
    throw new RenderBundleInvalid();
  }

  if (!Array.isArray(raw.assets) || raw.assets.length > MAX_ASSETS) {
    throw new RenderBundleInvalid();
  }
  if (typeof raw.renderer_version !== "string" || raw.renderer_version.length > 64) {
    throw new RenderBundleInvalid();
  }

  return Object.freeze({
    bundle_version: literal(raw.bundle_version, BUNDLE_VERSION),
    render_job_id: identifier(raw.render_job_id),
    project_id: identifier(raw.project_id),
    document_id: identifier(raw.document_id),
    document_revision: bounded(raw.document_revision, 1, Number.MAX_SAFE_INTEGER),
    dispatch_id: identifier(raw.dispatch_id),
    document,
    template_id: literal(raw.template_id, TRUSTED_TEMPLATE_ID),
    template_version: literal(raw.template_version, TRUSTED_TEMPLATE_VERSION),
    preset_id: literal(raw.preset_id, TRUSTED_PRESET_ID),
    renderer_version: raw.renderer_version,
    composition_id: literal(raw.composition_id, TRUSTED_COMPOSITION_ID),
    width,
    height,
    fps,
    duration_in_frames: durationInFrames,
    assets: Object.freeze(raw.assets.map(asset)),
  });
}
