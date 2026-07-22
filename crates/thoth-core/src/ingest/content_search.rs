//! Content data model + scout content-set loader.
//!
//! Content discovery (multi-platform search) is no longer done inside Thoth —
//! it is handled upstream by the `scout/` layer, which curates the main clippable
//! video plus a pool of relevant footage and hands them to Thoth via
//! `thoth run --content <set.json>`.
//!
//! This module keeps:
//!   - [`ContentResult`]: the normalized footage-pool item consumed by the edit
//!     stage (cutaways) and narration enrichment. Its on-disk form is the
//!     `content_enrichment.json` file written into the job's output dir.
//!   - [`load_content_set`]: parse the scout `--content` file into a main URL
//!     and the footage pool.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// One normalized footage item. `content_enrichment.json` is a `Vec<ContentResult>`.
/// `platform` + `url` are required; everything else defaults so scout can send
/// a minimal entry (`{"platform": "...", "url": "..."}`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContentResult {
    pub platform: String,
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub published: Option<String>,
    #[serde(default)]
    pub thumbnail: String,
    #[serde(default)]
    pub is_video: bool,
    #[serde(default)]
    pub duration_sec: u64,
    #[serde(default)]
    pub views: u64,
    #[serde(default)]
    pub query: String,
    /// What this footage SHOWS — the clip's own caption (video oEmbed) or post text
    /// (cropped post), supplied by scout (`build_footage.js`). Used by the narration
    /// edit stage to PLACE each cutaway where it semantically matches the narration
    /// (embed this vs the script segment, cosine). Empty = fall back to round-robin.
    #[serde(default)]
    pub description: String,
    /// Relevance verdict from the upstream curation layer: `"match"` (verified
    /// relevant) or `"unverified"`. Empty when unknown. The enrichment loader
    /// drops `"unverified"` items to avoid noisy cutaways.
    #[serde(default)]
    pub relevance: String,
    /// Local path to a clean cropped screenshot of this post, supplied by scout
    /// when the item is NOT a video (`is_video == false` — tweet/IG photo/article).
    /// yt-dlp cannot fetch such posts, so scout screenshots + vision-crops them
    /// and passes the saved PNG here. The edit stage renders it as a static image
    /// CARD (see `enrichment::load_image_pool`). Empty for video items.
    #[serde(default)]
    pub image_path: String,
    /// Seconds to trim from the start (skip a cover/headline intro baked into
    /// the source clip). Supplied by scout when it couldn't avoid picking a
    /// video with an unavoidable intro. `0.0` = no trim.
    #[serde(default)]
    pub trim_start: f64,
    /// Drop this item's own audio track (e.g. a reaction upload whose audio
    /// would clash with the narration voiceover). Supplied by scout.
    #[serde(default)]
    pub mute_audio: bool,
    /// Regions/time-windows of baked-in subtitles scout couldn't avoid, to be
    /// blurred out during render. Empty = nothing to blur.
    #[serde(default)]
    pub subtitle_blur: Vec<SubtitleBlur>,
}

/// The MAIN clippable video chosen by scout. Only `url` is required — ingest
/// (yt-dlp) re-derives title/channel/duration on download; the extra fields are
/// accepted for logging/forward-compat and otherwise ignored.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MainVideo {
    pub url: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub title: String,
    /// Platform caption/description of the main post (TikTok caption, YouTube
    /// description, tweet body, IG caption). Supplied by scout. For raw b-roll
    /// with no spoken narration this carries the topic — the narration stage uses
    /// it (with the title + top comments) to GROUND the script instead of
    /// hallucinating from a near-empty transcript. Empty = unknown.
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub is_video: bool,
    #[serde(default)]
    pub duration_sec: u64,
    /// Local path to a clean cropped screenshot of the main post, supplied by
    /// scout when `is_video == false`. (The current pipeline still expects a
    /// downloadable `url` for the main subject; this field is accepted for
    /// forward-compat and surfaced via `LoadedSet::main_image_path`.)
    #[serde(default)]
    pub image_path: String,
    /// Real social profile of the main subject, scraped by scout. Replaces the
    /// LLM-guessed `character_*` fields in the Beat-2 profile card (factual, no
    /// hallucinated follower counts). `None` = fall back to the LLM's guess.
    #[serde(default)]
    pub profile: Option<ProfileInfo>,
    /// Seconds to trim from the start (skip a cover/headline intro baked into
    /// the source clip). Supplied by scout when it couldn't avoid picking a
    /// video with an unavoidable intro. `0.0` = no trim.
    #[serde(default)]
    pub trim_start: f64,
    /// Drop this item's own audio track (e.g. a reaction upload whose audio
    /// would clash with the narration voiceover). Supplied by scout.
    #[serde(default)]
    pub mute_audio: bool,
    /// Regions/time-windows of baked-in subtitles scout couldn't avoid, to be
    /// blurred out during render. Empty = nothing to blur.
    #[serde(default)]
    pub subtitle_blur: Vec<SubtitleBlur>,
}

