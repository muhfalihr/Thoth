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

import { randomBytes } from "node:crypto";
import { join } from "node:path";

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
    reference_image: Object.freeze({
      base_digest: allowed(environment.THOTH_F1_BASE_DIGEST, DIGEST),
      image_id: allowed(environment.THOTH_F1_IMAGE_ID, DIGEST),
      renderer_version: allowed(environment.THOTH_RENDERER_VERSION, RENDERER_VERSION),
    }),
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
