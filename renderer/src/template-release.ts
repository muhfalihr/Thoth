/**
 * One verification run of the one released template.
 *
 * The phases are ordered so that nothing is ever compared against something
 * that has not been proven first: the capsule is validated, a run directory is
 * reserved, both surfaces are captured, the pair is compared, the approved
 * goldens are compared, a contact sheet is drawn, and only then is one report
 * written whole.
 *
 * The report is the machine gate, so it says as little as it can: public
 * release identity, frame numbers, fixture-relative names, synthetic digests,
 * numeric metrics, and one fixed verdict. It never carries a path from this
 * machine, an environment value, or anything a failing process said.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";

import type { RendererArtifactRoot, TemplateReleaseRun } from "./artifact-root";
import type { CapturedFrame } from "./release-capture";
import {
  loadReleaseCapsule,
  releaseIdentityOf,
  type ReleaseCapsule,
  type ReleaseIdentity,
} from "./release-capsule";
import {
  ImageUnreadable,
  comparePixels,
  decodeCanonicalRgba,
  readImageFacts,
  runFfmpeg,
  writeContactSheet,
  writeDiffImage,
  type ContactRow,
  type Geometry,
  type ImageFacts,
  type PixelComparison,
  type RunFfmpeg,
} from "./release-compare";

export class ReportUnsafe extends Error {
  constructor() {
    super("release report carries something it may not");
    this.name = "ReportUnsafe";
  }
}

/** A check that failed about what this run is, rather than about its pixels. */
class ContractFailed extends Error {
  constructor() {
    super("release contract failed");
    this.name = "ContractFailed";
  }
}

export type ReleaseVerdict =
  | "pass"
  | "review_required"
  | "visual_mismatch"
  | "contract_failed"
  | "capture_failed"
  | "golden_missing";

/**
 * Worst wins. A missing approval outranks a pixel that merely moved, and a
 * broken capture or contract outranks any comparison, because neither produced
 * a comparison worth believing.
 */
const VERDICT_ORDER: readonly ReleaseVerdict[] = [
  "pass",
  "review_required",
  "golden_missing",
  "visual_mismatch",
  "capture_failed",
  "contract_failed",
];

/** Digests and build identities, or the word for not having one. */
const UNKNOWN = "unknown";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RENDERER_VERSION = /^remotion-[0-9]+\.[0-9]+\.[0-9]+$/;

/** What a safe report string may not be: a place, a host, or an essay. */
const ABSOLUTE = /^[/\\]|^[A-Za-z]:[\\/]/;
const SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
const MAX_STRING = 256;

export type ReferenceImage = {
  readonly base_digest: string;
  readonly image_id: string;
  readonly renderer_version: string;
};

export type FrameReport = {
  readonly frame: number;
  readonly preview: ImageFacts;
  readonly render: ImageFacts;
  readonly pair: PixelComparison;
  readonly golden: { readonly preview: PixelComparison; readonly render: PixelComparison } | null;
};

export type ReleaseReport = {
  readonly schema_version: 1;
  readonly release: ReleaseIdentity;
  readonly run_id: string;
  readonly verdict: ReleaseVerdict;
  readonly reference_image: ReferenceImage;
  readonly composition: {
    readonly composition_id: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly duration_in_frames: number;
  };
  readonly capsule: {
    readonly template_id: string;
    readonly template_version: number;
    readonly document_sha256: string;
    readonly assets: readonly { asset_id: string; file: string; sha256: string }[];
    readonly frames: readonly number[];
  };
  readonly golden_set: string | null;
  readonly frames: readonly FrameReport[];
};

export type CaptureFrames = (options: {
  capsule: ReleaseCapsule;
  run: TemplateReleaseRun;
}) => Promise<readonly CapturedFrame[]>;

/**
 * The seams the design already allows: the two surfaces, the decoder process,
 * a temporary canonical release root, and the environment this run reads its
 * own build identity from.
 */
export type VerifyDeps = {
  readonly capture?: CaptureFrames;
  readonly ffmpeg?: RunFfmpeg;
  readonly releaseRoot?: string;
  readonly environment?: Record<string, string | undefined>;
};

