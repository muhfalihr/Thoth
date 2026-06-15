// search_social_v2.js — extract REAL canonical IG / Twitter-X URLs via the logged-in
// CDP browser (muhfalihr-chrome), validate their shape, and save to JSON.
//
// WHY: IG/Twitter post URLs "selalu tidak bisa diakses" karena dirakit dari handle/keyword
// (mis. instagram.com/p/<handle>/reel/ → 404) atau diakses logged-out (x.com login-wall).
// FIX: navigasi browser yang SUDAH LOGIN, ambil href canonical real dari DOM, validasi regex.
//
//   node search_social_v2.js ig "korupsi BGN MBG"
//   node search_social_v2.js tw "korupsi BGN MBG"
//
// Output: output/<ig|tw>_urls.json  { query, fetched_at, logged_out_hint, urls:[...] }

const fs = require('fs');
const { connect, sleep, run } = require('./cdp');
const { validIG, validTW } = require('./validate');
const { outPath } = require('./paths');

async function main() {
  const platform = (process.argv[2] || '').toLowerCase();
  const query = process.argv[3];
  if (!['ig', 'tw'].includes(platform) || !query) {
    console.log('Usage: node search_social_v2.js <ig|tw> "<query>"');
    process.exit(1);
  }

  const cfg = platform === 'ig'
    ? {
        match: 'instagram.com',
        searchUrl: 'https://www.instagram.com/explore/search/keyword/?q=' + encodeURIComponent(query),
        extract: 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a=>a.href.split("?")[0]).filter(h=>/instagram\\.com\\/(reel|p|tv)\\/[A-Za-z0-9_-]{5,}/.test(h)))',
        valid: validIG,
        out: 'ig_urls.json',
      }
    : {
        match: 'x.com',
        searchUrl: 'https://x.com/search?q=' + encodeURIComponent(query) + '&f=live',
        extract: 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a=>a.href.split("?")[0]).filter(h=>/(x|twitter)\\.com\\/[^/]+\\/status\\/\\d{15,}/.test(h)))',
        valid: validTW,
        out: 'tw_urls.json',
      };

  // connect() does the relay preflight: a clear "attach the extension" message if 18792 is down.
  const client = await connect({ match: cfg.match });

  console.log(`🔎 [${platform}] navigate: ${cfg.searchUrl}`);
  const loc = await client.navigate(cfg.searchUrl, 7000); // wait render + past login-wall (session logged in)
  console.log('   current:', loc);

  // Detect login-wall / dead page → URLs can't be trusted.
  const loggedOutHint = await client.evaluate(
    '/log in|masuk untuk|sign up|something went wrong|page isn.t available/i.test(document.body?.innerText||"")'
  );
  if (loggedOutHint) console.log('⚠️  Halaman tampak login-wall / error. Sesi mungkin belum login. URL tak diverifikasi.');

  let links = [];
  try { links = JSON.parse(await client.evaluate(cfg.extract) || '[]'); } catch (e) { console.log('parse err:', e.message); }
  client.close();

  // Dedupe + validate (drop fabricated / handle-as-shortcode shapes).
  const seen = new Set();
  const valid = [], rejected = [];
  for (const u of links) {
    if (seen.has(u)) continue; seen.add(u);
    (cfg.valid(u) ? valid : rejected).push(u);
  }

  console.log(`\n✅ ${valid.length} URL canonical tervalidasi:`);
  valid.slice(0, 15).forEach((l, i) => console.log(`   ${i + 1}. ${l}`));
  if (rejected.length) {
    console.log(`\n🚫 ${rejected.length} ditolak (bentuk tidak valid — JANGAN kirim ke CLIPPER):`);
    rejected.slice(0, 5).forEach(l => console.log(`   - ${l}`));
  }

  const outFile = outPath(cfg.out);
  fs.writeFileSync(outFile, JSON.stringify({ query, fetched_at: new Date().toISOString(), logged_out_hint: !!loggedOutHint, urls: valid }, null, 2));
  console.log(`\n💾 ${outFile}`);
  if (valid.length === 0) console.log('⚠️  Nol URL valid → JANGAN rakit URL manual. Buka postingan di browser login lalu salin URL canonical.');
}

run(main);