/// A region + time-window of baked-in subtitles to blur during render.
/// `x`,`y`,`w`,`h` are normalized (0.0-1.0) region coordinates; `start`,`end`
/// are seconds into the clip the blur should be active.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SubtitleBlur {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default)]
    pub start: f64,
    #[serde(default)]
    pub end: f64,
}

/// Real social-profile metadata for the Beat-2 character intro card. Acquired by
/// scout (browser/xpoz) so the on-screen handle + follower count are factual.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ProfileInfo {
    /// Display name (e.g. "Heru Gundul"). Empty = keep the LLM's `character_name`.
    #[serde(default)]
    pub name: String,
    /// Handle WITHOUT `@` (e.g. "heru_gundul").
    #[serde(default)]
    pub handle: String,
    /// Follower/like blurb exactly as shown on the platform (e.g. "153K followers").
    #[serde(default)]
    pub followers: String,
    /// Direct URL to the profile avatar image. Thoth downloads it locally and
    /// composites the real photo into the card. Empty = drawn initial tile.
    #[serde(default)]
    pub avatar_url: String,
    /// Local path to a pre-cropped screenshot of the source's PROFILE CARD (avatar +
    /// name + follower/like counts), produced by scout. When set + file exists, the
    /// edit stage pastes this real crop instead of drawing the synthetic card.
    #[serde(default)]
    pub image_path: String,
}

/// One real viral comment scraped by scout from the source video/post. Rendered
/// as a screenshot-style card in the reaction beat (`src/edit/comment_card.rs`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct CommentInfo {
    /// Comment author display name or handle (shown bold). Required to render.
    #[serde(default)]
    pub author: String,
    /// Comment body text.
    #[serde(default)]
    pub text: String,
    /// Like count shown next to the heart. 0 = hide the count.
    #[serde(default)]
    pub likes: u64,
    /// Direct URL to the commenter's avatar image. Empty = drawn initial tile.
    #[serde(default)]
    pub avatar_url: String,
    /// Local path to a pre-cropped screenshot of THIS comment, produced by scout
    /// (`scrape_comments.js`). When set + file exists, the edit stage pastes this real
    /// crop instead of drawing the synthetic card. The text/likes are still used for
    /// narration grounding. Empty = render the drawn card.
    #[serde(default)]
    pub image_path: String,
    /// One-line decoded MEANING of this comment (subtext + tone), produced by scout
    /// `enrich_context.js`. Lets the narrator read sarcasm/coded references correctly instead
    /// of taking the literal text at face value. Empty = no enrichment (older sets).
    #[serde(default)]
    pub context: String,
}

/// A cultural/contextual REFERENCE resolved by scout `enrich_context.js` from the caption +
/// comments — a named entity, meme, coded term, or recent event the audience assumes you know
/// (e.g. "Nadiem Makarim", "konoha", the "10+6=17" gaffe). Feeds the narrator a factual explainer
/// so the script sounds informed, not naive. `[]` = no enrichment / nothing notable.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Reference {
    /// The term as it appears / its canonical name (e.g. "konoha", "Nadiem Makarim").
    #[serde(default)]
    pub term: String,
    /// "person" | "org" | "place" | "event" | "meme" | "slang".
    #[serde(default)]
    pub kind: String,
    /// 1–2 sentence factual explainer of what it is and why it matters here.
    #[serde(default)]
    pub summary: String,
    /// As-of date of the summary (e.g. "2026-05") when web-grounded — status changes over time
    /// (tersangka→divonis). Empty = not grounded / not time-sensitive.
    #[serde(default)]
    pub as_of_date: String,
    /// Source URL backing a web-grounded summary (provenance). Empty = model knowledge only.
    #[serde(default)]
    pub source_url: String,
}

