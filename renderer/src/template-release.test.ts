/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { RendererArtifactRoot } from "./artifact-root";
import type { CapturedFrame } from "./release-capture";
import { canonicalReleaseRoot, goldenSetAddress } from "./release-capsule";
import { ffmpegRunner, writeRgbaPng, type RunFfmpeg } from "./release-compare";
import {
  PromotionRefused,
  ReportUnsafe,
  assertSafeReport,
  promoteRelease,
  underStopSignals,
  verifyRelease,
  type ReleaseReport,
  type StartCapture,
} from "./template-release";

const FFMPEG =
  process.platform === "win32" ? resolve(import.meta.dir, "..", "..", "ffmpeg.exe") : "ffmpeg";
const real: RunFfmpeg = ffmpegRunner(FFMPEG);

const IDENTITY = "vertical_text_story-v1";
/** The tracked capsule's own canvas: nothing here may render at another size. */
const CANVAS = { width: 1080, height: 1920 } as const;

let workspace: string;
let releaseRoot: string;
let capsule: string;
let artifacts: RendererArtifactRoot;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "thoth-release-"));
  releaseRoot = join(workspace, "releases");
  capsule = join(releaseRoot, IDENTITY);
  // A copy of the tracked capsule, so a test can narrow its frames or give it
  // goldens without touching the repository fixture it came from.
  await cp(join(canonicalReleaseRoot(), IDENTITY), capsule, { recursive: true });
  const release = JSON.parse(await readFile(join(capsule, "release.json"), "utf8"));
  release.frames = [0];
  await writeFile(join(capsule, "release.json"), JSON.stringify(release, null, 2));

  artifacts = new RendererArtifactRoot(join(workspace, "artifacts"), {
    probe: async () => {
      throw new Error("no media is probed while verifying a release");
    },
  });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function canvas(red: number, green: number, blue: number): Uint8Array {
  const raw = new Uint8Array(CANVAS.width * CANVAS.height * 4);
  for (let pixel = 0; pixel < CANVAS.width * CANVAS.height; pixel += 1) {
    raw.set([red, green, blue, 255], pixel * 4);
  }
  return raw;
}

function nudged(raw: Uint8Array, delta: number): Uint8Array {
  const changed = new Uint8Array(raw);
  changed[0] = raw[0]! + delta;
  return changed;
}

/**
 * A capture that writes the frames it was told to write.
 *
 * The browser half is proven in the reference container; what this substitutes
 * is only the two surfaces' output, so the phases after capture are exercised
 * against real PNG files on disk.
 */
function captureWriting(
  pixels: (surface: "preview" | "render", frame: number) => Uint8Array | null,
  order?: (frames: readonly CapturedFrame[]) => readonly CapturedFrame[],
) {
  return sessionOf(async (options) => {
    const captured: CapturedFrame[] = [];
    for (const frame of options.capsule.frames) {
      const preview = options.run.previewFrame(frame);
      const render = options.run.renderFrame(frame);
      for (const [surface, path] of [
        ["preview", preview],
        ["render", render],
      ] as const) {
        const raw = pixels(surface, frame);
        if (raw !== null) {
          await writeRgbaPng(raw, CANVAS, path, real);
        }
      }
      captured.push({ frame, preview, render });
    }
    return order === undefined ? captured : order(captured);
  });
}

/**
 * A fake capture that owns nothing, given the shape the real one has.
 *
 * Every one of these settles on its own, so `stop()` has nothing left to give
 * back; the tests that care about teardown build their own session instead.
 */
function sessionOf(
  work: (options: {
    capsule: { frames: readonly number[] };
    run: { previewFrame(frame: number): string; renderFrame(frame: number): string };
  }) => Promise<readonly CapturedFrame[]>,
): StartCapture {
  return (options) => ({ frames: work(options), stop: async (): Promise<void> => {} });
}

