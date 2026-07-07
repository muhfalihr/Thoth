// [DEPRECATED 2026-06-12] Crop komentar via VISION (screenshot + qwen3-vl bounding box).
// Pengganti: scrape_comments.js — DOM/CDP, pixel-perfect & data exact (lihat TOOLS.md).
// Disimpan untuk referensi; masih bisa dijalankan dari folder deprecated/ ini.
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { connect, sleep, run } = require('../lib/cdp');
const { detectComments, VISION_MODEL } = require('../lib/comments');
const { CROPS_DIR, outPath } = require('../lib/paths');

// ============================================================
//  Thoth COMMENT CROP PIPELINE — Full Pipeline
//  Usage: node crop_comment_pipeline.js <tiktok_url> [output_file]
// ============================================================

const CONFIG = {
  ffmpeg: process.env.THOTH_FFMPEG || 'C:\\Users\\mfr\\Documents\\MyTools\\CLIPPER\\ffmpeg.exe',
  outputDir: CROPS_DIR,
  novitaKey: fs.existsSync(path.join(__dirname, '..', '.novita_key')) ? fs.readFileSync(path.join(__dirname, '..', '.novita_key'), 'utf8').trim() : 'sk-placeholder',
  visionModel: VISION_MODEL,
  displayWidth: 730,   // crop cards scaled to this width, aspect preserved (height auto)
  visionWidth: 1200,   // image width sent to the vision model
  padPx: 10,           // extra padding around each comment box, in vision-space px
  screenshotFile: 'ss_comment.png',
  resizedFile: 'ss_vision.png',
};

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('\n❌ Usage: node crop_comment_pipeline.js <tiktok_url> [output_thoth_file.json]\n');
  console.error('Examples:');
  console.error('  node crop_comment_pipeline.js https://www.tiktok.com/@kompascom/video/7647116110399048980');
  console.error('  node crop_comment_pipeline.js https://www.tiktok.com/@user/video/123 content_set.json\n');
  process.exit(1);
}

const TARGET_URL = args[0];
const THOTH_OUTPUT = outPath(args[1] || 'thoth_content_set.json');

function extractUsername(url) { const m = url.match(/@([\w.]+)/); return m ? m[1] : 'unknown'; }
function extractVideoId(url) { const m = url.match(/video\/(\d+)/); return m ? m[1] : 'unknown'; }

// Read PNG dimensions from the IHDR chunk (bytes 16..24).
function pngSize(file) {
  const b = fs.readFileSync(file).subarray(16, 24);
  return { w: b.readUInt32BE(0), h: b.readUInt32BE(4) };
}

// === STEP 1: SCREENSHOT via CDP ===
async function takeScreenshot(targetUrl) {
  console.log('[1/4] Screenshot via CDP...');
  const client = await connect({ match: 'tiktok.com' });

  const videoId = extractVideoId(targetUrl);
  const cur = await client.evaluate('window.location.href');
  if (!cur || !cur.includes(videoId)) {
    console.log('  Navigasi ke URL target...');
    await client.navigate(targetUrl, 5000);
  }
  await client.scroll(650);
  await sleep(2000);

  const b64 = await client.screenshot();
  client.close();
  const fp = path.join(CONFIG.outputDir, CONFIG.screenshotFile);
  fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
  console.log(`  ✅ ${path.basename(fp)} (${(fs.statSync(fp).size / 1024).toFixed(1)} KB)`);
  return fp;
}

// === STEP 2: VISION — detect every comment block ===
async function detect(ssPath) {
  console.log('\n[2/4] Vision: deteksi semua komentar...');
  const resizedPath = path.join(CONFIG.outputDir, CONFIG.resizedFile);
  execSync(`"${CONFIG.ffmpeg}" -i "${ssPath}" -vf "scale=${CONFIG.visionWidth}:-1" -update 1 -y "${resizedPath}"`, { stdio: 'pipe', timeout: 10000 });
  const vis = pngSize(resizedPath); // actual resized dims (width x height)
  console.log(`  Image dikirim: ${vis.w}x${vis.h}`);

  const { comments, raw } = await detectComments({ imagePath: resizedPath, key: CONFIG.novitaKey, model: CONFIG.visionModel, W: vis.w, H: vis.h });
  if (!comments.length) console.log(`  ⚠️  0 komentar. Raw: ${raw.slice(0, 120)}`);
  else console.log(`  ${comments.length} komentar terdeteksi`);
  return { comments: comments.filter(c => c.box), vis };
}