/// The COLLECTIVE audience reading of the comments, synthesized by `enrich_context.js`. Without it
/// the narrator misreads coded sarcasm as literal complaints (e.g. "blaming netizens"). All fields
/// empty = no enrichment.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Discourse {
    /// What the audience collectively means/feels (e.g. "sarkasme protektif: warganet menyarankan
    /// sang diaspora JANGAN pulang karena Indonesia dinilai menjerat talentanya").
    #[serde(default)]
    pub audience_stance: String,
    /// Recurring themes behind the comments.
    #[serde(default)]
    pub themes: Vec<String>,
    /// One-line steer for the narrator (tone/angle to take given the stance).
    #[serde(default)]
    pub narration_guidance: String,
    /// Currently-live discourse terms/memes (from the daily Cultural Pulse harvest) — a STYLE/jargon
    /// reference the narrator may use when relevant, NOT a topic to force. `[]` when no pulse data.
    #[serde(default)]
    pub trends: Vec<String>,
}

/// A FIGURE the topic is about — a named person, organization, or community.
/// Extracted by scout (`extract_figures.js`) from the main title/description.
/// Empty list = no specific notable figure (e.g. an ordinary anonymous person).
/// Used to ground the narration in the real subject (and, optionally, a subject card).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Figure {
    /// Figure name (e.g. "Silmy Karim", "HIPMI").
    #[serde(default)]
    pub name: String,
    /// "person" | "organization" | "community".
    #[serde(default, rename = "type")]
    pub kind: String,
    /// Short role/title (e.g. "eks Wamen Imigrasi", "Menteri Investasi").
    #[serde(default)]
    pub role: String,
    /// One-sentence context about the figure in this topic.
    #[serde(default)]
    pub description: String,
}

/// Topic Dossier (scout `topic_dossier.ts`): entities + relations + story angles for narration
/// grounding. `search_queries` is scout-only (drives footage search) — NOT carried into Rust.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Dossier {
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub entities: Vec<Reference>,
    #[serde(default)]
    pub relations: Vec<String>,
    #[serde(default)]
    pub angles: Vec<String>,
    #[serde(default)]
    pub timeline: Vec<String>,
}

/// The scout content set passed via `thoth run --content <set.json>`:
/// one main video to clip + a footage pool for cutaways/narration enrichment +
/// (optionally) the subject's real profile and scraped viral comments.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContentSet {
    pub main: MainVideo,
    #[serde(default)]
    pub footage: Vec<ContentResult>,
    /// Real viral comments for the reaction-beat comment cards.
    #[serde(default)]
    pub comments: Vec<CommentInfo>,
    /// Figures (person/org/community) the topic is about. Narration grounding.
    #[serde(default)]
    pub figures: Vec<Figure>,
    /// Cultural references resolved by `enrich_context.js` (entities/memes/slang/events).
    #[serde(default)]
    pub references: Vec<Reference>,
    /// Collective audience reading of the comments (so the narrator doesn't misread sarcasm).
    #[serde(default)]
    pub discourse: Discourse,
    /// Topic dossier (entities/relations/angles/timeline) from scout `topic_dossier.ts`.
    /// Narration grounding. `[]`/empty defaults when scout doesn't supply one.
    #[serde(default)]
    pub dossier: Dossier,
}

