# DeepSeek-OCR Headline/Subtitle Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Qwen3-VL subtitle bbox detection with Novita DeepSeek-OCR, independently trim intro headlines and censor later subtitles, and honor those source-time directives across main, footage, fallback, and looping render paths.

**Architecture:** Scout extracts adaptively sampled frames, parses DeepSeek grounding boxes, and runs a pure temporal tracker that can emit `trim_start` and subtitle blur simultaneously. Rust owns source-to-output time projection and clean-loop filtering; enrichment downloads are trimmed at their declared source in-point before they become montage cues.

**Tech Stack:** Bun/TypeScript, Novita OpenAI-compatible API, DeepSeek-OCR grounding format, Rust 2024, FFmpeg filtergraphs, Cargo tests, repository CUDA build.

## Global Constraints

- Default OCR model: `deepseek/deepseek-ocr`.
- No Qwen fallback in this detector.
- Content-set changes remain additive and backward-compatible.
- OCR/network failure remains fail-open.
- Diagnostics never contain a raw source URL, image base64, credentials, or response headers.
- Unit tests never require network.
- Completion requires full `build_cuda.bat`, per `CLAUDE.md`.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Parse DeepSeek grounding output and schedule adaptive samples

**Files:**
- Modify: `scout/lib/subtitle_vision.test.ts`
- Modify: `scout/lib/subtitle_vision.ts`

**Interfaces:**
- Produces: `OcrBox`, `OcrFrame`, `parseDeepSeekOcr(content)`, `buildSampleTimes(duration,maxFrames)`.

- [ ] **Step 1: Write failing tests**

Add assertions for this response:

```ts
const boxes = parseDeepSeekOcr(
  '<|ref|>CUCURELLA BUNGKUS TROFI<|/ref|><|det|>[[53,460,821,540]]<|/det|>\\n' +
  '<|ref|>PIALA DUNIA PAKE KRESEK<|/ref|><|det|>[[70,545,790,617]]<|/det|>',
);
assert.deepEqual(boxes[0], {
  text: 'CUCURELLA BUNGKUS TROFI',
  x0: .053, y0: .46, x1: .821, y1: .54,
});
assert.equal(boxes.length, 2);
assert.deepEqual(
  parseDeepSeekOcr('<|ref|>valid<|/ref|><|det|>[[900,700,100,300]]<|/det|>'),
  [{ text: 'valid', x0: .1, y0: .3, x1: .9, y1: .7 }],
);
assert.deepEqual(buildSampleTimes(.3, 12), [0]);
const samples = buildSampleTimes(26.935, 12);
assert.deepEqual(samples.slice(0, 6), [.5, 1, 2, 3, 4, 5]);
assert.ok(samples.length <= 12 && samples.at(-1)! > 20);
```

- [ ] **Step 2: Verify RED**

Run: `bun scout/lib/subtitle_vision.test.ts`

Expected: missing-export failure for the new parser/scheduler.

- [ ] **Step 3: Implement minimal pure functions**

Use these types and rules:

```ts
export type OcrBox = {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
};
export type OcrFrame = { t: number; boxes: OcrBox[]; error?: string };

export function parseDeepSeekOcr(content: string): OcrBox[] {
  const out: OcrBox[] = [];
  const pair = /<\\|ref\\|>([\\s\\S]*?)<\\|\\/ref\\|>\\s*<\\|det\\|>(\\[\\[[\\s\\S]*?\\]\\])<\\|\\/det\\|>/g;
  for (const m of (content || '').matchAll(pair)) {
    try {
      for (const raw of JSON.parse(m[2])) {
        if (!Array.isArray(raw) || raw.length !== 4) continue;
        const scale = Math.max(...raw.map((n: number) => Math.abs(n))) > 1 ? 1000 : 1;
        const clamp = (n: number) => Math.min(1, Math.max(0, n / scale));
        let [x0, y0, x1, y1] = raw.map(clamp);
        if (x1 < x0) [x0, x1] = [x1, x0];
        if (y1 < y0) [y0, y1] = [y1, y0];
        const text = m[1].replace(/\\s+/g, ' ').trim();
        if (text && x1 - x0 >= .01 && y1 - y0 >= .01) out.push({ text, x0, y0, x1, y1 });
      }
    } catch {}
  }
  return out;
}
```

