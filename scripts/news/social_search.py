#!/usr/bin/env python3
"""Thoth multi-platform content search (Stage 0.5 / enrichment supplier).

Given one or more queries (usually derived from Twitter/X trends), searches
across YouTube, TikTok, Twitter/X, Instagram, and News, and prints ONE JSON
envelope the Rust `ingest::content_search` module consumes:

    {"results": [
        {"platform": "youtube", "url": ..., "title": ..., "snippet": ...,
         "source": ..., "published": ..., "thumbnail": ...,
         "is_video": true, "duration_sec": 612, "views": 1200000, "query": ...},
        ...
    ]}

Engines (selected with --engine):
    playwright   — Chromium + cookies + webdriver masking (default; installed).
    scrapling    — Scrapling StealthyFetcher (Camoufox, undetected) for the
                   hard platforms (TikTok/Instagram). Falls back to Playwright
                   automatically if Scrapling is not installed.
    auto         — Scrapling for tiktok/instagram if available, else Playwright.

Design goals (mirrors the montage-style enrichment needs):
    • collect MORE THAN ONE relevant clip across platforms for enrichment
    • be resilient to layout changes (multiple selector fallbacks + ytInitialData)
    • degrade gracefully: one platform/query failing never aborts the rest

Usage:
    python social_search.py --query "bigmo qurban" \
        --platforms youtube,tiktok,twitter,news \
        --max 6 --timeout 25 --cookies data/cookies.txt --engine auto
"""

import argparse
import json
import re
import sys
from urllib.parse import quote_plus

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ALL_PLATFORMS = ["youtube", "tiktok", "twitter", "instagram", "news"]
HARD_PLATFORMS = {"tiktok", "instagram"}  # benefit most from Scrapling stealth


def log(msg: str) -> None:
    print(f"[social_search] {msg}", file=sys.stderr, flush=True)


def emit(results, error=None, code=0):
    payload = {"results": results}
    if error:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def parse_args():
    p = argparse.ArgumentParser(description="Thoth multi-platform content search")
    p.add_argument("--query", action="append", default=[], help="search query (repeatable)")
    p.add_argument("--platforms", default="youtube,instagram,twitter,news",
                   help="comma list: youtube,instagram,twitter,news[,tiktok]. "
                        "tiktok is opt-in: its search is bot-blocked without a proxy")
    p.add_argument("--max", type=int, default=6, help="max results per platform per query")
    p.add_argument("--timeout", type=int, default=25, help="per-page timeout (seconds)")
    p.add_argument("--region", default="ID")
    p.add_argument("--lang", default="id")
    p.add_argument("--cookies", default="", help="Netscape cookies.txt path")
    p.add_argument("--engine", default="auto", choices=["auto", "playwright", "scrapling"])
    p.add_argument("--no-relevance-filter", action="store_true",
                   help="keep all results even when text matches none of the query tokens")
    p.add_argument("--drop-unverified", action="store_true",
                   help="also drop results with no caption/title to verify (e.g. some TikTok)")
    return p.parse_args()


# ── Relevance filtering ───────────────────────────────────────────────────────
# Indonesian + English filler words that carry no topical signal.
_STOPWORDS = {
    "yang", "di", "ke", "dari", "dan", "atau", "the", "a", "an", "of", "in", "on",
    "video", "viral", "terbaru", "full", "lengkap", "hari", "ini", "si", "pak",
    "bapak", "ibu", "vs", "for", "to", "is", "dengan", "saat", "momen",
}


def significant_tokens(query: str):
    """Topical tokens from a query, e.g. 'prabowo joget' -> ['prabowo', 'joget']."""
    toks = re.findall(r"[a-z0-9]+", (query or "").lower())
    return [t for t in toks if len(t) >= 3 and t not in _STOPWORDS]


