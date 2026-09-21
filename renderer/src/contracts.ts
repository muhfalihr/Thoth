/**
 * The immutable input one render job is allowed to see, validated again here.
 *
 * The control plane already built and bounded this bundle, so this module is
 * the second of two independent checks: it accepts exactly the fields it knows,
 * refuses anything it does not, and never repeats a rejected value, so a
 * malformed bundle can neither widen a render nor describe itself in a log.
 */

// The timeline module alone, so validating a bundle never drags React and
// Remotion into this service's process.
import { hasAudibleContent } from "@thoth/remotion-composition/timeline";
import type { EditDocumentV2 } from "@thoth/remotion-composition/timeline";

import type { ExpectedOutput } from "./artifact-root";
import { isEditDocumentV2 } from "./document-schema";

export class RenderBundleInvalid extends Error {
  constructor() {
    super("render bundle invalid");
    this.name = "RenderBundleInvalid";
  }
}

/** Identical to the control plane's `OpaqueId`: one safe segment, never a path. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
/** The control plane's `ProjectId`, which also admits a stored UUID. */
const PROJECT_ID =
  /^(?:[A-Za-z][A-Za-z0-9_-]{0,127}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** One staged copy inside the job workspace, addressed by its workspace name. */
const STAGED_NAME = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The control plane's one canonical digest: lowercase hex, never a variant. */
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;

const TRUSTED_TEMPLATE_ID = "vertical_text_story";
const TRUSTED_TEMPLATE_VERSION = 1;
const TRUSTED_PRESET_ID = "standard_vertical_mp4_v1";
const TRUSTED_COMPOSITION_ID = "advanced-timeline-v1";
const BUNDLE_VERSION = 1;

const MAX_ASSETS = 200;
const MAX_DIMENSION = 7680;
const MIN_DIMENSION = 16;
const MAX_FPS = 240;
/** Two hours at 30fps: far above any Creator Studio document, still bounded. */
const MAX_DURATION_IN_FRAMES = 216_000;
/** The control plane's own `RENDER_ASSET_MAX_BYTES`, restated, not configured. */
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;

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
  readonly composition_id: "advanced-timeline-v1";
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
    size_bytes: bounded(raw.size_bytes, 1, MAX_ASSET_BYTES),
    checksum: raw.checksum,
  });
}

/**
 * The document is validated against the control plane's own published schema,
 * then re-bound to the bundle carrying it, so the two sides cannot disagree
 * about which revision a render was authorized to produce.
 */
function documentOf(raw: Record<string, unknown>): Record<string, unknown> {
  const document = record(raw.document);
  if (!isEditDocumentV2(document)) {
    throw new RenderBundleInvalid();
  }
  const template = record(document.template);
  literal(template.template_id, TRUSTED_TEMPLATE_ID);
  literal(template.version, TRUSTED_TEMPLATE_VERSION);
  if (
    document.project_id !== raw.project_id ||
    document.document_id !== raw.document_id ||
    document.revision !== raw.document_revision
  ) {
    throw new RenderBundleInvalid();
  }
  return document;
}

/** Exactly the assets the document's clips play, one staged copy each. */
function bindAssets(
  document: Record<string, unknown>,
  assets: readonly RenderBundleAsset[],
): void {
  const played = new Set(
    ((document.clips ?? []) as readonly Record<string, unknown>[])
      .map((clip) => clip.asset_id)
      .filter((assetId): assetId is string => typeof assetId === "string"),
  );
  const staged = new Set(assets.map((entry) => entry.asset_id));
  const names = new Set(assets.map((entry) => entry.relative_name));
  if (staged.size !== assets.length || names.size !== assets.length || staged.size !== played.size) {
    throw new RenderBundleInvalid();
  }
  for (const assetId of played) {
    if (!staged.has(assetId)) {
      throw new RenderBundleInvalid();
    }
  }
}

/** What the dispatch this bundle answers said it was for. */
export type BundleIdentity = {
  readonly renderJobId: string;
  readonly dispatchId: string;
  readonly rendererVersion: string;
};

export function parseRenderBundle(value: unknown, expected: BundleIdentity): RenderBundle {
  const raw = record(value);
  exactly(raw, BUNDLE_FIELDS);

  // A bundle that is not this dispatch's, or not this build's, is refused
  // before anything is prepared, let alone rendered.
  if (
    raw.render_job_id !== expected.renderJobId ||
    raw.dispatch_id !== expected.dispatchId ||
    raw.renderer_version !== expected.rendererVersion
  ) {
    throw new RenderBundleInvalid();
  }

  const document = documentOf(raw);
  const canvas = record(document.canvas);
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
  const assets = Object.freeze(raw.assets.map(asset));
  bindAssets(document, assets);

  if (typeof raw.project_id !== "string" || !PROJECT_ID.test(raw.project_id)) {
    throw new RenderBundleInvalid();
  }

  return Object.freeze({
    bundle_version: literal(raw.bundle_version, BUNDLE_VERSION),
    render_job_id: identifier(raw.render_job_id),
    project_id: raw.project_id,
    document_id: identifier(raw.document_id),
    document_revision: bounded(raw.document_revision, 1, Number.MAX_SAFE_INTEGER),
    dispatch_id: identifier(raw.dispatch_id),
    document,
    template_id: literal(raw.template_id, TRUSTED_TEMPLATE_ID),
    template_version: literal(raw.template_version, TRUSTED_TEMPLATE_VERSION),
    preset_id: literal(raw.preset_id, TRUSTED_PRESET_ID),
    renderer_version: expected.rendererVersion,
    composition_id: literal(raw.composition_id, TRUSTED_COMPOSITION_ID),
    width,
    height,
    fps,
    duration_in_frames: durationInFrames,
    assets,
  });
}

/**
 * What a finished render of this bundle must look like.
 *
 * Audio is decided by the same helper the composition itself uses, so the
 * expectation cannot disagree with what the browser is about to draw.
 */
export function expectedOutputOf(bundle: RenderBundle): ExpectedOutput {
  return Object.freeze({
    width: bundle.width,
    height: bundle.height,
    fps: bundle.fps,
    durationInFrames: bundle.duration_in_frames,
    hasAudio: hasAudibleContent(bundle.document as unknown as EditDocumentV2),
  });
}