// === STEP 3-4: CROP each comment's natural box (clean card like the example) ===
function cropComments(ssPath, comments, vis) {
  console.log('\n[3/4] Crop tiap komentar (box natural + padding)...');
  const orig = pngSize(ssPath);
  console.log(`  Resolusi asli: ${orig.w}x${orig.h}`);
  const sx = orig.w / vis.w;
  const sy = orig.h / vis.h;
  const pad = CONFIG.padPx;
  const results = [];

  comments.forEach((c, i) => {
    // Scale the vision-space box to original resolution, add small padding, clamp.
    let x1 = Math.max(0, Math.round((c.box[0] - pad) * sx));
    let y1 = Math.max(0, Math.round((c.box[1] - pad) * sy));
    let x2 = Math.min(orig.w, Math.round((c.box[2] + pad) * sx));
    let y2 = Math.min(orig.h, Math.round((c.box[3] + pad) * sy));
    let w = x2 - x1, h = y2 - y1;
    if (w < 30 || h < 20) { console.log(`  ⏭️  #${i + 1} box terlalu kecil (${w}x${h}), skip`); return; }
    // Make crop dims even (some encoders dislike odd dims).
    if (w % 2) w--; if (h % 2) h--;

    const safeName = (c.user || `c${i}`).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20);
    const tmp = path.join(CONFIG.outputDir, `_tmp_${safeName}.png`);
    const finalPath = path.join(CONFIG.outputDir, `comment_${String(i + 1).padStart(2, '0')}_${safeName}_${c.likes}like.png`);

    try {
      // 1) crop the natural comment block, 2) scale to display width keeping aspect.
      execSync(`"${CONFIG.ffmpeg}" -i "${ssPath}" -vf "crop=${w}:${h}:${x1}:${y1}" -update 1 -y "${tmp}"`, { stdio: 'pipe', timeout: 10000 });
      execSync(`"${CONFIG.ffmpeg}" -i "${tmp}" -vf "scale=${CONFIG.displayWidth}:-2" -update 1 -y "${finalPath}"`, { stdio: 'pipe', timeout: 10000 });
      const out = pngSize(finalPath);
      const kb = (fs.statSync(finalPath).size / 1024).toFixed(1);
      console.log(`  #${i + 1} @${c.user} (${c.likes}❤) → ${out.w}x${out.h} (${kb} KB)`);
      results.push({ user: c.user || 'anon', text: c.text, likes: c.likes, file: path.basename(finalPath), image_path: finalPath, sizeKb: parseFloat(kb) });
      try { fs.unlinkSync(tmp); } catch (e) {}
    } catch (e) {
      console.log(`  ❌ #${i + 1} @${c.user}: ${e.message.slice(0, 80)}`);
    }
  });

  return results;
}

// === STEP 5: SAVE Thoth FORMAT ===
function saveThothFormat(url, results) {
  console.log('\n[4/4] Simpan ke format Thoth...');
  const username = extractUsername(url) || 'unknown';
  const videoId = extractVideoId(url) || 'unknown';

  const contentSet = {
    main: {
      url, platform: 'tiktok', title: `TikTok @${username} #${videoId}`, is_video: true, duration_sec: 60,
      profile: { name: username, handle: username, followers: '', avatar_url: '' },
    },
    footage: [],
    // image_path = path absolut crop komentar (forward-compat; lihat catatan hand-off).
    comments: results.map(r => ({ author: '@' + r.user, text: r.text, likes: r.likes, avatar_url: '', image_path: r.image_path })),
  };

  let existing = [];
  if (fs.existsSync(THOTH_OUTPUT)) {
    try { existing = JSON.parse(fs.readFileSync(THOTH_OUTPUT, 'utf8')); if (!Array.isArray(existing)) existing = []; }
    catch (e) { existing = []; }
  }

  const dup = existing.find(e => e.main?.url === url);
  if (!dup) {
    existing.push(contentSet);
    console.log(`  Menambahkan URL baru ke ${THOTH_OUTPUT}`);
  } else if (contentSet.comments.length > 0) {
    dup.comments = contentSet.comments;
    console.log(`  Update komentar untuk URL yang sudah ada`);
  } else {
    console.log(`  URL sudah ada, skip`);
  }

  fs.writeFileSync(THOTH_OUTPUT, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`  ✅ Disimpan: ${THOTH_OUTPUT} (total entri: ${existing.length})`);
  return contentSet;
}

// === MAIN ===
async function main() {
  console.log('='.repeat(60));
  console.log('  Thoth Comment Crop Pipeline');
  console.log('='.repeat(60));
  console.log(`URL: ${TARGET_URL}`);
  console.log(`Output: ${THOTH_OUTPUT}\n`);

  if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  const ssPath = await takeScreenshot(TARGET_URL);
  const { comments, vis } = await detect(ssPath);
  if (!comments.length) { console.log('\n⚠️ Tidak ada komentar terdeteksi.'); return; }

  const results = cropComments(ssPath, comments, vis);
  if (results.length === 0) { console.log('\n⚠️ Tidak ada komentar yang berhasil di-crop.'); return; }

  saveThothFormat(TARGET_URL, results);

  console.log('\n' + '='.repeat(60));
  console.log('  HASIL');
  console.log('='.repeat(60));
  results.sort((a, b) => b.likes - a.likes).forEach((r, i) => {
    console.log(`  ${i + 1}. @${r.user} — ${r.likes} ❤️`);
    console.log(`     "${r.text.slice(0, 80)}"`);
    console.log(`     ${r.file} (${r.sizeKb} KB)\n`);
  });

  const viral = results.filter(r => r.likes >= 1000);
  if (viral.length > 0) {
    console.log('🔥 Viral potensial untuk Thoth:');
    viral.forEach(r => console.log(`  → @${r.user} (${r.likes} likes) — "${r.text.slice(0, 50)}"`));
  }

  console.log(`\n📁 Crop images: ${CONFIG.outputDir}`);
  console.log(`📄 Thoth data: ${THOTH_OUTPUT}`);
  console.log('\nValidate dulu, lalu jalankan Thoth:');
  console.log(`  node validate_content_set.js "${THOTH_OUTPUT}"`);
  console.log(`  thoth run --content "${THOTH_OUTPUT}"`);
}

run(main);