def apply_relevance_filter(results, drop_unverified=False):
    """Drop results whose verifiable text (title/snippet) matches NONE of their
    query's topical tokens — i.e. content that has nothing to do with the query.

    Honest about uncertainty: results with no caption to verify (some TikTok
    cards expose no alt text) are KEPT and tagged ``relevance='unverified'``
    unless ``drop_unverified`` is set, because the platform's own search already
    ranked them for the query. Each kept result gains a ``relevance`` field
    (``match`` | ``unverified``)."""
    out, dropped = [], 0
    for r in results:
        toks = significant_tokens(r.get("query", ""))
        if not toks:
            r["relevance"] = "match"
            out.append(r)
            continue
        has_text = bool((r.get("title", "") + r.get("snippet", "")).strip())
        if not has_text:
            r["relevance"] = "unverified"
            if not drop_unverified:
                out.append(r)
            else:
                dropped += 1
            continue
        blob = " ".join([r.get("title", ""), r.get("snippet", ""),
                         r.get("source", ""), r.get("url", "")]).lower()
        if any(t in blob for t in toks):
            r["relevance"] = "match"
            out.append(r)
        else:
            dropped += 1
            log(f'drop off-topic [{r.get("platform","")}] {r.get("title","")[:55]!r}')
    if dropped:
        log(f"relevance filter dropped {dropped} off-topic result(s)")
    return out


# ── Cookie handling (Netscape → Playwright dicts, grouped by domain) ───────────
def load_netscape_cookies(path: str) -> list:
    if not path:
        return []
    from pathlib import Path as _Path
    if not _Path(path).exists():
        log(f"cookies file not found: {path}")
        return []
    cookies = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) < 7:
                    continue
                domain, _inc, cpath, secure, expires, name, value = parts[:7]
                try:
                    exp = int(expires)
                except ValueError:
                    exp = -1
                cookies.append({
                    "name": name, "value": value, "domain": domain,
                    "path": cpath or "/", "expires": exp,
                    "secure": secure.upper() == "TRUE",
                    "httpOnly": False, "sameSite": "Lax",
                })
    except Exception as e:
        log(f"cookies parse error: {e}")
    return cookies


# Mask navigator.webdriver and a few common automation tells.
STEALTH_JS = r"""
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['id-ID','id','en-US','en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
window.chrome = window.chrome || { runtime: {} };
"""

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def norm(platform, url, title, snippet="", source="", published=None,
         thumbnail="", is_video=True, duration_sec=0, views=0, query=""):
    return {
        "platform": platform, "url": url, "title": (title or "").strip(),
        "snippet": (snippet or "").strip()[:300], "source": (source or "").strip(),
        "published": published, "thumbnail": thumbnail or "",
        "is_video": bool(is_video), "duration_sec": int(duration_sec or 0),
        "views": int(views or 0), "query": query,
    }


# ── YouTube: parse ytInitialData (robust against HTML layout changes) ──────────
YT_EXTRACT_JS = r"""
(maxResults) => {
  const out = [];
  let data = null;
  try { data = window.ytInitialData; } catch (e) {}
  if (!data) {
    // search the inline scripts
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      const i = t.indexOf('var ytInitialData =');
      if (i >= 0) {
        try { data = JSON.parse(t.slice(i + 19, t.lastIndexOf('};') + 1)); } catch (e) {}
        if (data) break;
      }
    }
  }
  if (!data) return out;

  const walk = (node) => {
    if (out.length >= maxResults || node == null) return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (typeof node !== 'object') return;
    const vr = node.videoRenderer;
    if (vr && vr.videoId) {
      const title = (vr.title && vr.title.runs && vr.title.runs[0] && vr.title.runs[0].text) || '';
      const ch = (vr.ownerText && vr.ownerText.runs && vr.ownerText.runs[0] && vr.ownerText.runs[0].text) || '';
      const lengthTxt = (vr.lengthText && vr.lengthText.simpleText) || '';
      const viewTxt = (vr.viewCountText && (vr.viewCountText.simpleText ||
                       (vr.viewCountText.runs && vr.viewCountText.runs.map(r=>r.text).join('')))) || '';
      const pub = (vr.publishedTimeText && vr.publishedTimeText.simpleText) || '';
      const thumb = (vr.thumbnail && vr.thumbnail.thumbnails && vr.thumbnail.thumbnails.slice(-1)[0] &&
                     vr.thumbnail.thumbnails.slice(-1)[0].url) || '';
      out.push({videoId: vr.videoId, title, channel: ch, length: lengthTxt,
                views: viewTxt, published: pub, thumbnail: thumb});
    }
    for (const k in node) { if (out.length >= maxResults) break; walk(node[k]); }
  };
  walk(data);
  return out;
}
"""


