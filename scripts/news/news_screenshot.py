#!/usr/bin/env python3
"""Thoth news screenshot — Playwright backend (Phase 2).

Strategi screenshot yang dihasilkan:
  1. Network-level ad blocking (Playwright route intercept)
  2. DOM cleanup agresif: hapus header/nav/footer/sidebar/popup/iklan
  3. Screenshot element artikel secara langsung (bukan full viewport)
     → menghindari navbar, breadcrumb, dan elemen di luar artikel
  4. Fallback ke viewport screenshot jika element tidak ditemukan

Output JSON ke stdout:
    {"success": true, "path": "...", "title": "...", "lead": "...", "source": "..."}
    {"success": false, "error": "...", "path": null}

Usage:
    python news_screenshot.py --url URL --output PATH
        [--width 1200] [--timeout 25]
"""

import argparse
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ─── Ad / tracker domain blocklist ────────────────────────────────────────────
# Sumber: AdGuard Base + EasyList patterns yang paling umum di media Indonesia
_AD_DOMAINS = [
    # Google ad/tracking
    "doubleclick.net", "googlesyndication.com", "googleadservices.com",
    "googletagservices.com", "google-analytics.com", "adservice.google",
    # Major DSPs
    "adnxs.com", "amazon-adsystem.com", "criteo.com", "criteo.net",
    "taboola.com", "outbrain.com", "mgid.com", "revcontent.com",
    "rubiconproject.com", "openx.net", "pubmatic.com", "bidswitch.net",
    "smartadserver.com", "serving-sys.com", "appnexus.com",
    # Indonesian ad networks & trackers
    "adsterra.com", "propellerads.com", "popcash.net", "plugrush.com",
    "chitika.com", "infolinks.com", "mgid.com", "mediavine.com",
    # Analytics / trackers (bukan kebutuhan untuk konten artikel)
    "scorecardresearch.com", "quantserve.com", "hotjar.com",
    "moatads.com", "chartbeat.com", "parsely.com",
    "newrelic.com", "sentry.io", "segment.com",
    # Misc
    "zedo.com", "undertone.com", "tribalfusion.com", "yieldmanager.com",
    "casalemedia.com", "mathtag.com", "bounceexchange.com",
]

# URL path patterns yang sering dipakai iklan
_AD_URL_PATTERNS = [
    "/ads/", "/ad/", "/advertisement/", "/advert/",
    "/banner/", "/sponsor/", "/promo/",
    "?utm_", "&utm_",  # UTM params - still pass, just don't count as blocking
]

def _is_ad(url: str) -> bool:
    """Return True jika URL ini adalah request iklan/tracker yang harus diblok."""
    u = url.lower()
    return any(d in u for d in _AD_DOMAINS)

def _route_handler(route):
    if _is_ad(route.request.url):
        route.abort()
    else:
        route.continue_()


# ─── DOM cleanup JavaScript ────────────────────────────────────────────────────
# Dijalankan setelah halaman load. Menghapus semua elemen non-artikel.
_CLEANUP_JS = r"""
() => {
  // ── Struktural (header, nav, footer, sidebar) ─────────────────────────────
  const structural = [
    'header', 'nav', 'footer', 'aside',
    '#header', '#nav', '#footer', '#sidebar',
    '.header', '.nav', '.footer', '.sidebar',
    '[class*="header"]', '[class*="navbar"]', '[class*="navigation"]',
    '[class*="footer"]', '[class*="sidebar"]', '[class*="breadcrumb"]',
    '[class*="topbar"]', '[class*="top-bar"]', '[class*="sticky-bar"]',
    // Indonesian news sites specific
    '#sticky-header', '.site-header', '.site-footer',
    '.breaking-news', '.ticker', '.live-ticker',
    // Related / recommendations
    '[class*="related"]', '[class*="recommended"]', '[class*="terkait"]',
    '[class*="more-from"]', '[class*="popular"]', '[class*="trending"]',
    '[class*="baca-juga"]', '[class*="pilihan"]',
  ];

  // ── Iklan & promosi ────────────────────────────────────────────────────────
  const ads = [
    // Generic ad patterns
    '[class*=" ads"]', '[class*="ads "]', '[class*="ads-"]', '[class*="-ads"]',
    '[id*=" ads"]',    '[id*="ads-"]',    '[id*="-ads"]',
    '[class*="advert"]', '[class*="ad-slot"]', '[class*="ad_slot"]',
    '[class*="adbox"]', '[class*="ad-box"]', '[class*="adsense"]',
    '[class*="banner"]', '[class*="sponsored"]', '[class*="sponsor"]',
    '[class*="promo"]', '[class*="promotion"]',
    // Popup / overlay / modal
    '[class*="popup"]', '[class*="modal"]', '[class*="overlay"]',
    '[role="dialog"]', '[class*="dialog"]',
    // Cookie / consent / newsletter / paywall
    '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
    '[class*="newsletter"]', '[class*="subscribe"]', '[class*="subscription"]',
    '[class*="paywall"]', '[class*="metered"]',
    '.tp-modal', '#tp-backdrop', '.piano-modal',
    // Social share buttons (diluar artikel)
    '[class*="social-share"]', '[class*="share-button"]', '[class*="share-bar"]',
    // Comment section
    '[class*="comment"]', '[id*="comment"]', '#disqus_thread', '.disqus',
    // Tags / labels section
    '[class*="article-tags"]', '[class*="post-tags"]', '[class*="tag-list"]',
    // iframes (iklan, embed tracker)
    'iframe',
  ];

  const allSelectors = [...structural, ...ads];
  allSelectors.forEach(sel => {
    try {
      document.querySelectorAll(sel).forEach(el => el.remove());
    } catch (e) {}
  });

  // Fix overflow agar full element screenshot tidak terpotong
  document.body.style.overflow = 'visible';
  document.documentElement.style.overflow = 'visible';
  document.body.style.margin = '0';
  document.body.style.padding = '0';

  // Hapus fixed/sticky positioning yang bisa menutupi konten
  document.querySelectorAll('*').forEach(el => {
    const s = window.getComputedStyle(el);
    if (s.position === 'fixed' || s.position === 'sticky') {
      try { el.style.position = 'relative'; } catch(e) {}
    }
  });
}
"""

