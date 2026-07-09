// browser.js — standalone CDP host for CLIPPER: launches and owns the automation browser.
//
// WHY THIS EXISTS
// ---------------
// Our scrapers drive a real, logged-in browser over the Chrome DevTools Protocol
// (see lib/cdp.js). Earlier that CDP endpoint came from a third-party browser-relay
// extension on port 18792 that also required a manual click ("attach tab") before every
// session. This module removes that dependency: CLIPPER launches its own browser.
//
// HOW CDP ACTUALLY WORKS (the thing the relay was hiding)
// -------------------------------------------------------
// Any Chromium browser (Brave / Chrome / Edge) launched with
//     --remote-debugging-port=<PORT> --user-data-dir=<DIR>
// natively exposes the CDP HTTP surface with ZERO extensions:
//     GET  http://127.0.0.1:<PORT>/json/version   → readiness + browser WS url
//     GET  http://127.0.0.1:<PORT>/json           → list of page targets, each with
//                                                     a `webSocketDebuggerUrl`
// Connecting a WebSocket to a target's `webSocketDebuggerUrl` lets you speak raw
// CDP (Runtime.evaluate, Page.navigate, Page.captureScreenshot, …). That is EXACTLY
// what lib/cdp.js already does — so all we ever needed was to launch the browser
// ourselves instead of borrowing an extension's endpoint.
//
// THE ONE CATCH (why an extension relay was used before)
// ------------------------------------------------------
// Brave v149 / Chromium 136+ refuses --remote-debugging-port on the DEFAULT profile
// for security. A relay extension was one workaround to reach that already-logged-in
// default profile. The professional alternative — the one every automation stack uses
// (Playwright/Puppeteer "persistent context") — is a DEDICATED user-data-dir the user
// logs into once. Chromium allows the debug port freely on a non-default profile, the
// cookies persist across runs, and there is no extension and no manual attach step.
//
// USAGE
// -----
//   bun lib/browser.js start     # launch managed browser, wait until CDP is ready
//   bun lib/browser.js status    # is it up? how many page tabs are attached?
//   bun lib/browser.js stop      # terminate the managed browser
//   bun lib/browser.js path      # print the browser binary that would be used
//   bun lib/browser.js env       # print shell export lines for THOTH_CDP
//
// First run: `bun lib/browser.js start`, then in the window that opens log into
// TikTok / Instagram / X once. Cookies live in the dedicated profile, so every later
// run reuses that login — no re-attach, no extension.
//
// ENV OVERRIDES
//   THOTH_CDP_PORT        CDP port (default 18800)
//   THOTH_BROWSER_BIN     explicit browser binary (skips auto-detect)
//   THOTH_BROWSER_PROFILE dedicated user-data-dir (default ~/.clipper/browser-profile)
//   THOTH_BROWSER_HEADLESS set to 1 to run headless (NOT recommended: breaks logins /
//                            trips anti-bot on TikTok/IG). Default: visible window.
//
// Node builtins only — no third-party packages.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { ui } from './ui.ts';

// ── configuration ──────────────────────────────────────────────────────────
const PORT = Number(process.env.THOTH_CDP_PORT) || 18800;
const HOST = '127.0.0.1';
const PROFILE_DIR =
  process.env.THOTH_BROWSER_PROFILE || path.join(os.homedir(), '.clipper', 'browser-profile');
