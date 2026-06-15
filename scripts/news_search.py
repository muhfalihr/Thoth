#!/usr/bin/env python3
"""Thoth news search — Playwright backend (Stage 4).

Searches the internet for one or more queries and prints a JSON envelope to
stdout that the Rust `news` module consumes:

    {"results": [
        {"title": ..., "url": ..., "source": ..., "snippet": ..., "published": ..., "query": ...},
        ...
    ]}

On failure it still prints a JSON envelope with an "error" field and exits
non-zero so the Rust side can log the reason and gracefully degrade (no news
for that moment) without crashing the pipeline.

A single browser session is reused across all --query values for efficiency.

Usage:
    python news_search.py --query "kw1" --query "kw2" \
        --region ID --lang id --max 5 --timeout 20

Requirements:
    pip install playwright
    python -m playwright install chromium
"""

import argparse
import json
import sys
from urllib.parse import quote_plus, urlparse, parse_qs, unquote

# Force UTF-8 stdout/stderr so Windows cp1252 doesn't choke on non-ASCII output.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def log(msg: str) -> None:
    """Diagnostics go to stderr so stdout stays pure JSON."""
    print(f"[news_search] {msg}", file=sys.stderr, flush=True)


def emit(results, error=None, code=0):
    """Print the JSON envelope and exit."""
    payload = {"results": results}
    if error:
        payload["error"] = error
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def parse_args():
    p = argparse.ArgumentParser(description="Thoth Playwright news search")
    p.add_argument("--query", action="append", default=[], help="search query (repeatable)")
    p.add_argument("--region", default="ID", help="country code, e.g. ID")
    p.add_argument("--lang", default="id", help="UI language code, e.g. id")
    p.add_argument("--max", type=int, default=5, help="max results per query")
    p.add_argument("--timeout", type=int, default=20, help="per-query timeout in seconds")
    p.add_argument("--engine", default="bing", choices=["bing", "google"], help="search engine")
    p.add_argument("--cookies", default="", help="path to Netscape cookies.txt file")
    return p.parse_args()


def load_netscape_cookies(path: str) -> list:
    """Parse Netscape/Mozilla cookies.txt → list of Playwright cookie dicts."""
    if not path:
        return []
    from pathlib import Path as _Path
    if not _Path(path).exists():
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
                domain, include_sub, cpath, secure, expires, name, value = parts[:7]
                try:
                    exp = int(expires)
                except ValueError:
                    exp = -1
                cookies.append({
                    "name": name, "value": value, "domain": domain,
                    "path": cpath, "expires": exp,
                    "secure": secure.upper() == "TRUE",
                    "httpOnly": False, "sameSite": "Lax",
                })
    except Exception as e:
        log(f"cookies parse error: {e}")
    return cookies


def clean_bing_url(href: str) -> str:
    """Bing sometimes wraps outbound links; unwrap the real target when present."""
    if not href:
        return ""
    try:
        parsed = urlparse(href)
        if "bing.com" in parsed.netloc and parsed.path.startswith("/news/apiclick"):
            qs = parse_qs(parsed.query)
            if "url" in qs and qs["url"]:
                return unquote(qs["url"][0])
    except Exception:
        pass
    return href


# JS that scrapes Bing News result cards. Returns a list of dicts. Defensive:
# multiple selector fallbacks because Bing rotates layouts.
BING_EXTRACT_JS = r"""
(maxResults) => {
  const out = [];
  const seen = new Set();

  // Bing News uses several card layouts — try all known selectors
  const cardSelectors = [
    'div.news-card', 'div.newsitem', '.news-card-body',
    'div[class*="newscard"]', 'div[data-newsid]',
    'article', 'li.b_ans div[class*="news"]'
  ];
  let cards = [];
  for (const sel of cardSelectors) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length > 0) { cards = found; break; }
  }

  for (const card of cards) {
    if (out.length >= maxResults) break;

    // ── URL ──────────────────────────────────────────────────────────────────
    let url = card.getAttribute('data-url') || card.getAttribute('data-newsid') || '';
    if (!url) {
      const a = card.querySelector('a[href^="http"], a[href^="/"]');
      url = a ? (a.href || a.getAttribute('href') || '') : '';
    }
    if (!url || seen.has(url)) continue;

    // ── Title ────────────────────────────────────────────────────────────────
    const titleEl = card.querySelector(
      'a.title, a.news-card-title, [class*="title"] a, h3 a, h4 a, a[class*="heading"]'
    ) || card.querySelector('a');
    const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';
    if (!title || title.length < 5) continue;

    // ── Snippet ──────────────────────────────────────────────────────────────
    const snippetEl = card.querySelector(
      '.snippet, [class*="snippet"], [class*="description"], [class*="abstract"], p'
    );
    const snippet = snippetEl ? (snippetEl.innerText || '').trim().substring(0, 300) : '';

    // ── Source + Published ────────────────────────────────────────────────────
    // Bing sometimes puts "Source  •  11 jam" in the same element.
    const srcEl = card.querySelector(
      '.source a, .source, cite, [class*="provider"], [class*="source"], [class*="publisher"]'
    );
    let source = '';
    let published = '';
    if (srcEl) {
      const raw = (srcEl.innerText || srcEl.textContent || '').trim().split('\n')[0];
      // Split on middle-dot or pipe
      const parts = raw.split(/\s*[·•|]\s*/);
      source = parts[0].trim();
      if (parts.length > 1) {
        published = parts.slice(1).join(' ').trim();
      } else {
        // Bing appends time directly: "Bisnis20j" → source="Bisnis" published="20j"
        const m = raw.match(/^(.*?)(\d+\s*[mhjd]\w*)$/i);
        if (m) { source = m[1].trim(); published = m[2].trim(); }
      }
    }
    if (!published) {
      const timeEl = card.querySelector('span[aria-label], time, [class*="time"], [class*="date"]');
      if (timeEl) {
        published = (timeEl.getAttribute('aria-label') || timeEl.getAttribute('datetime') || timeEl.innerText || '').trim();
      }
    }

    seen.add(url);
    out.push({ title, url, snippet, source, published });
  }
  return out;
}
"""


