// scrape_comments.js — extract TikTok comments from the LOGGED-IN DOM (not vision).
//
// Why DOM, not vision: qwen3-vl-8b guesses bounding boxes (uniform grid) and OCRs text
// with errors. The comments are real HTML elements, so the DOM gives EXACT author / text /
// like count / avatar image URL, plus exact getBoundingClientRect → pixel-perfect crops via
// CDP's screenshot `clip`. CLIPPER renders its comment card from {author,text,likes,
// avatar_url}; image_path is included too (forward-compat for pasting the real crop).
//
//   node scrape_comments.js <tiktok_url> [out.json] [--max N]
//
// Output: content-set JSON in output/ (default output/clipper_content_set.json) + crop
// PNGs in output/crops/. Nothing is written to the workspace root.

const fs = require('fs');
const path = require('path');
const { connect, sleep, run } = require('./cdp');
const { normalizeLikes } = require('./comments');
const { CROPS_DIR, outPath } = require('./paths');

const OUT_DIR = CROPS_DIR;
const PAD = 6; // CSS px padding around each comment crop

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') flags.max = parseInt(args[++i], 10);
  else pos.push(args[i]);
}
const TARGET_URL = pos[0];
const OUT_JSON = outPath(pos[1] || 'clipper_content_set.json');
const MAX = flags.max || 12;

if (!TARGET_URL) {
  console.log('Usage: node scrape_comments.js <tiktok_url> [out.json] [--max N]');
  process.exit(1);
}

const extractUsername = u => (u.match(/@([\w.]+)/) || [, 'unknown'])[1];
const extractVideoId = u => (u.match(/video\/(\d+)/) || [, 'unknown'])[1];

// Runs in the page: each [data-e2e="comment-level-1"] IS the comment text element. We climb
// to the smallest ancestor that also has the username + avatar img (the full comment row),
// tag it for cropping, and read author/text/avatar. Likes have no data-e2e anymore, so we
// take the rightmost purely-numeric leaf span in the row (the heart count sits far right;
// the date has dashes and "Reply" isn't numeric, so both are excluded).
const EXTRACT_JS = `(() => {
  const num = s => s && /^[\\d.,]+\\s*[kKmMrbRBjtJT]*$/.test(s.trim());
  const texts = Array.from(document.querySelectorAll('[data-e2e="comment-level-1"]'));
  const out = [];
  texts.forEach((t, i) => {
    let w = t, chosen = null;
    for (let k=0;k<10 && w.parentElement;k++){
      w = w.parentElement;
      if (w.querySelectorAll('[data-e2e="comment-level-1"]').length > 1) break; // would merge comments
      const u = w.querySelector('[data-e2e="comment-username-1"]');
      const img = w.querySelector('img');
      if (u && img) { chosen = w; break; }
      if (u && !chosen) chosen = w;
    }
    const wrap = chosen || t.parentElement || t;
    wrap.setAttribute('data-clip-idx', String(i));
    const author = ((wrap.querySelector('[data-e2e="comment-username-1"]')||{}).innerText || '').trim();
    const img = wrap.querySelector('img');
    let likes_raw = '';
    const cands = Array.from(wrap.querySelectorAll('span,div')).filter(e => !e.querySelector('*') && num(e.innerText));
    if (cands.length) { cands.sort((a,b)=>b.getBoundingClientRect().right - a.getBoundingClientRect().right); likes_raw = cands[0].innerText.trim(); }
    out.push({ idx:i, author, text:(t.innerText||'').trim(), likes_raw, avatar_url: img ? (img.currentSrc||img.src||'') : '' });
  });
  return JSON.stringify(out);
})()`;

const countComments = client =>
  client.evaluate('document.querySelectorAll(\'[data-e2e="comment-level-1"], div[class*="CommentItem"]\').length');

