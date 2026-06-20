// discover_reels.js — discover potential-viral TOPICS from curator IG accounts' RECENT reels.
// These accounts (stories/commentary) surface hot angles before X/YT trends, BUT the topic lives in
// the VOICEOVER (audio) or the on-screen HOOK text — almost never in the caption (which shows the
// song). So we read the topic from the opening frame's hook (vision); if that's vague we transcribe
// ~30s of audio (Groq Whisper — guarded: only if a GROQ key exists).
//
//   node discover_reels.js [--accounts h1,h2,..] [--max-per N] [--hours 48] [--out file]
//
// Needs a logged-in instagram.com tab attached. Output → output/reel_topics.json (ranked views+recency).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { connect, sleep, run } = require('./cdp');
const { outPath } = require('./paths');
const { normalizeLikes } = require('./comments');

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
// Default akun = ig_accounts.json (daftar terkurasi user — satu sumber kebenaran, dipakai juga
// oleh discover_topics --platforms instagram). --accounts meng-override. Fallback: daftar lama.
function defaultAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'ig_accounts.json'), 'utf8'));
    const arr = Array.isArray(j) ? j : (j.accounts || []);
    const list = arr.map(s => String(s).trim().replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '')).filter(Boolean);
    if (list.length) return list.join(',');
  } catch (e) {}
  return 'sadampermana.w,jktlogy,basevox,unexplnd';
}
const ACCOUNTS = (getFlag('--accounts', defaultAccounts())).split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
const MAX_PER = parseInt(getFlag('--max-per', '5'), 10);
const HOURS = parseInt(getFlag('--hours', '48'), 10);
const OUT = getFlag('--out', null);
const MODEL = process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-8b-instruct';

// Recency-decay ranking (OPT-IN): score = views * 0.5^(ageHours / halfLife). Views are cumulative,
// so a pure-views sort favours OLDER reels; decay rewards reels that gathered views FAST (fresher).
// Gate via env THOTH_REEL_HALFLIFE_H (hours). 0/unset = legacy ranking (pure views, recency only as
// gate + tie-break). half-life ≈ window/2 is a sensible default if you turn it on.
const HALFLIFE_H = parseFloat(process.env.THOTH_REEL_HALFLIFE_H || '0');
const DECAY_ON = HALFLIFE_H > 0;
function ageHoursOf(r) {
  const ts = r && r.time ? Date.parse(r.time) : NaN;
  return isNaN(ts) ? NaN : Math.max(0, (Date.now() - ts) / 3600000);
}
// Ranking score. Decay off → raw views. Decay on → views * 0.5^(age/halfLife); unknown age = no
// penalty (factor 1) so a missing timestamp never silently buries a high-views reel.
function scoreOf(r) {
  const v = (r && r.views_n) || 0;
  if (!DECAY_ON) return v;
  const ah = ageHoursOf(r);
  return v * (isNaN(ah) ? 1 : Math.pow(0.5, ah / HALFLIFE_H));
}
const rankCmp = (a, b) => (scoreOf(b) - scoreOf(a)) || (Date.parse(b.time || 0) - Date.parse(a.time || 0));

const NOVITA_KEY = (() => { const f = path.join(__dirname, '.novita_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const GROQ_KEY = process.env.GROQ_API_KEY || (() => { const f = path.join(__dirname, '.groq_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const YTDLP = process.env.YTDLP || 'yt-dlp';
// Optional browser to pull cookies from so yt-dlp can fetch login-walled IG audio (voiceout
// fallback). e.g. THOTH_YTDLP_COOKIES=firefox | chrome | brave | edge. Unset = no audio for IG
// (vision hook stays the primary topic source — see Bug 5).
const YTDLP_COOKIES = (process.env.THOTH_YTDLP_COOKIES || '').trim();

// Read the on-screen HOOK/headline text from a reel's opening frame (base64 PNG) via Novita vision.
async function visionHook(b64, key, model) {
  if (!key) return '';
  const prompt = `Ini frame PEMBUKA sebuah reel Instagram. Banyak reel menempel TEKS HOOK/HEADLINE besar
(judul atau pancingan cerita) di atas video. Baca teks hook itu apa adanya. Kembalikan HANYA teksnya
(1 kalimat ringkas, tanpa tanda kutip), atau string kosong kalau memang tak ada teks overlay.`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 120, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }] }),
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 160);
  } catch (e) { return ''; }
}

