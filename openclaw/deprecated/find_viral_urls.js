// [DEPRECATED 2026-06-12] Sweep profil TikTok news-outlet — tidak dipakai flow mana pun (orphan).
// Discovery topik sekarang: discover_reels.js (akun IG terkurasi, hook/voiceover + recency).
// Disimpan untuk referensi; masih bisa dijalankan dari folder deprecated/ ini.
// find_viral_urls.js — sweep a set of Indonesian news-outlet TikTok profiles and collect
// recent /video/{id} URLs (raw b-roll candidates). Complements search_tiktok_v2.js
// (which is query-driven); this one is profile-driven.
//
//   node find_viral_urls.js                       # default outlet handles below
//   node find_viral_urls.js @kompascom @detikcom  # custom handles
//
// Output: output/viral_urls.json  { fetched_at, handles, urls:[...] }

const fs = require('fs');
const { connect, sleep, run } = require('../cdp');
const { validTK } = require('../validate');
const { outPath } = require('../paths');

const DEFAULT_HANDLES = ['@kompascom', '@detikcom', '@metrotvnews', '@cnnindonesia', '@liputan6'];

async function main() {
  const handles = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_HANDLES;
  const client = await connect({ match: 'tiktok.com' });

  const all = [];
  for (const h of handles) {
    console.log('Search:', h);
    const loc = await client.navigate('https://www.tiktok.com/' + h + '?lang=en', 5000);
    console.log('  URL:', String(loc).slice(0, 60));
    await client.scroll(1000); await sleep(2000);
    await client.scroll(2000); await sleep(2000);

    const links = JSON.parse(await client.evaluate(
      'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a=>a.href.split("?")[0]).filter(h=>h.indexOf("/video/")>-1))'
    ) || '[]');
    const fresh = [...new Set(links)].filter(u => validTK(u) && !all.includes(u)).slice(0, 6);
    console.log('  New:', fresh.length);
    fresh.forEach(u => all.push(u));
  }
  client.close();

  console.log('\n=== ALL UNIQUE URLs ===');
  all.forEach((u, i) => console.log((i + 1) + '. ' + u));

  const outFile = outPath('viral_urls.json');
  fs.writeFileSync(outFile, JSON.stringify({ fetched_at: new Date().toISOString(), handles, urls: all }, null, 2));
  console.log('\n💾', outFile);
}

run(main);
