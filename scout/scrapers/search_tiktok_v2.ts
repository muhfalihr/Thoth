// search_tiktok_v2.js — extract REAL /video/{id} URLs from the logged-in TikTok tab,
// validate their shape, and (optionally) gate them by caption against topic keywords.
//
//   bun search_tiktok_v2.js "<query>" [keyword1 keyword2 ...]
//
// With keywords, each candidate's caption is fetched via public oEmbed (verify.js) and
// kept only if it mentions ALL keywords — enforcing the GATE RELEVANSI the skill mandates
// (logged-out search often returns a generic feed that ignores the query).
//
// Output: output/tiktok_urls.json  { query, fetched_at, urls:[{url,relevance,caption,author}] }

import fs from 'node:fs';
import { connect, sleep, run } from '../lib/cdp.ts';
import { validTK } from '../lib/validate.ts';
import { verifyTikTok } from '../lib/verify.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';

async function main() {
  const query = process.argv[2];
  const keywords = process.argv.slice(3);
  if (!query) {
    console.log('Usage: bun search_tiktok_v2.ts "<query>" [keyword ...]');
    process.exit(1);
  }

  const client = await connect({ match: 'tiktok.com' });
  const searchUrl = 'https://www.tiktok.com/search?q=' + encodeURIComponent(query) + '&type=video';
  console.log('🔎 navigate:', searchUrl);
  const cur = await client.navigate(searchUrl, 6000);
  console.log('   current:', cur);

  // Scroll to load more results, then pull canonical /video/ hrefs from the DOM.
  await client.scroll(1200);
  await sleep(1500);
  await client.scroll(2400);
  await sleep(1500);
  const links = JSON.parse(
    (await client.evaluate(
      'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a=>a.href.split("?")[0]).filter(h=>/tiktok\\.com\\/@[\\w.-]+\\/video\\/\\d{8,}/.test(h)))',
    )) || '[]',
  );
  client.close();

  // Dedupe + validate shape (drop fabricated/short URLs).
  const seen = new Set();
  const valid = links.filter((u) => validTK(u) && !seen.has(u) && seen.add(u));
  console.log(`\nFound ${valid.length} valid /video/ URLs (from ${links.length} raw).`);

  // Optional caption gate.
  let out = valid.map((u) => ({ url: u, relevance: 'unverified', caption: '', author: '' }));
  if (keywords.length) {
    console.log(`\n🎯 GATE RELEVANSI vs [${keywords.join(', ')}] (oEmbed caption)…`);
    out = [];
    for (const u of valid.slice(0, 20)) {
      const r = await verifyTikTok(u, keywords);
      const rel = r.ok === null ? 'unverified' : r.ok ? 'match' : 'off-topic';
      const mark = rel === 'match' ? '✅' : rel === 'off-topic' ? '❌' : '⚠️';
      console.log(
        `   ${mark} [${rel}] ${u}\n        "${(r.caption || '(no caption)').slice(0, 70)}"`,
      );
      if (rel !== 'off-topic')
        out.push({ url: u, relevance: rel, caption: r.caption, author: r.author });
    }
    console.log(
      `\n→ ${out.filter((o) => o.relevance === 'match').length} match, ${out.filter((o) => o.relevance === 'unverified').length} unverified (off-topic dibuang).`,
    );
  } else {
    out.slice(0, 15).forEach((o, i) => console.log(`   ${i + 1}. ${o.url}`));
  }

  const outFile = outPath('tiktok_urls.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify({ query, keywords, fetched_at: new Date().toISOString(), urls: out }, null, 2),
  );
  console.log(`\n💾 ${outFile}`);
  if (!out.length)
    console.log(
      ui.amber(
        `${ui.WARN}  Nol URL. Jangan rakit URL manual — pastikan tab TikTok login ter-attach & query benar.`,
      ),
    );
}

run(main);