// AUDIO FALLBACK (best-effort): topic from the voiceover. The on-screen hook (vision) is the PRIMARY
// source; this only runs when the hook is too short, and a failure NEVER kills the entry (Bug 5). IG
// reels are login-walled → yt-dlp can't fetch their audio without cookies, so we pre-skip IG cleanly
// unless THOTH_YTDLP_COOKIES points yt-dlp at a logged-in browser (avoids a doomed ~minute download
// per hookless reel and the noisy "Command failed: yt-dlp …" message that looked like a crash).
async function audioTopic(reelUrl) {
  if (!GROQ_KEY) return { text: '', note: 'audio-off (no GROQ key)' };
  if (/instagram\.com/i.test(reelUrl) && !YTDLP_COOKIES) {
    return { text: '', note: 'audio-skip (IG login-wall — set THOTH_YTDLP_COOKIES=firefox/brave)' };
  }
  const tmp = path.join(require('os').tmpdir(), 'reel_' + Date.now());
  const cookieArg = YTDLP_COOKIES ? ` --cookies-from-browser ${YTDLP_COOKIES}` : '';
  try {
    execSync(`"${YTDLP}" -x --audio-format mp3 --no-warnings --no-playlist${cookieArg} -o "${tmp}.%(ext)s" "${reelUrl}"`, { stdio: 'pipe', timeout: 45000 });
    const mp3 = tmp + '.mp3';
    if (!fs.existsSync(mp3)) return { text: '', note: 'audio-skip (yt-dlp tak hasilkan audio)' };
    // Groq Whisper transcription (multipart)
    const buf = fs.readFileSync(mp3);
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'a.mp3');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('response_format', 'text');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_KEY }, body: fd });
    try { fs.unlinkSync(mp3); } catch (e) {}
    if (!r.ok) return { text: '', note: 'audio-skip (Groq ' + r.status + ')' };
    const t = (await r.text()).trim();
    return { text: t.split(/(?<=[.!?])\s/).slice(0, 2).join(' ').slice(0, 200), note: 'audio' };
  } catch (e) {
    // yt-dlp failed (IG login-wall is the usual cause). Keep it clean + best-effort — don't leak the
    // raw command, don't kill the reel (vision hook already carried the topic where it could).
    const err = String((e && (e.stderr || e.message)) || e);
    const why = /sign ?in|log ?in|cookies|private|rate.?limit|429/i.test(err) ? 'login-wall/akses'
      : /timed out|ETIMEDOUT|timeout/i.test(err) ? 'timeout'
      : 'yt-dlp gagal';
    return { text: '', note: `audio-skip (${why}${YTDLP_COOKIES ? '' : ' — set THOTH_YTDLP_COOKIES'})` };
  }
}

// A reel belongs to `handle` only if its href path is `/<handle>/reel/...` or a bare
// canonical `/reel/<code>/` (grid links are usually bare). Anchors that EXPLICITLY name a
// DIFFERENT account (`/<other>/reel/...`) are IG "Suggested"/related leaks — the root cause of
// cross-account bleed (e.g. indozone.id reels showing up under jktlogy). Those are dropped.
// Reject junk the vision model returns when there is no real hook overlay: its meta-answer
// ("Tak ada teks overlay di atas video."), or a watermark/domain it OCR'd off the footage
// (e.g. "WWW.INDOZONE.ID", "indozone.id"). These were being recorded as topics.
function cleanTopic(t) {
  t = (t || '').trim();
  if (!t) return '';
  if (/\b(tak ada|tidak ada|tanpa)\b.*\bteks\b|no (text|overlay)/i.test(t)) return '';
  const words = t.split(/\s+/);
  if (words.length <= 2 && /(^www\.)|([\w-]+\.(id|com|net|tv|co|org)\b\.?$)/i.test(t)) return '';
  return t;
}

async function reelsOf(client, handle) {
  await client.navigate(`https://www.instagram.com/${handle}/reels/`, 6000);
  await sleep(3000);
  const raw = await client.evaluate(`(() => {
    const HANDLE = ${JSON.stringify(handle)}.toLowerCase();
    const seen = new Set(); const out = [];
    document.querySelectorAll('a[href*="/reel/"]').forEach(a => {
      let href = a.getAttribute('href'); if (!href) return;
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^\\/(?:([\\w.]+)\\/)?reel\\/([\\w-]+)/);
      if (!m) return;
      const owner = (m[1] || '').toLowerCase();        // '' = bare /reel/<code> (own grid)
      if (owner && owner !== HANDLE) return;            // cross-account leak → drop
      const code = m[2];
      if (seen.has(code)) return; seen.add(code);
      const sp = Array.from(a.querySelectorAll('span')).map(s => (s.innerText || '').trim()).find(t => /^[\\d.,]+\\s*[KMrbjt]*$/i.test(t));
      out.push({ url: u.href, views: sp || '' });
    });
    return JSON.stringify(out);
  })()`);
  let list = []; try { list = JSON.parse(raw || '[]'); } catch (e) {}
  return list.slice(0, MAX_PER);
}

