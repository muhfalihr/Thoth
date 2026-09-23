/**
 * The one released template this repository promises to keep rendering.
 *
 * A capsule is a tracked repository fixture: a document, its synthetic assets,
 * the frames worth comparing, and — once an operator has approved one — the
 * golden set those frames are compared against. It is read exactly like a
 * render bundle is read, by a parser that accepts only the fields it knows and
 * never repeats a rejected value, because a capsule is what decides whether a
 * preview and a render may be called equal.
 *
 * There is one release, it is named by an allowlist, and its directory is
 * derived from this module's own location. Nothing a caller supplies chooses a
 * capsule, a golden set, or a file inside either.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { isEditDocumentV2 } from "./document-schema";

export class ReleaseCapsuleInvalid extends Error {
  constructor() {
    super("template release capsule invalid");
    this.name = "ReleaseCapsuleInvalid";
  }
}

/** The whole allowlist. A second release is a code change, not a parameter. */
export type ReleaseIdentity = "vertical_text_story-v1";
const RELEASE_IDENTITIES = ["vertical_text_story-v1"] as const;

/** What each allowlisted identity is, restated so neither side can drift. */
const RELEASED_TEMPLATES: Record<ReleaseIdentity, { id: string; version: number }> = {
  "vertical_text_story-v1": { id: "vertical_text_story", version: 1 },
};

/** The trusted composition, the same literal the render contract pins. */
const TRUSTED_COMPOSITION_ID = "advanced-timeline-v1";

/** One plain file name inside the capsule: never a path, never a traversal. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** One asset, addressed exactly as the render bundle addresses a staged copy. */
const ASSET_NAME = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The repository's one canonical digest: lowercase hex, never a variant. */
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
/** A promoted golden set is addressed by the content it contains. */
const GOLDEN_SET = /^sha256-[0-9a-f]{64}$/;

const ASSETS_DIRECTORY = "assets";
const GOLDEN_SETS_DIRECTORY = "golden-sets";
const RELEASE_NAME = "release.json";
const GOLDEN_MANIFEST_NAME = "golden-manifest.json";

const MAX_ASSETS = 200;
const MAX_FRAMES = 64;

const RELEASE_FIELDS = [
  "schema_version",
  "template_id",
  "template_version",
  "composition_id",
  "document",
  "assets",
  "frames",
] as const;
const RELEASE_ASSET_FIELDS = ["asset_id", "file", "sha256"] as const;
const MANIFEST_FIELDS = ["schema_version", "golden_set", "frames"] as const;
const MANIFEST_FRAME_FIELDS = ["frame", "preview", "render"] as const;

export type ReleaseCapsuleAsset = {
  readonly asset_id: string;
  readonly file: string;
  readonly sha256: string;
  /** The resolved file, proven contained, real, and unlinked at load time. */
  readonly path: string;
};

export type GoldenFrame = {
  readonly frame: number;
  readonly preview: string;
  readonly render: string;
};

export type GoldenManifest = {
  readonly schema_version: 1;
  readonly golden_set: string;
  readonly frames: readonly GoldenFrame[];
  readonly directory: string;
};

export type ReleaseCapsule = {
  readonly identity: ReleaseIdentity;
  readonly template_id: string;
  readonly template_version: number;
  readonly composition_id: typeof TRUSTED_COMPOSITION_ID;
  readonly directory: string;
  readonly document: Record<string, unknown>;
  /** The exact bytes read, so a candidate can be bound to this document. */
  readonly document_sha256: string;
  readonly assets: readonly ReleaseCapsuleAsset[];
  readonly frames: readonly number[];
  /** Null until an operator has approved a set; that is a verdict, not a fault. */
  readonly goldens: GoldenManifest | null;
};

/**
 * Test-only seams, and only the two the design already allows: a temporary
 * canonical release root, so a parser test never writes into the repository.
 */
export type CapsuleTestDeps = {
  readonly releaseRoot?: string;
};

/**
 * Where the tracked capsules live, derived from this file and nothing else.
 *
 * Not an argument, not an environment variable, and not a working directory:
 * the released template is part of the repository, so its location is too.
 */
export function canonicalReleaseRoot(): string {
  return resolve(import.meta.dir, "..", "..", "packages", "remotion-composition", "releases");
}

