// [DEPRECATED 2026-06-12] Orkestrator manual lama (URL eksplisit + komentar via VISION).
// Pengganti: run_pipeline.js (orkestrator penuh) + collect_comments.js (DOM scraper, lebih akurat).
// Disimpan untuk referensi; masih bisa dijalankan dari folder deprecated/ ini.
// ============================================================
//  Thoth BATCH PIPELINE — Per-Topic Content Set Generator
//  Usage: node batch_pipeline.js <topic_slug> <topic_name> <main_url> [react_url1 react_url2 ...]
//  Output: output/thoth_content_<topic_slug>.json (crops in output/crops/)
// ============================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { connect, sleep, run } = require('../lib/cdp');
const { detectComments } = require('../lib/comments');
const { OUTPUT_DIR: OUT_JSON_DIR, CROPS_DIR, outPath } = require('../lib/paths');

const THOTH_DIR = 'C:\\Users\\mfr\\Documents\\MyTools\\CLIPPER';
const OUTPUT_DIR = CROPS_DIR;
const FFMPEG =
  process.env.THOTH_FFMPEG || 'C:\\Users\\mfr\\Documents\\MyTools\\CLIPPER\\ffmpeg.exe';
const NOVITA_KEY_FILE = require('path').join(__dirname, '..', '.novita_key');
const NOVITA_KEY = fs.existsSync(NOVITA_KEY_FILE)
  ? fs.readFileSync(NOVITA_KEY_FILE, 'utf8').trim()
  : null;

function pngSize(file) {
  const b = fs.readFileSync(file).subarray(16, 24);
  return { w: b.readUInt32BE(0), h: b.readUInt32BE(4) };
}

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('\n❌ Usage:');
  console.error(
    '  node batch_pipeline.js <topic_slug> <topic_name> <main_url> [react_url1 react_url2 ...]',
  );
  console.error('\nExamples:');
  console.error(
    '  node batch_pipeline.js korupsi_bgn_mbg "Korupsi BGN/MBG" https://tiktok.com/@kompascom/video/xxx https://tiktok.com/@user/video/yyy',
  );
  console.error('\nTopics already created:');
  if (fs.existsSync(OUT_JSON_DIR)) {
    fs.readdirSync(OUT_JSON_DIR)
      .filter((f) => f.startsWith('thoth_content_') && f.endsWith('.json'))
      .forEach((f) => console.error('  - ' + f));
  }
  process.exit(1);
}

const TOPIC_SLUG = args[0];
const TOPIC_NAME = args[1];
const MAIN_URL = args[2];
const REACT_URLS = args.slice(3);
const THOTH_FILE = outPath(`thoth_content_${TOPIC_SLUG}.json`);

function extractUsername(url) {
  const m = url.match(/@([\w.]+)/);
  return m ? m[1] : 'unknown';
}

// ============================================================
//  STEP 1: Screenshot + Detect Comments
// ============================================================
async function scrapeComments(videoUrl) {
  console.log(`\n--- Scraping comments: ${videoUrl}`);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  try {
    const client = await connect({ match: 'tiktok.com' });
    await client.navigate(videoUrl, 5000);
    await client.scroll(650);
    await sleep(3000);
    const b64 = await client.screenshot();
    client.close();

    const ssPath = path.join(OUTPUT_DIR, 'ss_comment.png');
    fs.writeFileSync(ssPath, Buffer.from(b64, 'base64'));
    const ssSize = (fs.statSync(ssPath).size / 1024).toFixed(1);
    console.log(`  Screenshot: ${ssSize} KB`);

    if (ssSize < 20) {
      console.log('  ⚠️ Screenshot terlalu kecil, mungkin halaman gagal load. Skip vision.');
      return [];
    }

    const visionPath = path.join(OUTPUT_DIR, 'ss_vision.png');
    execSync(`"${FFMPEG}" -i "${ssPath}" -vf "scale=1200:-1" -update 1 -y "${visionPath}"`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    const vis = pngSize(visionPath);

    const { comments } = await detectComments({
      imagePath: visionPath,
      key: NOVITA_KEY,
      W: vis.w,
      H: vis.h,
    });
    console.log(`  ${comments.length} comments detected`);
    return comments.map((c) => ({
      author: '@' + (c.user || 'anon'),
      text: c.text,
      likes: c.likes,
      avatar_url: '',
    }));
  } catch (e) {
    if (e && e.relay) throw e; // let run() print the relay-attach fix
    console.log(`  ❌ Error: ${e.message.slice(0, 100)}`);
    return [];
  }
}

// ============================================================
//  STEP 2: Build + Save Content Set
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log(`  Thoth Batch — "${TOPIC_NAME}"`);
  console.log(`  Slug: ${TOPIC_SLUG}`);
  console.log(`  Main: ${MAIN_URL}`);
  console.log(`  Reactions: ${REACT_URLS.length}`);
  console.log('='.repeat(60));

  console.log('\n📥 Scraping comments from main video...');
  const comments = await scrapeComments(MAIN_URL);

  const username = extractUsername(MAIN_URL);
  const contentSet = {
    main: {
      url: MAIN_URL,
      platform: 'tiktok',
      title: `[${TOPIC_NAME}] Raw — @${username}`,
      is_video: true,
      duration_sec: 60,
      profile: { name: username, handle: username, followers: '', avatar_url: '' },
    },
    footage: REACT_URLS.map((url) => ({
      platform: 'tiktok',
      url,
      title: `Reaction @${extractUsername(url)}`,
      is_video: true,
      duration_sec: 60,
      relevance: 'match',
    })),
    comments,
  };

  let existing = null;
  if (fs.existsSync(THOTH_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(THOTH_FILE, 'utf8'));
    } catch (e) {}
  }

  if (existing && existing.main?.url === MAIN_URL) {
    const existingUrls = new Set((existing.footage || []).map((f) => f.url));
    for (const r of REACT_URLS) {
      if (!existingUrls.has(r)) {
        existing.footage.push({
          platform: 'tiktok',
          url: r,
          title: `Reaction @${extractUsername(r)}`,
          is_video: true,
          duration_sec: 60,
          relevance: 'match',
        });
      }
    }
    if (comments.length > 0) existing.comments = comments;
    fs.writeFileSync(THOTH_FILE, JSON.stringify(existing, null, 2), 'utf8');
    console.log(`\n✅ Updated: ${THOTH_FILE}`);
  } else {
    fs.writeFileSync(THOTH_FILE, JSON.stringify(contentSet, null, 2), 'utf8');
    console.log(`\n✅ Created: ${THOTH_FILE}`);
  }

  const saved = JSON.parse(fs.readFileSync(THOTH_FILE, 'utf8'));
  console.log(`\n📊 Summary:`);
  console.log(`  Raw: ${saved.main?.url?.slice(0, 80) || '-'}`);
  console.log(`  Reactions: ${(saved.footage || []).length}`);
  console.log(`  Comments: ${(saved.comments || []).length}`);
  const viral = (saved.comments || []).filter((c) => c.likes >= 1000);
  if (viral.length > 0) {
    console.log(`\n🔥 Viral comments:`);
    viral.forEach((c) => console.log(`  ${c.author} (${c.likes}❤️): "${c.text.slice(0, 60)}"`));
  }

  console.log(`\nValidate dulu, lalu run Thoth:`);
  console.log(`  node validate_content_set.js "${THOTH_FILE}"`);
  console.log(`  thoth run --content "${THOTH_FILE}"`);
}

run(main);
