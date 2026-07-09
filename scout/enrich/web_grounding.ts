// web_grounding.js — fetch CURRENT-status headlines for a term via Google News (CDP), so the
// narration enricher can resolve entities/events to their LATEST real status (beyond the LLM's
// training cutoff — e.g. "Nadiem Makarim" → corruption case 2025/2026). Same CDP→Google-News
// approach as search_news.js, but TEXT-ONLY (no crop) + reusable as a module.
//
//   import { groundTerms } from './web_grounding.ts';
//   await groundTerms(['Nadiem Makarim','konoha'], { max: 5 })
//     → { "Nadiem Makarim": [{title,source,url}], "konoha": [...] }
//
// Best-effort: no relay / nav failure → empty headlines for that term (caller keeps model summary).

import { connect, sleep } from '../lib/cdp.ts';

// Top news result cards on a Google News (tbm=nws) page → [{title,url,source}] (text only).
// Mirror of search_news.js NEWS_EXTRACT, minus the crop tagging.
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
    let source = '';
    const texts = Array.from(card.querySelectorAll('span,div')).map(e=>e.innerText.trim()).filter(t=>t && t!==title && t.length<40);
    source = texts[0] || '';
    out.push({ title, url, source });
  });
  return JSON.stringify(out.slice(0, 12));
})()`;

async function googleNewsHeadlines(client, query, max = 5) {
  await client.navigate('https://www.google.com/search?hl=id&tbm=nws&q=' + encodeURIComponent(query), 6000);
  await sleep(2200);
  let items = [];
  try { items = JSON.parse((await client.evaluate(NEWS_EXTRACT)) || '[]'); } catch (e) {}
  return items.slice(0, max).map(it => ({ title: it.title, source: it.source, url: it.url }));
}

// Fetch headlines for many terms reusing ONE Google tab. Returns { term: [{title,source,url}] }.
async function groundTerms(terms: string[], { max = 5, client }: { max?: number; client?: any } = {}) {
  const out = {};
  const list = (terms || []).filter(Boolean);
  if (!list.length) return out;
  let c = client, own = false;
  if (!c) {
    try { c = await connect({ match: ['google.com', 'google.co.id'], requireMatch: false }); own = true; }
    catch (e) { return out; } // no relay → caller falls back to model summaries
  }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    for (const t of list) {
      try { out[t] = await googleNewsHeadlines(c, t, max); }
      catch (e) { out[t] = []; }
    }
  } finally { if (own) { try { c.close(); } catch (e) {} } }
  return out;
}

export { groundTerms, googleNewsHeadlines };

// ---- CLI (debug) ----
if (import.meta.main) {
  const terms = process.argv.slice(2);
  if (!terms.length) { console.log('Usage: bun web_grounding.ts "<term>" ["<term2>" ...]'); process.exit(1); }
  (async () => { console.log(JSON.stringify(await groundTerms(terms, { max: 5 }), null, 2)); })();
}
