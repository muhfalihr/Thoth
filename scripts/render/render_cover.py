#!/usr/bin/env python3
"""Render a viral AI cover/thumbnail as a full-screen PNG (Thoth intro cover).

Composites, in order:
  1. AI background  — Novita FLUX.1 [schnell] text-to-image (themed to the topic).
  2. Subject cutout — rembg removes the background from a video frame, leaving the
                      person(s); pasted bottom-anchored with a soft drop shadow.
  3. Headline text  — thick-stroke, per-line coloured Montserrat (same look as
                      render_headline.py).

The Rust edit stage extracts a subject frame, builds the JSON spec, calls this,
then shows the resulting opaque PNG full-screen for the hook window before cutting
to footage. See src/edit/cover.rs.

Best-effort & graceful:
  • Novita fails  → fall back to a darkened/blurred crop of the subject frame.
  • rembg fails   → background + text only (no subject).
Exit non-zero only if nothing usable could be produced (Rust then drops the cover).

Usage: python render_cover.py <spec.json>   (writes spec["out"])
"""
import base64
import io
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.endpoints import novita, novita_api, openrouter_chat_completions  # noqa: E402

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except Exception as e:  # pragma: no cover
    sys.stderr.write(f"render_cover: Pillow not available: {e}\n")
    sys.exit(2)

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

SS = 2  # text supersample


# ── Novita API key ───────────
def novita_key():
    k = os.environ.get("THOTH_NOVITA_API_KEY")
    if k:
        return k
    try:
        for line in open(".env", encoding="utf-8"):
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            n, val = line.split("=", 1)
            if n.strip() == "THOTH_NOVITA_API_KEY":
                val = val.strip().strip('"').strip("'")
                if val:
                    return val
    except OSError:
        pass
    return None


# ── OpenRouter API key (env first, then .env) ─────────────────────────────────
def openrouter_key():
    k = os.environ.get("THOTH_OPENROUTER_API_KEY")
    if k:
        return k
    try:
        for line in open(".env", encoding="utf-8"):
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            n, val = line.split("=", 1)
            if n.strip() == "THOTH_OPENROUTER_API_KEY":
                val = val.strip().strip('"').strip("'")
                if val:
                    return val
    except OSError:
        pass
    return None


# ── Text helpers (mirrors render_headline.py) ─────────────────────────────────
def hex_to_rgba(h, alpha=255):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return (255, 255, 255, alpha)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def wrap_by_width(text, font, max_w, draw):
    words = text.split()
    if not words:
        return []
    lines, cur = [], words[0]
    for w in words[1:]:
        if draw.textlength(f"{cur} {w}", font=font) <= max_w:
            cur = f"{cur} {w}"
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def line_height(font):
    asc, desc = font.getmetrics()
    return asc + desc


def draw_text_block(canvas, spec):
    """Draw the per-line coloured, thick-stroke headline block onto `canvas`."""
    text = (spec.get("headline_text") or "").strip()
    if not text:
        return
    if spec.get("uppercase", True):
        text = text.upper()
    W, H = canvas.size
    w, h = W * SS, H * SS
    palette = spec.get("palette") or ["#FFFFFF", "#FFD60A"]
    stroke_w = int(spec.get("stroke_width", 13)) * SS
    stroke_color = spec.get("stroke_color", "#000000")
    # line_spacing is a multiple of the FONT SIZE (em) → tight stacked CapCut look
    # (≈1.0). The old ascent+descent metric was too loose.
    line_spacing = float(spec.get("line_spacing", 1.0))
    max_lines = int(spec.get("max_lines", 5))
    margin_v = int(spec.get("margin_v", 360))
    align = (spec.get("text_align") or "left").lower()
    margin_l = int(spec.get("margin_l", 56)) * SS
    max_w_ratio = float(spec.get("max_width_ratio", 0.92))
    sh = spec.get("text_shadow") or {"dx": 0, "dy": 10, "blur": 8, "color": "#000000", "alpha": 180}

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(layer)
    # Left-aligned text uses symmetric L/R margins; centred uses max_width_ratio.
    max_text_w = (w - 2 * margin_l) if align == "left" else int(w * max_w_ratio)

    size = int(spec.get("font_size", 110)) * SS
    fp = spec["font_path"]
    while size > 12:
        font = ImageFont.truetype(fp, size)
        lines = wrap_by_width(text, font, max_text_w, tdraw)
        widest = max((tdraw.textlength(ln, font=font) for ln in lines), default=0)
        if len(lines) <= max_lines and widest + 2 * stroke_w <= max_text_w:
            break
        size = int(size * 0.92)
    font = ImageFont.truetype(fp, size)
    lines = wrap_by_width(text, font, max_text_w, tdraw)
    # Tight stack: advance one em (×line_spacing) per line. Anchor the block bottom
    # `margin_v` px above the frame bottom (top of the last line = baseline-ascent).
    asc = font.getmetrics()[0]
    lh = int(size * line_spacing)
    y0 = (h - margin_v * SS) - lh * (len(lines) - 1) - asc

    def line_x(tw):
        return margin_l if align == "left" else (w - tw) / 2

    # shadow
    if int(sh.get("alpha", 0)) > 0:
        sl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sl)
        scol = hex_to_rgba(sh.get("color", "#000000"), int(sh["alpha"]))
        for i, ln in enumerate(lines):
            tw = sd.textlength(ln, font=font)
            sd.text((line_x(tw) + sh.get("dx", 0) * SS, y0 + i * lh + sh.get("dy", 10) * SS),
                    ln, font=font, fill=scol, stroke_width=stroke_w, stroke_fill=scol)
        sl = sl.filter(ImageFilter.GaussianBlur(float(sh.get("blur", 8)) * SS))
        layer = Image.alpha_composite(layer, sl)

    d = ImageDraw.Draw(layer)
    scol = hex_to_rgba(stroke_color)
    for i, ln in enumerate(lines):
        col = hex_to_rgba(palette[i % len(palette)])
        tw = d.textlength(ln, font=font)
        d.text((line_x(tw), y0 + i * lh), ln, font=font, fill=col,
               stroke_width=stroke_w, stroke_fill=scol)

    layer = layer.resize((W, H), Image.LANCZOS)
    canvas.alpha_composite(layer)