function digestOf(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/**
 * An approved set, written the way a promotion writes one: under the name its
 * own pixels address, which is the only name loading will accept.
 */
async function giveGoldens(preview: Uint8Array, render: Uint8Array): Promise<string> {
  const staging = join(workspace, "goldens");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeRgbaPng(preview, CANVAS, join(staging, PREVIEW_NAME), real);
  await writeRgbaPng(render, CANVAS, join(staging, RENDER_NAME), real);

  const set = goldenSetAddress([
    {
      frame: 0,
      preview: digestOf(join(staging, PREVIEW_NAME)),
      render: digestOf(join(staging, RENDER_NAME)),
    },
  ]);
  await cp(staging, join(capsule, "golden-sets", set), { recursive: true });
  await writeFile(
    join(capsule, "golden-manifest.json"),
    JSON.stringify({
      schema_version: 1,
      golden_set: set,
      frames: [{ frame: 0, preview: PREVIEW_NAME, render: RENDER_NAME }],
    }),
  );
  return set;
}

test("an unapproved release produces a complete candidate, not a pass", async () => {
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: captureWriting(() => canvas(30, 60, 90)),
  });

  expect(report.verdict).toBe("golden_missing");
  expect(report.golden_set).toBeNull();
  expect(report.frames).toHaveLength(1);
  expect(report.frames[0]!.pair).toEqual({
    verdict: "pass",
    metrics: { max_channel_delta: 0, changed_pixels: 0, changed_ratio: 0 },
  });
  expect(report.frames[0]!.preview.width).toBe(CANVAS.width);
  expect(report.frames[0]!.preview.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

  // The candidate an operator is asked to look at exists, and so does the
  // report, written whole.
  const run = join(workspace, "artifacts", "template-release", IDENTITY, report.run_id);
  expect(existsSync(join(run, "contact-sheet.png"))).toBe(true);
  expect(JSON.parse(readFileSync(join(run, "report.json"), "utf8"))).toEqual(report);
});

test("goldens that decode to the same pixels pass whatever their PNG bytes are", async () => {
  const drawn = canvas(30, 60, 90);
  const set = await giveGoldens(drawn, drawn);
  const golden = join(capsule, "golden-sets", set, PREVIEW_NAME);
  const before = readFileSync(golden);

  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: captureWriting(() => drawn),
  });

  expect(report.verdict).toBe("pass");
  expect(report.golden_set).toBe(set);
  expect(report.frames[0]!.golden).toEqual({
    preview: { verdict: "pass", metrics: { max_channel_delta: 0, changed_pixels: 0, changed_ratio: 0 } },
    render: { verdict: "pass", metrics: { max_channel_delta: 0, changed_pixels: 0, changed_ratio: 0 } },
  });
  // Verification reads goldens. It never writes one.
  expect(readFileSync(golden)).toEqual(before);
});

test("a single changed pixel against the golden is never a pass", async () => {
  const drawn = canvas(30, 60, 90);
  await giveGoldens(drawn, drawn);

  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: captureWriting(() => nudged(drawn, 2)),
  });

  expect(report.frames[0]!.pair.verdict).toBe("pass");
  expect(report.frames[0]!.golden!.preview.verdict).toBe("review_required");
  expect(report.verdict).toBe("review_required");
});

test("preview and render that disagree are a visual mismatch with a diff", async () => {
  const drawn = canvas(30, 60, 90);
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: captureWriting((surface) => (surface === "preview" ? drawn : nudged(drawn, 40))),
  });

  expect(report.verdict).toBe("visual_mismatch");
  expect(report.frames[0]!.pair.metrics.max_channel_delta).toBe(40);
  const run = join(workspace, "artifacts", "template-release", IDENTITY, report.run_id);
  expect(existsSync(join(run, "diff", "frame-000000.png"))).toBe(true);
});

test("captured frames that arrive out of order are a contract failure", async () => {
  const drawn = canvas(30, 60, 90);
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: captureWriting(
      () => drawn,
      (frames) => frames.map((captured) => ({ ...captured, frame: captured.frame + 1 })),
    ),
  });

  expect(report.verdict).toBe("contract_failed");
  expect(report.frames).toHaveLength(0);
});

test("a capture drawn at another size is a contract failure", async () => {
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: sessionOf(async (options) => {
      const preview = options.run.previewFrame(0);
      const render = options.run.renderFrame(0);
      const small = new Uint8Array(64 * 64 * 4).fill(255);
      await writeRgbaPng(small, { width: 64, height: 64 }, preview, real);
      await writeRgbaPng(small, { width: 64, height: 64 }, render, real);
      return [{ frame: 0, preview, render }];
    }),
  });

  expect(report.verdict).toBe("contract_failed");
});