def parse_duration(txt):
    if not txt:
        return 0
    parts = [int(x) for x in re.findall(r"\d+", txt)]
    if not parts:
        return 0
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0]


def parse_views(txt):
    if not txt:
        return 0
    t = txt.lower().replace(",", "").replace(".", "")
    m = re.search(r"([\d]+)\s*(rb|ribu|jt|juta|k|m|b)?", t)
    if not m:
        return 0
    n = int(m.group(1))
    mult = {"rb": 1_000, "ribu": 1_000, "k": 1_000,
            "jt": 1_000_000, "juta": 1_000_000, "m": 1_000_000, "b": 1_000_000_000}
    return n * mult.get(m.group(2) or "", 1)


def search_youtube(page, query, maxn, region, lang, timeout_ms):
    url = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp=EgIQAQ%253D%253D"
    page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("ytd-video-renderer, #contents", timeout=min(timeout_ms, 8000))
    except Exception:
        pass
    raw = page.evaluate(YT_EXTRACT_JS, maxn)
    items = []
    for r in raw:
        items.append(norm(
            "youtube", f"https://www.youtube.com/watch?v={r['videoId']}",
            r.get("title", ""), source=r.get("channel", ""),
            published=r.get("published") or None, thumbnail=r.get("thumbnail", ""),
            is_video=True, duration_sec=parse_duration(r.get("length", "")),
            views=parse_views(r.get("views", "")), query=query,
        ))
    return items


# ── Twitter/X: search with media filter (needs valid cookies) ─────────────────
TWITTER_EXTRACT_JS = r"""
(maxResults) => {
  const out = [];
  const seen = new Set();
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  for (const tw of tweets) {
    if (out.length >= maxResults) break;
    const link = tw.querySelector('a[href*="/status/"]');
    const url = link ? link.href : '';
    if (!url || seen.has(url)) continue;
    const textEl = tw.querySelector('[data-testid="tweetText"]');
    const text = textEl ? (textEl.innerText || '').trim() : '';
    const userEl = tw.querySelector('[data-testid="User-Name"] a');
    const user = userEl ? (userEl.innerText || '').trim().split('\n')[0] : '';
    const hasVideo = !!tw.querySelector('video, [data-testid="videoPlayer"], [data-testid="previewInterstitial"]');
    const img = tw.querySelector('img[src*="media"], video');
    const thumb = img ? (img.getAttribute('poster') || img.src || '') : '';
    seen.add(url);
    out.push({url, text, user, hasVideo, thumb});
  }
  return out;
}
"""


def _twitter_login_wall(page) -> bool:
    """X redirects logged-out / low-trust sessions to an onboarding/login flow.
    Detect it so we can retry instead of silently returning 0 results."""
    cur = page.url
    return "/i/flow" in cur or "onboarding" in cur or "/login" in cur


def search_twitter(page, query, maxn, timeout_ms):
    # `filter:native_video` keeps only tweets with uploaded video — ideal for
    # cutaways. `f=live` = Latest tab (more SSR results for guest sessions).
    url = f"https://x.com/search?q={quote_plus(query + ' filter:native_video')}&src=typed_query&f=live"
    raw = []
    # X is flaky for logged-out sessions (no auth_token/ct0): a slow first paint
    # bounces to the login wall, a retry usually lands on guest-visible SSR tweets.
    for attempt in range(2):
        page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
        try:
            page.wait_for_selector('article[data-testid="tweet"]', timeout=min(timeout_ms, 10000))
        except Exception:
            pass
        if _twitter_login_wall(page):
            log(f'twitter "{query}": login wall (attempt {attempt + 1}) — '
                f'cookies.txt lacks auth_token/ct0' if attempt else
                f'twitter "{query}": login wall, retrying…')
            page.wait_for_timeout(1500)
            continue
        # Nudge lazy-loaded results into the DOM.
        page.wait_for_timeout(1200)
        try:
            page.mouse.wheel(0, 2400)
            page.wait_for_timeout(1000)
        except Exception:
            pass
        raw = page.evaluate(TWITTER_EXTRACT_JS, maxn)
        if raw:
            break
    return [norm("twitter", r["url"], r.get("text", "")[:80], snippet=r.get("text", ""),
                 source=r.get("user", ""), thumbnail=r.get("thumb", ""),
                 is_video=r.get("hasVideo", False), query=query) for r in raw if r.get("url")]