/**
 * Capture this release's frames on both surfaces and report whether they are
 * the same picture, and whether that picture is the approved one.
 *
 * Only `pass` is a success. Every other verdict leaves a complete candidate an
 * operator can look at, which is the point of the run.
 */
export async function verifyRelease(
  identity: ReleaseIdentity,
  artifacts: RendererArtifactRoot,
  deps: VerifyDeps = {},
): Promise<ReleaseReport> {
  const ffmpeg = deps.ffmpeg ?? runFfmpeg;
  const capture = deps.capture ?? defaultCapture;

  // Phase one: the capsule. A release nobody can validate is not verified
  // against, and no run directory is reserved for it.
  const capsule = await loadReleaseCapsule(releaseIdentityOf(identity), {
    releaseRoot: deps.releaseRoot,
  });
  const canvas = canvasOf(capsule);

  const run = await artifacts.createTemplateReleaseRun(capsule.identity, newRunId());
  const frames: FrameReport[] = [];
  const rows: ContactRow[] = [];
  let verdict: ReleaseVerdict = capsule.goldens === null ? "golden_missing" : "pass";

  try {
    const captured = await capture({ capsule, run });
    assertCaptureAnswersTheRequest(captured, capsule, run);

    for (const entry of captured) {
      const preview = await facts(entry.preview, canvas);
      const render = await facts(entry.render, canvas);
      const drawn = {
        preview: await decodeCanonicalRgba(entry.preview, canvas, ffmpeg),
        render: await decodeCanonicalRgba(entry.render, canvas, ffmpeg),
      };

      const pair = comparePixels(drawn.preview, drawn.render);
      let diff: string | null = null;
      if (pair.verdict !== "pass") {
        diff = run.diffFrame(entry.frame);
        await writeDiffImage(drawn.preview, drawn.render, canvas, diff, ffmpeg);
      }
      verdict = worse(verdict, pair.verdict);

      const golden = await compareGoldens(capsule, entry.frame, drawn, canvas, ffmpeg);
      if (golden !== null) {
        verdict = worse(verdict, worse(golden.preview.verdict, golden.render.verdict));
      }

      frames.push(Object.freeze({ frame: entry.frame, preview, render, pair, golden }));
      rows.push({ frame: entry.frame, preview: entry.preview, render: entry.render, diff });
    }

    // Phase six: one sheet for the operator who has to look at all of it.
    await writeContactSheet(rows, canvas, run.contactSheet, ffmpeg);
  } catch (error) {
    verdict = worse(verdict, failureOf(error));
  }

  const report = buildReport(capsule, run, canvas, verdict, frames, deps.environment);
  assertSafeReport(report);
  await run.writeReport(report);
  return report;
}

/**
 * Refuse a report that names this machine.
 *
 * The check is on the serialized value rather than on the code that built it,
 * because the report is what leaves the container, and a field added later is
 * exactly the one nobody would think to check.
 */
export function assertSafeReport(report: unknown, depth = 0): void {
  if (depth > 8) {
    throw new ReportUnsafe();
  }
  if (report === null || typeof report === "boolean") {
    return;
  }
  if (typeof report === "number") {
    if (!Number.isFinite(report)) {
      throw new ReportUnsafe();
    }
    return;
  }
  if (typeof report === "string") {
    if (report.length > MAX_STRING || ABSOLUTE.test(report) || SCHEME.test(report)) {
      throw new ReportUnsafe();
    }
    return;
  }
  if (Array.isArray(report)) {
    for (const entry of report) {
      assertSafeReport(entry, depth + 1);
    }
    return;
  }
  if (typeof report === "object") {
    for (const [key, value] of Object.entries(report)) {
      assertSafeReport(key, depth + 1);
      assertSafeReport(value, depth + 1);
    }
    return;
  }
  throw new ReportUnsafe();
}

/** The real capture, loaded only when one is actually going to happen. */
const defaultCapture: CaptureFrames = async (options) => {
  const { captureReleaseFrames } = await import("./release-capture");
  return captureReleaseFrames(options);
};

function newRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`;
}

function worse(left: ReleaseVerdict, right: ReleaseVerdict): ReleaseVerdict {
  return VERDICT_ORDER.indexOf(left) >= VERDICT_ORDER.indexOf(right) ? left : right;
}

/** What a thrown phase means to the gate, and nothing about what it said. */
function failureOf(error: unknown): ReleaseVerdict {
  if (error instanceof ContractFailed) {
    return "contract_failed";
  }
  // `CaptureIncomplete` is named rather than imported: the browser half of this
  // module is loaded only when a real capture runs.
  if (error instanceof ImageUnreadable || (error as Error)?.name === "CaptureIncomplete") {
    return "capture_failed";
  }
  throw error;
}

function canvasOf(capsule: ReleaseCapsule): Geometry & { fps: number; duration_in_frames: number } {
  const canvas = capsule.document.canvas as {
    width: number;
    height: number;
    fps: number;
    duration_in_frames: number;
  };
  return Object.freeze({
    width: canvas.width,
    height: canvas.height,
    fps: canvas.fps,
    duration_in_frames: canvas.duration_in_frames,
  });
}

/**
 * The capture must answer the request it was given: every declared frame, in
 * order, at the paths this run owns. A surface that returns something else has
 * not captured this release, whatever it put on disk.
 */
function assertCaptureAnswersTheRequest(
  captured: readonly CapturedFrame[],
  capsule: ReleaseCapsule,
  run: TemplateReleaseRun,
): void {
  if (captured.length !== capsule.frames.length) {
    throw new ContractFailed();
  }
  for (const [index, entry] of captured.entries()) {
    const frame = capsule.frames[index]!;
    if (
      entry.frame !== frame ||
      entry.preview !== run.previewFrame(frame) ||
      entry.render !== run.renderFrame(frame)
    ) {
      throw new ContractFailed();
    }
  }
}

/** A captured frame is the frame that was asked for, or it is not compared. */
async function facts(path: string, canvas: Geometry): Promise<ImageFacts> {
  let image: ImageFacts;
  try {
    image = await readImageFacts(path);
  } catch {
    throw new ImageUnreadable();
  }
  if (image.width !== canvas.width || image.height !== canvas.height) {
    throw new ContractFailed();
  }
  return image;
}

async function compareGoldens(
  capsule: ReleaseCapsule,
  frame: number,
  drawn: { preview: Uint8Array; render: Uint8Array },
  canvas: Geometry,
  ffmpeg: RunFfmpeg,
): Promise<FrameReport["golden"]> {
  const goldens = capsule.goldens;
  if (goldens === null) {
    return null;
  }
  const approved = goldens.frames.find((entry) => entry.frame === frame);
  if (approved === undefined) {
    throw new ContractFailed();
  }
  const at = (name: string) => join(goldens.directory, name);
  return Object.freeze({
    preview: comparePixels(
      drawn.preview,
      await decodeCanonicalRgba(at(approved.preview), canvas, ffmpeg),
    ),
    render: comparePixels(
      drawn.render,
      await decodeCanonicalRgba(at(approved.render), canvas, ffmpeg),
    ),
  });
}

function buildReport(
  capsule: ReleaseCapsule,
  run: TemplateReleaseRun,
  canvas: Geometry & { fps: number; duration_in_frames: number },
  verdict: ReleaseVerdict,
  frames: readonly FrameReport[],
  environment: Record<string, string | undefined> = process.env,
): ReleaseReport {
  return Object.freeze({
    schema_version: 1 as const,
    release: capsule.identity,
    run_id: run.runId,
    verdict,
    reference_image: referenceImageOf(environment),
    composition: Object.freeze({
      composition_id: capsule.composition_id,
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      duration_in_frames: canvas.duration_in_frames,
    }),
    capsule: Object.freeze({
      template_id: capsule.template_id,
      template_version: capsule.template_version,
      document_sha256: capsule.document_sha256,
      assets: capsule.assets.map((asset) =>
        Object.freeze({ asset_id: asset.asset_id, file: asset.file, sha256: asset.sha256 }),
      ),
      frames: capsule.frames,
    }),
    golden_set: capsule.goldens?.golden_set ?? null,
    frames,
  });
}

/** An identity is reported only in the shape it is supposed to have. */
function allowed(value: string | undefined, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : UNKNOWN;
}

/**
 * The identity of the image this process is running in.
 *
 * Verification reports it and promotion compares against it, so both sides read
 * the same three values through the same filter and in the same order.
 */
function referenceImageOf(environment: Record<string, string | undefined>): ReferenceImage {
  return Object.freeze({
    base_digest: allowed(environment.THOTH_F1_BASE_DIGEST, DIGEST),
    image_id: allowed(environment.THOTH_F1_IMAGE_ID, DIGEST),
    renderer_version: allowed(environment.THOTH_RENDERER_VERSION, RENDERER_VERSION),
  });
}

/**
 * Promote one verified candidate into the release's approved golden set.
 *
 * Promotion is an operator action, so everything it trusts is revalidated here
 * rather than assumed from the run that produced it: the capsule is loaded
 * again, the report is checked against it field by field, and every candidate
 * frame is re-digested from disk. The set is then written whole under a name
 * derived from its own contents, and only a same-directory rename makes it the
 * approved one. A promotion that cannot finish leaves the release exactly as it
 * found it.
 *
 * Nothing here takes a path. The release is an allowlisted identity and the run
 * is an identifier the artifact root resolves.
 */

export class PromotionRefused extends Error {
  constructor() {
    super("template release promotion refused");
    this.name = "PromotionRefused";
  }
}

const GOLDEN_SETS = "golden-sets";
const GOLDEN_MANIFEST = "golden-manifest.json";
const INCOMING = ".incoming";
const FRAME_DIGITS = 6;

/** A capture nobody can believe is never approved, whatever an operator meant. */
const UNPROMOTABLE: readonly ReleaseVerdict[] = ["contract_failed", "capture_failed"];

/**
 * The failure seams this design already allows: the copy, the durability
 * barrier, and the rename. Tests inject failures there because those are the
 * three steps whose partial success would be a corrupted release.
 */
export type PromotionTestDeps = {
  readonly releaseRoot?: string;
  readonly environment?: Record<string, string | undefined>;
  readonly copy?: (from: string, to: string) => Promise<void>;
  readonly sync?: (path: string) => Promise<void>;
  readonly swap?: (from: string, to: string) => Promise<void>;
};

type CandidateFrame = {
  readonly frame: number;
  readonly preview: string;
  readonly render: string;
  readonly digests: { readonly preview: string; readonly render: string };
};

export async function promoteRelease(
  identity: ReleaseIdentity,
  artifacts: RendererArtifactRoot,
  runId: string,
  deps: PromotionTestDeps = {},
): Promise<void> {
  const copy = deps.copy ?? copyFile;
  const sync = deps.sync ?? syncPath;
  const swap = deps.swap ?? rename;

  const capsule = await loadReleaseCapsule(releaseIdentityOf(identity), {
    releaseRoot: deps.releaseRoot,
  });
  const canvas = canvasOf(capsule);
  const run = await artifacts.createTemplateReleaseRun(capsule.identity, identifier(runId));

  const report = await candidateReport(
    run.report,
    capsule,
    canvas,
    run.runId,
    deps.environment ?? process.env,
  );
  const frames = await candidateFrames(report, capsule, run, canvas);
  const set = `sha256-${addressOf(frames)}`;
  const sets = join(capsule.directory, GOLDEN_SETS);
  const target = join(sets, set);

  const existing = await lstat(target).catch(() => null);
  if (existing !== null) {
    // The same pixels under the same name are the state that is already there.
    // Anything else under it is someone's promotion being overwritten.
    if (!existing.isDirectory()) {
      throw new PromotionRefused();
    }
    await assertSetHolds(target, frames);
    await approve(capsule.directory, set, frames, sync, swap, null);
    return;
  }

  const staging = `${target}${INCOMING}`;
  try {
    await mkdir(sets, { recursive: true, mode: 0o755 });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o755 });
    for (const frame of frames) {
      for (const surface of ["preview", "render"] as const) {
        const written = join(staging, surfaceName(frame.frame, surface));
        await copy(frame[surface], written);
        await sync(written);
      }
    }
    await sync(staging);
    await swap(staging, target);
  } catch {
    await rm(staging, { recursive: true, force: true });
    throw new PromotionRefused();
  }

  await approve(capsule.directory, set, frames, sync, swap, target);
}

/** Make one set the approved one, or leave the release with the set it had. */
async function approve(
  directory: string,
  set: string,
  frames: readonly CandidateFrame[],
  sync: (path: string) => Promise<void>,
  swap: (from: string, to: string) => Promise<void>,
  created: string | null,
): Promise<void> {
  const manifest = {
    schema_version: 1,
    golden_set: set,
    frames: frames.map((frame) => ({
      frame: frame.frame,
      preview: surfaceName(frame.frame, "preview"),
      render: surfaceName(frame.frame, "render"),
    })),
  };
  const path = join(directory, GOLDEN_MANIFEST);
  const staging = `${path}${INCOMING}`;

  try {
    await writeFile(staging, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    await sync(staging);
    await swap(staging, path);
    await sync(directory);
  } catch {
    await rm(staging, { force: true });
    // A set nobody approved is not a set: it goes back out with the promotion.
    if (created !== null) {
      await rm(created, { recursive: true, force: true });
    }
    throw new PromotionRefused();
  }
}

/**
 * The report of the run being promoted, checked against the capsule as it is
 * now rather than as it was when the candidate was drawn.
 */
async function candidateReport(
  path: string,
  capsule: ReleaseCapsule,
  canvas: Geometry & { fps: number; duration_in_frames: number },
  runId: string,
  environment: Record<string, string | undefined>,
): Promise<ReleaseReport> {
  let report: ReleaseReport;
  try {
    report = JSON.parse(await readFile(path, "utf8")) as ReleaseReport;
  } catch {
    throw new PromotionRefused();
  }
  if (typeof report !== "object" || report === null) {
    throw new PromotionRefused();
  }
  if (report.schema_version !== 1 || report.release !== capsule.identity) {
    throw new PromotionRefused();
  }
  if (report.run_id !== runId) {
    throw new PromotionRefused();
  }
  if (UNPROMOTABLE.includes(report.verdict) || !VERDICT_ORDER.includes(report.verdict)) {
    throw new PromotionRefused();
  }
  // Only the image that drew a candidate may approve it. An environment that
  // cannot name itself approves nothing, and a candidate from another image is
  // not this image's evidence however well formed its identity is.
  const active = referenceImageOf(environment);
  if (Object.values(active).includes(UNKNOWN)) {
    throw new PromotionRefused();
  }
  if (JSON.stringify(report.reference_image) !== JSON.stringify(active)) {
    throw new PromotionRefused();
  }
  if (
    JSON.stringify(report.composition) !==
    JSON.stringify({
      composition_id: capsule.composition_id,
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      duration_in_frames: canvas.duration_in_frames,
    })
  ) {
    throw new PromotionRefused();
  }
  // The fixtures the candidate was drawn against are the fixtures on disk now.
  if (
    JSON.stringify(report.capsule) !==
    JSON.stringify({
      template_id: capsule.template_id,
      template_version: capsule.template_version,
      document_sha256: capsule.document_sha256,
      assets: capsule.assets.map((asset) => ({
        asset_id: asset.asset_id,
        file: asset.file,
        sha256: asset.sha256,
      })),
      frames: capsule.frames,
    })
  ) {
    throw new PromotionRefused();
  }
  return report;
}

/**
 * Every declared frame, present at the path this run owns, unchanged since the
 * report vouched for it, and with nothing else beside it.
 */
async function candidateFrames(
  report: ReleaseReport,
  capsule: ReleaseCapsule,
  run: TemplateReleaseRun,
  canvas: Geometry,
): Promise<readonly CandidateFrame[]> {
  if (!Array.isArray(report.frames) || report.frames.length !== capsule.frames.length) {
    throw new PromotionRefused();
  }

  const frames: CandidateFrame[] = [];
  for (const [index, entry] of report.frames.entries()) {
    const frame = capsule.frames[index]!;
    // Both surfaces drew the same picture, or there is nothing to approve.
    if (entry?.frame !== frame || entry.pair?.verdict !== "pass") {
      throw new PromotionRefused();
    }
    const preview = run.previewFrame(frame);
    const render = run.renderFrame(frame);
    frames.push({
      frame,
      preview,
      render,
      digests: {
        preview: await candidateFile(run.directory, preview, entry.preview, canvas),
        render: await candidateFile(run.directory, render, entry.render, canvas),
      },
    });
  }

  // A surface directory holding more than the declared frames is a run whose
  // contents nobody vouched for.
  for (const surface of ["preview", "render"] as const) {
    const present = await readdir(join(run.directory, surface)).catch(() => {
      throw new PromotionRefused();
    });
    const declared = frames.map((frame) => frameName(frame.frame));
    if (present.length !== declared.length || !present.every((name) => declared.includes(name))) {
      throw new PromotionRefused();
    }
  }

  return Object.freeze(frames);
}

/** One candidate file: contained, unlinked, whole, and the one that was reported. */
async function candidateFile(
  base: string,
  path: string,
  reported: ImageFacts | undefined,
  canvas: Geometry,
): Promise<string> {
  await assertUnlinked(base, path);
  let facts: ImageFacts;
  try {
    facts = await readImageFacts(path);
  } catch {
    throw new PromotionRefused();
  }
  if (facts.width !== canvas.width || facts.height !== canvas.height) {
    throw new PromotionRefused();
  }
  if (facts.sha256 !== reported?.sha256 || facts.bytes !== reported.bytes) {
    throw new PromotionRefused();
  }
  return facts.sha256;
}

/** Nothing on the way to a candidate is a link, and the candidate is a file. */
async function assertUnlinked(base: string, path: string): Promise<void> {
  if (!path.startsWith(base + sep)) {
    throw new PromotionRefused();
  }
  let current = base;
  for (const segment of path.slice(base.length + 1).split(sep)) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null || info.isSymbolicLink()) {
      throw new PromotionRefused();
    }
  }
  if (!(await lstat(path)).isFile()) {
    throw new PromotionRefused();
  }
}

/** An existing set is only the same set if it holds exactly the same pixels. */
async function assertSetHolds(
  directory: string,
  frames: readonly CandidateFrame[],
): Promise<void> {
  const present = await readdir(directory).catch(() => {
    throw new PromotionRefused();
  });
  const expected = new Map<string, string>();
  for (const frame of frames) {
    expected.set(surfaceName(frame.frame, "preview"), frame.digests.preview);
    expected.set(surfaceName(frame.frame, "render"), frame.digests.render);
  }
  if (present.length !== expected.size) {
    throw new PromotionRefused();
  }
  for (const [name, digest] of expected) {
    if (!present.includes(name)) {
      throw new PromotionRefused();
    }
    let facts: ImageFacts;
    try {
      facts = await readImageFacts(join(directory, name));
    } catch {
      throw new PromotionRefused();
    }
    if (facts.sha256 !== digest) {
      throw new PromotionRefused();
    }
  }
}

/** A set is named by what is in it, so the same pixels are always the same set. */
function addressOf(frames: readonly CandidateFrame[]): string {
  const hash = createHash("sha256");
  for (const frame of frames) {
    hash.update(`${frame.frame} ${frame.digests.preview} ${frame.digests.render}\n`);
  }
  return hash.digest("hex");
}

function frameName(frame: number): string {
  return `frame-${String(frame).padStart(FRAME_DIGITS, "0")}.png`;
}

function surfaceName(frame: number, surface: "preview" | "render"): string {
  return `frame-${String(frame).padStart(FRAME_DIGITS, "0")}-${surface}.png`;
}

function identifier(runId: string): string {
  if (typeof runId !== "string") {
    throw new PromotionRefused();
  }
  return runId;
}

/**
 * Make what was written survive the machine losing power.
 *
 * A file is opened for writing because synchronizing a read-only handle is not
 * permitted everywhere, and a directory cannot be opened for writing at all. On
 * a platform that will open neither, nothing is synchronized and the rename is
 * still the only step that publishes anything; a synchronize that was actually
 * attempted and failed is a failed promotion.
 */
async function syncPath(path: string): Promise<void> {
  for (const flags of ["r+", "r"] as const) {
    const handle = await open(path, flags).catch(() => null);
    if (handle === null) {
      continue;
    }
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
}
