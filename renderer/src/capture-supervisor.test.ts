/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureRequestOf, superviseCapture } from "./capture-supervisor";
import { canonicalReleaseRoot, loadReleaseCapsule, type ReleaseCapsule } from "./release-capsule";

let workspace: string;
let entries = 0;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "thoth-supervise-"));
  entries = 0;
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Only the three facts supervision reads: which capsule, where, which frames. */
function capsule(): ReleaseCapsule {
  return {
    identity: "vertical_text_story-v1",
    directory: join(workspace, "releases", "vertical_text_story-v1"),
    frames: [0],
  } as unknown as ReleaseCapsule;
}

const run = {
  previewFrame: (frame: number): string => join(workspace, `preview-${frame}.png`),
  renderFrame: (frame: number): string => join(workspace, `render-${frame}.png`),
};

function entryThat(body: string): string {
  entries += 1;
  const path = join(workspace, `entry-${entries}.ts`);
  writeFileSync(path, body);
  return path;
}

/** The outcome of a capture, recorded now and read after the run is over. */
function outcomeOf(frames: Promise<unknown>): Promise<string> {
  return frames.then(
    () => "answered",
    (reason: Error) => reason.constructor.name,
  );
}

async function until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !ready(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!ready()) {
    throw new Error("the capture never reached the state this test waits for");
  }
}

test("a capture that finishes hands back the frames the run asked for", async () => {
  const entry = entryThat(`
    const request = JSON.parse(await Bun.file(process.argv[2]).text());
    await Bun.write(request.answer, JSON.stringify(request.frames));
  `);

  const session = superviseCapture({ capsule: capsule(), run, entry });

  await expect(session.frames).resolves.toEqual([
    { frame: 0, preview: run.previewFrame(0), render: run.renderFrame(0) },
  ]);
  await session.stop();
  // Nothing the capture was given to work in outlives the report.
  expect(existsSync(session.workDir)).toBe(false);
});

test("a capture that refuses to stop is ended before the run is told", async () => {
  const entry = entryThat(`
    // A capture that answers nothing and refuses the polite way out, which is
    // what a wedged bundler or a browser that stopped answering looks like.
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    await Bun.write(process.env.TMPDIR + "/held", "a resource this process holds");
    setInterval(() => {}, 1000);
  `);

  const session = superviseCapture({ capsule: capsule(), run, entry, graceMs: 200 });
  const ended = outcomeOf(session.frames);
  await until(() => existsSync(join(session.workDir, "held")));

  await session.stop();

  // The directory is removed only after the child is gone, so its absence is
  // the proof that nothing is left running that could write into it again.
  expect(existsSync(session.workDir)).toBe(false);
  expect(await ended).toBe("CaptureProcessEnded");
});

test("a capture ended twice is ended once", async () => {
  const entry = entryThat(`setInterval(() => {}, 1000);`);

  const session = superviseCapture({ capsule: capsule(), run, entry, graceMs: 200 });
  const ended = outcomeOf(session.frames);

  await Promise.all([session.stop(), session.stop()]);
  await session.stop();

  expect(existsSync(session.workDir)).toBe(false);
  expect(await ended).toBe("CaptureProcessEnded");
});

test("the child captures the document the parent validated, not the one on disk now", async () => {
  const releases = join(workspace, "releases");
  const directory = join(releases, "vertical_text_story-v1");
  cpSync(join(canonicalReleaseRoot(), "vertical_text_story-v1"), directory, { recursive: true });
  const validated = await loadReleaseCapsule("vertical_text_story-v1", { releaseRoot: releases });
  // The child never starts capturing: this test reads the request it was handed.
  const session = superviseCapture({ capsule: validated, run, entry: entryThat("setInterval(() => {}, 1000);") });
  const ended = outcomeOf(session.frames);

  try {
    const document = join(directory, "document.json");
    writeFileSync(
      document,
      readFileSync(document, "utf8").replace('"project_template_release"', '"project_swapped"'),
    );

    const { capsule: handed } = await captureRequestOf(join(session.workDir, "request.json"));

    expect(handed.document_sha256).toBe(validated.document_sha256);
    expect(handed.document).toEqual(validated.document);
    expect(handed.assets).toEqual(validated.assets);
  } finally {
    await session.stop();
  }
  expect(await ended).toBe("CaptureProcessEnded");
});