# ─── Article element selector chain ───────────────────────────────────────────
_ARTICLE_SELECTORS = [
    # Semantic
    'article',
    'main article',
    # Common class patterns (ordered by specificity)
    '[class*="article-body"]',
    '[class*="article-content"]',
    '[class*="article__body"]',
    '[class*="article__content"]',
    '[class*="post-content"]',
    '[class*="post-body"]',
    '[class*="story-body"]',
    '[class*="story-content"]',
    '[class*="news-content"]',
    '[class*="news-body"]',
    '[class*="entry-content"]',
    '[class*="content-body"]',
    # Indonesian news sites
    '[class*="detail-content"]',
    '[class*="berita-content"]',
    '[class*="isi-berita"]',
    '[class*="konten-artikel"]',
    # Fallback
    'main',
    '#content',
    '.content',
]

# ─── Metadata extraction JavaScript ───────────────────────────────────────────
_EXTRACT_JS = r"""
() => {
  // Title: h1 first, fallback to og:title meta
  const h1 = document.querySelector('h1');
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const title = h1 ? h1.innerText.trim()
                    : (ogTitle ? ogTitle.getAttribute('content') : document.title).trim();

  // Lead paragraph: first substantial <p> in the article area
  const articleEl = document.querySelector('article, main, [class*="article-body"], [class*="article-content"], [class*="post-content"], [class*="entry-content"]') || document.body;
  let lead = '';
  if (articleEl) {
    for (const p of articleEl.querySelectorAll('p')) {
      const t = (p.innerText || '').trim();
      if (t.length > 80 && !t.startsWith('http')) { lead = t.substring(0, 500); break; }
    }
  }

  // Source: og:site_name first, then domain
  const metaSite = document.querySelector('meta[property="og:site_name"]');
  const source = metaSite
    ? metaSite.getAttribute('content').trim()
    : location.hostname.replace(/^www\./, '');

  return { title, lead, source };
}
"""


def log(msg: str) -> None:
    print(f"[screenshot] {msg}", file=sys.stderr, flush=True)


def emit(success: bool, path=None, title="", lead="", source="", error="") -> None:
    d = {"success": success, "path": path, "title": title, "lead": lead, "source": source}
    if error:
        d["error"] = error
    print(json.dumps(d, ensure_ascii=False))
    sys.stdout.flush()


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--url",     required=True)
    p.add_argument("--output",  required=True)
    p.add_argument("--width",   type=int, default=1200)
    p.add_argument("--timeout", type=int, default=25)
    p.add_argument("--cookies", default="", help="path to Netscape cookies.txt file")
    return p.parse_args()


def load_netscape_cookies(path: str) -> list:
    """Parse Netscape/Mozilla cookies.txt format → list of Playwright cookie dicts."""
    if not path or not Path(path).exists():
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
                    "name":     name,
                    "value":    value,
                    "domain":   domain,          # keep leading dot as-is
                    "path":     cpath,
                    "expires":  exp,
                    "secure":   secure.upper() == "TRUE",
                    "httpOnly": False,
                    "sameSite": "Lax",
                })
    except Exception as e:
        log(f"cookies parse error (non-fatal): {e}")
    return cookies


