//! Annotated asset catalog loader for the analyze stage.
//!
//! Reads `assets/asset_catalog.json` (produced by `scripts/media/annotate_assets.py`)
//! and turns it into:
//!   1. a compact prompt section the LLM uses to place timestamped `asset_cues`,
//!   2. a validation set so unknown files emitted by the LLM can be dropped.
//!
//! Everything degrades gracefully: a missing/invalid catalog yields `None`, and
//! the analyze stage simply omits the asset section (the LLM then emits no cues).

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;
use tracing::{debug, info};

#[derive(Debug, Clone, Deserialize)]
pub struct AssetCatalog {
    #[serde(default)]
    pub assets: Vec<AssetEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetEntry {
    pub file: String,
    #[serde(default)]
    pub kind: String, // "audio" | "video" | "font"
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub energy: String,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub place_beats: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<String>,
    #[serde(default)]
    pub placement_mode: String,
    #[serde(default)]
    pub has_audio: Option<bool>,
    #[serde(default)]
    pub min_gap_sec: Option<f64>,
    #[serde(default, rename = "meaning_id")]
    pub meaning: String,
}

impl AssetCatalog {
    /// Load and parse the catalog. Returns `None` (with a debug log) when the file
    /// is absent or unreadable — callers treat that as "no catalog".
    pub fn load(path: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(path).ok()?;
        match serde_json::from_str::<AssetCatalog>(&raw) {
            Ok(cat) => {
                let n = cat.cueable().count();
                info!("🎚️  Asset catalog loaded: {} cueable assets from {}", n, path.display());
                Some(cat)
            }
            Err(e) => {
                debug!("asset catalog parse failed ({}): {e}", path.display());
                None
            }
        }
    }

    /// Assets eligible to be placed as cues (audio SFX + video memes; fonts excluded).
    fn cueable(&self) -> impl Iterator<Item = &AssetEntry> {
        self.assets
            .iter()
            .filter(|a| a.kind == "audio" || a.kind == "video")
    }

    /// Set of valid cue file paths, for post-parse validation of LLM output.
    pub fn valid_files(&self) -> HashSet<String> {
        self.cueable().map(|a| a.file.clone()).collect()
    }

    /// Whether the catalog entry for `file` carries its own audio track.
    /// Used by the edit stage to decide if a meme cue should mix its sound
    /// (and duck the narration). Unknown file ⇒ false.
    pub fn file_has_audio(&self, file: &str) -> bool {
        self.assets
            .iter()
            .find(|a| a.file == file)
            .and_then(|a| a.has_audio)
            .unwrap_or(false)
    }

    /// True when there is at least one cueable asset worth advertising to the LLM.
    pub fn has_cues(&self) -> bool {
        self.cueable().next().is_some()
    }

