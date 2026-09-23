/**
 * What makes two frames the same frame.
 *
 * A PNG is a file format, not a picture: the same pixels compress differently,
 * carry different metadata, and hash differently. So nothing here compares PNG
 * bytes. Both inputs are decoded through the container's own FFmpeg to raw RGBA
 * at the geometry the release declares, and only those bytes decide. The file
 * digest is recorded for diagnosis and never for a verdict.
 *
 * FFmpeg is invoked as an argument array and its stderr is never read back into
 * a report: a decode either produced exactly the declared number of bytes or it
 * did not, and that is the whole of what this module is willing to say.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export class ImageUnreadable extends Error {
  constructor() {
    super("release image unreadable");
    this.name = "ImageUnreadable";
  }
}

/**
 * Diagnostic bounds, not a tolerance: a difference inside them still blocks a
 * release. They only separate "a pixel moved" from "the picture changed".
 */
export const DIFF_BOUNDS = Object.freeze({ max_channel_delta: 8, changed_ratio: 0.001 });

/** How wide one cell of the contact sheet is drawn, in pixels. */
const CELL_WIDTH = 180;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_AT = 16;
const PNG_TRAILER = 12;

export type Geometry = { readonly width: number; readonly height: number };

export type ImageFacts = {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
};

export type FrameMetrics = {
  readonly max_channel_delta: number;
  readonly changed_pixels: number;
  readonly changed_ratio: number;
};

export type PixelVerdict = "pass" | "review_required" | "visual_mismatch";

export type PixelComparison = {
  readonly verdict: PixelVerdict;
  readonly metrics: FrameMetrics;
};

export type ContactRow = {
  readonly frame: number;
  readonly preview: string;
  readonly render: string;
  readonly diff: string | null;
};

export type ContactSheet = {
  readonly width: number;
  readonly height: number;
  readonly cell: Geometry;
};

/** One FFmpeg run: an argument array in, its standard output back. */
export type RunFfmpeg = (args: readonly string[], stdin?: Uint8Array) => Promise<Uint8Array>;

/**
 * The container's FFmpeg, reached the way this service already reaches ffprobe.
 *
 * The binary is a parameter so a test can run the repository's own copy; it is
 * not a setting, and no caller supplies one at runtime.
 */
export function ffmpegRunner(binary = "ffmpeg"): RunFfmpeg {
  return async (args: readonly string[], stdin?: Uint8Array) => {
    const child = Bun.spawn([binary, ...args], {
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new ImageUnreadable();
    }
    return new Uint8Array(output);
  };
}

/** The one runner production uses. */
export const runFfmpeg: RunFfmpeg = ffmpegRunner();

/**
 * Read what a PNG says about itself: its geometry, its size, and its digest.
 *
 * A file that is not a whole PNG is refused here rather than handed to a
 * decoder that might make something of it.
 */
export async function readImageFacts(path: string): Promise<ImageFacts> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new ImageUnreadable();
  }
  if (bytes.byteLength < PNG_IHDR_AT + 8 + PNG_TRAILER) {
    throw new ImageUnreadable();
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new ImageUnreadable();
  }
  if (bytes.subarray(bytes.byteLength - 8, bytes.byteLength - 4).toString("ascii") !== "IEND") {
    throw new ImageUnreadable();
  }

  const width = bytes.readUInt32BE(PNG_IHDR_AT);
  const height = bytes.readUInt32BE(PNG_IHDR_AT + 4);
  if (width < 1 || height < 1) {
    throw new ImageUnreadable();
  }

  return Object.freeze({
    width,
    height,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}

/**
 * Decode one image to canonical raw RGBA at the geometry it was promised to be.
 *
 * Both the declared header and the produced byte count must agree with the
 * release, so a frame drawn at another size cannot be compared as if it were
 * the frame that was asked for.
 */
export async function decodeCanonicalRgba(
  path: string,
  geometry: Geometry,
  run: RunFfmpeg,
): Promise<Uint8Array> {
  const facts = await readImageFacts(path);
  if (facts.width !== geometry.width || facts.height !== geometry.height) {
    throw new ImageUnreadable();
  }
  return decodeRaw(
    ["-v", "error", "-nostdin", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    geometry,
    run,
  );
}

/** Compare two canonical decodes. Equality is exact; the rest is diagnosis. */
export function comparePixels(left: Uint8Array, right: Uint8Array): PixelComparison {
  if (left.byteLength !== right.byteLength || left.byteLength % 4 !== 0) {
    throw new ImageUnreadable();
  }

  const pixels = left.byteLength / 4;
  let changed = 0;
  let delta = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    let moved = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const at = pixel * 4 + channel;
      const difference = Math.abs(left[at]! - right[at]!);
      if (difference > 0) {
        moved = true;
        delta = Math.max(delta, difference);
      }
    }
    if (moved) {
      changed += 1;
    }
  }

  const metrics = Object.freeze({
    max_channel_delta: delta,
    changed_pixels: changed,
    changed_ratio: changed / pixels,
  });
  if (changed === 0) {
    return Object.freeze({ verdict: "pass" as const, metrics });
  }
  const within =
    delta <= DIFF_BOUNDS.max_channel_delta && metrics.changed_ratio <= DIFF_BOUNDS.changed_ratio;
  return Object.freeze({
    verdict: within ? ("review_required" as const) : ("visual_mismatch" as const),
    metrics,
  });
}