/// Parsed content set, split into the parts each pipeline stage consumes.
#[derive(Debug, Clone)]
pub struct LoadedSet {
    /// The main video URL to download + clip (Stage 1 ingest).
    pub main_url: String,
    /// Title of the main post (for narration grounding via `content_context.json`).
    pub main_title: String,
    /// Platform caption/description of the main post (narration grounding).
    pub main_description: String,
    /// Footage pool → written to `content_enrichment.json` (cutaways/enrichment).
    pub footage: Vec<ContentResult>,
    /// Real subject profile for the Beat-2 card. `None` = LLM fallback.
    pub profile: Option<ProfileInfo>,
    /// Scraped viral comments for reaction-beat comment cards.
    pub comments: Vec<CommentInfo>,
    /// Clean cropped screenshot of the main post when it is non-video. Empty for
    /// video mains. Rendered as a still→video MAIN when `main_is_video == false`.
    pub main_image_path: String,
    /// Whether the main post is a downloadable video. `false` = non-video post
    /// (photo/slide) → the edit uses `main_image_path` as a still-image MAIN.
    pub main_is_video: bool,
    /// Figures (person/org/community) the topic is about. `[]` when none. Narration grounding.
    pub figures: Vec<Figure>,
    /// Cultural references resolved by `enrich_context.js`. `[]` when none.
    pub references: Vec<Reference>,
    /// Collective audience reading of the comments. Empty fields when none.
    pub discourse: Discourse,
    /// Topic dossier (entities/relations/angles/timeline). Empty defaults when none.
    pub dossier: Dossier,
    /// Cover/headline intro to skip on the main B-roll (seconds). `0.0` = none.
    pub main_trim_start: f64,
    /// Drop the main clip's baked audio (reaction/subtitle source). `false` = keep.
    pub main_mute_audio: bool,
    /// Baked-subtitle regions to blur-censor on the main (source-normalized). `[]` = none.
    pub main_subtitle_blur: Vec<SubtitleBlur>,
}

/// Load and validate an scout content set file.
///
/// The caller writes `footage` to the job's `content_enrichment.json`, downloads
/// any avatar images, and writes the profile/comment sidecars the edit stage reads.
pub fn load_content_set(path: &Path) -> anyhow::Result<LoadedSet> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("cannot read content set {}: {e}", path.display()))?;
    let set: ContentSet = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("cannot parse content set {}: {e}", path.display()))?;
    if set.main.url.trim().is_empty() {
        anyhow::bail!("content set {}: main.url is empty", path.display());
    }
    Ok(LoadedSet {
        main_url: set.main.url,
        main_title: set.main.title,
        main_description: set.main.description,
        footage: set.footage,
        profile: set.main.profile,
        comments: set.comments,
        main_image_path: set.main.image_path,
        main_is_video: set.main.is_video,
        figures: set.figures,
        references: set.references,
        discourse: set.discourse,
        dossier: set.dossier,
        main_trim_start: set.main.trim_start,
        main_mute_audio: set.main.mute_audio,
        main_subtitle_blur: set.main.subtitle_blur,
    })
}

/// Sidecar (in the job base dir) holding the MAIN video's textual context — its
/// title and platform caption/description, supplied by scout. The narration
/// stage reads this so the script is GROUNDED in the real topic even when the
/// spoken transcript is empty (raw b-roll). Written by `main.rs` from `--content`.
pub const MAIN_CONTEXT_FILE: &str = "content_context.json";

/// On-disk form of [`MAIN_CONTEXT_FILE`]: the main video's title + description.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct MainContext {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Figures (person/org/community) the topic is about — narration grounding so the
    /// script names the real subject instead of guessing. `[]` when none.
    #[serde(default)]
    pub figures: Vec<Figure>,
    /// Resolved cultural references (entities/memes/slang/events) — narration grounding so
    /// the script sounds informed about what the audience is referencing. `[]` when none.
    #[serde(default)]
    pub references: Vec<Reference>,
    /// Collective audience reading of the comments — so the narrator reads sarcasm/coded
    /// references correctly instead of taking them literally. Empty fields when none.
    #[serde(default)]
    pub discourse: Discourse,
    /// Topic dossier (entities/relations/angles/timeline) from scout `topic_dossier.ts` —
    /// narration grounding. Empty defaults when scout didn't supply one.
    #[serde(default)]
    pub dossier: Dossier,
    /// Cover/headline intro to skip on the main B-roll, in seconds (scout's
    /// cover-exception: text only in the first few seconds → trim, don't blur).
    /// `0.0` = no trim.
    #[serde(default)]
    pub trim_start: f64,
    /// Drop the main clip's baked audio from the mix — set when the main is a
    /// reaction/subtitle-baked source whose talking must not leak. `false` = keep.
    #[serde(default)]
    pub mute_audio: bool,
    /// Baked-subtitle regions to blur-censor on the main clip, normalized against
    /// the SOURCE frame. `[]` = no censor.
    #[serde(default)]
    pub subtitle_blur: Vec<SubtitleBlur>,
}

