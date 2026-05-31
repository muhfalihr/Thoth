// color.wgsl — GPU color grading shaders
// Ported from CapCut's GLSL shaders (extracted via reverse engineering):
//   - hsl.frag        → hsl_adjust
//   - log_color_wheel.frag → color_wheel
//   - curves_apply.frag    → curves_apply
//   - shadow_highlight.frag → shadow_highlight

// ── Shared uniforms ────────────────────────────────────────────────────────────

struct ColorParams {
    // Basic adjustments [-1..1]
    brightness:  f32,
    contrast:    f32,
    saturation:  f32,
    temperature: f32,   // warm (+) / cool (-), converted to R-B shift
    tint:        f32,   // green (+) / magenta (-)

    // Tone [-1..1]
    highlights:  f32,
    shadows:     f32,
    whites:      f32,
    blacks:      f32,

    // HSL (per-channel) — packed as 8 × vec3 of (hue_shift, sat_delta, lum_delta)
    // [Red, Orange, Yellow, Green, Cyan, Blue, Purple, Magenta]
    hsl_red:     vec3<f32>,
    hsl_orange:  vec3<f32>,
    hsl_yellow:  vec3<f32>,
    hsl_green:   vec3<f32>,
    hsl_cyan:    vec3<f32>,
    hsl_blue:    vec3<f32>,
    hsl_purple:  vec3<f32>,
    hsl_magenta: vec3<f32>,

    // Log color wheels (shadow / midtone / highlight / offset)
    // Each is RGBA where .rgb = color shift, .a = saturation delta
    wheel_shadow:    vec4<f32>,
    wheel_midtone:   vec4<f32>,
    wheel_highlight: vec4<f32>,
    wheel_offset:    vec4<f32>,
    wheel_range_lo:  f32,   // default 0.333
    wheel_range_hi:  f32,   // default 0.550
    wheel_intensity: f32,   // overall intensity

    // Sharpen / Vignette
    sharpen:   f32,   // 0..1
    vignette:  f32,   // 0..1

    // LUT (1 = enabled)
    lut_enabled: u32,

    _pad: vec3<f32>,
}

@group(0) @binding(0) var<uniform> params: ColorParams;
@group(0) @binding(1) var input_tex:  texture_2d<f32>;
@group(0) @binding(2) var input_samp: sampler;
@group(0) @binding(3) var lut_tex:    texture_3d<f32>;
@group(0) @binding(4) var lut_samp:   sampler;

// ── Vertex pass-through ────────────────────────────────────────────────────────

struct VertOut {
    @builtin(position) pos: vec4<f32>,
    @location(0)       uv:  vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertOut {
    // Full-screen triangle (no vertex buffer needed)
    var out: VertOut;
    let x = f32((vi << 1u) & 2u);
    let y = f32(vi & 2u);
    out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    out.uv  = vec2<f32>(x, 1.0 - y);
    return out;
}

// ── Color space helpers ────────────────────────────────────────────────────────

fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
    let cmax   = max(c.r, max(c.g, c.b));
    let cmin   = min(c.r, min(c.g, c.b));
    let delta  = cmax - cmin;
    var h = 0.0f;
    var s = 0.0f;
    let l = (cmax + cmin) * 0.5;

