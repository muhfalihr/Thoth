#!/usr/bin/env python3
"""Verify a GENERATED narration against the proven `narration_structures` corpus.

Closes the loop: after CLIPPER writes a narration (narrator-driven spine), this
checks whether the resulting script actually FOLLOWS the structures that work —
strong hook format, a real beat arc, a strong punchline, debate-inviting close —
and FLAGS the anti-patterns the corpus warns about (moral preaching, weak/empty
punchline, alay closers, formal/news words). Prints a PASS/WARN/FAIL report with
concrete fixes pulled from the nearest reference structures.

Sources of the generated narration (pick one):
    --text "naskah..."                       analyze raw text
    --narration-file path.txt                a saved narration script
    --job-dir output/.clipper/<job_id>       reads narration/narration.txt
                                             (falls back to narration_words.json)
    --latest                                 newest job under ./output/.clipper

Examples:
    python scripts/verify_narration_structure.py --latest
    python scripts/verify_narration_structure.py --job-dir output/.clipper/abc123
    python scripts/verify_narration_structure.py --text "Bisa-bisanya ..." --hook "..."
    python scripts/verify_narration_structure.py --latest --json report.json

Reuses creds + LLM/DB helpers from analyze_narration_structure.py (same Supabase,
same Novita provider). No DB writes — analysis only.
"""
import argparse
import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Reuse the corpus analyzer's helpers (same dir).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze_narration_structure as ana  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# Hook formats considered "scroll-stopping" (present in the corpus / rage-bait DNA).
STRONG_HOOK_FORMATS = {
    "expectation_vs_reality", "konflik_langsung", "pernyataan_gila",
    "ranking_list", "niat_vs_realita", "klaim_bombastis",
    "kutipan_kontroversial", "misteri", "statistik",
}
WEAK_HOOK_FORMATS = {"sapaan", "other", ""}
# Closings the corpus flags as anti-patterns (kill the rage-bait).
BAD_CLOSINGS = {"nasihat_moral", "sapaan_alay"}


def log(m=""):
    print(m, flush=True)


# ──────────────────────────────────────────────────────────────────────────────
# Locate the generated narration text
# ──────────────────────────────────────────────────────────────────────────────
def text_from_job_dir(job_dir: Path) -> tuple[str, str]:
    """Return (narration_text, hook). Reads narration.txt or reconstructs from words."""
    ndir = job_dir / "narration"
    if not ndir.exists() and (job_dir.name == "narration"):
        ndir = job_dir
    hook = ""
    hp = ndir / "hook.txt"
    if hp.exists():
        hook = hp.read_text(encoding="utf-8", errors="replace").strip()
    txt = ndir / "narration.txt"
    if txt.exists():
        return txt.read_text(encoding="utf-8", errors="replace").strip(), hook
    # Fallback: reconstruct from word timings (older jobs without narration.txt).
    wj = ndir / "narration_words.json"
    if wj.exists():
        try:
            words = json.loads(wj.read_text(encoding="utf-8", errors="replace"))
            parts = [w.get("word") or w.get("text") or "" for w in words]
            return " ".join(p for p in parts if p).strip(), hook
        except Exception:
            pass
    return "", hook


def find_latest_job() -> Path | None:
    base = ROOT / "output" / ".clipper"
    if not base.exists():
        return None
    jobs = [p for p in base.iterdir() if p.is_dir() and (p / "narration").exists()]
    if not jobs:
        return None
    return max(jobs, key=lambda p: (p / "narration").stat().st_mtime)


