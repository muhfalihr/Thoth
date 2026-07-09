// search_news.js — news/data sourcing for a topic, in scout (was Thoth-side), via CDP/Google.
//
// Two modes, auto-detected from the topic:
//   - CHART : currency topics (e.g. "rupiah menurun dibanding dolar") → query Google "USD to IDR"
//             and crop the currency CONVERTER+CHART widget as a clean image card (image_path).
//   - ARTICLES : anything else → Google News (tbm=nws) → top result cards (title+url+source),
//             each cropped as an image card too.
//
//   bun search_news.js "<topik>" [--max N] [--mode chart|articles|auto]
//
// Needs a google.com tab attached to the relay; if none, falls back to any page tab + navigates to
// Google (Google search needs no login). Output → output/news_<slug>.json. Crops → output/crops/.

import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep, run } from '../lib/cdp.ts';
import { outPath, cropPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';

const args = process.argv.slice(2);
const getFlag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const QUERY = args.find(
  (a) =>
    !a.startsWith('--') && !['--max', '--mode', '--append'].includes(args[args.indexOf(a) - 1]),
);
const MAX = parseInt(getFlag('--max', '5'), 10);
const MODE = getFlag('--mode', 'auto');
const APPEND = getFlag('--append', null); // content-set JSON to fold news items into footage[]
if (!QUERY) {
  console.log('Usage: bun search_news.ts "<topik>" [--max N] [--mode chart|articles|auto]');
  process.exit(1);
}

const slug =
  QUERY.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'news';

// Currency terms → ISO code (multi-word terms longest-first when matching).
const CUR = {
  'dolar amerika': 'USD',
  'dolar singapura': 'SGD',
  'dolar australia': 'AUD',
  'mata uang rupiah': 'IDR',
  rupiah: 'IDR',
  idr: 'IDR',
  dolar: 'USD',
  dollar: 'USD',
  usd: 'USD',
  euro: 'EUR',
  eur: 'EUR',
  yen: 'JPY',
  jpy: 'JPY',
  ringgit: 'MYR',
  myr: 'MYR',
  won: 'KRW',
  krw: 'KRW',
  yuan: 'CNY',
  cny: 'CNY',
  renminbi: 'CNY',
  poundsterling: 'GBP',
  pound: 'GBP',
  gbp: 'GBP',
  sterling: 'GBP',
  baht: 'THB',
  peso: 'PHP',
  riyal: 'SAR',
  sar: 'SAR',
  dirham: 'AED',
  aed: 'AED',
  franc: 'CHF',
  chf: 'CHF',
  aud: 'AUD',
  sgd: 'SGD',
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build a Google currency-chart query ("USD to IDR") if the topic is about currency, else null.
function detectChartQuery(q) {
  const text = q.toLowerCase();
  const hits = [];
  for (const term of Object.keys(CUR).sort((a, b) => b.length - a.length)) {
    const m = text.match(new RegExp('\\b' + esc(term) + '\\b'));
    if (m) hits.push({ code: CUR[term], idx: m.index });
  }
  // dedupe codes, keep first-appearance order
  const codes = [];
  hits
    .sort((a, b) => a.idx - b.idx)
    .forEach((h) => {
      if (!codes.includes(h.code)) codes.push(h.code);
    });
  if (!codes.length) return null;
  let base, quote;
  if (codes.length >= 2) {
    base = codes.includes('USD') ? 'USD' : codes[0];
    quote = codes.find((c) => c !== base);
  } else {
    if (codes[0] === 'USD') return null;
    base = 'USD';
    quote = codes[0];
  }
  return `${base} to ${quote}`;
}

// Capture an element (already tagged data-news-crop="<tag>") with the proven page-coords +
// captureBeyondViewport + blank-guard technique. Returns image_path or null.
async function captureTagged(client, tag, outFile, pad = 10) {
  const dpr = (await client.evaluate('window.devicePixelRatio')) || 1;
  const measure = async () => {
    await client.evaluate(
      `(() => { const el = document.querySelector('[data-news-crop="${tag}"]'); if (el) el.scrollIntoView({block:"center"}); })()`,
    );
    await sleep(450);
    const rj = await client.evaluate(
      `(() => { const el = document.querySelector('[data-news-crop="${tag}"]'); if (!el) return ''; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height}); })()`,
    );
    try {
      return JSON.parse(rj);
    } catch (e) {
      return null;
    }
  };
  let rect = await measure();
  if (!rect || rect.w <= 30 || rect.h <= 12) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      await sleep(300);
      rect = (await measure()) || rect;
    }
    const data = await client.captureClip(rect, pad, { beyondViewport: true });
    const buf = data ? Buffer.from(data, 'base64') : Buffer.alloc(0);
    if (buf.length < 2048) continue;
    fs.writeFileSync(outFile, buf);
    return outFile;
  }
  return null;
}

