use serde::{Deserialize, Serialize};

/// Visual quality scores assigned by a vision LLM after analyzing video frames.
///
/// All scores are 0–10. Stored in moments.json when `[vision] enabled = true`.
/// Used to re-rank candidate moments alongside the text-based LLM ranking.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VisualScore {
    /// Funny expressions, reactions, comedic timing (0–10)
    pub humor: u8,
    /// Graphics, text overlays, charts, dramatic visuals (0–10)
    pub visual_impact: u8,
    /// New on-screen information: charts, demos, data reveals (0–10)
    pub novelty: u8,
    /// Eye contact, gestures, pacing, overall watchability (0–10)
    pub engagement: u8,
    /// One-sentence description of what the vision model saw
    #[serde(default)]
    pub note: String,
}

impl VisualScore {
    /// Normalised combined score 0.0–1.0 (sum of four 0-10 scores / 40).
    pub fn combined(&self) -> f32 {
        (self.humor as f32
            + self.visual_impact as f32
            + self.novelty as f32
            + self.engagement as f32)
            / 40.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViralMoment {
    /// Punchy hook title — drives clicks (≤60 chars, must use a proven formula)
    pub title: String,
    /// Visual on-screen headline for the lower-third panel overlay (≤44 chars, news-ticker style).
    /// Shown in ALL CAPS on the video. Different from `title` — designed for visual impact,
    /// not social media SEO. Empty = fallback to `title`.
    #[serde(default)]
    pub headline: String,
    pub start_sec: f64,
    pub end_sec: f64,
    /// Specific reason this moment goes viral (tension, surprise, value — be concrete)
    pub reason: String,
    /// Exact first words spoken — the 3-second scroll-stopper shown as overlay
    pub hook: String,
    /// Full social caption: hook restate + insight expand + CTA + hashtags
    pub caption: String,
    /// Primary viral mechanism driving shares/saves
    pub viral_type: String,
    /// Auto-detected content category
    pub content_category: String,
    /// Who this clip resonates with most (1 sentence)
    pub target_audience: String,
    /// Primary emotion the clip evokes in the viewer
    pub emotional_trigger: String,
    /// Energy level for background music & pacing
    pub energy: String,

    // ── Visual analysis (populated when [vision] enabled = true) ──────────────

    /// Visual quality scores from frame analysis.
    /// `None` when vision is disabled or video unavailable.
    #[serde(default)]
    pub visual_score: Option<VisualScore>,

    // ── Production suggestions (resolved to actual files via config.toml [assets]) ──

    /// Subtitle animation style for this clip.
    /// karaoke | capcut_bold | word_pop | minimal_white
    /// karaoke = classic yellow highlight (default, safe for anything)
    #[serde(default = "default_subtitle_style")]
    pub subtitle_style: String,

    /// Visual transition style for this specific clip.
    /// Picked by the LLM based on energy, viral_type, and emotional_trigger.
    /// fade | flash | zoom | smooth | none
    /// CLI --clip-style overrides this for all clips when specified.
    #[serde(default)]
    pub clip_style: String,

    /// Sound effect "vibe" for the intro hit.
    /// Mapped to an actual file via config.toml [assets.sfx].
    /// impact | whoosh | ding | comedy | none
    /// CLI --sfx overrides this for all clips when specified.
    #[serde(default)]
    pub sfx_vibe: String,

    /// When in the clip to play the SFX (seconds from clip start, NOT video start).
    /// 0.0 = clip start (default hook/intro SFX).
    /// >0  = play at the PEAK MOMENT: stat reveal, punchline, CTA, shocking line.
    /// Example: 30s clip about crypto crash with stat at 8s → sfx_at_sec = 8.0
    #[serde(default)]
    pub sfx_at_sec: f64,

    /// How many seconds the SFX plays (default 2.5, max 5.0).
    #[serde(default = "default_sfx_duration_sec")]
    pub sfx_duration_sec: f64,

    /// Background music "vibe" for the clip.
    /// Mapped to an actual file via config.toml [assets.bgm].
    /// lofi | upbeat | cinematic | inspirational | none
    /// CLI --bgm overrides this for all clips when specified.
    #[serde(default)]
    pub bgm_vibe: String,

    // ── Ground-truth from transcript (populated by enrich_moments_from_transcript) ──

    /// Actual spoken text at the selected time window, extracted from Whisper transcript.
    /// Populated after LLM analysis to ground hook/headline in real content.
    /// Shown in logs; also used by the edit stage to display accurate hook text.
    #[serde(default)]
    pub transcript_segment: String,

    /// Spoken text at the overlay peak moment (start_sec + overlay_at_sec, ~3s window).
    /// Populated by `enrich_moments_from_transcript()` — AFTER LLM analysis.
    /// Used to refine overlay_query with subject/context keywords.
    #[serde(default)]
    pub overlay_context_text: String,

    // ── Overlay (populated when [overlay] enabled = true) ─────────────────────

    /// Rendering style for the overlay clip.
    /// "auto"       = system auto-detects (greenscreen → sticker, portrait → pip, else → fullscreen)
    /// "sticker"    = chromakey greenscreen + corner sticker (reaction face, meme)
    /// "pip"        = small picture-in-picture box in corner (reaction video, duet)
    /// "fullscreen" = full-frame cut-away (B-roll, shocking footage)
    #[serde(default = "default_overlay_style")]
    pub overlay_style: String,

    /// Where to place the sticker/pip overlay in the frame.
    /// "bottom_right" | "bottom_left" | "top_right" | "top_left" | "bottom_center"
    /// Default: "bottom_right" (most common TikTok position).
    /// Choose based on main subject position: subject on right → use bottom_left.
    #[serde(default = "default_overlay_position")]
    pub overlay_position: String,

    /// TikTok/YouTube Shorts search query for the meme-insert overlay.
    /// Empty string = no overlay for this clip.
    /// Examples: "shocked reaction face", "mind blown tiktok", "funny fail meme"
    #[serde(default)]
    pub overlay_query: String,

    /// Seconds from clip start where the overlay should appear (relative timing).
    /// LLM picks the emotional peak: reveal, punchline, shocking stat.
    /// 0 = clip start. Default 5.0 if not specified.
    #[serde(default)]
    pub overlay_at_sec: f64,

    /// How many seconds to show the overlay (default 4.0, recommended 3–5).
    #[serde(default = "default_overlay_duration")]
    pub overlay_duration: f64,

    // ── GPU Color Grading ─────────────────────────────────────────────────────

    /// Color mood / look for this clip.
    /// Resolved to a `ColorGrading` preset by `ColorGrading::from_mood()`.
    /// Options: cinematic | warm | cool | vibrant | faded | night | bright | teal_orange
    /// Empty string = use config `[gpu] default_color_mood` or no grading.
    #[serde(default)]
    pub color_mood: String,

    /// GPU transition type going INTO this clip (from the previous clip).
    /// Uses the same names as `Transition::from_name()`.
    /// Empty string = use global clip_style setting.
    #[serde(default)]
    pub gpu_transition: String,

    // ── Timestamped asset cues (from assets/asset_catalog.json) ───────────────

    /// Extra timestamped SFX / meme-video punch-ins the LLM places throughout the
    /// clip, drawn ONLY from the annotated asset catalog. Empty when no catalog is
    /// available or the clip needs no punctuation. Distinct from the single
    /// `sfx_vibe`/`overlay_query` — this allows several cues per clip.
    #[serde(default)]
    pub asset_cues: Vec<AssetCue>,

    // ── Character intro (Beat-2: name + profile card) ─────────────────────────

    /// Main person/character this clip is about, if any (e.g. "Heru Gundul",
    /// "HoHo"). Drives the Beat-2 name-above-head + profile card. Empty = none.
    #[serde(default)]
    pub character_name: String,

    /// Their social handle EXACTLY as stated/visible in the source, without the
    /// leading @ (e.g. "heru_gundul"). Empty = unknown — never invent one.
    #[serde(default)]
    pub character_handle: String,

    /// Follower/like blurb ONLY if explicitly stated in the transcript
    /// (e.g. "153K followers"). Empty = unknown — never fabricate numbers.
    #[serde(default)]
    pub character_stats: String,

    // ── Number callouts (Beat-3: arrow + figure) ──────────────────────────────

    /// Punchy on-screen callouts for important figures spoken in the clip
    /// (weights, prices, counts, dates). Empty = none.
    #[serde(default)]
    pub callouts: Vec<Callout>,
}

/// One number/fact callout: a big figure with a pointing arrow, shown briefly.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Callout {
    /// Short text to emphasise — usually a number with unit (e.g. "25 KG", "Rp2,5JT").
    pub text: String,
    /// Seconds from clip start, at the moment the figure is spoken.
    #[serde(default)]
    pub at_sec: f64,
    /// How long it stays (seconds). Default 2.0.
    #[serde(default = "default_callout_duration")]
    pub duration_sec: f64,
    /// Where the figure box sits: "center" | "upper" | "lower" | "left" | "right".
    #[serde(default)]
    pub position: String,
    /// Arrow direction toward the subject: "left" | "right" | "up" | "down".
    #[serde(default)]
    pub direction: String,
}

fn default_callout_duration() -> f64 { 2.0 }

/// One timestamped asset punch-in selected from the annotated catalog.
///
/// `file` must match an entry in `assets/asset_catalog.json` exactly. Validated
/// by the analyze service after parsing — unknown files are dropped with a warn.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AssetCue {
    /// Catalog file path, e.g. "assets/sfx/vine-boom.mp3" or "assets/meme/clapping.mp4".
    pub file: String,
    /// Seconds from CLIP start (start_sec) where the cue fires.
    #[serde(default)]
    pub at_sec: f64,
    /// How long the cue plays/shows (seconds). Default 2.0.
    #[serde(default = "default_cue_duration")]
    pub duration_sec: f64,
    /// The catalog trigger this placement matches (e.g. "shock_reveal", "facepalm_react").
    #[serde(default)]
    pub trigger: String,
    /// One-line reason this asset fits this exact moment.
    #[serde(default)]
    pub reason: String,
}

