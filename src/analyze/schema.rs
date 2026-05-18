use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViralMoment {
    /// Punchy hook title — drives clicks (≤60 chars)
    pub title: String,
    pub start_sec: f64,
    pub end_sec: f64,
    /// Why this exact moment is viral (specific, not generic)
    pub reason: String,
    /// The very first sentence of the clip — this is the scroll-stopper hook
    pub hook: String,
    /// Full social media caption with CTA (2-4 sentences + hashtag line)
    pub caption: String,
    /// The type of viral content — affects how it spreads
    pub viral_type: String,
    /// Energy level for music/pacing decisions
    pub energy: String,
}

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
      "title": "string (max 60 chars — must use a proven hook formula, see rules)",
      "start_sec": number,
      "end_sec": number,
      "reason": "string (be specific: what EXACTLY makes this clip go viral — the tension, the surprise, the value)",
      "hook": "string (exact first words spoken in the clip — the scroll-stopper that appears as overlay text)",
      "caption": "string (full post caption: 2-3 sentences + line break + #hashtag1 #hashtag2 #hashtag3)",
      "viral_type": "educational_shock | transformation | controversy | actionable | relatable | blueprint",
      "energy": "high | medium | low"
    }
  ]
}"#;
