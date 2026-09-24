/**
 * The capture's ownership boundary: one child process, and a kill.
 *
 * Remotion's bundler cannot be cancelled once it has started, `selectComposition`
 * answers only to a timeout, and a Chrome that stopped answering is not this
 * process's to close. So a run does not own the capture directly — it owns a
 * process it can end, and every process that one started. On Linux the capture
 * runs under a keeper that is a child subreaper, so nothing the capture starts
 * can leave the keeper's subtree however it detaches. Ending it is a signal to
 * all of them and, if that is refused, a kill that cannot be; only once the
 * keeper has said it holds nothing is it released and the one temporary
 * directory everything the capture made lives under removed.
 *
 * That is why this exists at all: an `AbortSignal` alone proves that a stop was
 * asked for, never that anything was given back.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/** The capture could not be shown to have ended: something it started may still run. */
export class CaptureTeardownUnconfirmed extends Error {
  constructor() {
    super("release capture teardown unconfirmed");
    this.name = "CaptureTeardownUnconfirmed";
  }
}

/** How long a capture gets to close itself before it is closed for it. */
const TERMINATION_GRACE_MS = 20_000;

/** How long a killed capture gets to be seen gone before that is reported as unknown. */
const KILL_WAIT_MS = 5_000;

/** How often a capture being ended is looked at, and its stragglers killed. */
const SCAN_MS = 50;

/** The child entry: release-only, and never copied into the render image. */
const CAPTURE_ENTRY_POINT = resolve(import.meta.dir, "..", "scripts", "capture-release-frames.ts");

/** The Linux subreaper the capture runs under, release-only for the same reason. */
const KEEPER_ENTRY_POINT = resolve(import.meta.dir, "..", "scripts", "capture-keeper.ts");

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

  // Linux runs the capture under a keeper; elsewhere the capture is the child and
  // only it can be ended (Remotion's browser shares its lifetime on Windows).
  const kept = process.platform === "linux";
  const entry = options.entry ?? CAPTURE_ENTRY_POINT;
  const child = spawn(process.execPath, kept ? [KEEPER_ENTRY_POINT, entry, request] : [entry, request], {
    // Its own process group, so what the capture launched without detaching is
    // ended with it.
    detached: process.platform !== "win32",
    // The keeper's standard output is what it holds and how the capture ended.
    stdio: ["ignore", kept ? "pipe" : "inherit", "inherit"],
    // Every temporary file the child, the bundler, or the browser makes lands
    // under one directory this process removes once the child is gone.
    env: { ...process.env, TMPDIR: workDir, TEMP: workDir, TMP: workDir },
  });

  // `close`, not `exit`: by then everything the keeper said has been read.
  let over = false;
  const gone = new Promise<void>((settle) => {
    child.on("close", () => settle());
    child.on("error", () => settle());
  }).then(() => {
    over = true;
  });

  let said = "";
  const told = (line: string): boolean => said.split("\n").slice(0, -1).includes(line);
  const exited = new Promise<number | null>((settle) => {
    void gone.then(() => settle(null));
    child.on("exit", (code) => {
      if (!kept) {
        settle(code);
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      said += chunk;
      const reported = /^exited (-?\d+)\n/m.exec(said);
      if (reported !== null) {
        settle(Number(reported[1]));
      }
    });
  });

  const frames = exited.then(async (code) => {
    if (code !== 0) {
      throw new CaptureProcessEnded();
    }
    return JSON.parse(await readFile(answer, "utf8")) as readonly CapturedFrame[];
  });

  // Whether nothing of the capture is left: the keeper said so, or ended before
  // it started anything. Elsewhere, whether the child is gone.
  const clear = (): boolean => (kept ? told("empty") || (over && !told("held")) : over);

  // What of the capture is seen running, to be signalled; null once that can no
  // longer be known, because a keeper that is gone has handed it all to init.
  const held = (): number[] | null => {
    if (child.pid === undefined || over) {
      return kept && over ? null : [];
    }
    return kept ? runningBelow(child.pid) : [child.pid];
  };

  let ending: Promise<void> | undefined;

  return {
    workDir,
    frames,
    stop: (): Promise<void> => (ending ??= end({ child, clear, held, gone, workDir, grace })),
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
 * Every wait is bounded because the last signal is one no process can refuse,
 * and the directory is removed after the processes rather than beside them: a
 * capture that was still running could write into it again. A capture that is
 * still seen running after the kill, or can no longer be seen at all, is removed
 * from anyway and reported, never silently given back.
 */
async function end(capture: {
  child: ChildProcess;
  clear: () => boolean;
  held: () => number[] | null;
  gone: Promise<void>;
  workDir: string;
  grace: number;
}): Promise<void> {
  const { child, clear, held } = capture;
  // The polite half: the capture closes what it opened, and what it cannot
  // answer for is asked directly. The keeper only takes this as the question
  // whether it still holds anything.
  signalGroup(child, "SIGTERM");
  signalEach(held() ?? [], "SIGTERM");
  const confirmed =
    (await emptied(clear, held, capture.grace, null)) ||
    (await emptied(clear, held, KILL_WAIT_MS, "SIGKILL"));
  // The keeper is released last: ended any earlier, whatever it still held
  // would pass to init, out of sight.
  signalGroup(child, "SIGKILL");
  await capture.gone;
  await rm(capture.workDir, { recursive: true, force: true });
  if (!confirmed) {
    throw new CaptureTeardownUnconfirmed();
  }
}

/**
 * Whether the capture is clear within `within`, killing whatever is seen of it
 * if asked. What is seen only picks what to kill: a look at the process table
 * can miss a process forked while it is read, so it is never taken as proof.
 */
async function emptied(
  clear: () => boolean,
  held: () => number[] | null,
  within: number,
  kill: "SIGKILL" | null,
): Promise<boolean> {
  const until = Date.now() + within;
  for (;;) {
    if (clear()) {
      return true;
    }
    const running = held();
    if (running === null) {
      return false;
    }
    if (kill !== null) {
      signalEach(running, kill);
    }
    if (Date.now() >= until) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, SCAN_MS));
  }
}

function signalEach(pids: readonly number[], signal: "SIGTERM" | "SIGKILL"): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Every running process seen below `root` in `/proc` (Linux only), `root`
 * excluded: what there is to kill, never proof that nothing else runs.
 */
function runningBelow(root: number): number[] {
  const table = new Map<number, { ppid: number; running: boolean }>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // Gone between listing and reading.
    }
    // The command name may hold spaces and parentheses; the fields after it cannot.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // A zombie has ended; it is only waiting for a parent that may never reap it.
    table.set(Number(name), { ppid: Number(fields[1]), running: fields[0] !== "Z" && fields[0] !== "X" });
  }

  const below = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, entry] of table) {
      if (!below.has(pid) && below.has(entry.ppid)) {
        below.add(pid);
        grew = true;
      }
    }
  }
  below.delete(root);
  return [...below].filter((pid) => table.get(pid)?.running === true);
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
