/// Smart SFX / BGM catalog with auto-discovery and per-clip selection.
///
/// Scans a directory for audio files and categorizes them by matching
/// filename stems against vibe keyword lists.  When `pick()` is called,
/// the best candidate is chosen based on:
///
///   1. Config override table (explicit `vibe = "filename"` in config.toml) — always wins
///   2. Files whose names contain the requested vibe keyword
///   3. Energy-aware sub-selection (high → "hard/heavy/big/loud", low → "soft/light")
///   4. Round-robin rotation by `clip_index` to avoid repeating the same file

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tracing::{debug, info};

// ── Constants ─────────────────────────────────────────────────────────────────

const AUDIO_EXTS: &[&str] = &["mp3", "wav", "aac", "ogg", "m4a", "flac"];

/// Keyword lists used to infer the vibe of a file from its filename stem.
/// Loaded from VocabCache (Supabase) at startup; falls back to hardcoded defaults.
/// Access via `SfxCatalog::new()` which reads from the cache.
static VIBE_KEYWORDS: &[(&str, &[&str])] = &[
    ("impact",       &["impact", "hit", "punch", "thud", "boom", "smash", "strike", "slam"]),
    ("whoosh",       &["whoosh", "swipe", "swoosh", "woosh", "slide", "sweep", "fly", "zip"]),
    ("ding",         &["ding", "bell", "chime", "notify", "ping", "alert", "pop", "click"]),
    ("comedy",       &["comedy", "boing", "vine", "funny", "meme", "cartoon", "silly", "laugh"]),
    ("cinematic",    &["cinematic", "epic", "dramatic", "tense", "suspense", "rise", "stinger"]),
    ("upbeat",       &["upbeat", "energetic", "hype", "happy", "bright", "positive", "bounce"]),
    ("inspirational",&["inspire", "motivat", "uplift", "triumph", "achieve", "soar", "uplift"]),
    ("lofi",         &["lofi", "lo-fi", "chill", "relax", "ambient", "calm", "soft", "study"]),
];
// NOTE: These are static fallbacks. When VocabCache is loaded from Supabase,
// SfxCatalog::new_with_vocab() uses the dynamic lists instead.

static ENERGY_HIGH_KEYWORDS: &[&str] = &["hard", "heavy", "big", "loud", "strong", "intense", "power"];
static ENERGY_LOW_KEYWORDS:  &[&str] = &["soft", "light", "gentle", "subtle", "quiet", "small", "thin"];

// ── Directory scanner ─────────────────────────────────────────────────────────

/// Scan `dir` (non-recursive) for audio files and return them sorted by name.
/// Returns an empty `Vec` if the directory does not exist.
pub fn scan_audio_dir(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
                    .unwrap_or(false)
        })
        .collect();

    files.sort();
    files
}

// ── SfxCatalog ────────────────────────────────────────────────────────────────

/// Audio file catalog for one directory (sfx/ or bgm/).
///
/// Build once at edit-service start via `SfxCatalog::new()`, then call
/// `pick()` for each clip to get the best matching file.
pub struct SfxCatalog {
    /// Discovered files grouped by inferred vibe label.
    by_vibe: HashMap<String, Vec<PathBuf>>,
    /// Files that did not match any vibe keyword.
    uncategorized: Vec<PathBuf>,
    /// Config overrides: vibe label → exact filename (relative to `dir`).
    overrides: HashMap<String, String>,
    /// The directory this catalog was built from.
    dir: PathBuf,
}

impl SfxCatalog {
    /// Build a catalog from `dir`.
    ///
    /// `overrides` comes from `config.toml [assets.sfx]` or `[assets.bgm]`.
    /// An override entry wins over auto-discovery when the file exists.
    pub fn new(dir: &Path, overrides: &HashMap<String, String>) -> Self {
        let files = scan_audio_dir(dir);
        let mut by_vibe: HashMap<String, Vec<PathBuf>> = HashMap::new();
        let mut uncategorized: Vec<PathBuf> = Vec::new();

        'file: for path in &files {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();

            for (vibe, keywords) in VIBE_KEYWORDS {
                if keywords.iter().any(|kw| stem.contains(kw)) {
                    by_vibe
                        .entry(vibe.to_string())
                        .or_default()
                        .push(path.clone());
                    continue 'file;
                }
            }
            uncategorized.push(path.clone());
        }