/** Write raw RGBA out as a PNG, through the one encoder this service has. */
export async function writeRgbaPng(
  raw: Uint8Array,
  geometry: Geometry,
  path: string,
  run: RunFfmpeg,
): Promise<void> {
  if (raw.byteLength !== geometry.width * geometry.height * 4) {
    throw new ImageUnreadable();
  }
  await run(
    [
      "-v", "error", "-nostdin", "-y",
      "-f", "rawvideo", "-pixel_format", "rgba",
      "-video_size", `${geometry.width}x${geometry.height}`,
      "-i", "-",
      "-frames:v", "1", "-update", "1", "-pix_fmt", "rgba",
      path,
    ],
    raw,
  );
}

/** Mark every pixel that moved, so a reviewer sees where and not only how much. */
export async function writeDiffImage(
  left: Uint8Array,
  right: Uint8Array,
  geometry: Geometry,
  path: string,
  run: RunFfmpeg,
): Promise<void> {
  if (left.byteLength !== right.byteLength) {
    throw new ImageUnreadable();
  }
  const diff = new Uint8Array(left.byteLength);
  for (let pixel = 0; pixel < left.byteLength / 4; pixel += 1) {
    const at = pixel * 4;
    const moved =
      left[at] !== right[at] ||
      left[at + 1] !== right[at + 1] ||
      left[at + 2] !== right[at + 2] ||
      left[at + 3] !== right[at + 3];
    diff.set(moved ? [255, 0, 255, 255] : [0, 0, 0, 255], at);
  }
  await writeRgbaPng(diff, geometry, path, run);
}

/**
 * One sheet an operator can look at: a row per compared frame, and across it
 * the preview, the render, and what differs between them.
 */
export async function writeContactSheet(
  rows: readonly ContactRow[],
  geometry: Geometry,
  path: string,
  run: RunFfmpeg,
): Promise<ContactSheet> {
  if (rows.length < 1) {
    throw new ImageUnreadable();
  }
  const cell = Object.freeze({
    width: CELL_WIDTH,
    height: Math.max(1, Math.round((geometry.height * CELL_WIDTH) / geometry.width)),
  });
  const width = cell.width * 3;
  const height = cell.height * rows.length;
  const sheet = new Uint8Array(width * height * 4);
  // An empty cell is grey, so a missing surface reads as absent rather than as
  // a black frame someone might mistake for the picture.
  sheet.fill(0x20);
  for (let at = 3; at < sheet.byteLength; at += 4) {
    sheet[at] = 255;
  }

  for (const [row, entry] of rows.entries()) {
    const surfaces = [entry.preview, entry.render, entry.diff];
    for (const [column, surface] of surfaces.entries()) {
      if (surface === null) {
        continue;
      }
      const thumbnail = await decodeRaw(
        [
          "-v", "error", "-nostdin", "-i", surface,
          "-vf", `scale=${cell.width}:${cell.height}:flags=neighbor`,
          "-f", "rawvideo", "-pix_fmt", "rgba", "-",
        ],
        cell,
        run,
      );
      for (let line = 0; line < cell.height; line += 1) {
        const from = line * cell.width * 4;
        const to = ((row * cell.height + line) * width + column * cell.width) * 4;
        sheet.set(thumbnail.subarray(from, from + cell.width * 4), to);
      }
    }
  }

  await writeRgbaPng(sheet, { width, height }, path, run);
  return Object.freeze({ width, height, cell });
}

/** Run one decode and insist it produced exactly the frame it was asked for. */
async function decodeRaw(
  args: readonly string[],
  geometry: Geometry,
  run: RunFfmpeg,
): Promise<Uint8Array> {
  let raw: Uint8Array;
  try {
    raw = await run(args);
  } catch {
    throw new ImageUnreadable();
  }
  if (raw.byteLength !== geometry.width * geometry.height * 4) {
    throw new ImageUnreadable();
  }
  return raw;
}