`buildSampleTimes` uses dense intro `[.5,1,2,3,4,5]`, evenly distributes remaining slots after 5s, removes duplicates, caps at `THOTH_SUBTITLE_OCR_MAX_FRAMES` default 12, and samples zero for sub-.5s clips.

- [ ] **Step 4: Verify GREEN**

Run the test again; parser and schedule assertions must pass.

- [ ] **Step 5: Commit**

```powershell
git add scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts
git commit -m "feat(scout): parse DeepSeek OCR grounding boxes"
```

---

### Task 2: Track headline and subtitle actions independently

**Files:**
- Modify: `scout/lib/subtitle_vision.test.ts`
- Modify: `scout/lib/subtitle_vision.ts`

**Interfaces:**
- Consumes: `OcrFrame[]`.
- Produces: `classifyOcrFrames(frames,duration): ClipVerdict`.

- [ ] **Step 1: Write failing hybrid and geometry tests**

```ts
const b = (text: string, x0: number, y0: number, x1: number, y1: number) =>
  ({ text, x0, y0, x1, y1 });
const f = (t: number, ...boxes: OcrBox[]) => ({ t, boxes });

const hybrid = classifyOcrFrames([
  f(.5, b('CUCURELLA BUNGKUS TROFI', .05, .46, .82, .54)),
  f(1,  b('CUCURELLA BUNGKUS TROFI', .05, .46, .82, .54)),
  f(3,  b('CUCURELLA BUNGKUS TROFI', .05, .46, .82, .54)),
  f(5,  b('BAWA PULANG', .25, .78, .75, .85)),
  f(8,  b('KOK PIALA SEMEWAH', .18, .76, .82, .86)),
  f(12, b('REPLIKA RESMI YANG', .20, .75, .80, .86)),
], 26.935);
assert.equal(hybrid.outcome, 'subtitle');
assert.equal(hybrid.trim_start, 4);
assert.equal(hybrid.mute_audio, true);
assert.ok(hybrid.subtitle_blur.length >= 3);
assert.ok(hybrid.subtitle_blur.every((r) => r.y > .70));

const watermark = classifyOcrFrames([
  f(1, b('@channel', .86, .03, .98, .06)),
  f(3, b('@channel', .86, .03, .98, .06)),
  f(8, b('@channel', .86, .03, .98, .06)),
], 10);
assert.equal(watermark.outcome, 'clean');
```

Also add cover-only, subtitle-only, moving-band, and two-line envelope cases.

- [ ] **Step 2: Verify RED**

Run: `bun scout/lib/subtitle_vision.test.ts`

Expected: missing `classifyOcrFrames` or hybrid trim remains zero.

- [ ] **Step 3: Implement classifier**

Implement pure helpers `normText`, `area`, `iou`, `verticalOverlap`, `textSimilarity`, and padded `envelope`. Apply exact policy:

1. Ignore stable small tracks: area below .02, text stable, IoU >= .6 in at least 60% of usable frames.
2. Intro headline: t <= 5, area >= .04, at least two samples with text similarity >= .5 and IoU >= .45, then absent later.
3. `trim_start`: midpoint from last headline sample to first later sample without that track.
4. Subtitle: post-trim boxes width >= .18 and height >= .025, repeated positional band, changing recognized text.
5. Each subtitle sample gets midpoint-bounded source-time window and padded envelope.
6. Merge adjacent windows only at geometry IoU >= .6.
7. Hybrid verdict remains `outcome:'subtitle'` but retains positive trim.

- [ ] **Step 4: Verify GREEN and typecheck**

```powershell
bun scout/lib/subtitle_vision.test.ts
Push-Location scout
bun run typecheck
Pop-Location
```

- [ ] **Step 5: Commit**

```powershell
git add scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts
git commit -m "feat(scout): track headline and subtitle independently"
```

---

### Task 3: Call DeepSeek-OCR, probe real duration, and log safe diagnostics

**Files:**
- Modify: `scout/lib/subtitle_vision.test.ts`
- Modify: `scout/lib/subtitle_vision.ts`

**Interfaces:**
- Produces: existing `analyzeSubtitles(videoUrl,duration?)`.
- Writes: `scout/output/subtitle_ocr_debug.jsonl`.

