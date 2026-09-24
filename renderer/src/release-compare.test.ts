/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DIFF_BOUNDS,
  ImageUnreadable,
  comparePixels,
  decodeCanonicalRgba,
  ffmpegRunner,
  readImageFacts,
  writeContactSheet,
  writeDiffImage,
  writeRgbaPng,
  type RunFfmpeg,
} from "./release-compare";

// The comparison this module exists for is FFmpeg's decode of two real PNGs, so
// these tests run the real binary. Only the binary's location is injected: the
// container has it on PATH, this repository keeps its own copy at the root.
const FFMPEG =
  process.platform === "win32" ? resolve(import.meta.dir, "..", "..", "ffmpeg.exe") : "ffmpeg";
const real: RunFfmpeg = ffmpegRunner(FFMPEG);

const GEOMETRY = { width: 64, height: 64 } as const;
const PIXELS = GEOMETRY.width * GEOMETRY.height;

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "thoth-compare-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** A flat opaque canvas, the one input every case here starts from. */
function canvas(red: number, green: number, blue: number): Uint8Array {
  const raw = new Uint8Array(PIXELS * 4);
  for (let pixel = 0; pixel < PIXELS; pixel += 1) {
    raw.set([red, green, blue, 255], pixel * 4);
  }
  return raw;
}

function withPixel(raw: Uint8Array, pixel: number, channel: number, delta: number): Uint8Array {
  const changed = new Uint8Array(raw);
  const at = pixel * 4 + channel;
  changed[at] = raw[at]! + delta;
  return changed;
}

async function png(name: string, raw: Uint8Array): Promise<string> {
  const path = join(workspace, name);
  await writeRgbaPng(raw, GEOMETRY, path, real);
  return path;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

test("reads a PNG's geometry, size, and digest without decoding it", async () => {
  const path = await png("facts.png", canvas(12, 34, 56));
  const facts = await readImageFacts(path);

  expect(facts).toEqual({
    width: GEOMETRY.width,
    height: GEOMETRY.height,
    bytes: readFileSync(path).byteLength,
    sha256: sha256(path),
  });
});

test("a file that is not a whole PNG is unreadable, not a guess", async () => {
  const truncated = join(workspace, "truncated.png");
  writeFileSync(truncated, readFileSync(await png("whole.png", canvas(1, 2, 3))).subarray(0, 20));
  const foreign = join(workspace, "foreign.png");
  writeFileSync(foreign, "not a png at all");

  await expect(readImageFacts(truncated)).rejects.toBeInstanceOf(ImageUnreadable);
  await expect(readImageFacts(foreign)).rejects.toBeInstanceOf(ImageUnreadable);
});

test("equal pixels are equal however the PNG was encoded", async () => {
  const raw = canvas(200, 100, 50);
  const plain = await png("encoding-a.png", raw);
  // The same pixels written again with a different compression level and a
  // different creation time: a PNG that differs everywhere except its image.
  const other = join(workspace, "encoding-b.png");
  await real(
    [
      "-v", "error", "-nostdin", "-y",
      "-f", "rawvideo", "-pixel_format", "rgba",
      "-video_size", `${GEOMETRY.width}x${GEOMETRY.height}`,
      "-i", "-",
      "-frames:v", "1", "-update", "1", "-pix_fmt", "rgba",
      "-compression_level", "0",
      "-metadata", "comment=second encoding",
      other,
    ],
    raw,
  );

  expect(sha256(other)).not.toBe(sha256(plain));
  const left = await decodeCanonicalRgba(plain, GEOMETRY, real);
  const right = await decodeCanonicalRgba(other, GEOMETRY, real);

  expect(comparePixels(left, right)).toEqual({
    verdict: "pass",
    metrics: { max_channel_delta: 0, changed_pixels: 0, changed_ratio: 0 },
  });
});

test("a single barely changed pixel is never a pass", async () => {
  const raw = canvas(128, 128, 128);
  const left = await decodeCanonicalRgba(await png("same.png", raw), GEOMETRY, real);
  const right = await decodeCanonicalRgba(
    await png("nudged.png", withPixel(raw, 7, 1, DIFF_BOUNDS.max_channel_delta)),
    GEOMETRY,
    real,
  );

  expect(comparePixels(left, right)).toEqual({
    verdict: "review_required",
    metrics: {
      max_channel_delta: DIFF_BOUNDS.max_channel_delta,
      changed_pixels: 1,
      changed_ratio: 1 / PIXELS,
    },
  });
});

test("either bound exceeded is a visual mismatch", async () => {
  const raw = canvas(128, 128, 128);
  const base = await decodeCanonicalRgba(await png("bound-base.png", raw), GEOMETRY, real);

  const loud = await decodeCanonicalRgba(
    await png("loud.png", withPixel(raw, 7, 0, DIFF_BOUNDS.max_channel_delta + 1)),
    GEOMETRY,
    real,
  );
  expect(comparePixels(base, loud).verdict).toBe("visual_mismatch");

  // Quiet, but everywhere: the changed-pixel ratio is its own bound.
  const spread = new Uint8Array(raw);
  for (let pixel = 0; pixel < PIXELS; pixel += 1) {
    spread[pixel * 4] = raw[pixel * 4]! + 1;
  }
  const wide = await decodeCanonicalRgba(await png("wide.png", spread), GEOMETRY, real);
  const comparison = comparePixels(base, wide);

  expect(comparison.metrics.max_channel_delta).toBe(1);
  expect(comparison.metrics.changed_pixels).toBe(PIXELS);
  expect(comparison.verdict).toBe("visual_mismatch");
});

test("the declared geometry is the only geometry a decode may produce", async () => {
  const path = await png("declared.png", canvas(9, 9, 9));

  // A PNG of another size is refused before a byte of it is decoded.
  let decodes = 0;
  const counted: RunFfmpeg = async (args, stdin) => {
    decodes += 1;
    return real(args, stdin);
  };
  await expect(
    decodeCanonicalRgba(path, { width: GEOMETRY.width + 1, height: GEOMETRY.height }, counted),
  ).rejects.toBeInstanceOf(ImageUnreadable);
  expect(decodes).toBe(0);

  // And a decode that answers with the wrong number of bytes is refused after.
  const short: RunFfmpeg = async () => new Uint8Array(PIXELS * 4 - 1);
  await expect(decodeCanonicalRgba(path, GEOMETRY, short)).rejects.toBeInstanceOf(ImageUnreadable);
});

test("a failing FFmpeg is a capture fault carrying none of its output", async () => {
  const missing = join(workspace, "does-not-exist.png");
  writeFileSync(missing, readFileSync(await png("present.png", canvas(4, 4, 4))));
  await rm(missing);

  const failure = await readImageFacts(missing).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ImageUnreadable);

  const decoded = join(workspace, "damaged.png");
  const bytes = readFileSync(await png("intact.png", canvas(4, 4, 4)));
  bytes.fill(0, 40, 120);
  writeFileSync(decoded, bytes);
  const broken = await decodeCanonicalRgba(decoded, GEOMETRY, real).catch(
    (error: unknown) => error,
  );

  expect(broken).toBeInstanceOf(ImageUnreadable);
  // Whatever FFmpeg said about the file, the error repeats none of it.
  expect((broken as Error).message).toBe("release image unreadable");
});