async function loadComments(client) {
  // On the immersive player layout the comments panel is hidden until the comment icon is
  // clicked. Wait briefly, and if nothing showed up, click the icon to open the panel.
  for (let t = 0; t < 5; t++) {
    const n = await countComments(client);
    if (n > 0) return n;
    await sleep(1000);
  }
  const clicked = await client.evaluate('(() => { const b = document.querySelector(\'[data-e2e="comment-icon"]\'); if (b) { b.click(); return true; } return false; })()');
  if (clicked) console.log('  (buka panel komentar via comment-icon)');
  for (let t = 0; t < 12; t++) {
    const n = await countComments(client);
    if (n > 0) return n;
    await sleep(1000);
  }
  return 0;
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('='.repeat(60));
  console.log('  Scrape Comments (DOM/CDP)');
  console.log('='.repeat(60));
  console.log('URL:', TARGET_URL);

  const client = await connect({ match: 'tiktok.com' });

  // TikTok's SPA only mounts the video detail (player + comments) when the tab is focused;
  // a backgrounded relay tab renders just the home shell. Force focus before navigating.
  try { await client.cmd('Page.bringToFront'); } catch (e) {}
  try { await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}

  // Navigate only if not already on this video.
  const vid = extractVideoId(TARGET_URL);
  const cur = await client.evaluate('window.location.href');
  if (!cur || !cur.includes(vid)) { console.log('Navigasi ke video...'); await client.navigate(TARGET_URL, 5000); }

  console.log('[1/3] Tunggu komentar render...');
  let count = await loadComments(client);
  if (!count) { console.log('⚠️  Tidak ada elemen komentar. Pastikan tab login & video punya komentar (panel kanan terbuka).'); client.close(); return; }

  // Lazy-load more by scrolling the comment list a few times.
  for (let s = 0; s < 4; s++) {
    await client.evaluate('(() => { const els = document.querySelectorAll(\'[data-e2e="comment-level-1"]\'); const last = els[els.length-1]; if (last) last.scrollIntoView({block:"end"}); window.scrollBy(0, 600); })()');
    await sleep(900);
  }

  console.log('[2/3] Ekstrak field dari DOM...');
  const raw = await client.evaluate(EXTRACT_JS);
  let parsed = [];
  try { parsed = JSON.parse(raw || '[]'); } catch (e) {}
  // Buang komentar sticker-only ("[Sticker]"/"[Stiker]") — tak ada teks bermakna untuk
  // grounding narasi, dan crop-nya cuma gambar stiker. Filter SEBELUM slice(MAX) supaya
  // kuota terisi komentar bertekst nyata.
  const isStickerOnly = t => /^\[\s*sti?c?ker\s*\]$/i.test((t || '').trim());
  const withText = parsed.filter(c => c.text);
  const stickerCount = withText.filter(c => isStickerOnly(c.text)).length;
  parsed = withText.filter(c => !isStickerOnly(c.text)).slice(0, MAX);
  const stickerNote = stickerCount ? `, ${stickerCount} sticker-only di-skip` : '';
  console.log(`  ${parsed.length} komentar (dari ${count} terdeteksi${stickerNote})`);

  const dpr = (await client.evaluate('window.devicePixelRatio')) || 1;

  console.log('[3/3] Crop pixel-perfect (CDP clip)...');
  const results = [];
  for (const c of parsed) {
    // Scroll the comment into view, then read its fresh viewport rect.
    await client.evaluate(`(() => { const el = document.querySelector('[data-clip-idx="${c.idx}"]'); if (el) el.scrollIntoView({block:"center"}); })()`);
    await sleep(350);
    const rectJson = await client.evaluate(`(() => { const el = document.querySelector('[data-clip-idx="${c.idx}"]'); if (!el) return ''; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`);
    let rect; try { rect = JSON.parse(rectJson); } catch (e) { rect = null; }

    const likes = normalizeLikes(c.likes_raw);
    const safe = (c.author || `c${c.idx}`).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20);
    const entry = { author: c.author || 'anon', text: c.text, likes, avatar_url: c.avatar_url || '', image_path: '' };

    if (rect && rect.w > 30 && rect.h > 12) {
      const clip = { x: Math.max(0, rect.x - PAD), y: Math.max(0, rect.y - PAD), width: rect.w + PAD * 2, height: rect.h + PAD * 2, scale: dpr };
      try {
        const shot = await client.cmd('Page.captureScreenshot', { format: 'png', clip, fromSurface: true });
        const file = path.join(OUT_DIR, `comment_${String(c.idx + 1).padStart(2, '0')}_${safe}_${likes}like.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        entry.image_path = file;
        const kb = (fs.statSync(file).size / 1024).toFixed(1);
        console.log(`  #${c.idx + 1} @${entry.author} (${likes}❤) → ${path.basename(file)} (${kb} KB)`);
      } catch (e) {
        console.log(`  #${c.idx + 1} @${entry.author}: crop gagal (${e.message.slice(0, 50)})`);
      }
    } else {
      console.log(`  #${c.idx + 1} @${entry.author} (${likes}❤) — rect tak valid, data saja`);
    }
    results.push(entry);
  }
  client.close();

  // Build content-set. CLIPPER's load_content_set parses a SINGLE object
  // {main,footage,comments} (NOT an array). If OUT_JSON already holds a content-set for
  // the same main.url, only its comments are refreshed (footage from content-sourcing kept).
  const username = extractUsername(TARGET_URL);
  let contentSet = {
    main: { url: TARGET_URL, platform: 'tiktok', title: `TikTok @${username} #${vid}`, is_video: true, duration_sec: 60,
      profile: { name: username, handle: username, followers: '', avatar_url: '' } },
    footage: [],
    comments: results,
  };
  if (fs.existsSync(OUT_JSON)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
      if (prev && !Array.isArray(prev) && prev.main && prev.main.url === TARGET_URL) {
        prev.comments = results; // keep existing main/footage, refresh comments only
        contentSet = prev;
      }
    } catch (e) {}
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(contentSet, null, 2), 'utf8');

  console.log('\n' + '='.repeat(60));
  results.sort((a, b) => b.likes - a.likes).forEach((r, i) => console.log(`  ${i + 1}. @${r.author} (${r.likes}❤) "${r.text.slice(0, 60)}"`));
  console.log('='.repeat(60));
  console.log(`📄 ${OUT_JSON} (${results.length} komentar)  |  📁 crops: ${OUT_DIR}`);
  console.log('\nValidate lalu run:');
  console.log(`  node validate_content_set.js "${OUT_JSON}"`);
  console.log(`  clipper run --content "${OUT_JSON}"`);
}

run(main);
