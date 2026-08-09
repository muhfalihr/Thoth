// comment_engine.js — shared DOM/CDP comment scraper used by every per-platform script
// (scrape_comments_ig/_x/_yt/_fb/_reddit). Generalises the proven TikTok flow:
//   connect → focus tab → navigate → wait/lazy-load comments → extract fields from DOM →
//   pixel-perfect crop per comment (CDP Page.captureScreenshot `clip`) → write a SINGLE
//   content-set object {main,footage,comments} to output/ (NOT an array — load_content_set
//   parses one object). Crops land in output/crops/.
//
// A platform "adapter" supplies only what differs: the domain to match, how to tell the
// comments are loaded, the in-page EXTRACT_JS, and how to build the `main` object. The
// EXTRACT_JS MUST tag each comment's crop element with `data-clip-idx="<i>"` and return a
// JSON array of { idx, author, text, likes_raw, avatar_url }.

import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep } from './cdp.ts';
import { normalizeLikes } from './comments.ts';
import { finalizeCommentContentSet } from './comment_content.ts';
import { CROPS_DIR, outPath } from './paths.ts';
import { ui } from './ui.ts';
import { okCrop } from './crop_guard.ts';

const PAD = 6; // CSS px padding around each comment crop

// Reusable multi-source merge (Task 15): NOT CLI-only — this operates on already-collected
// comment records (from the kernel's AcquisitionService.collectComments(), one call per source),
// independent of the DOM/CDP scraping above. Used by pipeline/collect_comments.ts to fold several
// sources' comments into one deduped, likes-ranked, capped list before any screenshot is taken.
export const dedupeKey = (c: { author?: string; text?: string }) =>
  `${(c.author || '').toLowerCase()}|${(c.text || '').trim().slice(0, 60).toLowerCase()}`;

export function dedupeAndRankComments<
  T extends { author?: string; text?: string; likes?: number },
