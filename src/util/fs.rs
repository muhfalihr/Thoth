use std::path::{Path, PathBuf};

use anyhow::Result;

/// Create a directory and all parents, silently succeeding if it already exists.
pub fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

/// Return the job-specific working directory: `<base>/.clipper/<job_id>`
pub fn job_dir(base: &Path, job_id: &str) -> PathBuf {
    base.join(".clipper").join(job_id)
}

/// Slugify a string for use in file names.
pub fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// Return a path inside the job dir, creating the parent directory.
pub fn job_path(base: &Path, job_id: &str, sub: &str, filename: &str) -> Result<PathBuf> {
    let dir = job_dir(base, job_id).join(sub);
    ensure_dir(&dir)?;
    Ok(dir.join(filename))
}
