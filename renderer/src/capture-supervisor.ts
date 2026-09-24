/**
 * The capture's ownership boundary: one child process, and a kill.
 *
 * Remotion's bundler cannot be cancelled once it has started, `selectComposition`
 * answers only to a timeout, and a Chrome that stopped answering is not this
 * process's to close. So a run does not own the capture directly — it owns a
 * process it can end, and every process that one started. Ending it is a signal
 * to all of them and, if that is refused, a kill that cannot be; only once none
 * of them is seen running is the one temporary directory everything the capture
 * made lives under removed.
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

/** How often the processes a capture owns are looked for. */
const SCAN_MS = 50;

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
  let over = false;
  void exited.then(() => {
    over = true;
  });

  // Remotion starts Chrome in a session of its own, which no signal to this
  // child's group reaches; it is found while its parent is still this child.
  const owned =
    process.platform === "linux" && child.pid !== undefined ? new OwnedProcesses(child.pid) : null;
  const watch = owned === null ? undefined : setInterval(() => owned.scan(), SCAN_MS);
  watch?.unref();

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
    stop: (): Promise<void> =>
      (ending ??= end({ child, over: () => over, owned, watch, workDir, grace })),
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
 * still seen running after the kill is removed from anyway and reported, never
 * silently given back.
 */
async function end(capture: {
  child: ChildProcess;
  over: () => boolean;
  owned: OwnedProcesses | null;
  watch: ReturnType<typeof setInterval> | undefined;
  workDir: string;
  grace: number;
}): Promise<void> {
  const { child, owned, workDir } = capture;
  // The polite half: the child closes what it opened, and what it cannot answer
  // for is asked directly.
  if (!capture.over()) {
    signalGroup(child, "SIGTERM");
  }
  signalEach(owned?.scan() ?? [], "SIGTERM");
  let gone = await settled(capture, capture.grace, null);
  if (!gone) {
    if (!capture.over()) {
      signalGroup(child, "SIGKILL");
    }
    gone = await settled(capture, KILL_WAIT_MS, "SIGKILL");
  }
  clearInterval(capture.watch);
  await rm(workDir, { recursive: true, force: true });
  if (!gone) {
    throw new CaptureTeardownUnconfirmed();
  }
}

/** Whether the child and all it started are gone within `within`, killing stragglers if asked. */
async function settled(
  capture: { over: () => boolean; owned: OwnedProcesses | null },
  within: number,
  kill: "SIGKILL" | null,
): Promise<boolean> {
  const until = Date.now() + within;
  for (;;) {
    const running = capture.owned?.scan() ?? [];
    if (capture.over() && running.length === 0) {
      return true;
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
 * Every process a capture started, followed across `setsid` (Linux only).
 *
 * A process belongs to the capture if its parent does, or if it is in a session
 * one of the capture's processes leads, which is how a browser's own children
 * stay found after the process that launched it is gone. A process is known by
 * its pid and start time together, so a recycled pid is never mistaken for it.
 *
 * ponytail: polled, so a process that detaches and loses its parent between two
 * scans escapes; PR_SET_CHILD_SUBREAPER on the child closes that if it matters.
 */
class OwnedProcesses {
  private readonly owned = new Map<number, string>();
  private readonly sessions = new Set<number>();

  constructor(root: number) {
    const entry = processTable().get(root);
    if (entry !== undefined) {
      this.owned.set(root, entry.start);
    }
  }

  /** Learn every process that belongs to the capture now, and answer which still run. */
  scan(): number[] {
    const table = processTable();
    for (const [pid, start] of this.owned) {
      if (table.get(pid)?.start !== start) {
        this.owned.delete(pid);
      }
    }
    // A session nobody is in any more is a number the kernel may hand out again.
    const inUse = new Set([...table.values()].map((entry) => entry.session));
    for (const session of this.sessions) {
      if (!inUse.has(session)) {
        this.sessions.delete(session);
      }
    }
    for (let grew = true; grew; ) {
      grew = false;
      for (const pid of this.owned.keys()) {
        if (table.get(pid)?.session === pid) {
          this.sessions.add(pid);
        }
      }
      for (const [pid, entry] of table) {
        if (this.owned.has(pid) || !(this.owned.has(entry.ppid) || this.sessions.has(entry.session))) {
          continue;
        }
        this.owned.set(pid, entry.start);
        grew = true;
      }
    }
    return [...this.owned.keys()].filter((pid) => table.get(pid)?.running === true);
  }
}

type ProcessEntry = { ppid: number; session: number; start: string; running: boolean };

/** Every process `/proc` shows now: parent, session, start time, and whether it runs. */
function processTable(): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
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
    table.set(Number(name), {
      ppid: Number(fields[1]),
      session: Number(fields[3]),
      start: fields[19] ?? "",
      // A zombie has ended; it is only waiting for a parent that may never reap it.
      running: fields[0] !== "Z" && fields[0] !== "X",
    });
  }
  return table;
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