        Self {
            by_vibe,
            uncategorized,
            overrides: overrides.clone(),
            dir: dir.to_owned(),
        }
    }

    /// Human-readable summary for the startup log.
    pub fn summary(&self) -> String {
        if self.by_vibe.is_empty() && self.uncategorized.is_empty() {
            return format!("0 files ({})", self.dir.display());
        }

        let total: usize = self.by_vibe.values().map(|v| v.len()).sum::<usize>()
            + self.uncategorized.len();

        let mut parts: Vec<String> = self
            .by_vibe
            .iter()
            .map(|(vibe, files)| format!("{}×{}", vibe, files.len()))
            .collect();
        parts.sort();

        if !self.uncategorized.is_empty() {
            parts.push(format!("uncategorized×{}", self.uncategorized.len()));
        }

        format!(
            "{total} files in {} ({})",
            self.dir.display(),
            parts.join(", ")
        )
    }

    /// Pick the best audio file for a clip's context.
    ///
    /// Returns `None` when:
    /// - `vibe` is empty or `"none"`
    /// - The directory has no files
    /// - No suitable file could be found
    ///
    /// `clip_index` is used to rotate through multiple candidates so
    /// successive clips don't always get the same file.
    pub fn pick(
        &self,
        vibe:       &str,
        energy:     &str,
        viral_type: &str,
        clip_index: usize,
    ) -> Option<PathBuf> {
        let vibe = vibe.trim().to_lowercase();

        if vibe.is_empty() || vibe == "none" {
            return None;
        }

        // ── 1. Config override takes priority ─────────────────────────────────
        if let Some(filename) = self.overrides.get(&vibe) {
            if !filename.is_empty() && filename != "none" {
                let path = self.dir.join(filename);
                if path.exists() {
                    debug!("sfx: using config override: {}", path.display());
                    return Some(path);
                }
            }
        }

        // ── 2. Find candidates by vibe keyword ────────────────────────────────
        let mut candidates: Vec<PathBuf> = self
            .by_vibe
            .get(&vibe)
            .cloned()
            .unwrap_or_default();

        // ── 3. Widen search: try viral_type as fallback vibe ──────────────────
        if candidates.is_empty() {
            let vt = viral_type.to_lowercase();
            // Map viral_type to a vibe category that might have files
            let fallback_vibe = match vt.as_str() {
                "controversy" | "educational_shock"        => "impact",
                "transformation" | "inspiration"           => "inspirational",
                "actionable" | "blueprint"                 => "ding",
                "relatable" | "storytelling"               => "whoosh",
                _ if energy == "high"                      => "impact",
                _ if energy == "low"                       => "lofi",
                _                                          => "whoosh",
            };
            candidates = self.by_vibe.get(fallback_vibe).cloned().unwrap_or_default();
        }

        // ── 4. Widen search: use uncategorized pool ───────────────────────────
        if candidates.is_empty() {
            candidates = self.uncategorized.clone();
        }

        if candidates.is_empty() {
            return None;
        }

        // ── 5. Energy-aware sub-selection ─────────────────────────────────────
        let preferred = match energy {
            "high" => filter_by_keywords(&candidates, ENERGY_HIGH_KEYWORDS),
            "low"  => filter_by_keywords(&candidates, ENERGY_LOW_KEYWORDS),
            _      => Vec::new(),
        };

        let pool = if preferred.is_empty() { &candidates } else { &preferred };

        // ── 6. Round-robin rotation ───────────────────────────────────────────
        let idx  = clip_index % pool.len();
        let path = pool[idx].clone();

        debug!(
            "sfx: picked {} (vibe={}, energy={}, {} candidates, idx={})",
            path.file_name().unwrap_or_default().to_string_lossy(),
            vibe, energy, pool.len(), idx
        );

        Some(path)
    }

    /// Total number of audio files discovered.
    pub fn file_count(&self) -> usize {
        self.by_vibe.values().map(|v| v.len()).sum::<usize>() + self.uncategorized.len()
    }
}

// ── Helper ────────────────────────────────────────────────────────────────────

/// Return the subset of `files` whose stems contain any of `keywords`.
/// Returns an empty `Vec` when no file matches (caller falls back to full pool).
fn filter_by_keywords(files: &[PathBuf], keywords: &[&str]) -> Vec<PathBuf> {
    files
        .iter()
        .filter(|p| {
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            keywords.iter().any(|kw| stem.contains(kw))
        })
        .cloned()
        .collect()
}

// ── Startup log helper ────────────────────────────────────────────────────────

/// Log discovery results for both SFX and BGM catalogs at edit start.
pub fn log_catalogs(sfx: &SfxCatalog, bgm: &SfxCatalog) {
    if sfx.file_count() == 0 {
        info!("  🔊 SFX catalog: no files found in {}", sfx.dir.display());
    } else {
        info!("  🔊 SFX catalog: {}", sfx.summary());
    }
    if bgm.file_count() == 0 {
        info!("  🎵 BGM catalog: no files found in {}", bgm.dir.display());
    } else {
        info!("  🎵 BGM catalog: {}", bgm.summary());
    }
}