# ── TikTok: search/video page (heavy bot detection → prefer Scrapling) ─────────
TIKTOK_EXTRACT_JS = r"""
(maxResults) => {
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/video/"]');
  for (const a of anchors) {
    if (out.length >= maxResults) break;
    const url = a.href;
    if (!url || seen.has(url) || !/\/video\/\d+/.test(url)) continue;
    const container = a.closest('[data-e2e="search_top-item"], [class*="DivItemContainer"]') || a;
    const titleEl = container.querySelector('[data-e2e="search-card-desc"], [class*="DivDesc"], img[alt]');
    const title = titleEl ? (titleEl.innerText || titleEl.getAttribute('alt') || '').trim() : '';
    const img = container.querySelector('img');
    const thumb = img ? (img.src || '') : '';
    seen.add(url);
    out.push({url, title, thumb});
  }
  return out;
}
"""


def search_tiktok_playwright(page, query, maxn, timeout_ms):
    url = f"https://www.tiktok.com/search/video?q={quote_plus(query)}"
    page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
    try:
        page.wait_for_selector('a[href*="/video/"]', timeout=min(timeout_ms, 10000))
    except Exception:
        pass
    page.wait_for_timeout(2000)
    raw = page.evaluate(TIKTOK_EXTRACT_JS, maxn)
    return [norm("tiktok", r["url"], r.get("title", ""), thumbnail=r.get("thumb", ""),
                 is_video=True, query=query) for r in raw if r.get("url")]


# ── Instagram: hashtag explore (needs login cookies) ──────────────────────────
def search_instagram_playwright(page, query, maxn, timeout_ms):
    tag = re.sub(r"[^0-9a-zA-Z]", "", query.replace(" ", ""))
    if not tag:
        return []
    url = f"https://www.instagram.com/explore/tags/{tag}/"
    page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    raw = page.evaluate(r"""(maxResults) => {
      const out = []; const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
        if (out.length >= maxResults) break;
        const url = a.href; if (!url || seen.has(url)) continue;
        const img = a.querySelector('img');
        seen.add(url);
        out.push({url, title: img ? (img.getAttribute('alt')||'').slice(0,120) : '',
                  thumb: img ? img.src : '', isVideo: url.includes('/reel/')});
      }
      return out;
    }""", maxn)
    return [norm("instagram", r["url"], r.get("title", ""), thumbnail=r.get("thumb", ""),
                 is_video=r.get("isVideo", False), query=query) for r in raw if r.get("url")]


# ── Bing News (reuse the proven approach from news_search) ─────────────────────
def search_news(page, query, maxn, region, lang, timeout_ms):
    url = (f"https://www.bing.com/news/search?q={quote_plus(query)}"
           f"&setlang={lang}&cc={region}")
    page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("div.news-card, div.newsitem, article", timeout=min(timeout_ms, 8000))
    except Exception:
        pass
    raw = page.evaluate(r"""(maxResults) => {
      const out = []; const seen = new Set();
      let cards = [];
      for (const sel of ['div.news-card','div.newsitem','article','div[data-newsid]']) {
        const f = Array.from(document.querySelectorAll(sel)); if (f.length) { cards = f; break; }
      }
      for (const c of cards) {
        if (out.length >= maxResults) break;
        let url = c.getAttribute('data-url') || '';
        if (!url) { const a = c.querySelector('a[href^="http"]'); url = a ? a.href : ''; }
        if (!url || seen.has(url)) continue;
        const tEl = c.querySelector('a.title, [class*="title"] a, h3 a, a');
        const title = tEl ? (tEl.innerText||'').trim() : ''; if (title.length < 5) continue;
        const sEl = c.querySelector('.snippet, [class*="snippet"], p');
        const snippet = sEl ? (sEl.innerText||'').trim() : '';
        const srcEl = c.querySelector('.source, cite, [class*="provider"]');
        const source = srcEl ? (srcEl.innerText||'').trim().split('\n')[0] : '';
        seen.add(url);
        out.push({url, title, snippet, source});
      }
      return out;
    }""", maxn)
    return [norm("news", r["url"], r.get("title", ""), snippet=r.get("snippet", ""),
                 source=r.get("source", ""), is_video=False, query=query)
            for r in raw if r.get("url", "").startswith("http")]