- [ ] **Step 1: Add failing pure safety tests**

```ts
assert.match(hashVideoId('https://example.test/private?a=secret'), /^[a-f0-9]{16}$/);
assert.equal(parseDuration('26.935011\\n'), 26.935011);
assert.equal(parseDuration('N/A'), 0);
```

- [ ] **Step 2: Verify RED**

Run the detector test; expect missing helper exports.

- [ ] **Step 3: Implement the live adapter**

- Default model: `process.env.THOTH_SUBTITLE_OCR_MODEL || 'deepseek/deepseek-ocr'`.
- FFprobe real duration when caller duration is absent/zero.
- Extract frames at width 960 and JPEG quality 4.
- Call `https://api.novita.ai/v3/openai/chat/completions`.
- Request one high-detail image plus `<|grounding|>OCR this image.`.
- Use `max_tokens:4096`, `temperature:0`.
- Parse with `parseDeepSeekOcr`.
- A failed frame becomes `{boxes:[],error:'http_###'|error.name}`; all failed frames return clean.
- Hash URL with SHA-256 and keep first 16 hex chars.
- Best-effort append JSONL with model, URL hash, duration, samples, classified boxes, errors, and verdict. Never log URL/key/base64/raw headers.
- Remove Qwen prompt, Qwen parser, and `THOTH_VISION_MODEL_JS` from this detector.

- [ ] **Step 4: Verify GREEN**

Run detector test and scout typecheck; tests must make zero network calls.

- [ ] **Step 5: Commit**

```powershell
git add scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts
git commit -m "feat(scout): use DeepSeek OCR for subtitle geometry"
```

---

### Task 4: Preserve trim on hybrid main emission

**Files:**
- Modify: `scout/lib/subtitle_vision.test.ts`
- Modify: `scout/lib/subtitle_vision.ts`
- Modify: `scout/pipeline/trace_source.ts`
- Modify: `scout/pipeline/build_footage.ts`

**Interfaces:**
- Produces: main may carry trim + mute + blur simultaneously.

- [ ] **Step 1: Add failing policy test**

```ts
assert.deepEqual(mainDirectiveFields({
  outcome: 'subtitle',
  trim_start: 4,
  mute_audio: true,
  subtitle_blur: [{ x:.1, y:.7, w:.8, h:.1, start:5, end:8 }],
}), {
  trim_start: 4,
  mute_audio: true,
  subtitle_blur: [{ x:.1, y:.7, w:.8, h:.1, start:5, end:8 }],
});
```

- [ ] **Step 2: Verify RED**

Run the detector test; expect missing helper.

- [ ] **Step 3: Implement and wire**

```ts
export function mainDirectiveFields(v: ClipVerdict) {
  return {
    ...(v.trim_start > 0 ? { trim_start: v.trim_start } : {}),
    ...(v.outcome === 'subtitle'
      ? { mute_audio: true, subtitle_blur: v.subtitle_blur }
      : {}),
  };
}
```

In finalized-main handling, use `Object.assign(set.main, mainDirectiveFields(mv))` instead of cover/else-if. In footage handling, reject any `outcome==='subtitle'`; otherwise emit trim whenever positive.

- [ ] **Step 4: Verify GREEN**

Run detector tests and scout typecheck.

- [ ] **Step 5: Commit**

```powershell
git add scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts scout/pipeline/trace_source.ts scout/pipeline/build_footage.ts
git commit -m "fix(scout): preserve headline trim on subtitle main"
```

---

### Task 5: Add pure Rust source timing and blur projection

**Files:**
- Create: `crates/thoth-core/src/edit/source_timing.rs`
- Modify: `crates/thoth-core/src/edit/mod.rs`