def main():
    args = parse_args()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
    except ImportError:
        emit(False, error="playwright not installed — run: pip install playwright && python -m playwright install chromium")
        sys.exit(3)

    timeout_ms  = max(args.timeout, 5) * 1000
    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )

    title = lead = source = ""

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--disable-notifications",
                    "--disable-extensions",
                    "--hide-scrollbars",
                ],
            )
            context = browser.new_context(
                user_agent=ua,
                # Standard viewport — tall viewport bisa memicu CSS media query
                # yang berbeda pada beberapa site (Kumparan, dll).
                # Element screenshot Playwright bekerja tanpa tergantung tinggi viewport.
                viewport={"width": args.width, "height": 900},
                java_script_enabled=True,
            )

            # ── Block ad networks at network level ─────────────────────────────
            context.route("**/*", _route_handler)

            # ── Mask automation fingerprint ────────────────────────────────────
            # Beberapa site (Kumparan, dll) deteksi navigator.webdriver = true
            # dan serve versi berbeda / blank page untuk headless browser.
            context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
                Object.defineProperty(navigator, 'languages', {get: () => ['id-ID','id','en-US','en']});
                window.chrome = { runtime: {} };
            """)

            # ── Inject cookies (untuk bypass bot detection / login) ────────────
            cookies = load_netscape_cookies(args.cookies)
            if cookies:
                context.add_cookies(cookies)
                log(f"injected {len(cookies)} cookies from {args.cookies}")

            page = context.new_page()

            # ── Load page ──────────────────────────────────────────────────────
            log(f"loading {args.url}")
            try:
                # "load" menunggu semua script synchronous selesai dieksekusi.
                # Lebih reliable dari "networkidle" untuk React/Next.js karena
                # networkidle bisa timeout akibat polling/websocket yang tidak berhenti.
                page.goto(
                    args.url,
                    timeout=max(timeout_ms - 5000, 10000),
                    wait_until="load",
                )
                log("page load complete")
            except PwTimeout:
                log("load timeout — continuing with available DOM")
            except Exception as e:
                emit(False, error=f"navigation error: {e}")
                browser.close()
                return

            # Tunggu minimal satu <p> berisi teks di dalam area artikel.
            # Ini kritis untuk site React/Next.js (Kumparan, Detik, dll) yang
            # render konten setelah hydration — tanpa ini screenshot menangkap
            # skeleton/loading state yang kosong.
            _content_selectors = [
                "article p", "main article p",
                "[class*='article-body'] p", "[class*='article-content'] p",
                "[class*='post-content'] p", "[class*='entry-content'] p",
                "[class*='story-body'] p", "[class*='detail-content'] p",
                "main p",
            ]
            content_found = False
            for csel in _content_selectors:
                try:
                    page.wait_for_selector(csel, timeout=5000, state="visible")
                    content_found = True
                    log(f"article content visible (selector: {csel})")
                    break
                except Exception:
                    continue

            if not content_found:
                # Fallback: tunggu setidaknya ada h1 dan delay singkat
                try:
                    page.wait_for_selector("h1", timeout=3000, state="visible")
                except Exception:
                    pass
                log("content selector timeout — proceeding with available DOM")
                page.wait_for_timeout(2000)
            else:
                # Extra wait untuk React/Next.js hydration setelah konten DOM muncul.
                # CSS-in-JS (Emotion/Styled Components) diapply SETELAH hydration,
                # bukan saat HTML pertama kali di-parse.
                page.wait_for_timeout(2500)

            # ── Force lazy-loaded images (CSR/SSR sites) ───────────────────────
            # Banyak site Indonesia (Kumparan, Detik, Kompas) menggunakan lazy
            # loading via IntersectionObserver atau data-src. Kita trigger manual:
            try:
                page.evaluate(r"""
                () => {
                    // 1. Inject data-src → src untuk semua lazy images
                    document.querySelectorAll('img').forEach(img => {
                        const lazy = img.dataset.src || img.dataset.lazySrc
                                  || img.dataset.original || img.dataset.lazy
                                  || img.getAttribute('data-srcset');
                        if (lazy) {
                            img.src = lazy.split(',')[0].trim().split(' ')[0];
                            img.loading = 'eager';
                            img.removeAttribute('loading');
                        }
                        // Eager-load semua gambar
                        img.loading = 'eager';
                    });

                    // 2. Scroll artikel untuk trigger IntersectionObserver
                    const art = document.querySelector(
                        'article, main, [class*="article-body"], [class*="article-content"]'
                    ) || document.body;
                    const h = art.scrollHeight;
                    // Scroll bertahap 500px agar IO terpicu
                    for (let y = 0; y < Math.min(h, 5000); y += 500) {
                        window.scrollTo(0, y);
                    }
                    window.scrollTo(0, 0);  // kembali ke atas sebelum screenshot
                }
                """)
            except Exception as e:
                log(f"lazy-image trigger (non-fatal): {e}")

            # Beri waktu browser me-render gambar yang baru di-load
            page.wait_for_timeout(1200)

            # ── DOM cleanup: hapus semua non-artikel ───────────────────────────
            # Dijalankan SETELAH konten ter-render sehingga tidak menghapus
            # elemen yang belum ada saat domcontentloaded.
            try:
                page.evaluate(_CLEANUP_JS)
                page.wait_for_timeout(300)
            except Exception as e:
                log(f"cleanup JS (non-fatal): {e}")

            # ── Extract metadata sebelum screenshot ────────────────────────────
            try:
                meta = page.evaluate(_EXTRACT_JS)
                title  = meta.get("title", "")
                lead   = meta.get("lead", "")
                source = meta.get("source", "")
            except Exception as e:
                log(f"metadata extraction (non-fatal): {e}")

            # ── Screenshot: cari article element, gunakan page clip ────────────
            # Menggunakan page.screenshot(clip=...) bukan el.screenshot() agar
            # full CSS cascade (termasuk CSS parent) diterapkan saat render.
            # El.screenshot() di beberapa site CSR tidak menerapkan parent styles.
            screenshot_taken = False
            for sel in _ARTICLE_SELECTORS:
                try:
                    el = page.query_selector(sel)
                    if not el or not el.is_visible():
                        continue
                    box = el.bounding_box()
                    if not box or box["width"] < 200 or box["height"] < 200:
                        continue

                    # Scroll element ke posisi atas viewport agar terlihat penuh
                    page.evaluate(
                        "(el) => el.scrollIntoView({block: 'start', behavior: 'instant'})",
                        el,
                    )
                    page.wait_for_timeout(400)  # beri waktu reflow

                    # Ambil bounding box setelah scroll (posisi bisa berubah)
                    box = el.bounding_box()
                    if not box:
                        continue

                    log(f"screenshotting '{sel}' via page clip ({int(box['width'])}×{int(box['height'])})")

                    # Clamp koordinat agar tidak keluar dari canvas halaman
                    cx = max(0.0, box["x"])
                    cy = max(0.0, box["y"])
                    cw = max(1.0, box["width"])
                    ch = min(box["height"], 6000.0)

                    page.screenshot(
                        path=str(output_path),
                        type="png",
                        clip={"x": cx, "y": cy, "width": cw, "height": ch},
                    )

                    # Verifikasi ukuran file — jika terlalu kecil (<30KB untuk
                    # artikel) kemungkinan konten belum render; coba fallback
                    file_kb = output_path.stat().st_size / 1024
                    if file_kb < 30:
                        log(f"  result {file_kb:.0f}KB — suspiciously small, trying full-page crop")
                        # Fallback: full-page screenshot lalu crop ke area artikel
                        fp_path = output_path.with_suffix(".fullpage.png")
                        page.evaluate("() => window.scrollTo(0, 0)")
                        page.wait_for_timeout(300)
                        page.screenshot(path=str(fp_path), type="png", full_page=True)
                        fp_kb = fp_path.stat().st_size / 1024
                        log(f"  full-page: {fp_kb:.0f}KB")
                        if fp_kb > file_kb * 3:
                            # Full-page lebih berisi — crop ke area artikel dari atas
                            import shutil
                            shutil.move(str(fp_path), str(output_path))
                            log(f"  using full-page screenshot")
                        else:
                            try: fp_path.unlink()
                            except: pass

                    screenshot_taken = True
                    log(f"saved → {output_path} ({output_path.stat().st_size//1024}KB)")
                    break

                except Exception as e:
                    log(f"screenshot '{sel}' failed: {e}")
                    continue

            # ── Fallback: viewport screenshot (scroll ke h1 dulu) ──────────────
            if not screenshot_taken:
                log("no article element found — viewport fallback")
                try:
                    page.evaluate("() => { const h = document.querySelector('h1'); if (h) h.scrollIntoView({block:'start'}); }")
                    page.wait_for_timeout(300)
                    page.screenshot(path=str(output_path), full_page=False, type="png")
                    log(f"viewport screenshot → {output_path}")
                except Exception as e:
                    emit(False, error=f"screenshot failed: {e}")
                    browser.close()
                    return

            browser.close()

    except Exception as e:
        emit(False, error=f"browser error: {e}")
        return

    emit(True, path=str(output_path), title=title, lead=lead, source=source)


if __name__ == "__main__":
    main()