export function releaseIdentityOf(value: string): ReleaseIdentity {
  const identity = RELEASE_IDENTITIES.find((allowed) => allowed === value);
  if (identity === undefined) {
    throw new ReleaseCapsuleInvalid();
  }
  return identity;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReleaseCapsuleInvalid();
  }
  return value as Record<string, unknown>;
}

/** Exactly these keys, no more and no fewer: an extra field is a rejection. */
function exactly(value: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every((field) => field in value)) {
    throw new ReleaseCapsuleInvalid();
  }
}

function literal<T>(value: unknown, expected: T): T {
  if (value !== expected) {
    throw new ReleaseCapsuleInvalid();
  }
  return expected;
}

function matching(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ReleaseCapsuleInvalid();
  }
  return value;
}

function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new ReleaseCapsuleInvalid();
  }
  return value;
}

/**
 * Refuse a target that is not below the capsule, or is reached through a link.
 *
 * Containment is proven from the resolved path rather than inferred from the
 * name that produced it, so a name this module stops matching one day still
 * cannot address a file outside the release it belongs to.
 */
async function assertLinkFree(base: string, path: string): Promise<void> {
  if (!path.startsWith(base + sep)) {
    throw new ReleaseCapsuleInvalid();
  }
  let current = base;
  for (const segment of path.slice(base.length + 1).split(sep)) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch {
      throw new ReleaseCapsuleInvalid();
    }
    if (info.isSymbolicLink()) {
      throw new ReleaseCapsuleInvalid();
    }
  }
}

async function assertRegularFile(base: string, path: string): Promise<void> {
  await assertLinkFree(base, path);
  const info = await lstat(path).catch(() => {
    throw new ReleaseCapsuleInvalid();
  });
  if (!info.isFile()) {
    throw new ReleaseCapsuleInvalid();
  }
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readJson(base: string, path: string): Promise<unknown> {
  await assertRegularFile(base, path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ReleaseCapsuleInvalid();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseCapsuleInvalid();
  }
}

/** The frames worth comparing: ascending, distinct, and inside the timeline. */
function framesOf(value: unknown, durationInFrames: number): readonly number[] {
  const raw = list(value, MAX_FRAMES);
  const frames: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      throw new ReleaseCapsuleInvalid();
    }
    if (entry >= durationInFrames) {
      throw new ReleaseCapsuleInvalid();
    }
    const previous = frames.at(-1);
    if (previous !== undefined && entry <= previous) {
      throw new ReleaseCapsuleInvalid();
    }
    frames.push(entry);
  }
  return Object.freeze(frames);
}

/**
 * The document is validated against the control plane's own published schema,
 * then bound to the release carrying it, so the identity, the capsule, and the
 * composition cannot disagree about what is being rendered.
 */
function documentOf(value: unknown, templateId: string, templateVersion: number) {
  const document = record(value);
  if (!isEditDocumentV2(document)) {
    throw new ReleaseCapsuleInvalid();
  }
  const template = record(document.template);
  literal(template.template_id, templateId);
  literal(template.version, templateVersion);
  const canvas = record(document.canvas);
  if (typeof canvas.duration_in_frames !== "number" || canvas.duration_in_frames < 1) {
    throw new ReleaseCapsuleInvalid();
  }
  return { document, durationInFrames: canvas.duration_in_frames };
}

/** Every declared asset is present and unchanged, and no other asset exists. */
async function assetsOf(
  directory: string,
  value: unknown,
): Promise<readonly ReleaseCapsuleAsset[]> {
  const raw = list(value, MAX_ASSETS);
  const assets: ReleaseCapsuleAsset[] = [];
  const declared = new Set<string>();

  for (const entry of raw) {
    const asset = record(entry);
    exactly(asset, RELEASE_ASSET_FIELDS);
    const file = matching(asset.file, ASSET_NAME);
    const name = file.slice(`${ASSETS_DIRECTORY}/`.length);
    if (declared.has(name)) {
      throw new ReleaseCapsuleInvalid();
    }
    declared.add(name);

    const path = join(directory, ASSETS_DIRECTORY, name);
    await assertRegularFile(directory, path);
    const sha256 = matching(asset.sha256, CHECKSUM);
    if ((await digestOf(path)) !== sha256) {
      throw new ReleaseCapsuleInvalid();
    }
    assets.push(
      Object.freeze({
        asset_id: matching(asset.asset_id, PLAIN_NAME),
        file,
        sha256,
        path,
      }),
    );
  }

  // A file the capsule never declared is a rejection, not an ignored extra:
  // an undeclared asset is an unchecked input the composition could still read.
  let present: string[];
  try {
    present = await readdir(join(directory, ASSETS_DIRECTORY));
  } catch {
    throw new ReleaseCapsuleInvalid();
  }
  if (present.length !== declared.size || !present.every((name) => declared.has(name))) {
    throw new ReleaseCapsuleInvalid();
  }
  return Object.freeze(assets);
}