test("a capture that cannot be decoded is a capture failure", async () => {
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: sessionOf(async (options) => {
      const preview = options.run.previewFrame(0);
      const render = options.run.renderFrame(0);
      await writeRgbaPng(canvas(1, 2, 3), CANVAS, preview, real);
      await writeRgbaPng(canvas(1, 2, 3), CANVAS, render, real);
      // A PNG header with nothing decodable behind it.
      const damaged = readFileSync(render);
      damaged.fill(0, 40, damaged.byteLength - 12);
      await writeFile(render, damaged);
      return [{ frame: 0, preview, render }];
    }),
  });

  expect(report.verdict).toBe("capture_failed");
});

test("the report carries release facts and nothing about this machine", async () => {
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: captureWriting(() => canvas(30, 60, 90)),
    environment: { THOTH_F1_IMAGE_ID: "/home/someone/secret", THOTH_RENDERER_VERSION: "" },
  });
  const serialized = JSON.stringify(report);

  expect(serialized).not.toContain(workspace);
  expect(serialized).not.toContain(FFMPEG);
  expect(serialized).not.toContain("secret");
  // An identity that does not look like one is reported as unknown, not echoed.
  expect(report.reference_image.image_id).toBe("unknown");
  expect(report.release).toBe(IDENTITY);
  expect(report.capsule!.assets.map((asset) => asset.file)).toContain("assets/image.png");
});

test("a report that names a place on disk is refused before it is written", () => {
  const safe = {
    schema_version: 1,
    release: IDENTITY,
    note: "assets/image.png",
  };

  expect(() => assertSafeReport(safe)).not.toThrow();
  expect(() => assertSafeReport({ ...safe, note: "/var/lib/thoth/artifacts" })).toThrow(
    ReportUnsafe,
  );
  expect(() => assertSafeReport({ ...safe, note: "C:\\Users\\someone" })).toThrow(ReportUnsafe);
  expect(() => assertSafeReport({ ...safe, note: "https://example.test/pixel.png" })).toThrow(
    ReportUnsafe,
  );
});

/** The identity a real reference container reports about itself. */
const REFERENCE = {
  THOTH_F1_BASE_DIGEST: `sha256:${"11".repeat(32)}`,
  THOTH_F1_IMAGE_ID: `sha256:${"22".repeat(32)}`,
  THOTH_RENDERER_VERSION: "remotion-4.0.523",
} as const;

const MANIFEST = "golden-manifest.json";
/** The suffix promotion stages under, named here as a caller would see it. */
const INCOMING = ".incoming";
const PREVIEW_NAME = "frame-000000-preview.png";
const RENDER_NAME = "frame-000000-render.png";

async function candidate(
  pixels: (surface: "preview" | "render", frame: number) => Uint8Array | null = () =>
    canvas(30, 60, 90),
): Promise<ReleaseReport> {
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    capture: captureWriting(pixels),
    environment: REFERENCE,
  });
  if (report.capsule === null) {
    throw new Error("the candidate was never verified against a capsule");
  }
  return report;
}

function runDirectory(report: { run_id: string }): string {
  return join(workspace, "artifacts", "template-release", IDENTITY, report.run_id);
}

function promote(report: { run_id: string }, deps: Record<string, unknown> = {}): Promise<void> {
  return promoteRelease(IDENTITY, artifacts, report.run_id, {
    releaseRoot,
    environment: REFERENCE,
    ...deps,
  });
}