# ── Prompt translation (Indonesian headline → English scene) ──────────────────
def translate_to_scene(spec):
    """Ask the Novita chat model to turn the headline into a vivid ENGLISH
    text-to-image scene prompt. Returns the scene string, or None on failure."""
    key = novita_key()
    model = (spec.get("chat_model") or "").strip()
    if not key or not model:
        return None
    import requests
    base = (spec.get("chat_base_url") or novita()).rstrip("/")
    headline = (spec.get("headline_text") or "").strip()
    topic = (spec.get("topic_desc") or "").strip()
    if not headline and not topic:
        return None
    if (spec.get("subject_mode") or "cutout") == "ai":
        # AI generates the WHOLE cover incl. a dominant MAIN subject (medium shot).
        sys_p = (
            "You convert a (possibly Indonesian) news/social TOPIC into ONE vivid English "
            "text-to-image prompt for a VIRAL VERTICAL THUMBNAIL. Use BOTH the headline AND the "
            "topic description to capture the real who / what / where / action — do NOT rely on the "
            "headline alone. The image MUST have ONE clear MAIN SUBJECT central to the topic. "
            "FRAMING: if the subject is a PERSON, ANIMAL or any OBJECT, render it as a MEDIUM SHOT "
            "(mid-distance, roughly waist-up for a person), centered, facing the camera, with an "
            "expressive pose/emotion and some of the scene/context visible around it — NOT an extreme "
            "close-up and NOT a tiny full-body wide shot. ONLY a BUILDING or large structure may be "
            "framed wider. Place it over a dramatic cinematic background that matches the topic. "
            + AI_COMPOSITION + ". "
            "Photorealistic, high contrast, crisp focus, moody lighting. Absolutely NO text, letters, words, "
            "captions, logos or watermarks. Output ONLY the prompt on a single line — no quotes, no preamble."
        )
    else:
        # Background backdrop only; a separate cutout subject goes on top.
        sys_p = (
            "You convert a (possibly Indonesian) news/social TOPIC into ONE vivid English "
            "text-to-image prompt describing the BACKGROUND ENVIRONMENT for a viral video thumbnail. "
            "Use BOTH the headline AND the topic description to capture the real location / objects / "
            "atmosphere of the event — do NOT rely on the headline alone. Describe ONLY the setting / "
            "location / atmosphere — the place, time of day, weather, dramatic elements, mood and "
            "cinematic lighting — in concrete visual terms. "
            "CRITICAL: the scene is a BACKDROP behind a separate subject that will be composited on "
            "top, so it must contain absolutely NO people, NO persons, NO faces, NO crowds and NO "
            "human figures, and NO text/letters/logos/watermarks. Empty environment only. Output ONLY "
            "the prompt on a single line — no quotes, no preamble, no explanation."
        )
    user_msg = f"Headline: {headline or '(none)'}"
    if topic:
        user_msg += f"\nTopic description: {topic}"
    try:
        r = requests.post(
            f"{base}/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model,
                  "messages": [{"role": "system", "content": sys_p},
                               {"role": "user", "content": user_msg}],
                  "temperature": 0.7, "max_tokens": 180},
            timeout=60)
        if r.status_code != 200:
            sys.stderr.write(f"render_cover: chat {r.status_code}: {r.text[:160]}\n")
            return None
        txt = r.json()["choices"][0]["message"]["content"].strip()
        txt = txt.strip('"').strip("'").replace("\n", " ").strip()
        return txt or None
    except Exception as e:
        sys.stderr.write(f"render_cover: chat error: {e}\n")
        return None


