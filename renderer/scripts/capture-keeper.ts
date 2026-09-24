/**
 * Hold every process a capture starts, so that none of them can leave unseen.
 *
 * Linux only. This process makes itself a child subreaper, then starts the
 * capture entry. Whatever the capture starts — however it detaches, and even
 * after the process that started it has exited — is re-parented here rather
 * than to init, so while this process lives every process of the capture is
 * below it. It never ends itself and ignores a polite stop: the supervisor ends
 * it, and only once this process has said it holds nothing.
 *
 * That answer is the kernel's, not a look at `/proc`: `waitid` failing with
 * `ECHILD` means this process has no child, and so, being the subreaper, no
 * descendant at all.
 *
 * Its standard output is lines, each written whole: `held` once it is a
 * subreaper and before anything is started, `exited <code>` when the capture
 * entry ends, and `empty` once it has been asked to stop and holds nothing. A
 * keeper that never said `held` never started anything. The capture's own
 * output goes to standard error.
 *
 * It is never run by hand: `src/capture-supervisor.ts` starts it.
 */

import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

import { FFIType, dlopen, read } from "bun:ffi";

const PR_SET_CHILD_SUBREAPER = 36;
const P_ALL = 0;
const WNOHANG = 1;
const WEXITED = 4;
const WNOWAIT = 0x0100_0000;
const ECHILD = 10;
/** `siginfo_t` is 128 bytes; `si_pid` sits at byte 16 on every Linux ABI. */
const SIGINFO_BYTES = 128;
const SI_PID = 16;

const [entry, request, ...extra] = process.argv.slice(2);

if (entry === undefined || request === undefined || extra.length > 0) {
  console.error("usage: capture-keeper <entry> <request>");
  process.exit(2);
}

// Installed first: a polite stop that arrives while this is starting must not
// end it once it holds anything. Once asked, it answers when it holds nothing.
let settling: ReturnType<typeof setInterval> | undefined;
process.on("SIGTERM", () => {
  settling ??= setInterval(settle, 50);
});
process.on("SIGINT", () => {});

const libc = dlopen("libc.so.6", {
  prctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
  waitid: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
});
if (libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
  // Nothing is started that could not be held.
  console.error("capture keeper could not become a subreaper");
  process.exit(3);
}

writeSync(1, "held\n");

const capture = spawn(process.execPath, [entry, request], { stdio: ["ignore", 2, 2] });
capture.on("exit", (code) => writeSync(1, `exited ${code ?? -1}\n`));
capture.on("error", () => writeSync(1, "exited -1\n"));

/**
 * Reap every orphan that has ended, and say `empty` once no child is left.
 *
 * The capture entry itself is left to the runtime that started it, so its exit
 * is still reported; until that is reaped, this is simply not empty yet.
 */
function settle(): void {
  const info = new Uint8Array(SIGINFO_BYTES);
  for (;;) {
    info.fill(0);
    if (libc.symbols.waitid(P_ALL, 0, info, WEXITED | WNOHANG | WNOWAIT) !== 0) {
      // Anything but "no child" is not an answer, so it is never reported as one.
      const errno = libc.symbols.__errno_location();
      if (errno !== null && read.i32(errno) === ECHILD) {
        clearInterval(settling);
        writeSync(1, "empty\n");
      }
      return;
    }
    const pid = new DataView(info.buffer).getInt32(SI_PID, true);
    if (pid === 0 || pid === capture.pid) {
      return; // Something is still running, or the capture is not reaped yet.
    }
    libc.symbols.waitpid(pid, null, 0);
  }
}

// Held open until the supervisor ends it.
setInterval(() => {}, 60_000);