function rewriteReport(
  report: ReleaseReport,
  change: (value: Record<string, any>) => void,
): void {
  const path = join(runDirectory(report), "report.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  change(value);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function manifestOf(): Record<string, any> {
  return JSON.parse(readFileSync(join(capsule, MANIFEST), "utf8"));
}

/** Every file of the capsule and what is in it, so a refusal can be proven inert. */
function capsuleState(): Record<string, string> {
  const state: Record<string, string> = {};
  for (const entry of readdirSync(capsule, { recursive: true }) as string[]) {
    const path = join(capsule, entry);
    if (statSync(path).isFile()) {
      state[entry.split(sep).join("/")] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    }
  }
  return state;
}

async function refuses(promotion: Promise<void>, before: Record<string, string>): Promise<void> {
  await expect(promotion).rejects.toBeInstanceOf(PromotionRefused);
  // A refused promotion is not a partial one: the capsule is what it was.
  expect(capsuleState()).toEqual(before);
}

/** What the real steps say when the reference environment breaks under them. */
const CAPTURE_FAILURES = [
  "the preview page could not be built",
  "the bundler could not bundle the composition",
  "no composition with the requested id was found",
  "the browser could not be launched",
  "a page could not be created",
  "navigation to the preview never finished",
  "the screenshot could not be written",
  "renderStill could not draw the frame",
];

test("an operational failure closes the run with a capture failure", async () => {
  for (const failure of CAPTURE_FAILURES) {
    const report = await verifyRelease(IDENTITY, artifacts, {
      releaseRoot,
      ffmpeg: real,
      environment: REFERENCE,
      capture: sessionOf(async () => {
        throw new Error(failure);
      }),
    });

    expect(report.verdict).toBe("capture_failed");
    expect(report.frames).toHaveLength(0);
    // The run is closed rather than abandoned: a report an operator can read,
    // saying nothing about what the browser or the bundler had to say.
    const written = JSON.parse(readFileSync(join(runDirectory(report), "report.json"), "utf8"));
    expect(written).toEqual(report);
    expect(JSON.stringify(report)).not.toContain(failure);
  }
});

test("a decoder that cannot run is a capture failure, not an escape", async () => {
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    environment: REFERENCE,
    capture: captureWriting(() => canvas(30, 60, 90)),
    ffmpeg: async () => {
      throw new Error("ffmpeg exited with status 127");
    },
  });

  expect(report.verdict).toBe("capture_failed");
  expect(JSON.stringify(report)).not.toContain("127");
  expect(existsSync(join(runDirectory(report), "report.json"))).toBe(true);
});

test("a capsule nobody can load closes the run without drawing anything", async () => {
  writeFileSync(join(capsule, "release.json"), "{ this is not a capsule");
  let attempted = false;

  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    environment: REFERENCE,
    capture: sessionOf(async () => {
      attempted = true;
      return [];
    }),
  });

  // A contract failure before the browser is a contract failure without one.
  expect(attempted).toBe(false);
  expect(report.verdict).toBe("contract_failed");
  expect(report.release).toBe(IDENTITY);
  // Facts this run never had are absent, not invented.
  expect(report.capsule).toBeNull();
  expect(report.composition).toBeNull();
  expect(report.golden_set).toBeNull();
  expect(report.frames).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(runDirectory(report), "report.json"), "utf8"))).toEqual(
    report,
  );
});

test("no failure report is ever promotable", async () => {
  const broken = JSON.parse(readFileSync(join(capsule, "release.json"), "utf8"));
  writeFileSync(join(capsule, "release.json"), "{ this is not a capsule");
  const incomplete = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    environment: REFERENCE,
    capture: sessionOf(async () => []),
  });
  writeFileSync(join(capsule, "release.json"), JSON.stringify(broken, null, 2));

  const failed = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    environment: REFERENCE,
    capture: sessionOf(async () => {
      throw new Error("the browser could not be launched");
    }),
  });
  const before = capsuleState();

  await refuses(promote(incomplete), before);
  await refuses(promote(failed), before);
});

test("a capture that outlasts its deadline is a capture failure", async () => {
  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    environment: REFERENCE,
    deadlineMs: 25,
    // A surface that has stopped answering, which is what a wedged browser is.
    capture: () => ({ frames: new Promise<never>(() => {}), stop: async (): Promise<void> => {} }),
  });

  expect(report.verdict).toBe("capture_failed");
  expect(existsSync(join(runDirectory(report), "report.json"))).toBe(true);
});

/** Wait for something a capture does on its own clock, without a fixed sleep. */
async function until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !ready(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!ready()) {
    throw new Error("the capture never reached the state this test waits for");
  }
}

test("a stopped capture is given back before the run reports", async () => {
  let asked = false;
  let released = false;
  let end!: (error: Error) => void;
  // A capture that never settles on its own: ending it is the only thing that
  // ends it, which is what a wedged bundler or a browser that stopped answering
  // actually is.
  const frames = new Promise<readonly CapturedFrame[]>((_, reject) => {
    end = reject;
  });
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });

  let reported = false;
  const running = verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    environment: REFERENCE,
    deadlineMs: 5,
    capture: () => ({
      frames,
      stop: async () => {
        asked = true;
        // Closing a browser, stopping a server, and removing a temporary
        // directory all take time, and this is the window a race returns in.
        await cleanup;
        released = true;
        end(new Error("the capture was ended"));
      },
    }),
  }).then((value) => {
    reported = true;
    return value;
  });

  await until(() => asked);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(released).toBe(false);
  expect(reported).toBe(false);

  finish();
  const report = await running;

  expect(released).toBe(true);
  expect(report.verdict).toBe("capture_failed");
  expect(existsSync(join(runDirectory(report), "report.json"))).toBe(true);
});