def search_bing(page, query, region, lang, maxn, timeout_ms):
    url = (
        f"https://www.bing.com/news/search?q={quote_plus(query)}"
        f"&setlang={lang}&cc={region}&qft=interval%3d%227%22"
    )
    page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("div.news-card, div.newsitem", timeout=min(timeout_ms, 8000))
    except Exception:
        pass  # extract whatever rendered
    raw = page.evaluate(BING_EXTRACT_JS, maxn)
    items = []
    for r in raw:
        u = clean_bing_url(r.get("url", ""))
        if not u or not u.startswith("http"):
            continue
        items.append({
            "title": r.get("title", ""),
            "url": u,
            "snippet": r.get("snippet", ""),
            "source": r.get("source", ""),
            "published": r.get("published") or None,
            "query": query,
        })
    return items


GOOGLE_EXTRACT_JS = r"""
(maxResults) => {
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href^="http"]');
  for (const a of anchors) {
    if (out.length >= maxResults) break;
    const href = a.href;
    if (!href || seen.has(href)) continue;
    if (href.includes('google.com') || href.includes('gstatic.com')) continue;
    const h = a.querySelector('div[role="heading"], h3, .n0jPhd');
    if (!h) continue;
    const title = (h.innerText || '').trim();
    if (!title || title.length < 10) continue;
    seen.add(href);
    out.push({title, url: href, snippet: '', source: '', published: ''});
  }
  return out;
}
"""


def search_google(page, query, region, lang, maxn, timeout_ms):
    url = (
        f"https://www.google.com/search?q={quote_plus(query)}"
        f"&tbm=nws&hl={lang}&gl={region}"
    )
    page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
    # Best-effort consent dismissal
    for sel in ['button:has-text("Accept all")', 'button:has-text("Terima semua")',
                'button[aria-label*="Accept"]', '#L2AGLb']:
        try:
            btn = page.query_selector(sel)
            if btn:
                btn.click(timeout=2000)
                page.wait_for_timeout(500)
                break
        except Exception:
            continue
    raw = page.evaluate(GOOGLE_EXTRACT_JS, maxn)
    return [{
        "title": r.get("title", ""),
        "url": r.get("url", ""),
        "snippet": r.get("snippet", ""),
        "source": r.get("source", ""),
        "published": r.get("published") or None,
        "query": query,
    } for r in raw if r.get("url", "").startswith("http")]


def main():
    args = parse_args()
    queries = [q for q in args.query if q and q.strip()]
    if not queries:
        emit([], error="no queries provided", code=2)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        emit([], error="playwright not installed (pip install playwright && python -m playwright install chromium)", code=3)

    timeout_ms = max(args.timeout, 5) * 1000
    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )

    results = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
            context = browser.new_context(
                user_agent=ua,
                locale=f"{args.lang}-{args.region}",
                viewport={"width": 1280, "height": 900},
            )
            cookies = load_netscape_cookies(args.cookies)
            if cookies:
                context.add_cookies(cookies)
                log(f"injected {len(cookies)} cookies")
            page = context.new_page()
            for q in queries:
                try:
                    if args.engine == "google":
                        items = search_google(page, q, args.region, args.lang, args.max, timeout_ms)
                    else:
                        items = search_bing(page, q, args.region, args.lang, args.max, timeout_ms)
                        if not items:  # fallback to Google if Bing returned nothing
                            items = search_google(page, q, args.region, args.lang, args.max, timeout_ms)
                    log(f'query "{q}": {len(items)} result(s)')
                    results.extend(items)
                except Exception as e:  # one query failing must not abort the rest
                    log(f'query "{q}" failed: {e}')
            browser.close()
    except Exception as e:
        emit(results, error=f"browser error: {e}", code=1)

    emit(results)


if __name__ == "__main__":
    main()