# ──────────────────────────────────────────────────────────────────────────────
# Corpus norms + nearest references
# ──────────────────────────────────────────────────────────────────────────────
def corpus_norms(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT count(*), round(avg(quality_score)::numeric,1),
                   min(beat_count), round(avg(beat_count)::numeric,1), max(beat_count)
            FROM narration_structures WHERE quality_score >= 6
        """)
        n, avg_q, bmin, bavg, bmax = cur.fetchone()
        cur.execute("""
            SELECT hook_format, count(*) FROM narration_structures
            WHERE hook_format IS NOT NULL AND hook_format <> ''
            GROUP BY hook_format ORDER BY 2 DESC
        """)
        hooks = cur.fetchall()
        cur.execute("""
            SELECT narration_style, count(*) FROM narration_structures
            WHERE narration_style IS NOT NULL GROUP BY 1 ORDER BY 2 DESC
        """)
        styles = cur.fetchall()
    return {
        "n": n or 0, "avg_q": float(avg_q) if avg_q is not None else 0.0,
        "beat_min": bmin or 0, "beat_avg": float(bavg) if bavg else 0.0, "beat_max": bmax or 0,
        "hook_formats": {h: c for h, c in hooks},
        "styles": {s: c for s, c in styles},
    }


def nearest_refs(conn, embedding, limit=3):
    if not embedding:
        return []
    lit = "[" + ",".join(f"{float(x):.6f}" for x in embedding) + "]"
    with conn.cursor() as cur:
        cur.execute("""
            SELECT narration_style, hook_format, arc_template, quality_score,
                   analysis->>'lessons_for_generation',
                   CAST(1.0-(embedding <=> %s::halfvec) AS FLOAT8)
            FROM narration_structures WHERE embedding IS NOT NULL
            ORDER BY embedding <=> %s::halfvec LIMIT %s
        """, (lit, lit, limit))
        rows = cur.fetchall()
    out = []
    for style, hf, arc, q, lessons, sim in rows:
        try:
            lessons = json.loads(lessons) if lessons else []
        except Exception:
            lessons = []
        out.append({"style": style, "hook_format": hf, "arc": arc or [],
                    "quality": q, "lessons": lessons, "sim": sim})
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Conformance scoring
# ──────────────────────────────────────────────────────────────────────────────
def _g(d, *keys, default=None):
    cur = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


def check(name, status, detail, fix=""):
    return {"name": name, "status": status, "detail": detail, "fix": fix}


def evaluate(analysis: dict, norms: dict) -> list:
    """Return a list of checks: status in {PASS, WARN, FAIL}."""
    checks = []
    corpus_hooks = set(norms.get("hook_formats", {}).keys()) | STRONG_HOOK_FORMATS

    # 1. Hook format
    hf = (_g(analysis, "hook", "format") or "").strip()
    if hf in WEAK_HOOK_FORMATS or hf == "":
        checks.append(check("Hook format", "FAIL",
                            f"hook='{hf or 'none'}' — bukan pola penahan-scroll",
                            "Buka dgn expectation_vs_reality / konflik_langsung / pernyataan_gila."))
    elif hf in corpus_hooks:
        checks.append(check("Hook format", "PASS", f"hook='{hf}' (selaras korpus)"))
    else:
        checks.append(check("Hook format", "WARN", f"hook='{hf}' (tidak umum di korpus)"))

    # 2. Moral preaching (corpus's #1 anti-pattern)
    if _g(analysis, "closing", "has_moral_preaching") is True:
        checks.append(check("No moral preaching", "FAIL",
                            "penutup mengandung nasihat/moral",
                            "Buang nasihat. Tutup dgn pertanyaan memancing atau fakta menohok."))
    else:
        checks.append(check("No moral preaching", "PASS", "tidak ada ceramah moral"))

    # 3. Closing type
    ct = (_g(analysis, "closing", "type") or "").strip()
    if ct in BAD_CLOSINGS:
        checks.append(check("Closing type", "FAIL", f"closing='{ct}' (anti-pattern)",
                            "Ganti ke pertanyaan_memancing atau fakta_bicara_sendiri."))
    elif ct:
        checks.append(check("Closing type", "PASS", f"closing='{ct}'"))
    else:
        checks.append(check("Closing type", "WARN", "closing type tidak terdeteksi"))

    # 4. Invites debate
    if _g(analysis, "closing", "invites_debate") is True or ct == "fakta_bicara_sendiri":
        checks.append(check("Debate hook", "PASS", "penutup memancing debat/komentar"))
    else:
        checks.append(check("Debate hook", "WARN", "penutup kurang memancing debat",
                            "Akhiri dgn 'Menurut kalian wajar ga?' atau biarkan fakta bicara."))

    # 5. Punchline strength
    ps = (_g(analysis, "punchline", "strength") or "").strip().lower()
    if ps == "weak":
        checks.append(check("Punchline", "FAIL", "punchline lemah (mis. 'Yeah')",
                            "Tutup dgn kicker tajam: callback / meme reference / pertanyaan."))
    elif ps in ("strong", "medium"):
        checks.append(check("Punchline", "PASS", f"punchline {ps}"))
    else:
        checks.append(check("Punchline", "WARN", "kekuatan punchline tidak terdeteksi"))

    # 6. Beat arc depth
    beats = analysis.get("beats") if isinstance(analysis.get("beats"), list) else []
    bc = len(beats)
    bmin = max(4, int(norms.get("beat_min") or 4))
    if bc == 0:
        checks.append(check("Beat arc", "WARN", "beats tidak terdeteksi"))
    elif bc < 4:
        checks.append(check("Beat arc", "FAIL", f"{bc} babak — arc terlalu dangkal",
                            "Bangun arc: hook → setup → konteks → insiden → reaksi → punchline."))
    else:
        labels = [str(b.get("label", "")).upper() for b in beats]
        has_hook = any("HOOK" in x for x in labels)
        has_end = any(k in x for x in labels for k in ("PUNCHLINE", "KICKER", "PENUTUP"))
        if has_hook and has_end:
            checks.append(check("Beat arc", "PASS",
                                f"{bc} babak, ada HOOK + penutup (korpus avg {norms.get('beat_avg')})"))
        else:
            checks.append(check("Beat arc", "WARN",
                                f"{bc} babak tapi {'tanpa HOOK' if not has_hook else 'tanpa penutup tegas'}"))

    # 7. Formal/news words (should be ~none for this style)
    fw = analysis.get("formal_word_hits") or []
    if isinstance(fw, list) and len(fw) >= 2:
        checks.append(check("No formal words", "WARN",
                            f"{len(fw)} kata formal/berita: {', '.join(map(str, fw[:5]))}",
                            "Hindari 'merupakan/tersebut/beliau/adapun'."))
    else:
        checks.append(check("No formal words", "PASS", "bahasa tidak kaku/formal"))

    # 8. Pacing (words per second), if present
    wps = analysis.get("words_per_second")
    try:
        wps = float(wps)
        if 2.0 <= wps <= 3.8:
            checks.append(check("Pacing", "PASS", f"{wps:.1f} kata/detik"))
        else:
            checks.append(check("Pacing", "WARN", f"{wps:.1f} kata/detik (ideal ~2.5-3.5)"))
    except (TypeError, ValueError):
        pass

    # 9. Style is one the corpus uses
    style = (analysis.get("narration_style") or "").strip()
    if style and style in norms.get("styles", {}):
        checks.append(check("Style", "PASS", f"style='{style}' (ada di korpus)"))
    elif style:
        checks.append(check("Style", "WARN", f"style='{style}' (tidak ada di korpus)"))

    return checks


def verdict(checks: list) -> tuple[str, float]:
    fails = sum(1 for c in checks if c["status"] == "FAIL")
    warns = sum(1 for c in checks if c["status"] == "WARN")
    passes = sum(1 for c in checks if c["status"] == "PASS")
    total = max(1, len(checks))
    score = round(10.0 * (passes + 0.5 * warns) / total, 1)
    if fails:
        return "FAIL", score
    if warns:
        return "WARN", score
    return "PASS", score


# ──────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Verify generated narration vs corpus")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--text")
    src.add_argument("--narration-file")
    src.add_argument("--job-dir")
    src.add_argument("--latest", action="store_true")
    ap.add_argument("--hook", default="")
    ap.add_argument("--language", default="id")
    ap.add_argument("--llm-model", default="")
    ap.add_argument("--json", help="write the full report JSON to this path")
    args = ap.parse_args()

    ana.load_env()
    cfg = ana.load_config()
    import os
    novita_key = os.environ.get("CLIPPER_NOVITA_API_KEY", "").strip()
    embed_key = os.environ.get("CLIPPER_EMBED_API_KEY", "").strip() or novita_key

    # ── Resolve narration text ────────────────────────────────────────────────
    hook = args.hook
    if args.text:
        text = args.text.strip()
    elif args.narration_file:
        text = Path(args.narration_file).read_text(encoding="utf-8", errors="replace").strip()
    else:
        job_dir = find_latest_job() if args.latest else Path(args.job_dir)
        if not job_dir or not job_dir.exists():
            log("✗ job dir not found (run a narration first, or pass --text)")
            return 2
        text, hk = text_from_job_dir(job_dir)
        hook = hook or hk
        log(f"• job: {job_dir}")
    if not text:
        log("✗ no narration text found to verify")
        return 2
    log(f"• narration: {len(text.split())} words"
        + (f' | hook: "{hook}"' if hook else ""))

    # ── Analyze the generated narration's structure (same schema as corpus) ───
    log("• analyzing generated narration structure (LLM)…")
    meta = {"title": "(narasi hasil CLIPPER)", "description": hook}
    try:
        analysis = ana.analyze_structure(
            text, meta, args.language,
            cfg["novita_base_url"], args.llm_model or cfg["novita_model"], novita_key,
        )
    except Exception as e:
        log(f"✗ analysis failed: {e}")
        return 1

    # ── Corpus norms + nearest references ─────────────────────────────────────
    norms, refs = {}, []
    try:
        conn = ana.db_connect()
        norms = corpus_norms(conn)
        emb = ana.embed_text(text[:4000], cfg["novita_base_url"], cfg["embed_model"], embed_key)
        refs = nearest_refs(conn, emb, 3)
        conn.close()
    except Exception as e:
        log(f"! corpus unavailable ({e}) — checking against built-in rage-bait rules only")

    # ── Evaluate ──────────────────────────────────────────────────────────────
    checks = evaluate(analysis, norms)
    status, score = verdict(checks)

    # ── Report ────────────────────────────────────────────────────────────────
    log("\n" + "=" * 64)
    log(f"  VERDICT: {status}   (conformance {score}/10)")
    if norms.get("n"):
        log(f"  corpus: {norms['n']} struktur · avg quality {norms['avg_q']} · "
            f"beats {norms['beat_min']}–{norms['beat_max']} (avg {norms['beat_avg']})")
    log("=" * 64)
    log(f"  style={analysis.get('narration_style')} "
        f"posture={analysis.get('narrator_posture')} "
        f"hook={_g(analysis,'hook','format')} "
        f"punchline={_g(analysis,'punchline','strength')} "
        f"self_quality={analysis.get('quality_score')}")
    arc = [str(b.get("label", "?")) for b in (analysis.get("beats") or [])]
    if arc:
        log("  arc: " + " → ".join(arc))
    log("")
    icon = {"PASS": "✓", "WARN": "▲", "FAIL": "✗"}
    for c in checks:
        log(f"  {icon.get(c['status'],'?')} {c['name']:18} {c['detail']}")
        if c["fix"] and c["status"] != "PASS":
            log(f"      ↳ fix: {c['fix']}")

    if refs:
        log("\n  Struktur referensi terdekat (target tiruan):")
        for i, r in enumerate(refs, 1):
            log(f"   {i}. sim={r['sim']:.2f} [{r['style']}/{r['hook_format']}] q={r['quality']}")
            if r["arc"]:
                log(f"      arc: {' → '.join(r['arc'])}")
            for les in (r["lessons"] or [])[:2]:
                log(f"      • {les}")

    if args.json:
        Path(args.json).write_text(json.dumps({
            "verdict": status, "score": score, "checks": checks,
            "analysis": analysis, "norms": norms, "nearest_refs": refs,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"\n  report → {args.json}")

    return 0 if status != "FAIL" else 3


if __name__ == "__main__":
    sys.exit(main())