test("a verifier asked to stop ends the capture it started", async () => {
  const operator = new AbortController();
  let stopped = false;

  const report = await verifyRelease(IDENTITY, artifacts, {
    releaseRoot,
    ffmpeg: real,
    environment: REFERENCE,
    signal: operator.signal,
    // A surface that never answers, stopped by the operator rather than by the
    // deadline: the run still owns it, so the run is still the one that ends it.
    capture: () => {
      operator.abort();
      return {
        frames: new Promise<never>(() => {}),
        stop: async (): Promise<void> => {
          stopped = true;
        },
      };
    },
  });

  expect(stopped).toBe(true);
  expect(report.verdict).toBe("capture_failed");
});

test("a stoppable verifier leaves no signal handlers behind", async () => {
  const before = {
    interrupt: process.listenerCount("SIGINT"),
    terminate: process.listenerCount("SIGTERM"),
  };
  let given: AbortSignal | undefined;

  const answer = await underStopSignals(async (signal) => {
    given = signal;
    expect(process.listenerCount("SIGINT")).toBe(before.interrupt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.terminate + 1);
    // The operator's interrupt, delivered to the handler this call installed.
    (process.listeners("SIGINT").at(-1) as () => void)();
    expect(signal.aborted).toBe(true);
    return "verified";
  });

  expect(answer).toBe("verified");
  expect(given?.aborted).toBe(true);
  expect(process.listenerCount("SIGINT")).toBe(before.interrupt);
  expect(process.listenerCount("SIGTERM")).toBe(before.terminate);
});

test("promotion turns one approved candidate into an immutable golden set", async () => {
  const report = await candidate();

  await promote(report);

  const manifest = manifestOf();
  expect(manifest.schema_version).toBe(1);
  expect(manifest.golden_set).toMatch(/^sha256-[0-9a-f]{64}$/);
  expect(manifest.frames).toEqual([{ frame: 0, preview: PREVIEW_NAME, render: RENDER_NAME }]);
  const set = join(capsule, "golden-sets", manifest.golden_set);
  expect(readFileSync(join(set, PREVIEW_NAME))).toEqual(
    readFileSync(join(runDirectory(report), "preview", "frame-000000.png")),
  );

  // The promoted set is now what a later run of the same release passes against.
  const after = await candidate();
  expect(after.verdict).toBe("pass");
  expect(after.golden_set).toBe(manifest.golden_set);
});

test("a golden set is named by the pixels in it, not by the run that drew them", async () => {
  const first = await candidate();
  await promote(first);
  const name = manifestOf().golden_set;

  // The same picture from another run addresses the same set, and promoting it
  // again is the same state rather than a second set.
  const again = await candidate();
  await promote(again);
  expect(manifestOf().golden_set).toBe(name);
  expect(readdirSync(join(capsule, "golden-sets"))).toEqual([name]);

  // A different picture is a different set, which is what an operator approves.
  const changed = await candidate(() => nudged(canvas(30, 60, 90), 40));
  await promote(changed);
  expect(manifestOf().golden_set).not.toBe(name);
  expect(readdirSync(join(capsule, "golden-sets"))).toHaveLength(2);
});

test("only a candidate of this release, this run, and this reference image is promoted", async () => {
  const report = await candidate();
  const before = capsuleState();

  rewriteReport(report, (value) => {
    value.release = "vertical_text_story-v2";
  });
  await refuses(promote(report), before);

  rewriteReport(report, (value) => {
    value.release = IDENTITY;
    value.run_id = "run_0000000000000000";
  });
  await refuses(promote(report), before);

  rewriteReport(report, (value) => {
    value.run_id = report.run_id;
    value.reference_image.image_id = "unknown";
  });
  await refuses(promote(report), before);

  rewriteReport(report, (value) => {
    value.reference_image.image_id = REFERENCE.THOTH_F1_IMAGE_ID;
    value.verdict = "capture_failed";
  });
  await refuses(promote(report), before);
});

