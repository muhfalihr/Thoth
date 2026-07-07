#!/usr/bin/env python3
"""Render a viral-cover headline as a transparent PNG (Thoth hook title).

Pillow gives the thick uniform stroke, soft drop-shadow, per-line colours and
crisp anti-aliasing that libass/ASS cannot. The Rust edit stage calls this with
a JSON spec, then overlays the resulting full-frame RGBA PNG in FFmpeg (with the
pop / fade timing) — see src/edit/headline_png.rs.

Usage:
    python render_headline.py <spec.json>

The spec is JSON (see HeadlineSpec in Rust). Output is written to spec["out"].
The PNG is the FULL canvas size (e.g. 1080x1920), fully transparent except the
text block, which is baked at the requested position so FFmpeg can overlay at 0,0
with no extra geometry.

Exit code 0 on success; non-zero (with a message on stderr) on failure so the
Rust side can degrade gracefully back to the ASS renderer.
"""
import json
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except Exception as e:  # pragma: no cover - environment guard
    sys.stderr.write(f"render_headline: Pillow not available: {e}\n")
    sys.exit(2)


# Supersample factor: render big, downscale → smoother thick strokes & edges.
SS = 2


def hex_to_rgba(h, alpha=255):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return (255, 255, 255, alpha)
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    return (r, g, b, alpha)


def wrap_by_width(text, font, max_w, draw):
    """Greedy word-wrap so each line's rendered width <= max_w."""
    words = text.split()
    if not words:
        return []
    lines, cur = [], words[0]
    for w in words[1:]:
        trial = f"{cur} {w}"
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def line_height(font):
    asc, desc = font.getmetrics()
    return asc + desc


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("render_headline: missing spec.json argument\n")
        sys.exit(2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        spec = json.load(f)

    W = int(spec.get("width", 1080))
    H = int(spec.get("height", 1920))
    text = (spec.get("text") or "").strip()
    if not text:
        sys.stderr.write("render_headline: empty text\n")
        sys.exit(3)
    if spec.get("uppercase", True):
        text = text.upper()

    font_path = spec["font_path"]
    base_size = int(spec.get("font_size", 100))
    palette = spec.get("palette") or ["#FFFFFF", "#FFD60A"]
    stroke_w = int(spec.get("stroke_width", 12))
    stroke_color = spec.get("stroke_color", "#000000")
    # line_spacing as a multiple of the FONT SIZE (em) → tight stacked look.
    line_spacing = float(spec.get("line_spacing", 1.0))
    max_lines = int(spec.get("max_lines", 5))
    # Block bottom anchored `margin_v` px above the frame bottom (matches the
    # ASS alignment-2 semantics the Rust side used before).
    margin_v = int(spec.get("margin_v", 360))
    align = (spec.get("text_align") or "left").lower()
    margin_l = int(spec.get("margin_l", 56)) * SS
    max_w_ratio = float(spec.get("max_width_ratio", 0.90))

    shadow = spec.get("shadow") or {}
    sh_dx = int(shadow.get("dx", 0))
    sh_dy = int(shadow.get("dy", 10))
    sh_blur = float(shadow.get("blur", 8))
    sh_color = shadow.get("color", "#000000")
    sh_alpha = int(shadow.get("alpha", 150))

    # Work in supersampled space.
    w, h = W * SS, H * SS
    max_text_w = (w - 2 * margin_l) if align == "left" else int(w * max_w_ratio)

    tmp = Image.new("RGBA", (8, 8))
    tdraw = ImageDraw.Draw(tmp)

    # Auto-fit: shrink the font until the wrapped block fits width AND max_lines.
    size = base_size * SS
    sw = stroke_w * SS
    while size > 12:
        font = ImageFont.truetype(font_path, size)
        lines = wrap_by_width(text, font, max_text_w, tdraw)
        widest = max((tdraw.textlength(ln, font=font) for ln in lines), default=0)
        if len(lines) <= max_lines and widest + 2 * sw <= max_text_w:
            break
        size = int(size * 0.92)
    font = ImageFont.truetype(font_path, size)
    lines = wrap_by_width(text, font, max_text_w, tdraw)

    # Tight stack: advance one em (×line_spacing) per line; anchor block bottom.
    asc = font.getmetrics()[0]
    lh = int(size * line_spacing)
    y0 = (h - margin_v * SS) - lh * (len(lines) - 1) - asc

    def line_x(tw):
        return margin_l if align == "left" else (w - tw) / 2

    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    # ── Drop shadow layer (one blurred dark copy of all lines) ────────────────
    if sh_alpha > 0:
        sh_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        sh_draw = ImageDraw.Draw(sh_layer)
        scol = hex_to_rgba(sh_color, sh_alpha)
        for i, ln in enumerate(lines):
            tw = sh_draw.textlength(ln, font=font)
            x = line_x(tw) + sh_dx * SS
            y = y0 + i * lh + sh_dy * SS
            sh_draw.text((x, y), ln, font=font, fill=scol,
                         stroke_width=sw, stroke_fill=scol)
        if sh_blur > 0:
            sh_layer = sh_layer.filter(ImageFilter.GaussianBlur(sh_blur * SS))
        canvas = Image.alpha_composite(canvas, sh_layer)

    # ── Main text: per-line colour, thick black stroke ────────────────────────
    draw = ImageDraw.Draw(canvas)
    stroke_rgba = hex_to_rgba(stroke_color)
    for i, ln in enumerate(lines):
        col = hex_to_rgba(palette[i % len(palette)])
        tw = draw.textlength(ln, font=font)
        x = line_x(tw)
        y = y0 + i * lh
        draw.text((x, y), ln, font=font, fill=col,
                  stroke_width=sw, stroke_fill=stroke_rgba)

    # Downscale back to target size (supersampling AA).
    out_img = canvas.resize((W, H), Image.LANCZOS)
    out_img.save(spec["out"])

    # Report the rendered lines (handy for Rust logging / debugging).
    sys.stdout.write(json.dumps({"lines": lines, "font_size": size // SS}) + "\n")


if __name__ == "__main__":
    main()
