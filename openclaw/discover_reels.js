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

const NOVITA_KEY = (() => { const f = path.join(__dirname, '.novita_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const GROQ_KEY = process.env.GROQ_API_KEY || (() => { const f = path.join(__dirname, '.groq_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const YTDLP = process.env.YTDLP || 'yt-dlp';

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

// AUDIO FALLBACK (guarded): topic from the voiceover. Only runs if GROQ_KEY is set. Downloads audio
// via yt-dlp (IG reel) → Groq Whisper → first ~2 sentences (the topic is usually stated up front).
async function audioTopic(reelUrl) {
  if (!GROQ_KEY) return { text: '', note: 'audio-skip (no GROQ key)' };
  const tmp = path.join(require('os').tmpdir(), 'reel_' + Date.now());
  try {
    execSync(`"${YTDLP}" -x --audio-format mp3 -o "${tmp}.%(ext)s" "${reelUrl}"`, { stdio: 'pipe', timeout: 60000 });
    const mp3 = tmp + '.mp3';
    if (!fs.existsSync(mp3)) return { text: '', note: 'audio-skip (download gagal — cookie IG?)' };
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
  } catch (e) { return { text: '', note: 'audio-skip (' + String(e.message || e).slice(0, 40) + ')' }; }
}

async function reelsOf(client, handle) {
  await client.navigate(`https://www.instagram.com/${handle}/reels/`, 6000);
  await sleep(3000);
  const raw = await client.evaluate(`(() => {
    const seen = new Set(); const out = [];
    document.querySelectorAll('a[href*="/reel/"]').forEach(a => {
      const href = a.getAttribute('href'); if (!href || seen.has(href)) return; seen.add(href);
      const sp = Array.from(a.querySelectorAll('span')).map(s => (s.innerText || '').trim()).find(t => /^[\\d.,]+\\s*[KMrbjt]*$/i.test(t));
      out.push({ url: new URL(href, location.origin).href, views: sp || '' });
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
  if (!GROQ_KEY) console.log('ℹ️  audio-fallback OFF (belum ada GROQ key) — pakai hook-frame vision saja.');

  const client = await connect({ match: 'instagram.com', requireMatch: true });
  try { await client.cmd('Page.bringToFront'); } catch (e) {}
  try { await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}

  const cutoff = Date.now() - HOURS * 3600 * 1000;
  const found = [];
  for (const h of ACCOUNTS) {
    process.stdout.write(`\n• @${h}: ambil reels ... `);
    let reels = [];
    try { reels = await reelsOf(client, h); console.log(`${reels.length} reel`); }
    catch (e) { console.log(`⚠️ ${String(e.message || e).slice(0, 50)}`); continue; }
    for (const r of reels) {
      let fr; try { fr = await reelFrame(client, r.url); } catch (e) { continue; }
      const ts = fr.time ? Date.parse(fr.time) : NaN;
      if (!isNaN(ts) && ts < cutoff) { console.log(`    ⏹  reel >${HOURS}h → stop akun ini`); break; } // newest-first
      let topic = await visionHook(fr.frameB64, NOVITA_KEY, MODEL);
      let via = 'hook';
      if (topic.length < 8) { const a = await audioTopic(r.url); if (a.text) { topic = a.text; via = a.note; } else via = a.note; }
      const ageH = isNaN(ts) ? '?' : ((Date.now() - ts) / 3600000).toFixed(1) + 'h';
      found.push({ account: h, url: r.url, views: r.views, views_n: normalizeLikes(r.views), time: fr.time, age: ageH, topic, via });
      console.log(`    [${ageH}, ${r.views || '?'} views, ${via}] ${topic || '(tak terbaca)'}`);
    }
  }
  client.close();

  found.sort((a, b) => (b.views_n - a.views_n) || (Date.parse(b.time || 0) - Date.parse(a.time || 0)));
  const out = OUT || outPath('reel_topics.json');
  fs.writeFileSync(out, JSON.stringify({ fetched_at: new Date().toISOString(), accounts: ACCOUNTS, hours: HOURS, reels: found }, null, 2), 'utf8');
  console.log('\n' + '-'.repeat(60));
  console.log('PERINGKAT (views):');
  found.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}. [@${r.account}, ${r.views || '?'} views, ${r.age}] ${r.topic || '(tak terbaca)'}`));
  console.log(`📄 ${out}`);
});
