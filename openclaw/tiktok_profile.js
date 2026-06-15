// tiktok_profile.js — scrape a creator's videos (URL + view count, optionally caption) straight from
// their TikTok PROFILE page. TikTok *search* (search_tiktok_v2) rarely surfaces a specific account's
// post even by handle, so to recover the TRUE original of a `tt/<user>` credit we open the profile and
// list its grid directly — the analogue of ig_profile.js for Instagram.
//
//   const { tiktokProfileVideos } = require('./tiktok_profile');
//   await tiktokProfileVideos('putrarahmadani113', { max: 12, captions: true }) → [{url, views, caption}]
//
// Needs a logged-in tiktok.com tab attached to the relay.

const fs = require('fs');
const { connect, sleep } = require('./cdp');
const { tiktokOembed } = require('./verify');

// TikTok often serves a "Please wait..." anti-bot interstitial that resolves to the real page after a
// few seconds. Poll until the profile grid/header is present (or timeout). Returns true when ready.
async function waitProfileReady(c, maxMs = 16000) {
  const step = 1000;
  for (let waited = 0; waited <= maxMs; waited += step) {
    const ok = await c.evaluate(`String(!!document.querySelector('a[href*="/video/"]') || !!document.querySelector('[data-e2e="user-avatar"]'))`);
    if (ok === 'true' || ok === true) return true;
    await sleep(step);
  }
  return false;
}

function parseViews(s) {
  s = (s || '').trim().replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const u = (m[2] || '').toUpperCase();
  if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
  return Math.round(n);
}

async function tiktokProfileVideos(username, { max = 12, captions = true, client } = {}) {
  const u = (username || '').replace(/^@/, '');
  if (!u) return [];
  let c = client, own = false;
  if (!c) { c = await connect({ match: 'tiktok.com', requireMatch: true }); own = true; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate('https://www.tiktok.com/@' + u, 7000);
    await waitProfileReady(c); // ride out the "Please wait..." interstitial
    try { await c.scroll(1600); } catch (e) {}
    await sleep(1400);
    const raw = await c.evaluate(`(() => {
      const seen = new Set(); const out = [];
      document.querySelectorAll('a[href*="/video/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        if (!/\\/@[\\w.\\-]+\\/video\\/\\d{8,}/.test(href)) return;
        const url = new URL(href, location.origin).href.split('?')[0];
        if (seen.has(url)) return; seen.add(url);
        const vEl = a.querySelector('[data-e2e="video-views"]') ||
          (a.parentElement && a.parentElement.querySelector('[data-e2e="video-views"]'));
        out.push({ url, v: (vEl && vEl.innerText || '').trim() });
      });
      return JSON.stringify(out.slice(0, 40));
    })()`);
    let items = []; try { items = JSON.parse(raw || '[]'); } catch (e) {}
    // Keep only THIS creator's own videos (the profile grid is theirs; guard against stray links).
    const mine = new RegExp('/@' + u.replace(/[.]/g, '\\.') + '/video/', 'i');
    items = items.filter(it => mine.test(it.url))
      .map(it => ({ url: it.url, views: parseViews(it.v), caption: '' }))
      .slice(0, max);
    if (captions) {
      for (const it of items) {
        try { const m = await tiktokOembed(it.url); it.caption = (m && m.title) || ''; it.thumbnail = (m && m.thumbnail) || ''; }
        catch (e) { it.caption = ''; it.thumbnail = ''; }
      }
    }
    return items;
  } finally { if (own) c.close(); }
}

// Screenshot the creator's PROFILE-CARD header (avatar + name + follower/like counts) into `outPng`.
// CLIPPER pastes this real crop as the on-screen profile card (replacing the synthetic one). Computes a
// clip from the bounding box of the header elements (avatar + title + stats), with padding. Returns the
// path on success, '' on failure. Needs a logged-in tiktok.com tab attached.
async function cropTiktokProfile(username, outPng, { client } = {}) {
  const u = (username || '').replace(/^@/, '');
  if (!u || !outPng) return '';
  let c = client, own = false;
  if (!c) { c = await connect({ match: 'tiktok.com', requireMatch: true }); own = true; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate('https://www.tiktok.com/@' + u, 7000);
    await waitProfileReady(c); // ride out the "Please wait..." interstitial
    await sleep(800);
    const rectJson = await c.evaluate(`(() => {
      const pick = s => document.querySelector(s);
      const av = pick('[data-e2e="user-avatar"]');
      const title = pick('[data-e2e="user-title"]');
      const sub = pick('[data-e2e="user-subtitle"]');
      const stats = pick('[data-e2e="followers-count"]') || pick('[data-e2e="following-count"]');
      const bio = pick('[data-e2e="user-bio"]');
      const els = [av, title, sub, stats, bio].filter(Boolean);
      if (!els.length) return '';
      let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
      els.forEach(el => { const r = el.getBoundingClientRect(); x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); });
      const pad = 18;
      return JSON.stringify({ x: Math.max(0, x1 - pad), y: Math.max(0, y1 - pad), w: (x2 - x1) + pad * 2, h: (y2 - y1) + pad * 2 });
    })()`);
    let rect; try { rect = JSON.parse(rectJson || 'null'); } catch (e) {}
    if (!rect || rect.w < 80 || rect.h < 40) { console.log('    [tiktok] crop profil: header tak terbaca.'); return ''; }
    const dpr = (await c.evaluate('window.devicePixelRatio')) || 1;
    const shot = await c.cmd('Page.captureScreenshot', {
      format: 'png', fromSurface: true,
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: dpr },
    });
    if (!shot || !shot.data) return '';
    fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
    return outPng;
  } catch (e) { return ''; } finally { if (own) c.close(); }
}

module.exports = { tiktokProfileVideos, cropTiktokProfile, parseViews };