// ---- CHART: currency converter + chart widget --------------------------------------------------
const CHART_FIND = `(() => {
  // The currency widget is the smallest ancestor of a <select> that holds BOTH currency selects
  // and the chart <svg>. Climb up, then one more level for the full card. Classes are obfuscated,
  // so we anchor on structure, not class names.
  const sel = document.querySelector('select'); if (!sel) return 0;
  let w = sel, card = null;
  for (let k = 0; k < 12 && w.parentElement; k++) {
    w = w.parentElement;
    if (w.querySelectorAll('select').length >= 2 && w.querySelectorAll('svg').length >= 1) { card = w; break; }
  }
  if (!card) return 0;
  if (card.parentElement) { const p = card.parentElement; const a = card.getBoundingClientRect(), b = p.getBoundingClientRect(); if (Math.abs(a.width - b.width) < 8) card = p; }
  card.setAttribute('data-news-crop', 'chart');
  return 1;
})()`;

async function doChart(client, chartQuery) {
  console.log(`[chart] Google: "${chartQuery}"`);
  await client.navigate(
    'https://www.google.com/search?hl=id&q=' + encodeURIComponent(chartQuery),
    6000,
  );
  await sleep(2500);
  let tagged = 0;
  for (let t = 0; t < 6; t++) {
    tagged = await client.evaluate(CHART_FIND);
    if (tagged) break;
    await sleep(1000);
  }
  if (!tagged) {
    console.log(
      ui.amber(
        `  ${ui.WARN} widget kurs tak ketemu (mungkin Google tak menampilkan converter utk query ini).`,
      ),
    );
    return null;
  }
  const value = await client.evaluate(
    `(() => { const el = document.querySelector('[data-news-crop="chart"]'); if (!el) return ''; const line = (el.innerText||'').split('\\n').map(s=>s.trim()).find(s=>/=|Rp|\\d[\\d.,]+/.test(s)); return (line||'').slice(0,80); })()`,
  );
  const img = await captureTagged(client, 'chart', cropPath(`news_chart_${slug}.png`));
  if (!img) {
    console.log(ui.amber(`  ${ui.WARN} crop chart gagal/blank.`));
    return null;
  }
  console.log(ui.gold(`  ${ui.OK} ${path.basename(img)}  | nilai: ${value}`));
  return {
    chart_query: chartQuery,
    value,
    image_path: img,
    source_url: 'https://www.google.com/search?q=' + encodeURIComponent(chartQuery),
  };
}