/**
 * The approved golden set, if one has been promoted.
 *
 * An absent manifest is the ordinary state of a release nobody has approved
 * yet, so it is reported as no goldens. A manifest that exists but does not
 * describe exactly this release's frames, or names a set that is not there, is
 * a fault: it would otherwise let a comparison pass against the wrong pixels.
 */
async function goldensOf(
  directory: string,
  frames: readonly number[],
): Promise<GoldenManifest | null> {
  const path = join(directory, GOLDEN_MANIFEST_NAME);
  if (!(await lstat(path).catch(() => null))) {
    return null;
  }

  const manifest = record(await readJson(directory, path));
  exactly(manifest, MANIFEST_FIELDS);
  literal(manifest.schema_version, 1);
  const set = matching(manifest.golden_set, GOLDEN_SET);
  const setDirectory = join(directory, GOLDEN_SETS_DIRECTORY, set);
  await assertLinkFree(directory, setDirectory);
  const setInfo = await lstat(setDirectory).catch(() => null);
  if (!setInfo?.isDirectory()) {
    throw new ReleaseCapsuleInvalid();
  }

  const raw = list(manifest.frames, MAX_FRAMES);
  if (raw.length !== frames.length) {
    throw new ReleaseCapsuleInvalid();
  }
  const golden: GoldenFrame[] = [];
  for (const [index, entry] of raw.entries()) {
    const value = record(entry);
    exactly(value, MANIFEST_FRAME_FIELDS);
    literal(value.frame, frames[index]);
    const preview = matching(value.preview, PLAIN_NAME);
    const render = matching(value.render, PLAIN_NAME);
    await assertRegularFile(directory, join(setDirectory, preview));
    await assertRegularFile(directory, join(setDirectory, render));
    golden.push(Object.freeze({ frame: frames[index]!, preview, render }));
  }

  return Object.freeze({
    schema_version: 1 as const,
    golden_set: set,
    frames: Object.freeze(golden),
    directory: setDirectory,
  });
}

/**
 * Read the one capsule an identity names, or refuse it whole.
 *
 * Nothing partial is returned: a capsule whose assets, frames, or goldens do
 * not agree with each other is not a capsule with a problem, it is not a
 * capsule, because every later step would treat it as trustworthy input.
 */
export async function loadReleaseCapsule(
  identity: ReleaseIdentity,
  deps: CapsuleTestDeps = {},
): Promise<ReleaseCapsule> {
  const release = releaseIdentityOf(identity);
  const template = RELEASED_TEMPLATES[release];
  const root = deps.releaseRoot === undefined ? canonicalReleaseRoot() : resolve(deps.releaseRoot);
  const directory = join(root, release);

  const raw = record(await readJson(root, join(directory, RELEASE_NAME)));
  exactly(raw, RELEASE_FIELDS);
  literal(raw.schema_version, 1);
  literal(raw.template_id, template.id);
  literal(raw.template_version, template.version);
  literal(raw.composition_id, TRUSTED_COMPOSITION_ID);

  const documentPath = join(directory, matching(raw.document, PLAIN_NAME));
  const { document, durationInFrames } = documentOf(
    await readJson(directory, documentPath),
    template.id,
    template.version,
  );
  const frames = framesOf(raw.frames, durationInFrames);

  return Object.freeze({
    identity: release,
    template_id: template.id,
    template_version: template.version,
    composition_id: TRUSTED_COMPOSITION_ID,
    directory,
    document,
    document_sha256: await digestOf(documentPath),
    assets: await assetsOf(directory, raw.assets),
    frames,
    goldens: await goldensOf(directory, frames),
  });
}
