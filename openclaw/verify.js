// verify.js — caption-based topic verification for the GATE RELEVANSI in content-sourcing.
//
// PROBLEM: search_tiktok_v2 grabbed the first N /video/ links from a feed that often
// ignores the query (logged-out → "feed generik"). The skill mandates verifying each
// candidate's caption actually mentions the topic, but no tool could fetch a caption.
//
// FIX: TikTok exposes a PUBLIC oEmbed endpoint (no login) returning title (caption) +
// author. Use it to confirm a candidate is on-topic before marking relevance:"match".
//
//   Module:  const { tiktokOembed, matchesTopic } = require('./verify');
//   CLI:     node verify.js <tiktok_url> [keyword1 keyword2 ...]
//            → prints caption + author + whether all/any keywords are present.

// Fetch TikTok caption/author via public oEmbed. Returns {title,author,thumbnail} or null.
async function tiktokOembed(url) {
  try {
    const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return {
      title: d.title || '',
      author: d.author_name || d.author_unique_id || '',
      thumbnail: d.thumbnail_url || '',
    };
  } catch (_) {
    return null;
  }
}

// Fetch YouTube title via public oEmbed (no login). Returns {title,author} or null.
async function youtubeOembed(url) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { title: d.title || '', author: d.author_name || '', thumbnail: d.thumbnail_url || '' };
  } catch (_) { return null; }
}

// Does `text` mention the topic? mode 'all' (default) requires every keyword; 'any' needs one.
// Case-insensitive, accent-naive substring match (good enough for id/en captions).
function matchesTopic(text, keywords, mode = 'all') {
  if (!keywords || !keywords.length) return true;
  const hay = String(text || '').toLowerCase();
  const hits = keywords.filter(k => hay.includes(String(k).toLowerCase()));
  return mode === 'any' ? hits.length > 0 : hits.length === keywords.length;
}

// Verify a TikTok URL against keywords. Returns {url,ok,caption,author,hits,missing}.
// ok=null when the caption couldn't be fetched (oEmbed miss) → caller should treat as
// "unverified", never silently as "match".
async function verifyTikTok(url, keywords = []) {
  const meta = await tiktokOembed(url);
  if (!meta) return { url, ok: null, caption: '', author: '', hits: [], missing: keywords };
  const hay = (meta.title || '').toLowerCase();
  const hits = keywords.filter(k => hay.includes(String(k).toLowerCase()));
  const missing = keywords.filter(k => !hay.includes(String(k).toLowerCase()));
  return { url, ok: keywords.length ? hits.length === keywords.length : true, caption: meta.title, author: meta.author, hits, missing };
}

module.exports = { tiktokOembed, youtubeOembed, matchesTopic, verifyTikTok };

// --- CLI ------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const url = process.argv[2];
    const keywords = process.argv.slice(3);
    if (!url) { console.log('Usage: node verify.js <tiktok_url> [keyword ...]'); process.exit(1); }
    const res = await verifyTikTok(url, keywords);
    if (res.ok === null) {
      console.log('⚠️  Caption tak terambil (oEmbed miss). Perlakukan sebagai UNVERIFIED, jangan "match".');
      process.exitCode = 2; return;
    }
    console.log('Caption :', res.caption);
    console.log('Author  :', res.author);
    if (keywords.length) {
      console.log('Hits    :', res.hits.join(', ') || '(none)');
      console.log('Missing :', res.missing.join(', ') || '(none)');
      console.log(res.ok ? '✅ ON-TOPIC (semua keyword cocok) → boleh "match"' : '❌ OFF-TOPIC / sebagian → "unverified" atau buang');
    }
    process.exitCode = res.ok ? 0 : 1;
  })();
}
