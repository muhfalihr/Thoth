/**
 * Capture one release's frames, in a process the verifier can end.
 *
 * Everything that cannot be cancelled in-process lives here: the bundler, the
 * browser, the preview server, and every temporary file they make. The parent
 * hands this process one request file and one directory to live in, and ends it
 * by signalling it; a polite stop is answered by closing both surfaces, and a
 * stop that is not answered is not this process's decision to make.
 *
 * It is never run by hand: `scripts/verify-template-release.ts` starts it.
 */

import { readFile, writeFile } from "node:fs/promises";

import type { TemplateReleaseRun } from "../src/artifact-root";
import { captureReleaseFrames, type CapturedFrame } from "../src/release-capture";
import { loadReleaseCapsule, releaseIdentityOf } from "../src/release-capsule";

const [requestPath, ...extra] = process.argv.slice(2);

if (requestPath === undefined || extra.length > 0) {
  console.error("usage: capture-release-frames <request>");
  process.exit(2);
}

type CaptureRequest = {
  readonly release: string;
  readonly release_root: string;
  readonly answer: string;
  readonly frames: readonly CapturedFrame[];
};

const request = JSON.parse(await readFile(requestPath, "utf8")) as CaptureRequest;
const capsule = await loadReleaseCapsule(releaseIdentityOf(request.release), {
  releaseRoot: request.release_root,
});

// Where each frame may be written, decided by the run and not by this process.
const wanted = new Map(request.frames.map((entry) => [entry.frame, entry]));
const run = {
  previewFrame: (frame: number): string => named(frame).preview,
  renderFrame: (frame: number): string => named(frame).render,
} satisfies Pick<TemplateReleaseRun, "previewFrame" | "renderFrame">;

function named(frame: number): CapturedFrame {
  const entry = wanted.get(frame);
  if (entry === undefined) {
    throw new Error(`frame ${frame} was not requested`);
  }
  return entry;
}

// The polite half of being ended: close the browser, the page, and the server
// before the parent stops waiting and ends this process the way it can.
const stop = new AbortController();
const abort = (): void => stop.abort();
process.on("SIGTERM", abort);
process.on("SIGINT", abort);

try {
  const captured = await captureReleaseFrames({ capsule, run, signal: stop.signal });
  await writeFile(request.answer, JSON.stringify(captured));
  process.exit(0);
} catch (error) {
  // The parent reports one fixed verdict; the words stay in the container's log.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