// ---- ARTICLES: Google News result cards --------------------------------------------------------
// Tag the top N news result cards: from each headline (role=heading) climb to the nearest <a> with
// an external (non-google) href — that anchor wraps the card. Returns [{idx,title,url,source}].
const NEWS_EXTRACT = `(() => {
  const out = [];
  const heads = Array.from(document.querySelectorAll('[role="heading"], div[role="heading"]'));
  heads.forEach(h => {
    let a = h.closest('a[href]');
    if (!a) { let w = h; for (let k=0;k<5 && w.parentElement;k++){ w=w.parentElement; const x=w.querySelector('a[href^="http"]'); if(x){a=x;break;} } }
    if (!a) return;
    const url = a.href;
    if (!/^https?:/.test(url) || /google\\.com/.test(url)) return;
    const card = a.closest('div') || a;
    const title = (h.innerText||'').trim();
    if (!title || title.length < 8) return;
    if (out.some(o => o.url === url)) return;
    const idx = out.length;
    card.setAttribute('data-news-crop', 'a'+idx);
    // source = a short nearby text that isn't the title
    let source = '';
    const texts = Array.from(card.querySelectorAll('span,div')).map(e=>e.innerText.trim()).filter(t=>t && t!==title && t.length<40);
    source = texts[0] || '';
    out.push({ idx, title, url, source });
  });
  return JSON.stringify(out.slice(0, 12));
})()`;

async function doArticles(client, max) {
  console.log(`[articles] Google News: "${QUERY}"`);
  await client.navigate(
    'https://www.google.com/search?hl=id&tbm=nws&q=' + encodeURIComponent(QUERY),
    6000,
  );
  await sleep(2500);
  let items = [];
  try {
    items = JSON.parse((await client.evaluate(NEWS_EXTRACT)) || '[]');
  } catch (e) {}
  items = items.slice(0, max);
  console.log(`  ${items.length} artikel terdeteksi`);
  const out = [];
  for (const it of items) {
    const img = await captureTagged(
      client,
      'a' + it.idx,
      cropPath(`news_${slug}_${it.idx + 1}.png`),
    );
    out.push({ title: it.title, url: it.url, source: it.source, image_path: img || '' });
    console.log(
      `  ${it.idx + 1}. ${img ? ui.gold(ui.OK) : ui.amber(`${ui.WARN} (no crop)`)} ${it.title.slice(0, 60)} — ${it.source}`,
    );
  }
  return out;
}

run(async () => {
  console.log(ui.rule());
  console.log('  Search News (CDP/Google)');
  console.log(ui.rule());
  console.log('Topik:', QUERY);

  const client = await connect({ match: ['google.com', 'google.co.id'], requireMatch: false });
  try {
    await client.cmd('Page.bringToFront');
  } catch (e) {}

  const chartQuery = MODE === 'articles' ? null : detectChartQuery(QUERY);
  const result = {
    query: QUERY,
    fetched_at: new Date().toISOString(),
    mode: '',
    chart: null,
    articles: [],
  };

  if (chartQuery && MODE !== 'articles') {
    result.chart = await doChart(client, chartQuery);
    result.mode = result.chart ? 'chart' : 'articles';
  }
  if (!result.chart && MODE !== 'chart') {
    result.articles = await doArticles(client, MAX);
    result.mode = 'articles';
  }
  client.close();

  const out = outPath(`news_${slug}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  console.log(ui.rule('thin'));
  console.log(`📄 ${out} (mode: ${result.mode})`);

  // Fold news items into a content-set's footage[] — they already carry image_path + are on-topic,
  // so they go in as ready image cards (is_video:false, relevance:"match"; enrich skips them).
  if (APPEND) {
    if (!fs.existsSync(APPEND)) {
      console.log(ui.amber(`${ui.WARN}  --append: ${APPEND} tak ada, lewati.`));
      return;
    }
    let set;
    try {
      set = JSON.parse(fs.readFileSync(APPEND, 'utf8'));
    } catch (e) {
      console.log(ui.amber(`${ui.WARN}  --append: JSON tak valid.`));
      return;
    }
    set.footage = set.footage || [];
    let added = 0;
    const push = (url, image_path) => {
      if (image_path) {
        set.footage.push({
          url,
          platform: 'news',
          query: QUERY,
          is_video: false,
          image_path,
          relevance: 'match',
        });
        added++;
      }
    };
    if (result.chart) push(result.chart.source_url, result.chart.image_path);
    result.articles.forEach((a) => push(a.url, a.image_path));
    fs.writeFileSync(APPEND, JSON.stringify(set, null, 2), 'utf8');
    console.log(`➕ ${added} kartu news → ${APPEND}`);
  }
});