test("the diff image marks the changed pixels and nothing else", async () => {
  const raw = canvas(20, 20, 20);
  const changed = withPixel(raw, 3, 2, 60);
  const path = join(workspace, "diff.png");

  await writeDiffImage(raw, changed, GEOMETRY, path, real);
  const drawn = await decodeCanonicalRgba(path, GEOMETRY, real);

  expect(Array.from(drawn.subarray(12, 16))).toEqual([255, 0, 255, 255]);
  expect(Array.from(drawn.subarray(0, 4))).toEqual([0, 0, 0, 255]);
  expect(Array.from(drawn.subarray(16, 20))).toEqual([0, 0, 0, 255]);
});

test("the contact sheet lays every frame out as preview, render, and diff", async () => {
  const preview = await png("sheet-preview.png", canvas(10, 20, 30));
  const render = await png("sheet-render.png", canvas(10, 20, 30));
  const diff = join(workspace, "sheet-diff.png");
  await writeDiffImage(canvas(10, 20, 30), canvas(11, 20, 30), GEOMETRY, diff, real);
  const sheet = join(workspace, "contact-sheet.png");

  const laid = await writeContactSheet(
    [
      { frame: 0, preview, render, diff },
      { frame: 30, preview, render, diff: null },
    ],
    GEOMETRY,
    sheet,
    real,
  );
  const facts = await readImageFacts(sheet);

  expect(facts.width).toBe(laid.width);
  expect(facts.height).toBe(laid.height);
  // Three surfaces across, one row per compared frame.
  expect(laid.width).toBe(laid.cell.width * 3);
  expect(laid.height).toBe(laid.cell.height * 2);
});

test("an FFmpeg that never exits is ended when its caller stops waiting", async () => {
  const pidFile = join(workspace, "wedged.pid");
  const stop = new AbortController();
  const outcome = ffmpegRunner(process.execPath)(
    ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
    undefined,
    stop.signal,
  ).then(
    () => "answered",
    (error: Error) => error.constructor.name,
  );
  for (let attempt = 0; attempt < 400 && !existsSync(pidFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const pid = Number(readFileSync(pidFile, "utf8"));

  try {
    stop.abort();
    expect(await outcome).toBe("ImageUnreadable");
    expect(alive(pid)).toBe(false);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