test("a candidate drawn against other fixtures is refused", async () => {
  const report = await candidate();
  const before = capsuleState();

  rewriteReport(report, (value) => {
    value.capsule.assets[0].sha256 = `sha256:${"ab".repeat(32)}`;
  });
  await refuses(promote(report), before);

  rewriteReport(report, (value) => {
    value.capsule.assets[0].sha256 = report.capsule.assets[0]!.sha256;
    value.capsule.frames = [0, 30];
  });
  await refuses(promote(report), before);
});

test("a candidate drawn in another reference environment is refused", async () => {
  const report = await candidate();
  const before = capsuleState();

  // Every one of these is a syntactically valid identity. None of them is the
  // image this promotion is running in, which is the only one that may approve.
  const elsewhere = [
    { ...REFERENCE, THOTH_F1_IMAGE_ID: `sha256:${"33".repeat(32)}` },
    { ...REFERENCE, THOTH_F1_BASE_DIGEST: `sha256:${"44".repeat(32)}` },
    { ...REFERENCE, THOTH_RENDERER_VERSION: "remotion-4.0.522" },
    { THOTH_F1_IMAGE_ID: REFERENCE.THOTH_F1_IMAGE_ID },
    {},
  ];
  for (const environment of elsewhere) {
    await refuses(promote(report, { environment }), before);
  }

  // The image that drew it still promotes it.
  await promote(report);
  expect(manifestOf().golden_set).toMatch(/^sha256-[0-9a-f]{64}$/);
});

test("a candidate drawn from other document bytes is refused", async () => {
  const report = await candidate();
  const document = join(capsule, "document.json");
  const value = JSON.parse(readFileSync(document, "utf8"));
  value.revision = 2;
  writeFileSync(document, JSON.stringify(value, null, 2));
  const before = capsuleState();

  await refuses(promote(report), before);
});

test("a candidate missing its report is refused", async () => {
  const report = await candidate();
  const before = capsuleState();
  rmSync(join(runDirectory(report), "report.json"));

  await refuses(promote(report), before);
});

test("a partial, altered, or padded candidate is refused", async () => {
  const report = await candidate();
  const before = capsuleState();
  const preview = join(runDirectory(report), "preview", "frame-000000.png");
  const kept = readFileSync(preview);

  rmSync(preview);
  await refuses(promote(report), before);

  // A frame that is no longer the frame the report vouched for.
  await writeRgbaPng(canvas(1, 2, 3), CANVAS, preview, real);
  await refuses(promote(report), before);

  writeFileSync(preview, kept);
  writeFileSync(join(runDirectory(report), "preview", "frame-000001.png"), kept);
  await refuses(promote(report), before);
});

test("a candidate reached through a link is refused", async () => {
  const report = await candidate();
  const before = capsuleState();
  const outside = join(workspace, "outside");
  mkdirSync(outside, { recursive: true });
  const decoy = join(outside, "frame-000000.png");
  const preview = join(runDirectory(report), "preview", "frame-000000.png");
  writeFileSync(decoy, readFileSync(preview));

  rmSync(preview);
  try {
    symlinkSync(decoy, preview, "file");
    await refuses(promote(report), before);
  } catch {
    // Creating a file symlink is a privilege on Windows, not a capability this
    // check depends on. The linked directory below walks it everywhere.
  }

  rmSync(join(runDirectory(report), "preview"), { recursive: true, force: true });
  symlinkSync(outside, join(runDirectory(report), "preview"), "junction");
  await refuses(promote(report), before);
});

test("an existing set is never rewritten by a promotion", async () => {
  const report = await candidate();
  await promote(report);
  const name = manifestOf().golden_set;
  // A second candidate of the same picture, drawn while the release is whole.
  const repeat = await candidate();

  // Another picture, readable and whole, under the name this candidate
  // addresses: the case where only the set's own contents can refuse it.
  await writeRgbaPng(
    canvas(90, 60, 30),
    CANVAS,
    join(capsule, "golden-sets", name, PREVIEW_NAME),
    real,
  );
  const before = capsuleState();

  await refuses(promote(repeat), before);
});

/** A step that fails only where it was told to, and works nowhere else. */
function failingAt(where: (path: string) => boolean) {
  return async (path: string): Promise<void> => {
    if (where(path)) {
      throw new Error("the disk said no");
    }
  };
}

