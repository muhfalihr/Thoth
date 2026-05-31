// transition.wgsl — GPU-native transitions
// Ported from CapCut's GLSL blend pipeline (lens.dll OpenCL + MixMode shaders)
// progress: 0.0 = clip A fully visible, 1.0 = clip B fully visible

struct TransitionParams {
    progress:     f32,  // 0.0 → 1.0 over transition duration
    transition_id: u32, // see TransitionKind enum below
    smoothness:   f32,  // edge smoothness (0.0 = hard, 1.0 = very smooth)
    _pad:         f32,
}

// TransitionKind IDs (match Rust Transition enum ordinal)
const TK_FADE:          u32 = 0u;
const TK_BLINK:         u32 = 1u;
const TK_DISSOLVE:      u32 = 2u;
const TK_WIPE_LEFT:     u32 = 3u;
const TK_WIPE_RIGHT:    u32 = 4u;
const TK_WIPE_UP:       u32 = 5u;
const TK_WIPE_DOWN:     u32 = 6u;
const TK_SLIDE_LEFT:    u32 = 7u;
const TK_SLIDE_RIGHT:   u32 = 8u;
const TK_ZOOM_IN:       u32 = 9u;
const TK_CIRCLE_OPEN:   u32 = 10u;
const TK_CIRCLE_CLOSE:  u32 = 11u;
const TK_PIXELIZE:      u32 = 12u;
const TK_RADIAL:        u32 = 13u;
const TK_HBLUR:         u32 = 14u;
const TK_FADE_GRAYS:    u32 = 15u;
const TK_DIAG_TL:       u32 = 16u;
const TK_COVER_LEFT:    u32 = 17u;
const TK_REVEAL_LEFT:   u32 = 18u;
const TK_SQUEEZE_H:     u32 = 19u;
const TK_SMOOTH_LEFT:   u32 = 20u;

@group(0) @binding(0) var<uniform> params: TransitionParams;
@group(0) @binding(1) var tex_a:    texture_2d<f32>;
@group(0) @binding(2) var tex_b:    texture_2d<f32>;
@group(0) @binding(3) var samp:     sampler;