**Interfaces:**
- Produces: `clamp_segment`, `project_blur_regions`, `clean_loop_video_prefix`, `clean_loop_audio_prefix`.

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn clamps_segment_after_intro() {
    assert_eq!(clamp_segment(0.0, 8.0, 26.0, 4.0), (4.0, 12.0));
}
#[test]
fn projects_after_trim() {
    let got = project_blur_regions(&[blur(5.0, 8.0)], 4.0, 26.0, 10.0, false);
    assert_eq!((got[0].start, got[0].end), (1.0, 4.0));
}
#[test]
fn repeats_for_clean_loop() {
    let got = project_blur_regions(&[blur(5.0, 8.0)], 4.0, 10.0, 14.0, true);
    let times: Vec<_> = got.iter().map(|r| (r.start,r.end)).collect();
    assert_eq!(times, vec![(1.0,4.0),(7.0,10.0),(13.0,14.0)]);
}
#[test]
fn clean_loop_filters_remove_every_intro() {
    assert!(clean_loop_video_prefix(26.935,4.0)
        .contains("gte(mod(t\\\\,26.935000)\\\\,4.000000)"));
    assert!(clean_loop_audio_prefix(26.935,4.0)
        .contains("aselect='gte(mod(t\\\\,26.935000)\\\\,4.000000)'"));
}
```

- [ ] **Step 2: Register module and verify RED**

Add `pub(crate) mod source_timing;` to `edit/mod.rs`.

Run: `cargo test -p thoth-core source_timing --no-run`

Expected: missing-function errors.

- [ ] **Step 3: Implement**

`clamp_segment` preserves requested duration while moving start to at least trim and clamping to source duration. `project_blur_regions` intersects source windows with the clean segment, subtracts segment start, duplicates by clean-span for looped output, truncates final repeat, and treats `start=end=0` as the whole selected segment.

Loop prefixes are exactly:

```rust
format!("select='gte(mod(t\\\\,{source_duration:.6})\\\\,{trim_start:.6})',setpts=N/FRAME_RATE/TB")
format!("aselect='gte(mod(t\\\\,{source_duration:.6})\\\\,{trim_start:.6})',asetpts=N/SR/TB")
```

- [ ] **Step 4: Verify GREEN**

Run: `cargo test -p thoth-core source_timing`

- [ ] **Step 5: Commit**

```powershell
git add crates/thoth-core/src/edit/source_timing.rs crates/thoth-core/src/edit/mod.rs
git commit -m "feat(core): map source trim and blur timing"
```

---

### Task 6: Apply clean main loop and output-relative blur in both render modes

**Files:**
- Modify: `crates/thoth-core/src/edit/ffmpeg.rs`
- Modify: `crates/thoth-core/src/edit/service.rs`

**Interfaces:**
- Adds: `AudioOptions.source_duration_secs`, `AudioOptions.source_trim_start`.

- [ ] **Step 1: Add failing FFmpeg tests**

```rust
#[test]
fn looped_main_filter_removes_intro_each_cycle() {
    let f = build_main_timing_prefix(true,26.935,4.0,44.65,0.0,44.65);
    assert!(f.contains("select='gte(mod(t\\\\,26.935000)\\\\,4.000000)'"));
    assert!(f.contains("trim=duration=44.650"));
}
#[test]
fn non_loop_filter_keeps_exact_segment() {
    assert_eq!(
      build_main_timing_prefix(false,26.935,4.0,8.0,4.0,12.0),
      "trim=start=4.000:end=12.000,setpts=PTS-STARTPTS"
    );
}
```

- [ ] **Step 2: Verify RED**

Run the first test with `--no-run`; expect missing helper/fields.

- [ ] **Step 3: Implement FFmpeg timing**

Add both timing fields to `AudioOptions` and every constructor. For loop+positive trim, prepend Task 5 video `select` then trim by output duration. Apply Task 5 audio `aselect` before event/main audio trim. Zero trim retains byte-equivalent legacy filters.

- [ ] **Step 4: Wire service paths**

Clip fallback: clamp segment, set timing fields, and project blur non-loop.

Narration:
- clean start = clamped main trim;
- clean duration = source duration - clean start;
- loop decision uses clean duration;
- logical loop segment is `[clean_start,video_dur]`;
- set timing fields;
- project subtitle windows for chosen segment and every loop;
- never clone source-time regions directly into `AudioOptions`.

- [ ] **Step 5: Verify GREEN**

```powershell
cargo test -p thoth-core source_timing
cargo test -p thoth-core looped_main_filter_removes_intro_each_cycle
cargo test -p thoth-core subtitle_blur_overlay_gates_and_uniquely_labels
```

- [ ] **Step 6: Commit**

```powershell
git add crates/thoth-core/src/edit/ffmpeg.rs crates/thoth-core/src/edit/service.rs
git commit -m "fix(core): trim every main loop and project blur windows"
```

---

### Task 7: Honor footage trim during download/cache

**Files:**
- Modify: `crates/thoth-core/src/edit/overlay.rs`
- Modify: `crates/thoth-core/src/edit/service.rs`

**Interfaces:**
- Changes: `fetch_overlay_from_url` gains `source_start:f64`.

- [ ] **Step 1: Add failing tests**

```rust
#[test]
fn section_includes_trim_and_headroom() {
    assert_eq!(section_download_secs(4.0,6.0),12);
    assert_eq!(section_download_secs(0.0,6.0),8);
}
#[test]
fn cache_identity_includes_source_start() {
    assert_ne!(overlay_cache_identity("https://x/video",0.0),
               overlay_cache_identity("https://x/video",4.0));
}
#[test]
fn trim_args_seek_before_input() {
    let a = trim_clip_args(Path::new("raw.mp4"),Path::new("out.mp4"),4.0,6.0);
    assert_eq!(a, vec!["-y","-ss","4.000","-i","raw.mp4","-t","6.000",
                       "-c","copy","-movflags","+faststart","out.mp4"]);
}
```

- [ ] **Step 2: Verify RED**

Run one named test with `--no-run`; expect missing helpers.

- [ ] **Step 3: Implement**

- Cache identity: URL plus formatted source start, used only for cache hash.
- Download opening seconds: `ceil(source_start + max_duration + 2)`.
- `trim_clip`: seek source start before input and cap duration.
- Real command consumes the same vector produced by tested `trim_clip_args`.
- Signature gains source start after display duration.

- [ ] **Step 4: Pass `cand.trim_start` at all three service call sites**

Primary overlay, extra clip-mode montage, and narration montage must pass the candidate's trim. Future non-content callers pass zero explicitly.

- [ ] **Step 5: Verify GREEN**

Run all three named overlay tests.

- [ ] **Step 6: Commit**

```powershell
git add crates/thoth-core/src/edit/overlay.rs crates/thoth-core/src/edit/service.rs
git commit -m "fix(core): trim footage at clean source in-point"
```

---

### Task 8: Live smoke, full verification, and blueprint

**Files:**
- Modify: `BLUEPRINT.md`

- [ ] **Step 1: Run scout verification**

```powershell
bun scout/lib/subtitle_vision.test.ts
Push-Location scout
bun run typecheck
Pop-Location
```

Expected: all detector tests pass.

- [ ] **Step 2: Run live DeepSeek smoke against reported source**

Expected verdict:
- trim between 3 and 5 seconds;
- outcome subtitle;
- mute true;
- blur regions at/after trim target lower caption bands, not intro headline.

If the observed boxes fail policy, capture them from safe JSONL, first add a failing pure regression, then adjust Task 2 thresholds.

- [ ] **Step 3: Run full Rust suite**

Run: `cargo test -p thoth-core`

Expected: zero failures.

- [ ] **Step 4: Run required CUDA build**

```powershell
cmd /c ".\\build_cuda.bat > build_log.txt 2>&1"
```

Inspect exit code, log, and release binary timestamp. Expected: exit zero and no compile errors.

- [ ] **Step 5: Update blueprint**

Record DeepSeek-OCR bbox grounding, hybrid trim+blur actions, clean main looping, fallback trim, footage trim, and source-to-output blur projection. Date remains 2026-07-22.

- [ ] **Step 6: Final checks and commit docs**

```powershell
git diff --check
git status --short
git add BLUEPRINT.md
git commit -m "docs(blueprint): record DeepSeek OCR subtitle tracking"
```

Confirm unrelated pre-existing dirty files remain untouched.

## Self-Review

- Spec coverage: Tasks 1–4 cover OCR/model/classification/diagnostics; Tasks 5–7 cover main, loop, fallback, blur time mapping, and footage; Task 8 covers live and full verification.
- Type consistency: scout retains `x/y/w/h/start/end`; Rust retains `SubtitleBlur` and changes only timing.
- Placeholder scan: no TBD/TODO; every production task begins with a named failing test and expected failure.