test("no failure before the manifest is published changes the release", async () => {
  const first = await candidate();
  await promote(first);
  const before = capsuleState();
  const changed = await candidate(() => nudged(canvas(30, 60, 90), 40));
  const failing = async () => {
    throw new Error("the disk said no");
  };

  // Every fallible step of a publication, one at a time: the golden copy, the
  // golden file's durability barrier, the staged set, the sets directory, the
  // staged manifest's write, the release directory, and the manifest rename.
  const steps: Record<string, unknown>[] = [
    { copy: failing },
    { sync: failingAt((path) => path.endsWith(".png")) },
    { sync: failingAt((path) => path.endsWith(`${INCOMING}`)) },
    { sync: failingAt((path) => path.endsWith("golden-sets")) },
    { write: failing },
    { sync: failingAt((path) => path === capsule) },
    {
      // The one rename that publishes. Every other rename still happens, so
      // the set this promotion built is whole and approved by nothing.
      swap: async (from: string, to: string) => {
        if (to.endsWith(MANIFEST)) {
          throw new Error("the disk said no");
        }
        await rename(from, to);
      },
    },
  ];
  for (const step of steps) {
    await refuses(promote(changed, step), before);
  }

  // And the release still verifies against the set it had all along.
  const after = await candidate();
  expect(after.verdict).toBe("pass");
  expect(after.golden_set).toBe(manifestOf().golden_set);
});

test("a failure after the manifest is published leaves the new set approved", async () => {
  const first = await candidate();
  await promote(first);
  const kept = manifestOf().golden_set;
  const drawn = () => nudged(canvas(30, 60, 90), 40);
  const changed = await candidate(drawn);

  // The last durability barrier fails, after the rename that published the
  // manifest. The set it names is already whole, so it stays whole.
  let published = false;
  await promote(changed, {
    swap: async (from: string, to: string) => {
      await rename(from, to);
      published = published || to.endsWith(MANIFEST);
    },
    sync: async () => {
      if (published) {
        throw new Error("the disk said no");
      }
    },
  });

  const manifest = manifestOf();
  expect(manifest.golden_set).not.toBe(kept);
  expect(existsSync(join(capsule, "golden-sets", manifest.golden_set))).toBe(true);
  const after = await candidate(drawn);
  expect(after.verdict).toBe("pass");
  expect(after.golden_set).toBe(manifest.golden_set);
});

test("a manifest is never published through a staging path someone else created", async () => {
  const report = await candidate();
  const before = capsuleState();
  const outside = join(workspace, "outside");
  mkdirSync(outside, { recursive: true });
  const decoy = join(outside, "kept.json");
  writeFileSync(decoy, "not mine to write\n");
  const staging = join(capsule, `${MANIFEST}${INCOMING}`);
  try {
    symlinkSync(decoy, staging, "file");
  } catch {
    // A file symlink is a Windows privilege; a linked directory is the same
    // pre-created node at the same path, and is available everywhere.
    symlinkSync(outside, staging, "junction");
  }

  await expect(promote(report)).rejects.toBeInstanceOf(PromotionRefused);

  // Nothing was written through the link, and nothing beyond it was removed.
  expect(readFileSync(decoy, "utf8")).toBe("not mine to write\n");
  expect(readdirSync(outside)).toEqual(["kept.json"]);
  expect(existsSync(join(capsule, MANIFEST))).toBe(false);
  rmSync(staging, { recursive: true, force: true });
  expect(readFileSync(decoy, "utf8")).toBe("not mine to write\n");
  expect(capsuleState()).toEqual(before);
});

test("a failed copy, sync, or manifest switch leaves the approved release alone", async () => {
  const first = await candidate();
  await promote(first);
  const before = capsuleState();
  const failing = async () => {
    throw new Error("the disk said no");
  };

  const changed = await candidate(() => nudged(canvas(30, 60, 90), 40));
  await refuses(promote(changed, { copy: failing }), before);
  await refuses(promote(changed, { sync: failing }), before);
  await refuses(promote(changed, { swap: failing }), before);

  // And the release still verifies against the set it had all along.
  const after = await candidate();
  expect(after.verdict).toBe("pass");
  expect(after.golden_set).toBe(manifestOf().golden_set);
});
