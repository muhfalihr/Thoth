/**
 * The capture's ownership boundary: one child process, and a kill.
 *
 * Remotion's bundler cannot be cancelled once it has started, `selectComposition`
 * answers only to a timeout, and a Chrome that stopped answering is not this
 * process's to close. So a run does not own the capture directly — it owns a
 * process it can end. Ending it is a signal to the whole group and, if that is
 * refused, a kill that cannot be, followed by removing the one temporary
 * directory everything the capture made lives under.
 *
 * That is why this exists at all: an `AbortSignal` alone proves that a stop was
 * asked for, never that anything was given back.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { TemplateReleaseRun } from "./artifact-root";
import type { CapturedFrame } from "./release-capture";
import type { ReleaseCapsule } from "./release-capsule";
import type { CaptureSession } from "./template-release";

/** The capture process ended without handing back the frames it was asked for. */
export class CaptureProcessEnded extends Error {
  constructor() {
    super("release capture process ended");
    this.name = "CaptureProcessEnded";
  }
}

/** How long a capture gets to close itself before it is closed for it. */
const TERMINATION_GRACE_MS = 20_000;

/** The child entry: release-only, and never copied into the render image. */
const CAPTURE_ENTRY_POINT = resolve(import.meta.dir, "..", "scripts", "capture-release-frames.ts");

/** A supervised capture, and the directory its whole temporary world lives in. */
export type SupervisedCapture = CaptureSession & { readonly workDir: string };

/**
 * Start one capture in a process this one can end, whatever it is doing.
 *
 * Everything is taken before the child exists — the work directory, the request,
 * the frame paths — so there is no moment where a stop arrives and finds nothing
 * to stop, and nothing is taken again afterwards.
 */
export function superviseCapture(options: {
  capsule: ReleaseCapsule;
  run: Pick<TemplateReleaseRun, "previewFrame" | "renderFrame">;
  /** The child entry, replaced only to test what supervision itself does. */
  entry?: string;
  graceMs?: number;
}): SupervisedCapture {
  const grace = options.graceMs ?? TERMINATION_GRACE_MS;
  const workDir = mkdtempSync(join(tmpdir(), "thoth-release-capture-"));
  const request = join(workDir, "request.json");
  const answer = join(workDir, "frames.json");
  const asked: readonly CapturedFrame[] = options.capsule.frames.map((frame) => ({
    frame,
    preview: options.run.previewFrame(frame),
    render: options.run.renderFrame(frame),
  }));

  writeFileSync(
    request,
    JSON.stringify({
      // The capsule itself, as validated here: the child captures exactly this
      // document and these asset digests, and never reads the release again.
      capsule: options.capsule,
      answer,
      frames: asked,
    }),
  );

  const child = spawn(process.execPath, [options.entry ?? CAPTURE_ENTRY_POINT, request], {
    // Its own process group, so a browser the child launched is ended with it
    // instead of being left behind holding the capture's directory open.
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
    // Every temporary file the child, the bundler, or the browser makes lands
    // under one directory this process removes once the child is gone.
    env: { ...process.env, TMPDIR: workDir, TEMP: workDir, TMP: workDir },
  });

  const exited = new Promise<number | null>((settle) => {
    child.on("exit", (code) => settle(code));
    child.on("error", () => settle(null));
  });

  const frames = exited.then(async (code) => {
    if (code !== 0) {
      throw new CaptureProcessEnded();
    }
    return JSON.parse(await readFile(answer, "utf8")) as readonly CapturedFrame[];
  });

  let ending: Promise<void> | undefined;

  return {
    workDir,
    frames,
    stop: (): Promise<void> => (ending ??= end(child, exited, workDir, grace)),
  };
}

type CaptureRequest = {
  readonly capsule: ReleaseCapsule;
  readonly answer: string;
  readonly frames: readonly CapturedFrame[];
};

/** What the child is asked to capture, read back from the request it was handed. */
export async function captureRequestOf(requestPath: string): Promise<{
  capsule: ReleaseCapsule;
  run: Pick<TemplateReleaseRun, "previewFrame" | "renderFrame">;
  answer: string;
}> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as CaptureRequest;

  // Where each frame may be written, decided by the run and not by the child.
  const wanted = new Map(request.frames.map((entry) => [entry.frame, entry]));
  const named = (frame: number): CapturedFrame => {
    const entry = wanted.get(frame);
    if (entry === undefined) {
      throw new Error(`frame ${frame} was not requested`);
    }
    return entry;
  };
  return {
    capsule: request.capsule,
    run: {
      previewFrame: (frame) => named(frame).preview,
      renderFrame: (frame) => named(frame).render,
    },
    answer: request.answer,
  };
}

/**
 * End the capture, and resolve only once there is nothing left of it.
 *
 * The wait is bounded because the last signal is one no process can refuse, and
 * the directory is removed after the exit rather than beside it: a capture that
 * was still running could write into it again.
 */
async function end(
  child: ChildProcess,
  exited: Promise<number | null>,
  workDir: string,
  grace: number,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    signalGroup(child, "SIGTERM");
    const unrefusable = setTimeout(() => signalGroup(child, "SIGKILL"), grace);
    try {
      await exited;
    } finally {
      clearTimeout(unrefusable);
    }
  } else {
    await exited;
  }
  await rm(workDir, { recursive: true, force: true });
}

function signalGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      // Windows has no process group to signal; this ends the child itself.
      child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Already gone, which is the outcome that was asked for.
  }
}