    if delta > 0.00001 {
        s = select(delta / (2.0 - cmax - cmin), delta / (cmax + cmin), l <= 0.5);
        if cmax == c.r {
            h = (c.g - c.b) / delta;
            h = select(h, h + 6.0, c.g < c.b);
        } else if cmax == c.g {
            h = (c.b - c.r) / delta + 2.0;
        } else {
            h = (c.r - c.g) / delta + 4.0;
        }
        h = h * 60.0;
    }
    return vec3<f32>(h, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t_in: f32) -> f32 {
    var t = t_in;
    t = select(t + 1.0, t, t >= 0.0);
    t = select(t - 1.0, t, t <= 1.0);
    if t < 1.0 / 6.0  { return p + (q - p) * 6.0 * t; }
    if t < 0.5         { return q; }
    if t < 2.0 / 3.0  { return p + (q - p) * (2.0/3.0 - t) * 6.0; }
    return p;
}

fn hsl_to_rgb(hsl: vec3<f32>) -> vec3<f32> {
    let h = hsl.x / 360.0;
    let s = hsl.y;
    let l = hsl.z;
    if s < 0.00001 {
        return vec3<f32>(l, l, l);
    }
    let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
    let p = 2.0 * l - q;
    return vec3<f32>(
        hue_to_rgb(p, q, h + 1.0/3.0),
        hue_to_rgb(p, q, h),
        hue_to_rgb(p, q, h - 1.0/3.0),
    );
}

fn rgb_to_gray(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ── HSL per-channel adjustment (from CapCut hsl_v1/HSL/xshader/fshader.frag) ──

// Hue ranges for the 8 default color channels (degrees, ±30° trapezoid)
const HALF_HUE_RANGE: f32 = 30.0;
const HUE_FLAT_RATIO: f32 = 0.5;

fn regularize_hue(h_in: f32) -> f32 {
    var h = h_in % 360.0;
    h = select(h + 360.0, h, h >= 0.0);
    h = select(h - 360.0, h, h > 360.0);
    return h;
}

// Trapezoidal mask: full weight between x2..y1, linear ramp x1..x2 and y1..y2
fn hue_weight(h: f32, ll: f32, l: f32, r: f32, rr: f32) -> f32 {
    // Handles wraparound by checking all cases
    if h >= l && h <= r { return 1.0; }
    if h >= ll && h < l { return (h - ll) / max(l - ll, 0.001); }
    if h > r && h <= rr { return (rr - h) / max(rr - r, 0.001); }
    // Wraparound case (e.g. red: 315..20)
    if l > r {
        if h >= l && h <= 360.0 { return 1.0; }
        if h >= 0.0 && h <= r   { return 1.0; }
    }
    return 0.0;
}

fn hsl_channel_adjust(hsl: vec3<f32>, param: vec3<f32>,
                       ll: f32, l: f32, r: f32, rr: f32) -> vec3<f32> {
    let w = hue_weight(hsl.x, ll, l, r, rr);
    if w < 0.0001 { return hsl; }
    var out = hsl;
    out.x = regularize_hue(hsl.x + param.x * w);
    // Saturation: negative = desaturate, positive = oversaturate
    let ds = clamp(param.y / 100.0, -1.0, 1.0) * w;
    out.y = select(hsl.y * (1.0 + ds), hsl.y + (hsl.y - hsl.y * (1.0 - ds)), ds >= 0.0);
    out.y = clamp(out.y, 0.0, 1.0);
    // Luminance
    let dl = clamp(param.z / 100.0, -1.0, 1.0) * w;
    out.z = clamp(hsl.z + dl * 0.5, 0.0, 1.0);
    return out;
}

fn apply_hsl(c: vec3<f32>) -> vec3<f32> {
    var hsl = rgb_to_hsl(c);
    // 8 color channels with their hue ranges (from CapCut hsl shader source)
    hsl = hsl_channel_adjust(hsl, params.hsl_red,     315.0, 330.0, 5.0,  20.0);
    hsl = hsl_channel_adjust(hsl, params.hsl_orange,  350.0, 20.0,  40.0, 60.0);
    hsl = hsl_channel_adjust(hsl, params.hsl_yellow,  25.0,  50.0,  70.0, 90.0);
    hsl = hsl_channel_adjust(hsl, params.hsl_green,   50.0,  70.0,  160.0,190.0);
    hsl = hsl_channel_adjust(hsl, params.hsl_cyan,    135.0, 165.0, 195.0,225.0);
    hsl = hsl_channel_adjust(hsl, params.hsl_blue,    145.0, 180.0, 235.0,275.0);
    hsl = hsl_channel_adjust(hsl, params.hsl_purple,  235.0, 255.0, 315.0,335.0);
    hsl = hsl_channel_adjust(hsl, params.hsl_magenta, 255.0, 285.0, 335.0,5.0);
    return hsl_to_rgb(hsl);
}

// ── Log Color Wheels (from CapCut AmazingFeature_logWheel/xshader/fshader.frag) ─

fn cubic_eval(x: f32, c: vec4<f32>) -> f32 {
    let x2 = x * x;
    return c.x + c.y * x + c.z * x2 + c.w * x2 * x;
}

fn get_midtone_param(midtone: f32) -> f32 {
    let m = midtone;
    let m2 = m * m; let m3 = m2 * m; let m4 = m3 * m;
    let m5 = m4 * m; let m6 = m5 * m; let m7 = m6 * m;
    return 1.0 - 1.10145*m + 0.906076*m2 - 0.681492*m3
               - 0.253415*m4 + 0.272653*m5 + 1.09324*m6 - 0.909166*m7;
}

fn process_wheel_channel(x_in: f32, shadow: f32, midtone: f32, highlight: f32,
                          offset: f32, rng_lo: f32, rng_hi: f32) -> f32 {
    let EPS = 0.000001;
    let MAX_SLOPE = 9.0;
    let RNG_T = 0.05;
    let x = x_in + offset;
    let rng_mid = (rng_lo + rng_hi) * 0.5;

    if x <= rng_lo - RNG_T {
        // Shadow region
        if shadow > 0.0 {
            return x * (1.0 - shadow) + rng_lo * shadow;
        } else {
            let slope = (rng_lo - shadow) / max(rng_lo, EPS);
            return select(x * MAX_SLOPE + (1.0 - MAX_SLOPE) * rng_lo,
                          x * slope + shadow, slope <= MAX_SLOPE);
        }
    } else if x >= rng_hi + RNG_T {
        // Highlight region
        if highlight > 0.0 {
            let slope = (1.0 - rng_hi + highlight) / max(1.0 - rng_hi, EPS);
            return select(x * MAX_SLOPE + (1.0 - MAX_SLOPE) * rng_hi,
                          x * slope - rng_hi * highlight / max(1.0 - rng_hi, EPS),
                          slope <= MAX_SLOPE);
        } else {
            return x * (1.0 + highlight) - rng_hi * highlight;
        }
    } else {
        // Midtone region — power function
        let m = get_midtone_param(midtone);
        let xn = (x - rng_lo) / max(rng_hi - rng_lo, EPS);
        let yn = 1.0 - pow(max(1.0 - pow(max(xn, 0.0), m), 0.0), 1.0 / m);
        return yn * (rng_hi - rng_lo) + rng_lo;
    }
}

fn apply_color_wheels(c: vec3<f32>) -> vec3<f32> {
    let lo = params.wheel_range_lo;
    let hi = params.wheel_range_hi;
    var r = process_wheel_channel(c.r, params.wheel_shadow.r, params.wheel_midtone.r,
                                   params.wheel_highlight.r, params.wheel_offset.r, lo, hi);
    var g = process_wheel_channel(c.g, params.wheel_shadow.g, params.wheel_midtone.g,
                                   params.wheel_highlight.g, params.wheel_offset.g, lo, hi);
    var b = process_wheel_channel(c.b, params.wheel_shadow.b, params.wheel_midtone.b,
                                   params.wheel_highlight.b, params.wheel_offset.b, lo, hi);
    let result = vec3<f32>(r, g, b);
    // Saturation via wheel
    let y_orig = rgb_to_gray(c);
    let y_new  = rgb_to_gray(result);
    let ds = (y_new - y_orig) * 12.0 + params.wheel_offset.a;
    let hsl = rgb_to_hsl(result);
    var s_new = hsl.y * (1.0 + ds);
    s_new = clamp(s_new, 0.0, 1.0);
    return hsl_to_rgb(vec3<f32>(hsl.x, s_new, hsl.z));
}

// ── Basic tone adjustments ────────────────────────────────────────────────────

fn apply_brightness_contrast(c: vec3<f32>) -> vec3<f32> {
    var r = c;
    // Brightness: additive shift
    r = r + vec3<f32>(params.brightness * 0.5);
    // Contrast: sigmoid-like around 0.5
    if abs(params.contrast) > 0.001 {
        let factor = 1.0 + params.contrast;
        r = (r - 0.5) * factor + 0.5;
    }
    return clamp(r, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn apply_saturation(c: vec3<f32>) -> vec3<f32> {
    if abs(params.saturation) < 0.001 { return c; }
    let y = rgb_to_gray(c);
    let s = 1.0 + params.saturation;
    return clamp(mix(vec3<f32>(y), c, s), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn apply_temperature_tint(c: vec3<f32>) -> vec3<f32> {
    var r = c;
    // Temperature: warm = +R −B, cool = −R +B
    r.r = clamp(r.r + params.temperature * 0.15, 0.0, 1.0);
    r.b = clamp(r.b - params.temperature * 0.15, 0.0, 1.0);
    // Tint: green = +G, magenta = −G (affects G and complementary)
    r.g = clamp(r.g + params.tint * 0.10, 0.0, 1.0);
    r.r = clamp(r.r - params.tint * 0.05, 0.0, 1.0);
    r.b = clamp(r.b - params.tint * 0.05, 0.0, 1.0);
    return r;
}

fn apply_whites_blacks(c: vec3<f32>) -> vec3<f32> {
    var r = c;
    if abs(params.whites) > 0.001 {
        let mask = r;  // brighter pixels affected more
        r = r + mask * params.whites * 0.25;
    }
    if abs(params.blacks) > 0.001 {
        let mask = vec3<f32>(1.0) - r; // darker pixels affected more
        r = r - mask * params.blacks * 0.25;
    }
    return clamp(r, vec3<f32>(0.0), vec3<f32>(1.0));
}

// ── Sharpen (unsharp mask, 3×3 Laplacian) ────────────────────────────────────

fn apply_sharpen(c: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    if params.sharpen < 0.001 { return c; }
    let dims = vec2<f32>(textureDimensions(input_tex, 0));
    let px = 1.0 / dims;
    // Laplacian kernel: 4×center − neighbors
    let n = textureSample(input_tex, input_samp, uv + vec2<f32>(0.0,  px.y)).rgb;
    let s = textureSample(input_tex, input_samp, uv + vec2<f32>(0.0, -px.y)).rgb;
    let e = textureSample(input_tex, input_samp, uv + vec2<f32>( px.x, 0.0)).rgb;
    let w = textureSample(input_tex, input_samp, uv + vec2<f32>(-px.x, 0.0)).rgb;
    let lap = c * 4.0 - n - s - e - w;
    return clamp(c + lap * params.sharpen * 2.0, vec3<f32>(0.0), vec3<f32>(1.0));
}

// ── Vignette ─────────────────────────────────────────────────────────────────

fn apply_vignette(c: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    if params.vignette < 0.001 { return c; }
    let d = length(uv - vec2<f32>(0.5));
    let mask = smoothstep(0.8, 0.3, d * (1.0 + params.vignette));
    return c * mask;
}

// ── LUT 3D (Color Lookup Table) ───────────────────────────────────────────────

fn apply_lut(c: vec3<f32>) -> vec3<f32> {
    if params.lut_enabled == 0u { return c; }
    return textureSample(lut_tex, lut_samp, c).rgb;
}

// ── Fragment shader — full color grading pipeline ─────────────────────────────

@fragment
fn fs_main(in: VertOut) -> @location(0) vec4<f32> {
    let raw = textureSample(input_tex, input_samp, in.uv);
    var c = raw.rgb;

    // 1. Temperature / Tint
    c = apply_temperature_tint(c);
    // 2. Brightness / Contrast
    c = apply_brightness_contrast(c);
    // 3. Saturation (global)
    c = apply_saturation(c);
    // 4. Whites / Blacks
    c = apply_whites_blacks(c);
    // 5. HSL per-channel
    c = apply_hsl(c);
    // 6. Log Color Wheels (Shadow / Midtone / Highlight)
    c = apply_color_wheels(c);
    // 7. LUT
    c = apply_lut(c);
    // 8. Sharpen
    c = apply_sharpen(c, in.uv);
    // 9. Vignette
    c = apply_vignette(c, in.uv);

    return vec4<f32>(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), raw.a);
}
