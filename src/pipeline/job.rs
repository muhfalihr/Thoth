use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::util::fs::{ensure_dir, job_dir};

/// Encapsulates all path logic for a single pipeline job.
#[derive(Debug, Clone)]
pub struct JobContext {
    pub job_id: String,
    pub base_dir: PathBuf,
}

impl JobContext {
    pub fn new(job_id: String, base_dir: PathBuf) -> Result<Self> {
        let ctx = Self { job_id, base_dir };
        ensure_dir(&ctx.root())?;
        ensure_dir(&ctx.source_dir())?;
        ensure_dir(&ctx.transcribe_dir())?;
        ensure_dir(&ctx.analyze_dir())?;
        ensure_dir(&ctx.clips_dir())?;
        Ok(ctx)
    }

    pub fn root(&self) -> PathBuf {
        job_dir(&self.base_dir, &self.job_id)
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

    pub fn state_path(&self) -> PathBuf {
        self.root().join("state.json")
    }

    pub fn transcript_path(&self) -> PathBuf {
        self.transcribe_dir().join("transcript.json")
    }

    pub fn moments_path(&self) -> PathBuf {
        self.analyze_dir().join("moments.json")
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