const STATE_FILE = path.join(PROFILE_DIR, '.clipper-browser.json');
const HEADLESS = /^(1|true|yes)$/i.test(process.env.THOTH_BROWSER_HEADLESS || '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── browser binary discovery ────────────────────────────────────────────────
// Brave first (this box's daily driver + what lib/cdp.js was written against),
// then Chrome, then Edge. All are Chromium, so the CDP surface is identical.
function candidateBinaries() {
  if (process.env.THOTH_BROWSER_BIN) return [process.env.THOTH_BROWSER_BIN];
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'win32') {
    return [
      `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${pf86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${lad}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${lad}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  // linux
  return [
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
}

function resolveBinary() {
  for (const b of candidateBinaries()) {
    try {
      if (fs.existsSync(b)) return b;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

// ── CDP readiness / discovery ────────────────────────────────────────────────
function httpGetJSON(urlPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: urlPath, timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// True once the browser answers CDP on our port (a managed browser we launched,
// or one already running there).
async function isReady() {
  try {
    await httpGetJSON('/json/version');
    return true;
  } catch (_) {
    return false;
  }
}

async function pageTargets() {
  try {
    const t = await httpGetJSON('/json');
    return Array.isArray(t) ? t.filter((x) => x.type === 'page') : [];
  } catch (_) {
    return [];
  }
}

function portInUse() {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT });
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

// ── state file (pid/port bookkeeping for stop/status) ─────────────────────────
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}
function writeState(obj) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
}
function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch (_) {
    /* ignore */
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ── launch flags ──────────────────────────────────────────────────────────────
// Mirrors the hardening a managed automation browser wants: no first-run noise,
// no default-browser nag, no sync/crash bubbles polluting the debug session.
function launchArgs() {
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--remote-debugging-address=${HOST}`,
    // Chromium 111+ rejects CDP WebSocket upgrades from disallowed origins; Node's
    // ws sends none, but allowlisting all keeps every client (undici/ws) working.
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE_DIR}`, // dedicated profile → debug port allowed + login persists
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate,MediaRouter',
    '--restore-last-session=false',
    'about:blank',
  ];
  if (HEADLESS) {
    args.splice(args.length - 1, 0, '--headless=new');
  }
  return args;
}

// ── commands ──────────────────────────────────────────────────────────────────
async function cmdStart() {
  if (await isReady()) {
    const n = (await pageTargets()).length;
    console.log(
      ui.gold(`${ui.OK} Managed browser sudah aktif di http://${HOST}:${PORT} (${n} tab).`),
    );
    console.log(`   CDP base: http://${HOST}:${PORT}  →  scraper siap jalan.`);
    return 0;
  }
  if (await portInUse()) {
    console.log(
      ui.red(`${ui.ERR} Port ${PORT} dipakai proses lain yang bukan CDP (bukan /json/version).`),
    );
    console.log(`   Ganti port: set THOTH_CDP_PORT=<lain> lalu ulangi.`);
    return 1;
  }

  const bin = resolveBinary();
  if (!bin) {
    console.log(ui.red(`${ui.ERR} Tidak menemukan browser Chromium (Brave/Chrome/Edge).`));
    console.log('   Set THOTH_BROWSER_BIN ke path browser, atau install salah satunya.');
    return 1;
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`  ${ui.gold(ui.BLOCK)} Launch: ${path.basename(bin)}`);
  console.log(`   profile: ${PROFILE_DIR}`);
  console.log(`   CDP    : http://${HOST}:${PORT}${HEADLESS ? '  (headless)' : ''}`);

  const child = spawn(bin, launchArgs(), { detached: true, stdio: 'ignore' });
  child.on('error', (e) => {
    console.log(ui.red(`${ui.ERR} Gagal launch:`), e.message);
  });
  child.unref();
  writeState({
    pid: child.pid,
    port: PORT,
    bin,
    profile: PROFILE_DIR,
    startedAt: new Date().toISOString(),
  });

  // Wait until CDP answers (cold start of a fresh profile can take a few seconds).
  for (let i = 0; i < 40; i++) {
    if (await isReady()) {
      console.log(ui.gold(`${ui.OK} CDP siap di http://${HOST}:${PORT} (pid ${child.pid}).`));
      console.log('   Login sekali ke TikTok/IG/X di window ini; cookie tersimpan di profile.');
      console.log('   lib/cdp.ts otomatis pakai endpoint ini (default port 18800).');
      return 0;
    }
    await sleep(500);
  }
  console.log(ui.red(`${ui.ERR} Browser jalan tapi CDP tak merespon dalam 20s.`));
  console.log(
    '   Kemungkinan browser memblokir debug port di profile ini — cek THOTH_BROWSER_PROFILE.',
  );
  return 1;
}

async function cmdStatus() {
  const up = await isReady();
  const st = readState();
  if (up) {
    const tabs = await pageTargets();
    console.log(ui.gold(`${ui.OK} UP  http://${HOST}:${PORT}  —  ${tabs.length} page tab`));
    for (const t of tabs.slice(0, 8)) console.log(`   • ${String(t.url).slice(0, 90)}`);
    if (st)
      console.log(`   pid ${st.pid} · ${path.basename(st.bin || '?')} · since ${st.startedAt}`);
    return 0;
  }
  console.log(`⭘ DOWN  http://${HOST}:${PORT}  —  CDP tidak merespon.`);
  if (st && pidAlive(st.pid))
    console.log(
      `   (proses pid ${st.pid} masih hidup tapi CDP tak menjawab — coba stop lalu start.)`,
    );
  console.log('   Jalankan: bun lib/browser.ts start');
  return 1;
}

async function cmdStop() {
  const st = readState();
  if (!st || !st.pid) {
    console.log('Tidak ada state managed browser. Tak ada yang di-stop.');
    clearState();
    return 0;
  }
  if (!pidAlive(st.pid)) {
    console.log(`Proses pid ${st.pid} sudah mati.`);
    clearState();
    return 0;
  }
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F']);
    else process.kill(st.pid);
    console.log(`■ Managed browser (pid ${st.pid}) dihentikan.`);
  } catch (e) {
    console.log(ui.red(`${ui.ERR} Gagal stop pid ${st.pid}: ${e.message}`));
    return 1;
  }
  clearState();
  return 0;
}

function cmdPath() {
  const bin = resolveBinary();
  if (bin) {
    console.log(bin);
    return 0;
  }
  console.log('(tidak ditemukan — set THOTH_BROWSER_BIN)');
  return 1;
}

function cmdEnv() {
  const base = `http://${HOST}:${PORT}`;
  console.log(`# CLIPPER standalone CDP endpoint`);
  console.log(`export THOTH_CDP="${base}"      # bash`);
  console.log(`$env:THOTH_CDP="${base}"        # powershell`);
  return 0;
}

async function main() {
  const cmd = (process.argv[2] || 'start').toLowerCase();
  const table = { start: cmdStart, status: cmdStatus, stop: cmdStop, path: cmdPath, env: cmdEnv };
  const fn = table[cmd];
  if (!fn) {
    console.log('Usage: bun lib/browser.ts [start|status|stop|path|env]');
    process.exit(1);
  }
  process.exit((await fn()) || 0);
}

// Export the pieces cdp.js / verify.js may want to reuse programmatically.
const CDP_BASE = `http://${HOST}:${PORT}`;
export { PORT, HOST, PROFILE_DIR, CDP_BASE, isReady, pageTargets, resolveBinary, readState };

if (import.meta.main) main();
