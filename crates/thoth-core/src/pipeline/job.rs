use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::util::fs::{ensure_dir, job_dir};

/// Encapsulates all path logic for a single pipeline job.
#[derive(Debug, Clone)]
pub struct JobContext {
    pub job_id: String,
    pub base_dir: PathBuf,
    flat: bool,
}

impl JobContext {
    pub fn new(job_id: String, base_dir: PathBuf) -> Result<Self> {
        Self::build(job_id, base_dir, false)
    }

    pub fn new_flat(job_id: String, base_dir: PathBuf) -> Result<Self> {
        Self::build(job_id, base_dir, true)
    }

    fn build(job_id: String, base_dir: PathBuf, flat: bool) -> Result<Self> {
        let ctx = Self {
            job_id,
            base_dir,
            flat,
        };
        ensure_dir(&ctx.root())?;
        ensure_dir(&ctx.source_dir())?;
        ensure_dir(&ctx.transcribe_dir())?;
        ensure_dir(&ctx.analyze_dir())?;
        ensure_dir(&ctx.clips_dir())?;
        Ok(ctx)
    }

    pub fn root(&self) -> PathBuf {
        if self.flat {
            self.base_dir.clone()
        } else {
            job_dir(&self.base_dir, &self.job_id)
        }
    }

    pub fn source_dir(&self) -> PathBuf {
        self.root().join("source")
    }

    pub fn transcribe_dir(&self) -> PathBuf {
        self.root().join("transcribe")
    }

    pub fn analyze_dir(&self) -> PathBuf {
        self.root().join("analyze")
    }

    pub fn clips_dir(&self) -> PathBuf {
        self.root().join("clips")
    }

    // ── Stage 4: Enrich (news + reaction) ──────────────────────────────────────

    /// Root directory for all enrichment artifacts.
    pub fn enrich_dir(&self) -> PathBuf {
        self.root().join("enrich")
    }

    /// Aggregated enrichment data for all moments.
    pub fn enrich_path(&self) -> PathBuf {
        self.enrich_dir().join("enrich.json")
    }

    /// Per-moment news artifacts (screenshots, metadata).
    pub fn news_dir(&self, index: usize) -> PathBuf {
        self.enrich_dir().join("news").join(format!("moment_{index}"))
    }

    /// Per-moment reaction artifacts (script, voice, avatar).
    pub fn reaction_dir(&self, index: usize) -> PathBuf {
        self.enrich_dir().join("reaction").join(format!("moment_{index}"))
    }

    // ── Narration (narrator-driven spine) ──────────────────────────────────────

    /// Directory for narration artifacts (voiceover + word timings).
    pub fn narration_dir(&self) -> PathBuf {
        self.root().join("narration")
    }

    /// Narrator voiceover MP3 (the audio spine).
    pub fn narration_mp3(&self) -> PathBuf {
        self.narration_dir().join("narration.mp3")
    }

    /// Narration per-word timings JSON (for synced subtitles).
    pub fn narration_words(&self) -> PathBuf {
        self.narration_dir().join("narration_words.json")
    }

    pub fn state_path(&self) -> PathBuf {
        self.root().join("state.json")
    }

    pub fn transcript_path(&self) -> PathBuf {
        self.transcribe_dir().join("transcript.json")
    }

    pub fn moments_path(&self) -> PathBuf {
        self.analyze_dir().join("moments.json")
    }

    /// Per-frame visual descriptions from the vision model (Stage 3 `describe_video`).
    /// Persisted so the narration stage can ground its script in what is ON SCREEN
    /// when the spoken transcript is near-empty (raw b-roll).
    pub fn video_descriptions_path(&self) -> PathBuf {
        self.analyze_dir().join("video_descriptions.json")
    }

    pub fn clip_path(&self, index: usize, slug: &str) -> PathBuf {
        self.clips_dir()
            .join(format!("clip_{index:03}_{slug}.mp4"))
    }

    pub fn ass_path(&self, index: usize, slug: &str) -> PathBuf {
        self.clips_dir()
            .join(format!("clip_{index:03}_{slug}.ass"))
    }

    /// Resolve a path that may be relative to the job root or absolute.
    pub fn resolve(&self, p: &Path) -> PathBuf {
        if p.is_absolute() { p.to_owned() } else { self.root().join(p) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_job_context_nested_mode() {
        let temp_dir = TempDir::new().unwrap();
        let base_dir = temp_dir.path().to_path_buf();
        let job_id = "test_job_123".to_string();

        let ctx = JobContext::new(job_id.clone(), base_dir.clone()).unwrap();

        // In nested mode, root should be base_dir/.thoth/job_id
        let expected_root = base_dir.join(".thoth").join(&job_id);
        assert_eq!(ctx.root(), expected_root);

        // Verify the directory was created
        assert!(fs::metadata(&ctx.root()).is_ok());
        assert!(fs::metadata(&ctx.source_dir()).is_ok());
        assert!(fs::metadata(&ctx.transcribe_dir()).is_ok());
        assert!(fs::metadata(&ctx.analyze_dir()).is_ok());
        assert!(fs::metadata(&ctx.clips_dir()).is_ok());
    }

    #[test]
    fn test_job_context_flat_mode() {
        let temp_dir = TempDir::new().unwrap();
        let base_dir = temp_dir.path().to_path_buf();
        let job_id = "test_job_flat".to_string();

        let ctx = JobContext::new_flat(job_id, base_dir.clone()).unwrap();

        // In flat mode, root should be base_dir directly (no .thoth wrapper)
        assert_eq!(ctx.root(), base_dir);

        // Verify the directories were created (under base_dir, not under .thoth)
        assert!(fs::metadata(&ctx.root()).is_ok());
        assert!(fs::metadata(&ctx.source_dir()).is_ok());
        assert!(fs::metadata(&ctx.transcribe_dir()).is_ok());
        assert!(fs::metadata(&ctx.analyze_dir()).is_ok());
        assert!(fs::metadata(&ctx.clips_dir()).is_ok());

        // Verify subdirs are directly under base_dir
        assert_eq!(ctx.source_dir(), base_dir.join("source"));
        assert_eq!(ctx.transcribe_dir(), base_dir.join("transcribe"));
        assert_eq!(ctx.analyze_dir(), base_dir.join("analyze"));
        assert_eq!(ctx.clips_dir(), base_dir.join("clips"));
    }
}
