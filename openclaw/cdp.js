// cdp.js — shared Chrome DevTools Protocol helper for OpenClaw workspace scripts.
//
// WHY: every CDP script used to re-implement httpGetJSON + WebSocket connect + cmd()
// + tab-finding (~50 dup lines each). This centralizes it so a fix lands everywhere,
// and gives ONE consistent "relay not attached" preflight message.
//
// Brave v149 (Chromium 136+) blocks --remote-debugging-port on the default profile,
// so OpenClaw serves CDP via the "OpenClaw Browser Relay" extension on port 18792 —
// but ONLY after you click the extension icon to ATTACH a tab. "ECONNREFUSED 18792"
// = relay not attached, NOT browser down. connect() turns that into a clear message.
//
// Requires Node 18+ (global fetch) / Node 21+ (global WebSocket). This box runs v24.
// Start CDP: openclaw node install && openclaw node start

const http = require('http');

const CDP_BASE = process.env.OPENCLAW_CDP || 'http://127.0.0.1:18792';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Mark relay/attach failures so run() can print the fix + exit(2) uniformly.
function relayError(msg) {
  const e = new Error(msg);
  e.relay = true;
  return e;
}

async function listTargets() {
  try {
    return await httpGetJSON(`${CDP_BASE}/json`);
  } catch (e) {
    throw relayError(`CDP relay tidak aktif di ${CDP_BASE} (${e.message}).`);
  }
}

function printRelayHelp() {
  console.log('   FIX: di Brave → buka/log-in tab target (TikTok/IG/X) → KLIK ikon extension');
  console.log('   "OpenClaw Browser Relay" untuk ATTACH tab itu (pin dulu kalau tersembunyi).');
  console.log(`   Relay menyajikan CDP di ${CDP_BASE}; lalu jalankan ulang perintah ini.`);
}

// Open a CDP session against a page tab.
//   match    : substring (or array of substrings) to prefer, e.g. 'tiktok.com' or
//              ['x.com','twitter.com']; falls back to any usable page tab unless requireMatch.
//   navigate : if set, navigate there after connecting and wait `waitMs`.
//   waitMs   : default settle time after navigate.
//   requireMatch : if true, throw (instead of grabbing any tab) when no match is attached —
//              use this for multi-platform scripts so they never drive the wrong site's tab.
// Returns { ws, tab, cmd, evaluate, navigate, scroll, screenshot, close }.
async function connect({ match, navigate, waitMs = 6000, requireMatch = false } = {}) {
  const targets = await listTargets();

  const matches = Array.isArray(match) ? match : (match ? [match] : []);
  let tab = matches.length
    ? targets.find(t => t.type === 'page' && matches.some(m => String(t.url).includes(m)) && !String(t.url).includes('sw.js'))
    : null;
  if (!tab && requireMatch) {
    throw relayError(`Tidak ada tab '${matches.join("' / '")}' yang ter-attach. Buka & login tab itu lalu attach relay.`);
  }
  if (!tab) {
    tab = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl
      && !String(t.url).startsWith('devtools://'));
  }
  if (!tab || !tab.webSocketDebuggerUrl) {
    throw relayError('Tidak ada page tab CDP yang bisa dipakai.');
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', () => j(relayError('Gagal connect WebSocket ke relay.')));
    setTimeout(() => j(relayError('WebSocket timeout ke relay.')), 10000);
  });

  let mid = 1;
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = mid++;
    const h = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          ws.removeEventListener('message', h);
          if (m.error) reject(new Error(`${method}: ${m.error.message}`));
          else resolve(m.result);
        }
      } catch (_) { /* ignore non-JSON frames */ }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', h); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  });

  const evaluate = async expr =>
    (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;

  const client = {
    ws, tab, cmd, evaluate,
    async navigate(url, w = waitMs) { await cmd('Page.navigate', { url }); await sleep(w); return evaluate('window.location.href'); },
    scroll(y) { return cmd('Runtime.evaluate', { expression: `window.scrollTo(0, ${y})` }); },
    async screenshot() { return (await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true })).data; },
    close() { try { ws.close(); } catch (_) {} },
  };

  if (navigate) await client.navigate(navigate, waitMs);
  return client;
}

// Wrap a script's main(): on relay/attach failure print the fix and exit(2),
// on any other error exit(1). Keeps every CLI's error handling identical.
async function run(main) {
  try {
    await main();
  } catch (e) {
    if (e && e.relay) { console.log('❌ ' + e.message); printRelayHelp(); process.exit(2); }
    console.error('❌', e && e.message ? e.message : e);
    process.exit(1);
  }
}

module.exports = { CDP_BASE, sleep, httpGetJSON, listTargets, connect, printRelayHelp, run };