/// Load the main-context sidecar from `base_dir/content_context.json`. Returns
/// `None` when absent/unparseable (narration then falls back to the transcript).
pub fn load_main_context(base_dir: &Path) -> Option<MainContext> {
    let raw = std::fs::read_to_string(base_dir.join(MAIN_CONTEXT_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Assemble the `MainContext` sidecar from a loaded content-set. Used by `lib.rs` when
/// handling `thoth run --content <set.json>` (extracted here so it's unit-testable).
pub fn to_main_context(set: LoadedSet) -> MainContext {
    MainContext {
        title: set.main_title.trim().to_string(),
        description: set.main_description.trim().to_string(),
        figures: set.figures,
        references: set.references,
        discourse: set.discourse,
        dossier: set.dossier,
        trim_start: set.main_trim_start,
        mute_audio: set.main_mute_audio,
        subtitle_blur: set.main_subtitle_blur,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn loads_main_and_footage() {
        let json = r#"{
            "main": { "url": "https://youtu.be/abc", "platform": "youtube",
                      "is_video": true, "duration_sec": 600 },
            "footage": [
                { "platform": "youtube",   "url": "https://youtu.be/x", "is_video": true, "relevance": "match" },
                { "platform": "instagram", "url": "https://ig/y" }
            ]
        }"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        let set = load_content_set(f.path()).unwrap();
        assert_eq!(set.main_url, "https://youtu.be/abc");
        assert_eq!(set.footage.len(), 2);
        assert_eq!(set.footage[0].platform, "youtube");
        assert!(set.profile.is_none());
        assert!(set.comments.is_empty());
    }

    #[test]
    fn empty_main_url_errors() {
        let json = r#"{ "main": { "url": "" }, "footage": [] }"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        assert!(load_content_set(f.path()).is_err());
    }

    #[test]
    fn footage_defaults_to_empty() {
        let json = r#"{ "main": { "url": "https://youtu.be/abc" } }"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        let set = load_content_set(f.path()).unwrap();
        assert_eq!(set.main_url, "https://youtu.be/abc");
        assert!(set.footage.is_empty());
    }

    #[test]
    fn loads_profile_and_comments() {
        let json = r#"{
            "main": {
                "url": "https://youtu.be/abc",
                "profile": { "name": "Heru Gundul", "handle": "heru_gundul",
                             "followers": "153K followers",
                             "avatar_url": "https://cdn/av.jpg" }
            },
            "comments": [
                { "author": "@netizen1", "text": "anjir parah sih ini", "likes": 1200,
                  "avatar_url": "https://cdn/c1.jpg" },
                { "author": "warga +62", "text": "wkwk ngakak" }
            ]
        }"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        let set = load_content_set(f.path()).unwrap();
        let p = set.profile.expect("profile present");
        assert_eq!(p.handle, "heru_gundul");
        assert_eq!(p.followers, "153K followers");
        assert_eq!(set.comments.len(), 2);
        assert_eq!(set.comments[0].likes, 1200);
        assert_eq!(set.comments[1].likes, 0); // defaulted
    }

    #[test]
    fn loads_image_path_for_non_video() {
        let json = r#"{
            "main": { "url": "https://tt/v", "is_video": true },
            "footage": [
                { "platform": "twitter", "url": "https://x/1", "is_video": false,
                  "image_path": "C:\\crops\\a.png", "relevance": "match" },
                { "platform": "youtube", "url": "https://yt/2", "is_video": true }
            ]
        }"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        let set = load_content_set(f.path()).unwrap();
        assert_eq!(set.footage[0].image_path, "C:\\crops\\a.png");
        assert!(!set.footage[0].is_video);
        assert!(set.footage[1].image_path.is_empty()); // defaulted for video item
        assert!(set.main_image_path.is_empty());
    }

    #[test]
    fn content_set_parses_dossier_into_main_context() {
        let json = r#"{
            "main": {"url":"u","title":"T","description":"D"},
            "footage": [], "comments": [],
            "dossier": {
                "topic":"Kasus X",
                "entities":[{"term":"Nvidia","kind":"org","summary":"chip"}],
                "relations":["A kaitan B"],
                "angles":["sudut 1"],
                "search_queries":[{"q":"chip ai","for":"entity:nvidia"}],
                "timeline":["t1"]
            }
        }"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        let set = load_content_set(f.path()).unwrap();
        let ctx = to_main_context(set);
        assert_eq!(ctx.dossier.topic, "Kasus X");
        assert_eq!(ctx.dossier.entities.len(), 1);
        assert_eq!(ctx.dossier.angles, vec!["sudut 1".to_string()]);
        assert_eq!(ctx.dossier.timeline, vec!["t1".to_string()]);
    }

    #[test]
    fn content_set_without_dossier_defaults_empty() {
        let json = r#"{"main":{"url":"u"},"footage":[],"comments":[]}"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        let set = load_content_set(f.path()).unwrap();
        let ctx = to_main_context(set);
        assert!(ctx.dossier.topic.is_empty());
        assert!(ctx.dossier.entities.is_empty());
    }

    #[test]
    fn loads_main_title_and_description() {
        let json = r#"{
            "main": {
                "url": "https://tt/v", "is_video": true,
                "title": "Dadan Hindayana ditangkap",
                "description": "Kepala BGN Dadan Hindayana resmi ditahan terkait dugaan korupsi MBG."
            }
        }"#;
        let mut f = tempfile_like();
        f.write_all(json.as_bytes()).unwrap();
        let set = load_content_set(f.path()).unwrap();
        assert_eq!(set.main_title, "Dadan Hindayana ditangkap");
        assert!(set.main_description.contains("korupsi MBG"));
    }

    /// Minimal temp-file helper (avoids adding a dev-dependency).
    struct TmpFile(std::path::PathBuf, std::fs::File);
    impl TmpFile {
        fn path(&self) -> &std::path::Path { &self.0 }
    }
    impl std::ops::Deref for TmpFile {
        type Target = std::fs::File;
        fn deref(&self) -> &std::fs::File { &self.1 }
    }
    impl std::io::Write for TmpFile {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.1.write(buf) }
        fn flush(&mut self) -> std::io::Result<()> { self.1.flush() }
    }
    impl Drop for TmpFile {
        fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
    }
    fn tempfile_like() -> TmpFile {
        let mut p = std::env::temp_dir();
        p.push(format!("thoth_cset_{}.json", uuid::Uuid::new_v4()));
        let f = std::fs::File::create(&p).unwrap();
        TmpFile(p, f)
    }

    #[test]
    fn subtitle_fields_default_and_parse() {
        // legacy JSON without the fields → defaults
        let m: MainVideo = serde_json::from_str(r#"{"url":"u","is_video":true}"#).unwrap();
        assert_eq!(m.trim_start, 0.0);
        assert!(!m.mute_audio);
        assert!(m.subtitle_blur.is_empty());

        // new JSON populates them
        let m2: MainVideo = serde_json::from_str(
            r#"{"url":"u","is_video":true,"trim_start":4.0,"mute_audio":true,
                 "subtitle_blur":[{"x":0.1,"y":0.7,"w":0.8,"h":0.08,"start":6.0,"end":14.0}]}"#).unwrap();
        assert_eq!(m2.trim_start, 4.0);
        assert!(m2.mute_audio);
        assert_eq!(m2.subtitle_blur.len(), 1);
        assert_eq!(m2.subtitle_blur[0].w, 0.8);
        assert_eq!(m2.subtitle_blur[0].end, 14.0);
    }
}