fn default_cue_duration() -> f64 { 2.0 }

fn default_overlay_duration()  -> f64     { 4.0 }
fn default_overlay_style()     -> String  { "auto".to_owned() }
fn default_overlay_position()  -> String  { "bottom_right".to_owned() }
fn default_subtitle_style()    -> String  { "karaoke".to_owned() }
fn default_sfx_duration_sec()  -> f64     { 2.5 }

impl ViralMoment {
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViralMomentList {
    pub moments: Vec<ViralMoment>,
}

/// JSON schema string embedded in the system prompt
pub const MOMENT_SCHEMA: &str = r#"{
  "moments": [
    {
      "title": "string (max 60 chars — hook formula required, see RULE 4)",
      "headline": "string (max 44 chars — news-ticker visual overlay, see RULE 4b)",
      "start_sec": number,
      "end_sec": number,
      "reason": "string (SPECIFIC: what tension/surprise/value makes this viral — not generic)",
      "hook": "string — VERBATIM first 5-8 words spoken at start_sec. Copy from transcript. Do NOT paraphrase.",
      "caption": "string (line1: hook restate | line2: expand insight | line3: CTA | line4: #tag1 #tag2 #tag3)",
      "viral_type": "educational_shock | transformation | controversy | actionable | relatable | blueprint | inspiration | storytelling",
      "content_category": "tech | business | health | finance | lifestyle | relationship | education | entertainment | motivation | other",
      "target_audience": "string (1 sentence: who resonates most with this clip)",
      "emotional_trigger": "curiosity | surprise | validation | inspiration | fear | humor | empathy | admiration",
      "energy": "high | medium | low",
      "subtitle_style": "karaoke | capcut_bold | word_pop | minimal_white",
      "clip_style": "fade | flash | zoom | smooth | none",
      "sfx_vibe": "impact | whoosh | ding | comedy | none",
      "sfx_at_sec": number (seconds from clip start where SFX plays, 0.0 = clip start),
      "sfx_duration_sec": number (how long SFX plays, default 2.5),
      "bgm_vibe": "lofi | upbeat | cinematic | inspirational | none",
      "overlay_style":    "auto | sticker | pip | fullscreen  (see RULE 7)",
      "overlay_position": "bottom_right | bottom_left | top_right | top_left | bottom_center  (see RULE 7)",
      "overlay_query":    "string (3-5 word query for topic-relevant footage/photo/chart — NOT a meme or reaction; empty string = no overlay, see RULE 7)",
      "overlay_at_sec":   number (seconds from clip start where overlay appears),
      "overlay_duration": number (seconds to show overlay, default 4.0),
      "asset_cues": [
        {
          "file": "EXACT path from the ASSET CATALOG section (e.g. assets/sfx/vine-boom.mp3). Never invent files.",
          "at_sec": number (seconds from CLIP start = absolute_time − start_sec; MUST be between 0 and (end_sec−start_sec)),
          "duration_sec": number (default 2.0),
          "trigger": "the catalog trigger that matches what happens at at_sec",
          "reason": "string (1 line: why this asset fits this exact moment)"
        }
      ],
      "character_name":   "string — main person/character this clip is about, or \"\" if none (e.g. \"Heru Gundul\")",
      "character_handle": "string — their social handle WITHOUT @, only if stated/visible, else \"\". Never invent.",
      "character_stats":  "string — follower/like blurb ONLY if explicitly said (e.g. \"153K followers\"), else \"\"",
      "callouts": [
        {
          "text": "short figure spoken in the clip, e.g. \"25 KG\" or \"Rp2,5JT\" (keep it punchy)",
          "at_sec": number (seconds from CLIP start = absolute_time − start_sec, exactly WHEN the figure is spoken; MUST be 0..(end_sec−start_sec)),
          "duration_sec": number (default 2.0),
          "position": "center | upper | lower | left | right",
          "direction": "left | right | up | down  (arrow points toward the subject)"
        }
      ]
    }
  ]
}

NOTE on "asset_cues": OPTIONAL. Include 0–4 cues per clip, ONLY using files listed in
the ASSET CATALOG section of the system prompt. Omit or use [] when no catalog is given
or the clip needs no punctuation."#;