    /// Build the prompt section: a RULE header + a grouped catalog listing.
    /// Returns an empty string when nothing is cueable.
    pub fn to_prompt_section(&self) -> String {
        if !self.has_cues() {
            return String::new();
        }

        let mut audio = String::new();
        let mut video = String::new();
        for a in self.cueable() {
            let dur = a
                .duration_sec
                .map(|d| format!("{d:.1}s"))
                .unwrap_or_else(|| "—".into());
            let trig = a.triggers.join(", ");
            if a.kind == "video" {
                // include placement_mode + audio caveat for memes
                let mode = if a.placement_mode.is_empty() {
                    "overlay_pip"
                } else {
                    a.placement_mode.as_str()
                };
                let snd = match a.has_audio {
                    Some(true) => " [has own audio — duck narration]",
                    _ => "",
                };
                video.push_str(&format!(
                    "  {} | {} | energy={} | dur={} | {} | triggers: {}{} | {}\n",
                    a.file, a.category, a.energy, dur, mode, trig, snd, a.meaning
                ));
            } else {
                audio.push_str(&format!(
                    "  {} | {} | energy={} | dur={} | triggers: {} | {}\n",
                    a.file, a.category, a.energy, dur, trig, a.meaning
                ));
            }
        }

        format!(
            r#"

═══════════════════════════════════════════════════════════════
ASSET CATALOG — timestamped SFX & MEME cues (fills the "asset_cues" field)
═══════════════════════════════════════════════════════════════
This is what makes the edit feel ALIVE instead of stiff. A viral reaction edit reacts
to the event WITH the audience — a meme is the viewer's inner voice popping in at the
exact emotional beat. A clip with zero memes feels flat. Use ONLY the assets below.

★ REQUIRED: place at least ONE reaction MEME (video) at each clip's strongest emotional
  beat or punchline — NOT just SFX. Aim for 1–2 memes + 1–2 SFX per clip. Only a truly
  calm/neutral clip may have none.

MATCH THE MEME TO THE EMOTION of that exact second (read the transcript tone):
  • shock / "gila!" / "nggak nyangka" / big reveal → screaming-woodchuck, Yea-Boi  (shock_reveal/hype_react)
  • disappointment / "yah" / blunder / fail        → Higuruma-facepalm, black-guy-crying, SFX bruh  (facepalm_react/fail_moment)
  • confused / absurd / "hah?" / suspicious        → Confused-Nick-Young, think-about-it  (confused_react/suspicion_moment)
  • proud / cool / agreement / applause            → clapping, Yea-Boi, Leonardo-pointing  (agree_react/flex_moment)
  • panic / chaos / rage                            → sweaty-gamer, Keyboard-smash  (rage_react)
  • realization / "ternyata" / plot twist          → think-about-it, sweaty-gamer  (realization_react)
  • skip / censor / "yaudahlah"                     → No-Signal-pattern  (scene_change)

For each cue set `file` EXACTLY as written, `at_sec` (seconds from the CLIP's start_sec)
at the emotional peak, `duration_sec` (memes 1–2s, short & punchy), the matching `trigger`,
and a 1-line `reason` naming the emotion you are reacting to.
Rules:
  • Land the meme ON the peak word, not before/after. Pair a punchy SFX with the same beat for impact.
  • Memes are SHORT pops (0.8–2s). Don't stack >1 within ~1s; don't reuse a file within its min_gap.
  • Memes marked "[has own audio]" briefly duck the narration.
  • Match emotion HONESTLY — a wrong-emotion meme is worse than none.

[SFX — audio]
{audio}[MEME / REACTION — video]
{video}"#
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> AssetCatalog {
        let json = r#"{
          "version": 1,
          "assets": [
            {"file":"assets/sfx/vine-boom.mp3","kind":"audio","category":"impact_stinger",
             "energy":"high","duration_sec":1.31,"place_beats":["climax"],
             "triggers":["zoom_punch","shock_reveal"],"meaning_id":"boom ikonik"},
            {"file":"assets/meme/clapping.mp4","kind":"video","category":"meme_reaction",
             "energy":"medium","duration_sec":13.49,"placement_mode":"overlay_pip",
             "has_audio":true,"triggers":["applause_react"],"meaning_id":"tepuk tangan"},
            {"file":"assets/fonts/Poppins-Bold.ttf","kind":"font","category":"font_display",
             "energy":"medium","meaning_id":"font"}
          ]
        }"#;
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn fonts_are_not_cueable() {
        let c = sample();
        let files = c.valid_files();
        assert!(files.contains("assets/sfx/vine-boom.mp3"));
        assert!(files.contains("assets/meme/clapping.mp4"));
        assert!(!files.contains("assets/fonts/Poppins-Bold.ttf"));
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn prompt_section_lists_cueable_and_flags_audio_meme() {
        let c = sample();
        assert!(c.has_cues());
        let s = c.to_prompt_section();
        assert!(s.contains("assets/sfx/vine-boom.mp3"));
        assert!(s.contains("assets/meme/clapping.mp4"));
        assert!(s.contains("zoom_punch"));
        // meme with own audio must carry the ducking caveat
        assert!(s.contains("has own audio"));
        // fonts never advertised as cues
        assert!(!s.contains("Poppins-Bold"));
    }

    #[test]
    fn empty_catalog_yields_empty_section() {
        let c = AssetCatalog { assets: vec![] };
        assert!(!c.has_cues());
        assert!(c.to_prompt_section().is_empty());
    }
}