# Composition shared by every AI prompt: keep the subject sharp & unobstructed in the upper area and
# leave the lower third clean/darker so the burned headline never covers the subject's face.
AI_COMPOSITION = (
    "compose VERTICALLY: place the MAIN SUBJECT in the UPPER TWO-THIRDS with the face and upper body "
    "fully visible, sharp and UNOBSTRUCTED; keep the LOWER THIRD simpler and darker (uncluttered) so a "
    "headline text overlay there will not cover the subject"
)

# Style suffix for the AI-subject / AI-event image (people ARE allowed here).
AI_EVENT_SUFFIX = (
    "dramatic cinematic photorealistic HD illustration, ultra detailed, crisp focus, high contrast, "
    "moody cinematic lighting, MEDIUM SHOT framing for people animals and objects "
    "(mid-distance, waist-up for a person, not an extreme close-up, not a tiny full-body wide shot; "
    "only buildings or large structures may be framed wider), " + AI_COMPOSITION + ", "
    "viral vertical thumbnail, no text, no letters, no watermark, no caption"
)


def describe_frame(spec, frame_path):
    """Use the Novita VISION model to describe the actual frame/event in detail, so
    FLUX can recreate it as a dramatic HD illustration that depicts what really
    happened (instead of a generic guess from the headline). Returns the English
    description, or None."""
    key = novita_key()
    model = (spec.get("vision_model") or "").strip()
    if not key or not model or not frame_path or not os.path.exists(frame_path):
        return None
    import requests
    base = (spec.get("vision_base_url") or spec.get("chat_base_url")
            or novita()).rstrip("/")
    try:
        img = Image.open(frame_path).convert("RGB")
        img.thumbnail((768, 768))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        sys.stderr.write(f"render_cover: frame encode error: {e}\n")
        return None
    headline = (spec.get("headline_text") or "").strip()
    topic = (spec.get("topic_desc") or "").strip()
    sys_p = (
        "You are describing a real (possibly dark or low-quality) video frame so an "
        "artist can recreate THIS EXACT SCENE as a dramatic, photorealistic HD "
        "illustration for a viral thumbnail. Use the headline AND topic description as "
        "context for what the scene is about. In ONE vivid English paragraph describe: "
        "the main subject(s) and exactly what they are DOING, the setting/location, "
        "key objects and vehicles, time of day, weather, mood and cinematic lighting. "
        "Frame the MAIN SUBJECT (person/animal/object — not a building) as a MEDIUM SHOT "
        "(mid-distance, waist-up for a person), not an extreme close-up. "
        "Be concrete and faithful to what is actually in the image. Never mention blur, "
        "darkness or low quality. Output ONLY the description — no preamble."
    )
    ctx = f"Headline context: '{headline}'."
    if topic:
        ctx += f" Topic description: {topic}."
    ctx += " Describe this scene for a faithful dramatic HD recreation."
    try:
        r = requests.post(
            f"{base}/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model,
                  "messages": [
                      {"role": "system", "content": sys_p},
                      {"role": "user", "content": [
                          {"type": "text", "text": ctx},
                          {"type": "image_url",
                           "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                      ]}],
                  "temperature": 0.5, "max_tokens": 280},
            timeout=90)
        if r.status_code != 200:
            sys.stderr.write(f"render_cover: vision {r.status_code}: {r.text[:160]}\n")
            return None
        txt = r.json()["choices"][0]["message"]["content"].strip()
        return txt.replace("\n", " ").strip() or None
    except Exception as e:
        sys.stderr.write(f"render_cover: vision error: {e}\n")
        return None


def build_prompt(spec):
    """Resolve the FLUX prompt.

    • AI mode → describe the ACTUAL frame via the vision model and recreate that
      event as an HD illustration (faithful to what happened). If no frame/vision,
      fall back to a headline-derived scene.
    • cutout/backdrop mode → a people-free environment derived from the headline.
    """
    mode = (spec.get("subject_mode") or "cutout").lower()
    if mode == "ai":
        frame = spec.get("describe_frame") or spec.get("subject_frame") or ""
        desc = describe_frame(spec, frame) if frame else None
        if desc:
            sys.stderr.write(f"render_cover: vision scene: {desc[:160]}\n")
            return f"{desc}, {AI_EVENT_SUFFIX}"
        sys.stderr.write("render_cover: no vision desc → headline scene\n")
        if spec.get("translate"):
            scene = translate_to_scene(spec)
            if scene:
                return f"{scene}, {AI_EVENT_SUFFIX}"
        return spec.get("prompt", "")
    # cutout / backdrop: people-free environment behind the cutout.
    if spec.get("translate"):
        scene = translate_to_scene(spec)
        if scene:
            suffix = (spec.get("prompt_suffix") or "").strip()
            sys.stderr.write(f"render_cover: backdrop scene: {scene[:140]}\n")
            return f"{scene}, {suffix}" if suffix else scene
    return spec.get("prompt", "")


# ── Background ────────────────────────────────────────────────────────────────
def cover_fit(img, W, H):
    """Scale+crop `img` to exactly WxH (center crop)."""
    img = img.convert("RGB")
    s = max(W / img.width, H / img.height)
    img = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)
    x = (img.width - W) // 2
    y = (img.height - H) // 2
    return img.crop((x, y, x + W, y + H))


def cover_matches_topic(spec, img):
    """Vision yes/no: does the GENERATED cover actually depict THIS event? Guards against FLUX/OpenRouter
    drawing an off-topic/generic scene. Returns True when it matches OR when vision is unavailable
    (degrade safe — don't discard a cover we can't verify)."""
    import re, requests
    key = novita_key()
    model = (spec.get("vision_model") or "").strip()
    topic = ((spec.get("topic_desc") or "") + " " + (spec.get("headline_text") or "")).strip()
    if not key or not model or not topic:
        return True
    base = (spec.get("vision_base_url") or spec.get("chat_base_url")
            or novita()).rstrip("/")
    try:
        im = img.convert("RGB"); im.thumbnail((768, 768))
        buf = io.BytesIO(); im.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()
        sys_p = ("You judge whether a generated thumbnail faithfully depicts a described news event. "
                 "Answer ONLY compact JSON {\"match\": true|false}. match=true only if the image's scene, "
                 "subjects and setting plausibly match the event; false if it shows an unrelated or "
                 "generic stock scene.")
        usr = f"Event: {topic[:400]}. Does this image depict that event?"
        r = requests.post(f"{base}/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "temperature": 0, "max_tokens": 30,
                  "messages": [{"role": "system", "content": sys_p},
                               {"role": "user", "content": [
                                   {"type": "text", "text": usr},
                                   {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]}]},
            timeout=90)
        if r.status_code != 200:
            sys.stderr.write(f"render_cover: cover-check {r.status_code} → assume OK\n"); return True
        txt = r.json()["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", txt, re.S)
        ok = bool(json.loads(m.group(0)).get("match", True)) if m else True
        sys.stderr.write(f"render_cover: cover-check match={ok}\n")
        return ok
    except Exception as e:
        sys.stderr.write(f"render_cover: cover-check error {e} → assume OK\n"); return True


def frame_as_cover(spec, W, H):
    """Use the REAL video frame as the cover background (Lanczos cover-fit to WxH). Faithful to the
    actual scene — chosen when the AI cover is judged off-topic. Returns an RGB image or None."""
    frame = spec.get("describe_frame") or spec.get("subject_frame") or ""
    if not frame or not os.path.exists(frame):
        return None
    try:
        return cover_fit(Image.open(frame), W, H)
    except Exception as e:
        sys.stderr.write(f"render_cover: frame-as-cover error {e}\n"); return None


def _data_uri(path, max_side=1024):
    """RGB-JPEG data URI of an image, capped to `max_side` (for sending reference photos to OpenRouter)."""
    img = Image.open(path).convert("RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def gen_cover_openrouter(spec, W, H):
    """Generate the cover via an OpenRouter image-OUTPUT model (e.g. openai/gpt-5-image): feed the REAL
    reference photos of the subject (internet portrait + video frame) + a scene prompt → an HD cover that
    NATIVELY preserves the subject's identity. No FLUX text2img + face-swap hack. RGB PIL WxH, or None."""
    key = openrouter_key()
    if not key:
        sys.stderr.write("render_cover: no OpenRouter key (THOTH_OPENROUTER_API_KEY) → skip\n")
        return None
    import requests
    model = (spec.get("image_model") or "openai/gpt-5-image").strip()
    # Reference photos = the subject "knowledge": internet portrait (by name) + the video frame.
    refs = []
    name = (spec.get("subject_name") or "").strip()
    ref_dl = None
    if name:
        ref_dl = fetch_reference_face(name, spec["out"] + ".ref.jpg")
        if ref_dl:
            refs.append(ref_dl)
    frame = spec.get("subject_frame") or spec.get("describe_frame") or ""
    if frame and os.path.exists(frame):
        refs.append(frame)
    scene = (spec.get("prompt") or spec.get("headline_text") or "").strip()
    prompt = (
        "Create a viral vertical 9:16 news/social media thumbnail image. "
        + ("The MAIN SUBJECT must look EXACTLY like the same person shown in the reference photo(s) — "
           "preserve their real face and identity. " if refs else "")
        + f"Scene and context: {scene}. "
        "Render the subject as a MEDIUM SHOT (mid-distance, roughly waist-up for a person), expressive, "
        "facing the camera, placed in the UPPER TWO-THIRDS with the face sharp and unobstructed; keep the "
        "LOWER THIRD simpler and darker for a caption overlay. Photorealistic, dramatic cinematic lighting, "
        "high contrast, ultra detailed, crisp focus. Absolutely NO text, letters, words, captions, logos or watermarks."
    )
    content = [{"type": "text", "text": prompt}]
    for p in refs:
        try:
            content.append({"type": "image_url", "image_url": {"url": _data_uri(p)}})
        except Exception:
            pass
    body = {"model": model, "messages": [{"role": "user", "content": content}], "modalities": ["image", "text"]}
    try:
        t = time.time()
        r = requests.post(openrouter_chat_completions(),
                          headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                   "HTTP-Referer": "https://github.com/thoth", "X-Title": "Thoth"},
                          json=body, timeout=180)
    finally:
        try:
            if ref_dl and os.path.exists(ref_dl):
                os.remove(ref_dl)
        except OSError:
            pass
    try:
        if r.status_code != 200:
            sys.stderr.write(f"render_cover: openrouter {r.status_code}: {r.text[:200]}\n")
            return None
        msg = r.json()["choices"][0]["message"]
        url = None
        imgs = msg.get("images") or []
        if imgs:
            url = (imgs[0].get("image_url") or {}).get("url") or imgs[0].get("url")
        if not url:
            c = msg.get("content")
            if isinstance(c, str) and ("data:image" in c or c.strip().startswith("http")):
                url = c.strip()
        if not url:
            sys.stderr.write(f"render_cover: openrouter no image in response: {str(msg)[:160]}\n")
            return None
        if url.startswith("data:"):
            im = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
        else:
            im = Image.open(io.BytesIO(requests.get(url, timeout=60).content))
        sys.stderr.write(f"render_cover: openrouter cover ({model}) in {time.time()-t:.1f}s\n")
        return cover_fit(im, W, H)
    except Exception as e:
        sys.stderr.write(f"render_cover: openrouter parse error: {e}\n")
        return None


def gen_background(spec, W, H):
    """Generate the AI background via Novita; return an RGB image WxH, or None."""
    key = novita_key()
    if not key:
        sys.stderr.write("render_cover: no Novita API key\n")
        return None
    import requests
    bw = int(spec.get("bg_width", 864))
    bh = int(spec.get("bg_height", 1536))
    body = {
        "prompt": spec["prompt"],
        "width": bw, "height": bh,
        "steps": int(spec.get("model_steps", 4)),
        "seed": int(spec.get("model_seed", 0)),
        "image_num": 1,
        "response_image_format": "png",
    }
    try:
        t = time.time()
        r = requests.post(f"{novita_api()}/v3beta/flux-1-schnell",
                          headers={"Authorization": f"Bearer {key}",
                                   "Content-Type": "application/json"},
                          json=body, timeout=150)
        if r.status_code != 200:
            sys.stderr.write(f"render_cover: novita {r.status_code}: {r.text[:200]}\n")
            return None
        url = r.json()["images"][0]["image_url"]
        raw = spec["out"] + ".bg.png"
        urllib.request.urlretrieve(url, raw)
        sys.stderr.write(f"render_cover: bg generated in {time.time()-t:.1f}s\n")
        img = cover_fit(Image.open(raw), W, H)
        try:
            os.remove(raw)
        except OSError:
            pass
        return img
    except Exception as e:
        sys.stderr.write(f"render_cover: novita error: {e}\n")
        return None


def fallback_background(spec, W, H):
    """Darkened, blurred crop of the subject frame, or solid dark gradient."""
    frame = spec.get("subject_frame") or ""
    if frame and os.path.exists(frame):
        img = cover_fit(Image.open(frame), W, H).filter(ImageFilter.GaussianBlur(18))
        dark = Image.new("RGB", (W, H), (0, 0, 0))
        return Image.blend(img, dark, 0.45)
    return Image.new("RGB", (W, H), (12, 12, 16))


def darken_for_text(bg, W, H, strength):
    """Overlay a subtle global + bottom-heavy dark gradient for text contrast."""
    if strength <= 0:
        return bg
    grad = Image.new("L", (1, H), 0)
    for y in range(H):
        # darker toward the bottom (where the text/subject sit)
        t = y / max(1, H - 1)
        grad.putpixel((0, y), int(255 * strength * (0.35 + 0.65 * t)))
    grad = grad.resize((W, H))
    black = Image.new("RGB", (W, H), (0, 0, 0))
    return Image.composite(black, bg, grad)


# ── Subject cutout + quality gate ─────────────────────────────────────────────
def _cutout_quality(cut_bbox):
    """(coverage_in_bbox, mean_brightness 0-255, sharpness=Laplacian variance).
    A dark/blurry/empty cutout (e.g. a back-view night frame) scores very low on
    brightness + sharpness → in "auto" mode we replace it with an AI subject."""
    if np is None:
        return (1.0, 255.0, 1e9)  # can't measure → assume OK
    arr = np.asarray(cut_bbox).astype(np.float32)
    if arr.ndim != 3 or arr.shape[2] < 4:
        return (0.0, 0.0, 0.0)
    opaque = arr[..., 3] > 128
    if not opaque.any():
        return (0.0, 0.0, 0.0)
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    bright = float(lum[opaque].mean())
    lap = (lum[:-2, 1:-1] + lum[2:, 1:-1] + lum[1:-1, :-2] + lum[1:-1, 2:]
           - 4 * lum[1:-1, 1:-1])
    m = opaque[1:-1, 1:-1]
    sharp = float(lap[m].var()) if m.any() else 0.0
    return (float(opaque.mean()), bright, sharp)


def make_cutout(spec, W, H):
    """rembg the subject frame → (scaled RGBA cutout, quality dict) or (None, None)."""
    frame = spec.get("subject_frame") or ""
    if not frame or not os.path.exists(frame):
        return None, None
    try:
        from rembg import remove, new_session
    except Exception as e:
        sys.stderr.write(f"render_cover: rembg unavailable: {e}\n")
        return None, None
    try:
        model = spec.get("rembg_model", "u2net_human_seg")
        session = new_session(model)
        src = Image.open(frame).convert("RGBA")
        cut = remove(src, session=session)
        bbox = cut.getbbox()
        if not bbox:
            return None, None
        cut = cut.crop(bbox)
        cov, bright, sharp = _cutout_quality(cut)
        frac = ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / float(src.width * src.height)
        # native_h = the subject's REAL pixel height before we upscale it to the frame. A small native
        # height means pasting it would upscale → blur, so "auto" should prefer an AI HD recreation.
        quality = {"coverage": frac, "brightness": bright, "sharpness": sharp, "native_h": cut.height}
        scale = float(spec.get("subject_scale", 1.0))
        target_h = int(H * scale)
        s = target_h / cut.height
        cut = cut.resize((max(1, round(cut.width * s)), target_h), Image.LANCZOS)
        if cut.width > W:  # too wide → fit width instead
            s2 = W / cut.width
            cut = cut.resize((W, max(1, round(cut.height * s2))), Image.LANCZOS)
        return cut, quality
    except Exception as e:
        sys.stderr.write(f"render_cover: rembg error: {e}\n")
        return None, None


def cutout_is_good(quality, spec):
    """Gate for "auto" mode: reject cutouts that won't make a CLEAN HD subject — dark/blurry/tiny
    (e.g. firefighter back-view: brightness≈15, sharpness≈3) OR LOW-RESOLUTION (would upscale a lot →
    blurry, like a 600px person stretched to 1920). Rejected → "auto" uses an AI HD recreation that
    INCLUDES the subject instead of pasting a blurry real cutout."""
    if not quality:
        return False
    if not (quality["coverage"] >= float(spec.get("auto_min_coverage", 0.02))
            and quality["brightness"] >= float(spec.get("auto_min_brightness", 40.0))
            and quality["sharpness"] >= float(spec.get("auto_min_sharpness", 12.0))):
        return False
    # Resolution gate: how much would we upscale the subject to fill the frame?
    native_h = float(quality.get("native_h", 0) or 0)
    if native_h > 0:
        target_h = float(spec.get("height", 1920)) * float(spec.get("subject_scale", 1.0))
        if target_h / native_h > float(spec.get("auto_max_upscale", 1.5)):
            sys.stderr.write(f"render_cover: cutout low-res (native {int(native_h)}px → upscale "
                             f"{target_h/native_h:.1f}× > {float(spec.get('auto_max_upscale',1.5))}) → AI subject\n")
            return False
    return True


def paste_subject(canvas, cut, W, H):
    """Paste the cutout large & centred, anchored to the bottom so it dominates
    the frame (head near the top when it fills full height), with a soft shadow."""
    x = (W - cut.width) // 2
    y = H - cut.height  # bottom-aligned (head rises toward the top as it fills)
    # drop shadow: blurred dark silhouette from the alpha
    alpha = cut.split()[3]
    shadow = Image.new("RGBA", cut.size, (0, 0, 0, 0))
    shadow.putalpha(alpha)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sil = Image.new("RGBA", cut.size, (0, 0, 0, 200))
    sil.putalpha(alpha.point(lambda a: int(a * 0.78)))
    shadow.alpha_composite(sil, (x + 8, y + 10))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(cut, (x, y))


# ── Face likeness: internet reference photo + face swap ───────────────────────
def fetch_reference_face(name, out_path):
    """Search the internet for a clean reference photo of the subject so the face-swap matches the
    REAL person — much better than a blurry/sunglassed video frame. Uses Wikipedia (id → en), which is
    key-free and reliable for public figures. Returns the saved path, or None."""
    name = (name or "").strip()
    if not name:
        return None
    try:
        import requests
    except Exception:
        return None
    ua = {"User-Agent": "ThothBot/1.0 (cover face reference)"}
    for host in ("id.wikipedia.org", "en.wikipedia.org"):
        try:
            s = requests.get(f"https://{host}/w/api.php", headers=ua, timeout=20, params={
                "action": "query", "list": "search", "srsearch": name, "srlimit": 1, "format": "json"}).json()
            hits = s.get("query", {}).get("search", [])
            if not hits:
                continue
            title = hits[0]["title"]
            p = requests.get(f"https://{host}/w/api.php", headers=ua, timeout=20, params={
                "action": "query", "titles": title, "prop": "pageimages",
                "piprop": "original|thumbnail", "pithumbsize": 800, "format": "json"}).json()
            pages = list(p.get("query", {}).get("pages", {}).values())
            if not pages:
                continue
            # Prefer the 800px thumbnail (a face source needs no more, and the original can be a
            # 100+ MP file that trips PIL's DecompressionBomb guard).
            src = (pages[0].get("thumbnail") or {}).get("source") or (pages[0].get("original") or {}).get("source")
            if not src:
                continue
            r = requests.get(src, headers=ua, timeout=25)
            if r.ok and r.content and len(r.content) > 1500:
                with open(out_path, "wb") as f:
                    f.write(r.content)
                sys.stderr.write(f"render_cover: reference face '{name}' ← {host}/{title}\n")
                return out_path
        except Exception as e:
            sys.stderr.write(f"render_cover: wiki {host} error: {e}\n")
    sys.stderr.write(f"render_cover: no internet reference photo for '{name}'\n")
    return None


def _encode_capped(src, max_side, quality=92):
    """RGB-JPEG-encode `src` (PIL image or path), capped to `max_side` longest edge → base64. Keeps the
    payload under Novita merge-face's ~3.75 MB per-image limit (a full-res Wikipedia portrait is bigger)."""
    img = src if isinstance(src, Image.Image) else Image.open(src)
    img = img.convert("RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def merge_face(target_img, face_path):
    """Swap the face from `face_path` (the real subject) onto `target_img` (the AI cover) via Novita
    merge-face. Returns the swapped RGB PIL image, or None on failure."""
    key = novita_key()
    if not key or not face_path or not os.path.exists(face_path):
        return None
    try:
        import requests
        tgt_b64 = _encode_capped(target_img, 1920)
        face_b64 = _encode_capped(face_path, 1024)
        r = requests.post(f"{novita_api()}/v3/merge-face",
                          headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                          json={"image_file": tgt_b64, "face_image_file": face_b64}, timeout=120)
        if r.status_code != 200:
            sys.stderr.write(f"render_cover: merge-face {r.status_code}: {r.text[:160]}\n")
            return None
        img_b64 = r.json().get("image_file")
        if not img_b64:
            return None
        return Image.open(io.BytesIO(base64.b64decode(img_b64))).convert("RGB")
    except Exception as e:
        sys.stderr.write(f"render_cover: merge-face error: {e}\n")
        return None


def apply_face_swap(spec, bg, W, H):
    """If enabled & in AI mode, swap the REAL subject's face onto the AI-generated subject so it looks
    like the actual person. Face source: internet reference photo (by name) > the video frame."""
    if not spec.get("face_swap", True) or bg is None:
        return bg
    ref = spec["out"] + ".faceref.jpg"
    face_src = fetch_reference_face(spec.get("subject_name"), ref)
    if not face_src:
        sf = spec.get("subject_frame") or spec.get("describe_frame") or ""
        if sf and os.path.exists(sf):
            face_src = sf
    if not face_src:
        return bg
    swapped = merge_face(bg, face_src)
    try:
        if os.path.exists(ref):
            os.remove(ref)
    except OSError:
        pass
    if swapped is not None:
        sys.stderr.write("render_cover: face-swapped REAL subject onto AI cover\n")
        return cover_fit(swapped, W, H)
    return bg


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("render_cover: missing spec.json\n")
        sys.exit(2)
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    W = int(spec.get("width", 1080))
    H = int(spec.get("height", 1920))

    # ── Resolve subject mode ──────────────────────────────────────────────────
    # "cutout" → always paste the real cutout. "ai" → FLUX makes the subject.
    # "auto"   → try the cutout; if it's too dark/blurry/small to read as a clear
    #            subject, generate an AI subject instead (no red-blob covers).
    engine = (spec.get("image_engine") or "flux").lower()
    mode = (spec.get("subject_mode") or "cutout").lower()
    cut = None
    if engine == "openrouter":
        # An image-OUTPUT model generates the WHOLE cover (scene + subject) and natively preserves the
        # subject's identity from reference photos → no cutout, no face-swap. Treat as AI mode.
        mode = "ai"
    elif mode in ("cutout", "auto"):
        cut, quality = make_cutout(spec, W, H)
        if mode == "auto":
            if cut is not None and cutout_is_good(quality, spec):
                mode = "cutout"
                sys.stderr.write(f"render_cover: auto → real cutout OK {quality}\n")
            else:
                mode = "ai"
                cut = None
                sys.stderr.write(f"render_cover: auto → cutout too weak {quality} → AI subject\n")
    # The (resolved) mode drives the LLM system prompt: "ai" asks for a dominant
    # full-frame subject; otherwise a people-free backdrop.
    spec["subject_mode"] = mode

    spec["prompt"] = build_prompt(spec)

    bg = None
    if engine == "openrouter":
        bg = gen_cover_openrouter(spec, W, H)  # identity-preserving, no face-swap needed
        if bg is None:
            sys.stderr.write("render_cover: openrouter failed → fallback FLUX + face-swap\n")
    if bg is None:
        bg = gen_background(spec, W, H)
        # FLUX renders a generic face → swap the REAL subject's face on for likeness (internet ref photo).
        if mode == "ai" and bg is not None:
            bg = apply_face_swap(spec, bg, W, H)
    if bg is None:
        bg = fallback_background(spec, W, H)

    # Vision-guard: if the AI cover doesn't actually depict THIS event (FLUX/OpenRouter drifted to a
    # generic/off-topic scene), use the REAL video frame as the cover instead — faithful over pretty.
    if bg is not None and mode == "ai" and not cover_matches_topic(spec, bg):
        fc = frame_as_cover(spec, W, H)
        if fc is not None:
            sys.stderr.write("render_cover: AI cover off-topic → using REAL video frame as cover\n")
            bg = fc
            mode = "cutout"   # frame already shows the real subject → don't paste a cutout over it
            cut = None

    bg = darken_for_text(bg, W, H, float(spec.get("darken", 0.30)))

    canvas = bg.convert("RGBA")

    if mode == "ai":
        sys.stderr.write("render_cover: AI-subject mode (no cutout)\n")
    elif cut is not None:
        paste_subject(canvas, cut, W, H)
    else:
        sys.stderr.write("render_cover: no subject (background + text only)\n")

    draw_text_block(canvas, spec)

    canvas.convert("RGB").save(spec["out"])
    sys.stdout.write(json.dumps({"out": spec["out"], "subject": cut is not None, "mode": mode}) + "\n")


if __name__ == "__main__":
    main()