>(comments: T[], cap: number): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const c of comments) {
    const key = dedupeKey(c);
    if (!c.text || seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  merged.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  return merged.slice(0, cap);
}

// "[Sticker]"/"[Stiker]" (and the like) carry no text for narration grounding.
const isStickerOnly = (t) => /^\[\s*sti?c?ker\s*\]$/i.test((t || '').trim());

// Link-first promo "comments" — a news/brand account dropping its article link (e.g.
// "http://\nKLIKSUMUT.COM | MEDAN – …") are promo, not audience reactions. Skip them.
const isLinkSpam = (t) => /^https?:\/\//i.test((t || '').trim());

// Poll an in-page count expression until > 0 (or tries exhausted).
async function pollCount(client, countJs, tries = 8, interval = 1000) {
  for (let t = 0; t < tries; t++) {
    const n = await client.evaluate(countJs);
    if (n > 0) return n;
    await sleep(interval);
  }
  return 0;
}

async function scrapeComments(opts) {
  const {
    url,
    platform,
    match, // domain substring (or array) for connect() to pick the tab
    requireMatch = true, // error if that tab isn't attached (don't drive the wrong site)
    idToken = '', // if current href already contains this, skip navigation
    ensureLoaded, // async (client) => count ; opens panel / first wait
    extractJs, // string IIFE → JSON array, tags data-clip-idx on crop element
    scrollJs, // optional string evaluated a few times to lazy-load more
    scrollRounds = 4,
    buildMain, // (url) => main object
    max = 12,
    out = 'thoth_content_set.json',
    pad = PAD,
    skipSticker = true,
    label = platform,
    commentsOnly = process.argv.includes('--comments-only'),
  } = opts;

  if (!fs.existsSync(CROPS_DIR)) fs.mkdirSync(CROPS_DIR, { recursive: true });
  const OUT_JSON = outPath(out);

  console.log(ui.rule());
  console.log(`  Scrape Comments (DOM/CDP) — ${label}`);
  console.log(ui.rule());
  console.log('URL:', url);

  const client = await connect({ match, requireMatch });

  // Many SPAs only mount the detail view (and its comments) when the tab is focused; a
  // backgrounded relay tab renders just a shell. Force focus before navigating.
  try {
    await client.cmd('Page.bringToFront');
  } catch (e) {}
  try {
    await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (e) {}

  const cur = await client.evaluate('window.location.href');
  if (
    !cur ||
    (idToken
      ? !cur.includes(idToken)
      : !cur.includes(url.replace(/^https?:\/\//, '').split('?')[0]))
  ) {
    console.log('Navigasi ke target...');
    await client.navigate(url, 6000);
  }

  console.log('[1/3] Tunggu komentar render...');
  const count = await ensureLoaded(client);
  if (!count) {
    console.log(
      ui.amber(
        `${ui.WARN}  Tidak ada elemen komentar. Pastikan tab login (jika perlu) & post punya komentar.`,
      ),
    );
    client.close();
    return { comments: [], outJson: OUT_JSON };
  }

  console.log('[2/3] Ekstrak + crop progresif (anti-virtualisasi)...');
  const dpr = (await client.evaluate('window.devicePixelRatio')) || 1;
  const scroll = scrollJs || 'window.scrollBy(0, 800)';
  const results = [];
  const seen = new Set();
  let stickerCount = 0,
    stagnant = 0,
    outIdx = 0;

  // Virtualised lists (X, IG) recycle off-screen nodes, so we can't tag everything then loop —
  // the tagged nodes are gone by capture time. Instead: extract the CURRENTLY-mounted comments,
  // crop each immediately (before scrolling unmounts it), dedupe by a stable key, then scroll
  // and repeat until we have `max` or the list stops yielding new ones. Capture uses PAGE
  // (document) coords + captureBeyondViewport:true — plain viewport+fromSurface returns a BLACK
  // clip on wide/virtualised layouts (e.g. YouTube watch).
  while (results.length < max && stagnant < 8) {
    let batch = [];
    try {
      batch = JSON.parse((await client.evaluate(extractJs)) || '[]');
    } catch (e) {}
    let progressed = false;
    for (const c of batch) {
      if (results.length >= max) break;
      const text = (c.text || '').trim();
      if (!text) continue;
      const key = c.key || `${c.author}|${text.slice(0, 60)}`;
      if (seen.has(key)) continue;
      if (skipSticker && isStickerOnly(text)) {
        seen.add(key);
        stickerCount++;
        progressed = true;
        continue;
      }
      if (isLinkSpam(text)) {
        seen.add(key);
        progressed = true;
        continue;
      }

      const measure = async () => {
        await client.evaluate(
          `(() => { const el = document.querySelector('[data-clip-idx="${c.idx}"]'); if (el) el.scrollIntoView({block:"center"}); })()`,
        );
        // Wait for the node's OWN images (avatar/media) to actually decode before we read/capture —
        // an unpainted bun captures as a solid-black clip (the root cause of blank crops). Poll
        // from Node since client.evaluate doesn't awaitPromise; break early once painted (usually
        // faster than the old blind 420ms), cap ~1.3s for lazy avatars.
        const imgsReady = `(() => { const el = document.querySelector('[data-clip-idx="${c.idx}"]'); if (!el) return true; return [...el.querySelectorAll('img')].every(im => im.complete && im.naturalWidth > 0); })()`;
        for (let i = 0; i < 8; i++) {
          await sleep(160);
          try {
            if ((await client.evaluate(imgsReady)) === true) break;
          } catch (e) {}
        }
        const rj = await client.evaluate(
          `(() => { const el = document.querySelector('[data-clip-idx="${c.idx}"]'); if (!el) return ''; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height,txt:(el.innerText||'').replace(/\\s+/g,' ').slice(0,400)}); })()`,
        );
        try {
          return JSON.parse(rj);
        } catch (e) {
          return null;
        }
      };
      // The tagged bun must STILL show this comment's text at capture time. Virtualised lists (IG/X)
      // recycle off-screen nodes, so a `data-clip-idx` can end up on a bun now rendering something
      // else (e.g. the post caption) → a crop of the WRONG content. Guard: require the comment's text
      // to appear in the element's current innerText; if not, skip the crop (keep the correct
      // author/text → Thoth draws the synthetic card) instead of pasting a mismatched screenshot.
      const norm = (s) =>
        (s || '')
          .toLowerCase()
          .replace(/[^a-z0-9 ]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const want = norm(text).slice(0, 24);
      const contentMatches = (r) => want.length < 8 || norm(r && r.txt).includes(want);

      let rect = await measure();
      if (!rect || rect.w <= 30 || rect.h <= 12) continue; // recycled before we reached it → retry next batch
      if (!contentMatches(rect)) {
        seen.add(key);
        progressed = true;
        results.push({
          author: c.author || 'anon',
          text,
          likes: normalizeLikes(c.likes_raw),
          avatar_url: c.avatar_url || '',
          image_path: '',
        });
        outIdx++;
        console.log(
          `  #${outIdx} @${c.author}: crop konten tak cocok (bun ter-recycle) → kartu sintetis`,
        );
        continue;
      }

      seen.add(key);
      progressed = true;
      const likes = normalizeLikes(c.likes_raw);
      const safe = (c.author || `c${outIdx}`).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20);
      const entry = {
        author: c.author || 'anon',
        text,
        likes,
        avatar_url: c.avatar_url || '',
        image_path: '',
      };

      // Capture, retrying once on a blank result. A blank/uncomposited region is a solid black
      // PNG; okCrop() rejects it by pixel density so image_path stays empty and Thoth falls back
      // to its drawn card (never paste a blank crop). See lib/crop_guard.ts.
      let saved = false;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        if (attempt) {
          await sleep(300);
          rect = (await measure()) || rect;
          if (!contentMatches(rect)) break;
        }
        try {
          const data = await client.captureClip(rect, pad, { beyondViewport: true }); // device-pixel clip (dpr-correct)
          if (!data) continue;
          const buf = Buffer.from(data, 'base64');
          if (!okCrop(buf)) continue; // blank/black (low B/px) → retry / synthetic fallback
          const file = path.join(
            CROPS_DIR,
            `comment_${String(outIdx + 1).padStart(2, '0')}_${safe}_${likes}like.png`,
          );
          fs.writeFileSync(file, buf);
          entry.image_path = file;
          saved = true;
          console.log(
            `  #${outIdx + 1} @${entry.author} (${likes}❤) → ${path.basename(file)} (${(buf.length / 1024).toFixed(1)} KB)`,
          );
        } catch (e) {
          console.log(`  #${outIdx + 1} @${entry.author}: crop gagal (${e.message.slice(0, 50)})`);
          break;
        }
      }
      if (!saved)
        console.log(
          `  #${outIdx + 1} @${entry.author} (${likes}❤) — crop blank → pakai kartu sintetis (data tetap dipakai)`,
        );
      results.push(entry);
      outIdx++;
    }
    if (!progressed) stagnant++;
    else stagnant = 0;
    if (results.length < max) {
      await client.evaluate(scroll);
      await sleep(800);
    }
  }
  if (stickerCount) console.log(`  (${stickerCount} sticker-only di-skip)`);
  client.close();

  // Build/merge the content-set (single object). If OUT_JSON already holds a set for the
  // same main.url, refresh only its comments (keep main/footage from content-sourcing).
  let contentSet = { main: buildMain(url), footage: [], comments: results };
  if (fs.existsSync(OUT_JSON)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
      if (prev && !Array.isArray(prev) && prev.main && prev.main.url === url) {
        prev.comments = results;
        contentSet = prev;
      }
    } catch (e) {}
  }
  await finalizeCommentContentSet(contentSet, { commentsOnly });
  fs.writeFileSync(OUT_JSON, JSON.stringify(contentSet, null, 2), 'utf8');

  console.log('\n' + ui.rule());
  results
    .slice()
    .sort((a, b) => b.likes - a.likes)
    .forEach((r, i) =>
      console.log(`  ${i + 1}. @${r.author} (${r.likes}❤) "${r.text.slice(0, 60)}"`),
    );
  console.log(ui.rule());
  console.log(`📄 ${OUT_JSON} (${results.length} komentar)  |  📁 crops: ${CROPS_DIR}`);
  console.log('\nValidate lalu run:');
  console.log(`  bun validate_content_set.ts "${OUT_JSON}"`);
  console.log(`  thoth run --content "${OUT_JSON}"`);

  return { comments: results, outJson: OUT_JSON };
}

// Shared CLI arg parsing: <url> [out.json] [--max N]
function parseArgs(argv: string[]) {
  const flags: any = {},
    pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') flags.max = parseInt(argv[++i], 10);
    else if (argv[i] === '--comments-only') flags.commentsOnly = true;
    else pos.push(argv[i]);
  }
  return {
    url: pos[0],
    out: pos[1],
    max: flags.max,
    commentsOnly: Boolean(flags.commentsOnly),
  };
}

export { scrapeComments, pollCount, parseArgs, isStickerOnly, sleep };