struct VertOut {
    @builtin(position) pos: vec4<f32>,
    @location(0)       uv:  vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertOut {
    var out: VertOut;
    let x = f32((vi << 1u) & 2u);
    let y = f32(vi & 2u);
    out.pos = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    out.uv  = vec2<f32>(x, 1.0 - y);
    return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sample_a(uv: vec2<f32>) -> vec4<f32> { return textureSample(tex_a, samp, uv); }
fn sample_b(uv: vec2<f32>) -> vec4<f32> { return textureSample(tex_b, samp, uv); }

fn smooth_edge(x: f32, sm: f32) -> f32 {
    return smoothstep(0.0, sm + 0.001, x);
}

fn rgb_to_gray(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ── Transition implementations ────────────────────────────────────────────────

// Fade through black (xfade=fade)
fn tr_fade(uv: vec2<f32>, p: f32) -> vec4<f32> {
    if p < 0.5 {
        return sample_a(uv) * (1.0 - p * 2.0);
    } else {
        return sample_b(uv) * ((p - 0.5) * 2.0);
    }
}

// Flash to white then next (CapCut "Blink" — xfade=fadewhite)
fn tr_blink(uv: vec2<f32>, p: f32) -> vec4<f32> {
    if p < 0.5 {
        let t = p * 2.0;
        return mix(sample_a(uv), vec4<f32>(1.0), t);
    } else {
        let t = (p - 0.5) * 2.0;
        return mix(vec4<f32>(1.0), sample_b(uv), t);
    }
}

// Pixel dissolve (xfade=dissolve) — random dithered blend
fn tr_dissolve(uv: vec2<f32>, p: f32) -> vec4<f32> {
    // Simple hash-based dissolve (matches xfade=dissolve visually)
    let dims = vec2<f32>(textureDimensions(tex_a, 0));
    let px   = floor(uv * dims);
    // 2D hash: Wang hash
    var h = u32(px.x) * 1664525u + u32(px.y) * 214013u + 2531011u;
    h = h ^ (h >> 16u);
    h = h * 2246822519u;
    h = h ^ (h >> 13u);
    let thresh = f32(h & 0xFFFFu) / 65535.0;
    return select(sample_a(uv), sample_b(uv), p > thresh);
}

// Wipe left (xfade=wipeleft)
fn tr_wipe_left(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let edge = 1.0 - p;
    let mask = smooth_edge(uv.x - edge, sm);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Wipe right (xfade=wiperight)
fn tr_wipe_right(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let mask = smooth_edge(p - uv.x, sm);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Wipe up (xfade=wipeup)
fn tr_wipe_up(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let edge = 1.0 - p;
    let mask = smooth_edge(uv.y - edge, sm);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Wipe down (xfade=wipedown)
fn tr_wipe_down(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let mask = smooth_edge(p - uv.y, sm);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Slide left — clip A slides out, clip B slides in from right
fn tr_slide_left(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let uv_a = vec2<f32>(uv.x + p, uv.y);
    let uv_b = vec2<f32>(uv.x - (1.0 - p), uv.y);
    if uv_b.x >= 0.0 && uv_b.x <= 1.0 {
        return sample_b(uv_b);
    }
    if uv_a.x >= 0.0 && uv_a.x <= 1.0 {
        return sample_a(uv_a);
    }
    return vec4<f32>(0.0);
}

// Slide right
fn tr_slide_right(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let uv_a = vec2<f32>(uv.x - p, uv.y);
    let uv_b = vec2<f32>(uv.x + (1.0 - p), uv.y);
    if uv_b.x >= 0.0 && uv_b.x <= 1.0 {
        return sample_b(uv_b);
    }
    if uv_a.x >= 0.0 && uv_a.x <= 1.0 {
        return sample_a(uv_a);
    }
    return vec4<f32>(0.0);
}

// Zoom into next clip (xfade=zoomin)
fn tr_zoom_in(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let scale = mix(1.0, 0.1, p);
    let uv_a = (uv - 0.5) / scale + 0.5;
    let in_a = uv_a.x >= 0.0 && uv_a.x <= 1.0 && uv_a.y >= 0.0 && uv_a.y <= 1.0;
    let ca = select(vec4<f32>(0.0), sample_a(uv_a), in_a);
    return mix(ca, sample_b(uv), p);
}

// Circle open iris (xfade=circleopen)
fn tr_circle_open(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let d = length(uv - 0.5);
    let mask = smooth_edge(p * 0.707 - d, sm * 0.5);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Circle close iris (xfade=circleclose)
fn tr_circle_close(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let d = length(uv - 0.5);
    let mask = smooth_edge(d - (1.0 - p) * 0.707, sm * 0.5);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Pixelize / Mosaic (xfade=pixelize)
fn tr_pixelize(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let max_blocks: f32 = 30.0;
    let t = select(p * 2.0, (1.0 - p) * 2.0, p < 0.5);
    let blocks = ceil(mix(max_blocks, 1.0, t));
    let uv_pix = floor(uv * blocks) / blocks + 0.5 / blocks;
    let a = sample_a(uv_pix);
    let b = sample_b(uv_pix);
    return mix(a, b, select(0.0, 1.0, p >= 0.5));
}

// Radial wipe (xfade=radial)
fn tr_radial(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let angle = atan2(uv.y - 0.5, uv.x - 0.5) / (2.0 * 3.14159265) + 0.5;
    let mask = smooth_edge(p - angle, sm * 0.5);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Horizontal blur wipe (xfade=hblur, CapCut "Glitch"/"Blur")
fn tr_hblur(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let strength = sin(p * 3.14159265) * 0.08;
    var col = vec4<f32>(0.0);
    let steps = 8;
    for (var i = 0; i < steps; i++) {
        let offset = (f32(i) / f32(steps - 1) - 0.5) * strength;
        let t = (uv.x - 0.5 + offset * 0.5 + 0.5) / 1.0; // blurred A
        col += sample_a(uv + vec2<f32>(offset, 0.0));
    }
    col /= f32(steps);
    return mix(col, sample_b(uv), p);
}

// Desaturate fade (xfade=fadegrays)
fn tr_fade_grays(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let ca = sample_a(uv);
    let cb = sample_b(uv);
    let ga = rgb_to_gray(ca.rgb);
    let gb = rgb_to_gray(cb.rgb);
    // Desaturate A out, saturate B in
    let a_out = mix(ca, vec4<f32>(ga, ga, ga, ca.a), smoothstep(0.0, 0.5, p));
    let b_in  = mix(vec4<f32>(gb, gb, gb, cb.a), cb, smoothstep(0.5, 1.0, p));
    return mix(a_out, b_in, p);
}

// Diagonal TL wipe (xfade=diagtl)
fn tr_diag_tl(uv: vec2<f32>, p: f32, sm: f32) -> vec4<f32> {
    let mask = smooth_edge(p * 2.0 - uv.x - uv.y, sm);
    return mix(sample_a(uv), sample_b(uv), mask);
}

// Cover left — B slides over A from right
fn tr_cover_left(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let uv_b = vec2<f32>(uv.x - (1.0 - p), uv.y);
    if uv_b.x >= 0.0 && uv_b.x <= 1.0 {
        return sample_b(uv_b);
    }
    return sample_a(uv);
}

// Squeeze horizontal (xfade=squeezeh)
fn tr_squeeze_h(uv: vec2<f32>, p: f32) -> vec4<f32> {
    let scale = 1.0 - p;
    if scale < 0.001 { return sample_b(uv); }
    let uv_a = vec2<f32>((uv.x - 0.5) / scale + 0.5, uv.y);
    if uv_a.x >= 0.0 && uv_a.x <= 1.0 {
        return sample_a(uv_a);
    }
    return sample_b(uv);
}

// Smooth left (xfade=smoothleft) — wipe with smooth edge
fn tr_smooth_left(uv: vec2<f32>, p: f32) -> vec4<f32> {
    return tr_wipe_left(uv, p, 0.05);
}

// ── Main fragment dispatch ────────────────────────────────────────────────────

@fragment
fn fs_main(in: VertOut) -> @location(0) vec4<f32> {
    let p  = clamp(params.progress, 0.0, 1.0);
    let sm = clamp(params.smoothness, 0.0, 0.1);
    let uv = in.uv;

    switch params.transition_id {
        case TK_FADE:         { return tr_fade(uv, p); }
        case TK_BLINK:        { return tr_blink(uv, p); }
        case TK_DISSOLVE:     { return tr_dissolve(uv, p); }
        case TK_WIPE_LEFT:    { return tr_wipe_left(uv, p, sm); }
        case TK_WIPE_RIGHT:   { return tr_wipe_right(uv, p, sm); }
        case TK_WIPE_UP:      { return tr_wipe_up(uv, p, sm); }
        case TK_WIPE_DOWN:    { return tr_wipe_down(uv, p, sm); }
        case TK_SLIDE_LEFT:   { return tr_slide_left(uv, p); }
        case TK_SLIDE_RIGHT:  { return tr_slide_right(uv, p); }
        case TK_ZOOM_IN:      { return tr_zoom_in(uv, p); }
        case TK_CIRCLE_OPEN:  { return tr_circle_open(uv, p, sm); }
        case TK_CIRCLE_CLOSE: { return tr_circle_close(uv, p, sm); }
        case TK_PIXELIZE:     { return tr_pixelize(uv, p); }
        case TK_RADIAL:       { return tr_radial(uv, p, sm); }
        case TK_HBLUR:        { return tr_hblur(uv, p); }
        case TK_FADE_GRAYS:   { return tr_fade_grays(uv, p); }
        case TK_DIAG_TL:      { return tr_diag_tl(uv, p, sm); }
        case TK_COVER_LEFT:   { return tr_cover_left(uv, p); }
        case TK_REVEAL_LEFT:  { return tr_wipe_left(uv, 1.0 - p, sm); }
        case TK_SQUEEZE_H:    { return tr_squeeze_h(uv, p); }
        case TK_SMOOTH_LEFT:  { return tr_smooth_left(uv, p); }
        default:              { return mix(sample_a(uv), sample_b(uv), p); }
    }
}
