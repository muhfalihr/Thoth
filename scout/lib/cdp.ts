// cdp.ts — shared Chrome DevTools Protocol helper for Thoth scraper scripts.
//
// WHY: every CDP script used to re-implement httpGetJSON + WebSocket connect + cmd()
// + tab-finding (~50 dup lines each). This centralizes it so a fix lands everywhere,
// and gives ONE consistent "CDP not up — start the managed browser" preflight message.
//
// CDP endpoint: STANDALONE managed browser. lib/browser.ts launches a Chromium
// (Brave/Chrome/Edge) with --remote-debugging-port + a dedicated profile, which natively
// serves CDP on port 18800. Override with THOTH_CDP; otherwise defaults to 18800.
// "ECONNREFUSED" on the default port = managed browser not started, NOT browser down.
// Start it: `bun lib/browser.ts start` (see lib/browser.ts header for the full CDP writeup).
//
// Requires Node 18+ (global fetch) / Node 21+ (global WebSocket). This box runs v24.

import http from 'node:http';
import { ui } from './ui.ts';

const CDP_BASE: string = process.env.THOTH_CDP || 'http://127.0.0.1:18800';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A /json target entry (only the fields we use).
export interface CdpTarget {
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
  [k: string]: any;
}

export interface CdpRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CdpClient {
  ws: WebSocket;
  tab: CdpTarget;
  cmd: (method: string, params?: Record<string, any>) => Promise<any>;
  evaluate: (expr: string) => Promise<any>;
  navigate: (url: string, waitMs?: number) => Promise<any>;
  scroll: (y: number) => Promise<any>;
  screenshot: () => Promise<string>;
  captureClip: (
    rect: CdpRect,
    pad?: number,
    opts?: { beyondViewport?: boolean },
  ) => Promise<string>;
  close: () => void;
}

export interface ConnectOpts {
  match?: string | string[];
  navigate?: string;
  waitMs?: number;
  requireMatch?: boolean;
}

function httpGetJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

// Mark relay/attach failures so run() can print the fix + exit(2) uniformly.
function relayError(msg: string): Error & { relay: true } {
  const e = new Error(msg) as Error & { relay: true };
  e.relay = true;
  return e;
}

async function listTargets(): Promise<CdpTarget[]> {
  try {
    return await httpGetJSON(`${CDP_BASE}/json`);
  } catch (e: any) {
    throw relayError(`CDP tidak aktif di ${CDP_BASE} (${e.message}).`);
  }
}

function printRelayHelp(): void {
  console.log('   FIX (standalone): jalankan  bun lib/browser.ts start');
  console.log('   → browser terbuka; login sekali ke tab target (TikTok/IG/X), cookie tersimpan.');
  console.log(
    `   → lib/browser.ts menyajikan CDP di ${CDP_BASE}; lalu jalankan ulang perintah ini.`,
  );
  console.log('   Cek status kapan saja:  bun lib/browser.ts status');
}

// Open a CDP session against a page tab.
//   match    : substring (or array of substrings) to prefer, e.g. 'tiktok.com' or
//              ['x.com','twitter.com']; falls back to any usable page tab unless requireMatch.
//   navigate : if set, navigate there after connecting and wait `waitMs`.
//   waitMs   : default settle time after navigate.
//   requireMatch : if true, throw (instead of grabbing any tab) when no match is attached —
//              use this for multi-platform scripts so they never drive the wrong site's tab.
// Returns { ws, tab, cmd, evaluate, navigate, scroll, screenshot, close }.
async function connect({
  match,
  navigate,
  waitMs = 6000,
  requireMatch = false,
}: ConnectOpts = {}): Promise<CdpClient> {
  const targets = await listTargets();

  const matches = Array.isArray(match) ? match : match ? [match] : [];
  let tab = matches.length
    ? targets.find(
        (t) =>
          t.type === 'page' &&
          matches.some((m) => String(t.url).includes(m)) &&
          !String(t.url).includes('sw.js'),
      )
    : null;
  if (!tab && requireMatch) {
    throw relayError(
      `Tidak ada tab '${matches.join("' / '")}' yang terbuka. Buka & login tab itu di managed browser (bun lib/browser.ts start).`,
    );
  }
  if (!tab) {
    tab = targets.find(
      (t) =>
        t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'),
    );
  }
  if (!tab || !tab.webSocketDebuggerUrl) {
    throw relayError('Tidak ada page tab CDP yang bisa dipakai.');
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', () => j(relayError('Gagal connect WebSocket CDP.')));
    setTimeout(() => j(relayError('WebSocket timeout ke CDP.')), 10000);
  });

  let mid = 1;
  const cmd = (method: string, params: Record<string, any> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = mid++;
      const h = (ev: MessageEvent) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.id === id) {
            ws.removeEventListener('message', h);
            if (m.error) reject(new Error(`${method}: ${m.error.message}`));
            else resolve(m.result);
          }
        } catch (_) {
          /* ignore non-JSON frames */
        }
      };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        ws.removeEventListener('message', h);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
    });

  const evaluate = async (expr: string): Promise<any> =>
    (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;

  const client: CdpClient = {
    ws,
    tab,
    cmd,
    evaluate,
    async navigate(url, w = waitMs) {
      await cmd('Page.navigate', { url });
      await sleep(w);
      return evaluate('window.location.href');
    },
    scroll(y) {
      return cmd('Runtime.evaluate', { expression: `window.scrollTo(0, ${y})` });
    },
    async screenshot() {
      return (await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true })).data;
    },
    // Crop a region given a CSS-pixel rect {x,y,w,h} (+ optional CSS pad). captureScreenshot's `clip`
    // is in CSS pixels (same as DOM/getBoundingClientRect coords); Chrome renders the output at the
    // page's devicePixelRatio automatically (scale:1). Do NOT multiply by dpr — that DOUBLE-applies
    // it: at dpr=2 the clip x/width come out 2× → the crop shifts right (left-chopped) and balloons
    // with a black empty right. Pass {beyondViewport:true} (with PAGE coords) so regions outside the
    // viewport render instead of capturing black. Returns base64 PNG or ''. Verified at dpr 0.9 & 2.
    async captureClip(rect, pad = 0, opts = {}) {
      if (!rect || !(rect.w > 0) || !(rect.h > 0)) return '';
      const clip = {
        x: Math.max(0, rect.x - pad),
        y: Math.max(0, rect.y - pad),
        width: rect.w + pad * 2,
        height: rect.h + pad * 2,
        scale: 1,
      };
      const params: Record<string, any> = { format: 'png', clip, fromSurface: true };
      if (opts.beyondViewport) params.captureBeyondViewport = true;
      try {
        const shot = await cmd('Page.captureScreenshot', params);
        return shot.data;
      } catch (e) {
        return '';
      }
    },
    close() {
      try {
        ws.close();
      } catch (_) {}
    },
  };

  if (navigate) await client.navigate(navigate, waitMs);
  return client;
}

// Wrap a script's main(): on relay/attach failure print the fix and exit(2),
// on any other error exit(1). Keeps every CLI's error handling identical.
async function run(main: () => Promise<any> | any): Promise<void> {
  try {
    await main();
  } catch (e: any) {
    if (e && e.relay) {
      console.log(ui.red(`${ui.ERR} ${e.message}`));
      printRelayHelp();
      process.exit(2);
    }
    console.error(ui.red(`${ui.ERR} ${e && e.message ? e.message : e}`));
    process.exit(1);
  }
}

export { CDP_BASE, sleep, httpGetJSON, listTargets, connect, printRelayHelp, run };