# ── Scrapling StealthyFetcher path for hard platforms (optional) ──────────────
def scrapling_available():
    try:
        import scrapling  # noqa: F401
        return True
    except Exception:
        return False


def _scrapling_cookies(path):
    """Netscape cookies → Scrapling/Playwright cookie dicts (reuses the loader)."""
    return load_netscape_cookies(path)


def search_with_scrapling(platform, query, maxn, timeout_s, cookies_path=""):
    """Use Scrapling StealthyFetcher (Camoufox, undetected) to fetch a search page
    and parse it with resilient CSS selectors. Returns [] on any failure so the
    caller can fall back to Playwright. API matches Scrapling 0.4.x."""
    try:
        from scrapling.fetchers import StealthyFetcher
    except Exception as e:
        log(f"scrapling import failed: {e}")
        return []
    try:
        if platform == "tiktok":
            url = f"https://www.tiktok.com/search/video?q={quote_plus(query)}"
            sels = ['a[href*="/video/"]']
            base = "https://www.tiktok.com"
        elif platform == "instagram":
            tag = re.sub(r"[^0-9a-zA-Z]", "", query.replace(" ", ""))
            if not tag:
                return []
            url = f"https://www.instagram.com/explore/tags/{tag}/"
            sels = ['a[href*="/reel/"]', 'a[href*="/p/"]']
            base = "https://www.instagram.com"
        else:
            return []

        cookies = _scrapling_cookies(cookies_path)
        page = StealthyFetcher.fetch(
            url,
            headless=True,
            network_idle=True,
            timeout=timeout_s * 1000,
            wait_selector=sels[0],
            cookies=cookies or None,
            block_ads=True,
            selector_config={"adaptive": True},   # enable layout-change resilience
        )

        items, seen = [], set()
        for sel in sels:                       # multiple selector fallbacks
            try:
                # adaptive=True relocates the element if TikTok/IG changed layout
                found = page.css(sel, adaptive=True, auto_save=True)
            except Exception:
                found = page.css(sel)
            for a in found:
                if len(items) >= maxn:
                    break
                href = a.attrib.get("href", "") if hasattr(a, "attrib") else ""
                if not href:
                    continue
                if href.startswith("/"):
                    href = base + href
                if href in seen or "/video/" not in href and "/reel/" not in href and "/p/" not in href:
                    continue
                seen.add(href)
                is_video = ("/video/" in href) or ("/reel/" in href)
                # Pull a caption so relevance is verifiable + feedable to the LLM.
                # TikTok cover <img alt> and IG post <img alt> both carry the
                # description; aria-label/title are fallbacks.
                cap = ""
                try:
                    imgs = a.css("img")
                    if imgs:
                        cap = (imgs[0].attrib.get("alt", "") or "").strip()
                except Exception:
                    pass
                if not cap and hasattr(a, "attrib"):
                    cap = (a.attrib.get("aria-label", "") or a.attrib.get("title", "") or "").strip()
                items.append(norm(platform, href, cap[:120], snippet=cap, is_video=is_video, query=query))
            if items:
                break
        log(f'scrapling {platform} "{query}": {len(items)} result(s)')
        return items
    except Exception as e:
        log(f"scrapling {platform} failed: {e}")
        return []