// Open a reel, return {time, frameB64}. Pauses the video at t=0 to grab the opening (hook) frame.
async function reelFrame(client, url) {
  await client.navigate(url, 6000);
  await sleep(2500);
  await client.evaluate(`(() => { const v = document.querySelector('video'); if (v) { try { v.pause(); v.currentTime = 0; } catch (e) {} } })()`);
  await sleep(600);
  const meta = await client.evaluate(`(() => { const t = document.querySelector('time'); const v = document.querySelector('video'); const r = v && v.getBoundingClientRect(); return JSON.stringify({ time: t ? t.getAttribute('datetime') : null, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }); })()`);
  let m; try { m = JSON.parse(meta); } catch (e) { m = {}; }
  let frameB64 = '';
  if (m.rect && m.rect.w > 30) {
    const dpr = (await client.evaluate('window.devicePixelRatio')) || 1;
    const clip = { x: Math.max(0, m.rect.x), y: Math.max(0, m.rect.y), width: m.rect.w, height: m.rect.h, scale: dpr };
    try { const shot = await client.cmd('Page.captureScreenshot', { format: 'png', clip, fromSurface: true }); frameB64 = shot.data; } catch (e) {}
  }
  return { time: m.time, frameB64 };
}

run(async () => {
  console.log('='.repeat(60));
  console.log('  Discover Reels (topik dari akun kurator IG)');
  console.log('='.repeat(60));
  console.log('Akun:', ACCOUNTS.join(', '), '| max/akun:', MAX_PER, '| window:', HOURS + 'h');
  console.log('Ranking:', DECAY_ON ? `recency-decay (half-life ${HALFLIFE_H}h)` : 'views (set THOTH_REEL_HALFLIFE_H untuk recency-decay)');
  if (!GROQ_KEY) console.log('ℹ️  audio-fallback OFF (belum ada GROQ key) — pakai hook-frame vision saja.');

  const client = await connect({ match: 'instagram.com', requireMatch: true });
  try { await client.cmd('Page.bringToFront'); } catch (e) {}
  try { await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}

  const cutoff = Date.now() - HOURS * 3600 * 1000;
  const found = [];
  // Checkpoint to disk after every reel/account so a SIGKILL from the runner's process timeout
  // (Bug 3) doesn't throw away everything scraped so far — partial progress stays usable, mirroring
  // run_pipeline's per-stage writes. Sorted on each flush so the file is always rank-ordered.
  const out = OUT || outPath('reel_topics.json');
  const ranking = DECAY_ON ? `recency-decay (half-life ${HALFLIFE_H}h)` : 'views';
  const writeRanked = (partial) => {
    const ranked = found.slice().sort(rankCmp)
      .map(r => DECAY_ON ? { ...r, score: Math.round(scoreOf(r)) } : r);
    try { fs.writeFileSync(out, JSON.stringify({ fetched_at: new Date().toISOString(), accounts: ACCOUNTS, hours: HOURS, ranking, partial, reels: ranked }, null, 2), 'utf8'); } catch (e) {}
  };
  const flush = () => writeRanked(true);
  for (const h of ACCOUNTS) {
    process.stdout.write(`\n• @${h}: ambil reels ... `);
    let reels = [];
    try { reels = await reelsOf(client, h); console.log(`${reels.length} reel`); }
    catch (e) { console.log(`⚠️ ${String(e.message || e).slice(0, 50)}`); continue; }
    if (!reels.length) { console.log(`    ⚠️  grid kosong/virtualized (atau semua leak antar-akun di-drop) — skip akun ini`); continue; }
    let acctViews = 0;
    for (const r of reels) {
      let fr; try { fr = await reelFrame(client, r.url); } catch (e) { continue; }
      const ts = fr.time ? Date.parse(fr.time) : NaN;
      if (!isNaN(ts) && ts < cutoff) { console.log(`    ⏹  reel >${HOURS}h → stop akun ini`); break; } // newest-first
      let topic = cleanTopic(await visionHook(fr.frameB64, NOVITA_KEY, MODEL));
      let via = 'hook';
      if (topic.length < 8) { const a = await audioTopic(r.url); const at = cleanTopic(a.text); if (at) { topic = at; via = a.note; } else via = a.note; }
      const ageH = isNaN(ts) ? '?' : ((Date.now() - ts) / 3600000).toFixed(1) + 'h';
      const vn = normalizeLikes(r.views); if (vn > 0) acctViews++;
      found.push({ account: h, url: r.url, views: r.views, views_n: vn, time: fr.time, age: ageH, topic, via });
      console.log(`    [${ageH}, ${r.views || '?'} views, ${via}] ${topic || '(tak terbaca)'}`);
      flush(); // checkpoint after each reel
    }
    if (reels.length && acctViews === 0) console.log(`    ⚠️  views 0 untuk semua reel @${h} (grid view-count tak render) — ranking pakai recency saja`);
    flush(); // checkpoint after each account
  }
  client.close();

  found.sort(rankCmp);
  writeRanked(false); // final: drop the partial flag now that the run completed cleanly
  console.log('\n' + '-'.repeat(60));
  console.log(`PERINGKAT (${ranking}):`);
  found.slice(0, 10).forEach((r, i) => console.log(
    `  ${i + 1}. [@${r.account}, ${r.views || '?'} views, ${r.age}${DECAY_ON ? `, score ${Math.round(scoreOf(r))}` : ''}] ${r.topic || '(tak terbaca)'}`));
  console.log(`📄 ${out}`);
});
