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

import { writeFile } from "node:fs/promises";

import { captureRequestOf } from "../src/capture-supervisor";
import { captureReleaseFrames } from "../src/release-capture";

const [requestPath, ...extra] = process.argv.slice(2);

if (requestPath === undefined || extra.length > 0) {
  console.error("usage: capture-release-frames <request>");
  process.exit(2);
}

const { capsule, run, answer } = await captureRequestOf(requestPath);

// The polite half of being ended: close the browser, the page, and the server
// before the parent stops waiting and ends this process the way it can.
const stop = new AbortController();
const abort = (): void => stop.abort();
process.on("SIGTERM", abort);
process.on("SIGINT", abort);

try {
  const captured = await captureReleaseFrames({ capsule, run, signal: stop.signal });
  await writeFile(answer, JSON.stringify(captured));
  process.exit(0);
} catch (error) {
  // The parent reports one fixed verdict; the words stay in the container's log.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