# ── TikTok caption verification (oEmbed) ──────────────────────────────────────
def fetch_tiktok_oembed(url: str, timeout_s: int = 10):
    """TikTok's public oEmbed endpoint — no auth — returns the video caption
    (`title`), author and thumbnail. Lets us VERIFY relevance for TikTok results
    whose search-page cards expose no alt text."""
    import urllib.request
    api = "https://www.tiktok.com/oembed?url=" + quote_plus(url)
    req = urllib.request.Request(api, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def enrich_tiktok_captions(results, timeout_s: int = 10):
    """Fill caption/author/thumbnail for TikTok results that arrived without text,
    so the relevance filter can judge them. Best-effort + parallel; failures leave
    the result untouched (it stays `unverified`)."""
    targets = [r for r in results
               if r.get("platform") == "tiktok" and not r.get("title", "").strip()]
    if not targets:
        return results
    from concurrent.futures import ThreadPoolExecutor, as_completed
    n = 0
    with ThreadPoolExecutor(max_workers=min(6, len(targets))) as ex:
        futs = {ex.submit(fetch_tiktok_oembed, r["url"], timeout_s): r for r in targets}
        for fut in as_completed(futs):
            r = futs[fut]
            try:
                d = fut.result()
            except Exception as e:
                log(f'tiktok oembed failed [{r["url"][-19:]}]: {e}')
                continue
            cap = (d.get("title") or "").strip()
            if cap:
                r["title"] = cap[:120]
                r["snippet"] = cap
                n += 1
            if not r.get("source"):
                r["source"] = d.get("author_name") or d.get("author_unique_id") or ""
            if not r.get("thumbnail"):
                r["thumbnail"] = d.get("thumbnail_url") or ""
    if n:
        log(f"tiktok oembed: enriched {n}/{len(targets)} caption(s)")
    return results


def finalize_and_emit(results, args):
    """Verify TikTok captions, drop off-topic results, then emit."""
    results = enrich_tiktok_captions(results, max(args.timeout, 8))
    if not args.no_relevance_filter:
        results = apply_relevance_filter(results, drop_unverified=args.drop_unverified)
    emit(results)


# ── Orchestration ─────────────────────────────────────────────────────────────
def main():
    args = parse_args()
    queries = [q for q in args.query if q and q.strip()]
    platforms = [p.strip().lower() for p in args.platforms.split(",") if p.strip()]
    platforms = [p for p in platforms if p in ALL_PLATFORMS]
    if not queries or not platforms:
        emit([], error="no queries or platforms provided", code=2)

    timeout_ms = max(args.timeout, 5) * 1000
    use_scrapling = args.engine in ("scrapling", "auto") and scrapling_available()
    if args.engine == "scrapling" and not use_scrapling:
        log("scrapling requested but not installed — falling back to playwright")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        emit([], error="playwright not installed", code=3)

    results = []

    # Hard platforms via Scrapling first (if enabled)
    pw_platforms = list(platforms)
    if use_scrapling:
        for plat in [p for p in platforms if p in HARD_PLATFORMS]:
            for q in queries:
                got = search_with_scrapling(plat, q, args.max, args.timeout, args.cookies)
                if got:
                    results.extend(got)
                    # if scrapling produced results, skip the playwright pass for this plat
                    if plat in pw_platforms:
                        pw_platforms.remove(plat)

    # Everything else (and scrapling fallbacks) via Playwright.
    # Skip launching the browser entirely if Scrapling already covered everything.
    if not pw_platforms:
        finalize_and_emit(results, args)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            )
            context = browser.new_context(
                user_agent=UA, locale=f"{args.lang}-{args.region}",
                viewport={"width": 1366, "height": 900},
            )
            context.add_init_script(STEALTH_JS)
            cookies = load_netscape_cookies(args.cookies)
            if cookies:
                context.add_cookies(cookies)
                log(f"injected {len(cookies)} cookies")
            page = context.new_page()

            handlers = {
                "youtube":   lambda q: search_youtube(page, q, args.max, args.region, args.lang, timeout_ms),
                "twitter":   lambda q: search_twitter(page, q, args.max, timeout_ms),
                "tiktok":    lambda q: search_tiktok_playwright(page, q, args.max, timeout_ms),
                "instagram": lambda q: search_instagram_playwright(page, q, args.max, timeout_ms),
                "news":      lambda q: search_news(page, q, args.max, args.region, args.lang, timeout_ms),
            }
            for plat in pw_platforms:
                for q in queries:
                    try:
                        got = handlers[plat](q)
                        log(f'{plat} "{q}": {len(got)} result(s)')
                        results.extend(got)
                    except Exception as e:
                        log(f'{plat} "{q}" failed: {e}')
            browser.close()
    except Exception as e:
        emit(results, error=f"browser error: {e}", code=1)

    finalize_and_emit(results, args)


if __name__ == "__main__":
    main()
