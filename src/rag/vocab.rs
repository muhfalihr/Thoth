/// Dynamic Vocabulary System — loads word lists from Supabase `word_lists` table.
///
/// Replaces all 8 hardcoded static word arrays in the codebase with a single
/// in-memory cache backed by Supabase. The cache refreshes every `ttl_secs`
/// seconds (default 1 hour) so new words added via `clipper vocab add` or
/// auto-discovery take effect without restarting the service.
///
/// Falls back to hardcoded defaults if Supabase is unavailable.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use sqlx::PgPool;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

// reqwest is already a direct dependency in Cargo.toml

// ── Public type alias ─────────────────────────────────────────────────────────

pub type SharedVocabCache = Arc<RwLock<VocabCache>>;

// ── VocabCache ────────────────────────────────────────────────────────────────

/// In-memory cache of all word lists loaded from Supabase.
/// Access via `SharedVocabCache` (Arc<RwLock<VocabCache>>).
#[derive(Debug, Clone)]
pub struct VocabCache {
    // Tone detection (for overlay query refinement)
    pub tone_funny:    Vec<String>,
    pub tone_serious:  Vec<String>,
    // Intro section detection (first ~15% of video)
    pub intro:         Vec<String>,
    // Outro section detection (last ~15% of video)
    pub outro:         Vec<String>,
    // Indonesian title/honorific patterns ("pak ", "bu ", "dr ", ...)
    pub name_titles:   Vec<String>,
    // Stop words for keyword extraction
    pub stop_words_id: HashSet<String>,
    pub stop_words_en: HashSet<String>,
    // SFX energy modifiers
    pub energy_high:   Vec<String>,
    pub energy_low:    Vec<String>,
    // SFX/BGM vibe categories: vibe_name → filename keywords
    pub vibes:         HashMap<String, Vec<String>>,
    // Cache freshness
    pub loaded_at:     Instant,
    pub ttl_secs:      u64,
    pub from_db:       bool,   // false = using hardcoded defaults
}

impl VocabCache {
    // ── Construction ──────────────────────────────────────────────────────────

    /// Load vocabulary from Supabase. Returns defaults if DB unavailable.
    pub async fn load(pool: Option<&PgPool>, ttl_secs: u64) -> Self {
        if let Some(p) = pool {
            match Self::load_from_db(p, ttl_secs).await {
                Ok(cache) => {
                    info!(
                        "🔤 Vocab: loaded from Supabase — intro={}, funny={}, serious={}, \
                         stop_words={}/{}, vibes={} categories",
                        cache.intro.len(), cache.tone_funny.len(), cache.tone_serious.len(),
                        cache.stop_words_id.len(), cache.stop_words_en.len(), cache.vibes.len()
                    );
                    return cache;
                }
                Err(e) => {
                    warn!("vocab: Supabase load failed ({e}), using hardcoded defaults");
                }
            }
        }
        debug!("vocab: no DB pool, using hardcoded defaults");
        Self::defaults(ttl_secs)
    }

    async fn load_from_db(pool: &PgPool, ttl_secs: u64) -> Result<Self> {
        let rows = sqlx::query_as::<_, (String, Option<String>, String)>(
            "SELECT category, subcategory, word FROM word_lists WHERE active = TRUE ORDER BY category, subcategory"
        )
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            return Err(anyhow::anyhow!("word_lists table is empty — not yet seeded"));
        }

        let mut cache = Self::defaults(ttl_secs);
        cache.from_db = true;

        // Clear defaults — we'll fill from DB
        cache.tone_funny.clear();
        cache.tone_serious.clear();
        cache.intro.clear();
        cache.outro.clear();
        cache.name_titles.clear();
        cache.stop_words_id.clear();
        cache.stop_words_en.clear();
        cache.energy_high.clear();
        cache.energy_low.clear();
        cache.vibes.clear();

        for (category, subcategory, word) in rows {
            match category.as_str() {
                "tone_funny"   => cache.tone_funny.push(word),
                "tone_serious" => cache.tone_serious.push(word),
                "intro"        => cache.intro.push(word),
                "outro"        => cache.outro.push(word),
                "name_titles"  => cache.name_titles.push(word),
                "stop_words"   => {
                    let lang = subcategory.as_deref().unwrap_or("id");
                    if lang == "en" {
                        cache.stop_words_en.insert(word);
                    } else {
                        cache.stop_words_id.insert(word);
                    }
                }
                "energy_high"  => cache.energy_high.push(word),
                "energy_low"   => cache.energy_low.push(word),
                "vibe"         => {
                    if let Some(vibe) = subcategory {
                        cache.vibes.entry(vibe).or_default().push(word);
                    }
                }
                other => { debug!("vocab: unknown category '{other}', skipping"); }
            }
        }

        // Fall back to defaults for any empty categories
        let d = Self::defaults(ttl_secs);
        if cache.tone_funny.is_empty()    { cache.tone_funny    = d.tone_funny; }
        if cache.tone_serious.is_empty()  { cache.tone_serious  = d.tone_serious; }
        if cache.intro.is_empty()         { cache.intro         = d.intro; }
        if cache.outro.is_empty()         { cache.outro         = d.outro; }
        if cache.name_titles.is_empty()   { cache.name_titles   = d.name_titles; }
        if cache.stop_words_id.is_empty() { cache.stop_words_id = d.stop_words_id; }
        if cache.stop_words_en.is_empty() { cache.stop_words_en = d.stop_words_en; }
        if cache.energy_high.is_empty()   { cache.energy_high   = d.energy_high; }
        if cache.energy_low.is_empty()    { cache.energy_low    = d.energy_low; }
        if cache.vibes.is_empty()         { cache.vibes         = d.vibes; }

        Ok(cache)
    }

    /// Returns true if the cache has expired and should be refreshed.
    pub fn is_stale(&self) -> bool {
        self.loaded_at.elapsed().as_secs() >= self.ttl_secs
    }

    /// Combined stop words (both Indonesian and English).
    pub fn all_stop_words(&self) -> HashSet<&str> {
        self.stop_words_id.iter().map(|s| s.as_str())
            .chain(self.stop_words_en.iter().map(|s| s.as_str()))
            .collect()
    }

    // ── Persistence helpers ───────────────────────────────────────────────────

    /// Add a new word to a vocabulary category and persist to Supabase.
    pub async fn add_word(
        pool:        &PgPool,
        category:    &str,
        subcategory: Option<&str>,
        word:        &str,
        language:    &str,
        source:      &str,
        notes:       Option<&str>,
    ) -> Result<()> {
        let word = word.to_lowercase();
        sqlx::query(
            "INSERT INTO word_lists (category, subcategory, word, language, source, notes)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (category, COALESCE(subcategory,''), word, language) DO UPDATE
             SET active = TRUE, updated_at = NOW(), notes = COALESCE($6, word_lists.notes)"
        )
        .bind(category)
        .bind(subcategory)
        .bind(&word)
        .bind(language)
        .bind(source)
        .bind(notes)
        .execute(pool)
        .await?;
        info!("vocab: added '{}' to category '{}' (source={})", word, category, source);
        Ok(())
    }

    /// Record a word candidate for human review.
    pub async fn flag_candidate(pool: &PgPool, word: &str, suggested_category: &str, context: &str) {
        let _ = sqlx::query(
            "INSERT INTO word_candidates (word, suggested_category, context, occurrences)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (word) DO UPDATE
             SET occurrences = word_candidates.occurrences + 1,
                 context = EXCLUDED.context"
        )
        .bind(word)
        .bind(suggested_category)
        .bind(context)
        .execute(pool)
        .await;
    }

    /// List words in a category (for `clipper vocab list`).
    pub async fn list_category(pool: &PgPool, category: &str) -> Result<Vec<(String, Option<String>, String, f64)>> {
        let rows = sqlx::query_as::<_, (String, Option<String>, String, f64)>(
            "SELECT word, subcategory, language, weight FROM word_lists
             WHERE category = $1 AND active = TRUE ORDER BY weight DESC, word ASC"
        )
        .bind(category)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Get unreviewed word candidates.
    pub async fn pending_candidates(pool: &PgPool) -> Result<Vec<(String, Option<String>, i32, Option<String>)>> {
        let rows = sqlx::query_as::<_, (String, Option<String>, i32, Option<String>)>(
            "SELECT word, suggested_category, occurrences, context FROM word_candidates
             WHERE reviewed = FALSE ORDER BY occurrences DESC LIMIT 20"
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Approve a candidate — move to word_lists.
    pub async fn approve_candidate(pool: &PgPool, word: &str, category: &str, language: &str) -> Result<()> {
        sqlx::query("UPDATE word_candidates SET reviewed = TRUE WHERE word = $1")
            .bind(word).execute(pool).await?;
        Self::add_word(pool, category, None, word, language, "auto_discovered", None).await
    }

    /// Reject a candidate.
    pub async fn reject_candidate(pool: &PgPool, word: &str) -> Result<()> {
        sqlx::query("UPDATE word_candidates SET reviewed = TRUE WHERE word = $1")
            .bind(word).execute(pool).await?;
        Ok(())
    }

    // ── Hardcoded defaults (current static arrays) ────────────────────────────

    pub fn defaults(ttl_secs: u64) -> Self {
        let mut vibes: HashMap<String, Vec<String>> = HashMap::new();
        vibes.insert("impact".into(),       vec!["impact","hit","punch","thud","boom","smash","strike","slam"].into_iter().map(String::from).collect());
        vibes.insert("whoosh".into(),       vec!["whoosh","swipe","swoosh","woosh","slide","sweep","fly","zip"].into_iter().map(String::from).collect());
        vibes.insert("ding".into(),         vec!["ding","bell","chime","notify","ping","alert","pop","click"].into_iter().map(String::from).collect());
        vibes.insert("comedy".into(),       vec!["comedy","boing","vine","funny","meme","cartoon","silly","laugh"].into_iter().map(String::from).collect());
        vibes.insert("cinematic".into(),    vec!["cinematic","epic","dramatic","tense","suspense","rise","stinger"].into_iter().map(String::from).collect());
        vibes.insert("upbeat".into(),       vec!["upbeat","energetic","hype","happy","bright","positive","bounce"].into_iter().map(String::from).collect());
        vibes.insert("inspirational".into(),vec!["inspire","motivat","uplift","triumph","achieve","soar"].into_iter().map(String::from).collect());
        vibes.insert("lofi".into(),         vec!["lofi","lo-fi","chill","relax","ambient","calm","soft","study"].into_iter().map(String::from).collect());

        Self {
            tone_funny: vec![
                "ketawa","lucu","ngakak","joget","haha","hehe","gila sih","anjir",
                "bercanda","ngga nyangka","kocak","lawak","humor","nggak nyangka",
                "goyang","nyanyi","nari","absurd","parah sih","gokil","badut",
                "meme","viral lucu","ngeselin","awkward","salah tingkah",
            ].into_iter().map(String::from).collect(),
            tone_serious: vec![
                "serius","penting","masalah","krisis","kebijakan","aturan",
                "hukum","tragedi","meninggal","korban","bencana","ancaman",
                "bahaya","perang","konflik","terancam","kritis","darurat",
                "ekonomi","inflasi","korupsi","skandal","penangkapan","ditangkap",
                "dipecat","mengundurkan","persoalan","problematika","dampak negatif",
            ].into_iter().map(String::from).collect(),
            intro: vec![
                "selamat datang","welcome back","halo semua","hai semua",
                "assalamualaikum","halo guys","hai guys","selamat pagi","selamat siang","selamat malam",
                "subscribe","like dan","jangan lupa","aktifkan","notifikasi",
                "bell","komentar di bawah","tinggalkan komentar","klik like","tekan like","dukung channel","support channel",
                "kali ini kita akan","di video ini kita","hari ini kita akan",
                "kita akan bahas","kita akan diskusi","kita akan bicara",
                "di episode ini","di kesempatan ini","pada kesempatan kali",
                "kita akan membahas","yang akan kita bahas",
                "tanpa panjang lebar","tanpa basa basi","langsung saja kita",
                "baik langsung","oke langsung","yuk langsung","ayo langsung",
                "welcome to","today we're going","today we will","in today's video",
                "don't forget to","smash that","without further ado",
                "let's get started","let's dive in",
                // ── Talk-show / interview opening patterns ─────────────────────
                "saya undang","kami undang","kita undang","saya persilakan","kami persilakan",
                "kita sambut","mari sambut","mohon sambut","sambut bersama",
                "tepuk tangan","tepuk tangan untuk","tepuk tangan buat",
                "tuan rumah","hadir bersama kita","bergabung bersama kita",
                "sudah hadir","ada bersama kita","bersama kita malam","bersama kita hari",
                "izinkan saya memperkenalkan","izinkan kami memperkenalkan",
                "perkenalkan kepada","kita perkenalkan",
                "terima kasih sudah mau hadir","terima kasih sudah bergabung",
                "terima kasih sudah hadir","terima kasih sudah datang",
                "selamat datang di studio","selamat datang di acara","selamat datang di program",
                "sebelum kita mulai","sebelum lebih lanjut","sebelum lebih jauh",
                "gimana kabar","apa kabar pak","apa kabar bu","apa kabar bapak","bagaimana kabar",
                "silakan duduk","oke teman-teman","nah teman-teman","baik teman-teman",
                // ── Episode context-setting / "why we made this" intro ──────────
                // These appear early in podcast/podcast-style videos explaining the episode premise.
                // They are NOT substance — they're the host framing why they're discussing the topic.
                "kami membuat episode","kita membuat episode","kami buat episode","kita buat episode",
                "episode ini dibuat","video ini dibuat","episode ini membahas","video ini membahas",
                "saat podcast ini","waktu podcast ini","ketika podcast ini",
                "di podcast ini kita","di podcast ini kami",
                "kita akan explore","kita akan kupas","kita akan bedah",
                "hari ini kita explore","hari ini kita bedah","hari ini kita kupas",
                "yang ingin kami bahas","yang ingin kita bahas","yang akan kami bahas",
                "tujuan episode","tujuan video","topik hari ini","topik kali ini",
            ].into_iter().map(String::from).collect(),
            outro: vec![
                // ── Indonesian farewells ────────────────────────────────────────────
                "sampai jumpa","sampai ketemu lagi","sampai bertemu lagi",
                "sampai bertemu kembali","sampai di video",
                // ── Closing thank-yous (very specific — almost never mid-content) ──
                "terima kasih sudah menonton","terima kasih sudah nonton",
                "terima kasih telah menonton","terima kasih sudah menyimak",
                "terima kasih sudah melihat","terima kasih sudah hadir",
                "terima kasih sudah meluangkan","terima kasih buat kalian yang sudah",
                "makasih udah nonton","makasih sudah nonton","makasih sudah menyimak",
                // ── Comment/share CTAs (safe in last-15% scan window) ────────────────
                // These dual-use CTA phrases also appear in intros, but finding them
                // in the last 15% of a video is almost always an outro sign-off.
                "komen di bawah","komentar di bawah","silakan komen",
                "silakan komentar","tulis di kolom komentar","di kolom komentar",
                "bagikan pengalaman","ceritakan di kolom",
                // ── Subscribe/like CTAs (high-density = outro zone) ────────────────
                "jangan lupa subscribe","jangan lupa like dan subscribe",
                "yuk subscribe","yuk follow","hit subscribe",
                "dukung channel ini","support channel ini","pantau terus channel",
                // ── Next-video promos ──────────────────────────────────────────────
                "nantikan video berikutnya","nantikan video selanjutnya",
                "tunggu video berikutnya","tunggu video selanjutnya",
                "see you di video berikutnya","see you di video selanjutnya",
                "di video selanjutnya kita","di video berikutnya kita",
                "video selanjutnya akan","video berikutnya akan",
                // ── Closing phrases ────────────────────────────────────────────────
                "itu saja dari kami","itu saja dari kita","itu saja dari saya",
                "sekian dari kami","sekian dari kita","sekian dari saya",
                "sampai sini dulu","segitu dulu ya","oke sekian","cukup sekian",
                "akhir kata","sebelum kami menutup","sebelum kita tutup",
                "demikianlah","demikian tadi","itulah tadi",
                // ── Religious closing ──────────────────────────────────────────────
                "wassalamualaikum warahmatullahi","wassalamualaikum wr wb","wassalam",
                // ── English farewells ──────────────────────────────────────────────
                "thanks for watching","thank you for watching","thanks for tuning in",
                "see you next time","see you in the next video","see you in the next",
                "that's all for today","that's all for now","that's it for today",
                "until next time","until then","catch you later",
                "bye bye","bye for now","goodbye everyone","peace out",
            ].into_iter().map(String::from).collect(),
            name_titles: vec![
                "pak ","bu ","ibu ","kak ","bro ","mas ","mba ","om ",
                "tante ","dokter ","dr ","haji ","ustaz ","bapak ",
            ].into_iter().map(String::from).collect(),
            stop_words_id: vec![
                "yang","di","ke","dari","dan","atau","itu","ini","dengan","untuk","ada","tidak","bisa",
                "gue","gw","aku","kamu","lo","lu","sih","kan","tapi","tuh","udah","jadi","juga","kalau",
                "kita","aja","deh","ya","loh","dong","nah","lebih","sudah","akan","banyak","saya","mereka",
                "dia","kami","karena","jika","maka","pada","adalah","dalam","oleh","seperti","apa","bagaimana",
                "kenapa","siapa","dimana","kapan","gimana","gitu","kayak","banget","emang","memang","baru",
                "lagi","sama","kalo","terus","harus","mau","perlu","punya","hal","cara","orang","waktu",
                "tahun","hari","bulan","kali","sekarang","dulu","nanti","gua","enggak","iya","oke","bang",
                "betul","heeh","berarti","nih","anda","kang",
            ].into_iter().map(String::from).collect(),
            stop_words_en: vec![
                "the","a","an","is","it","in","of","to","and","for","that","this","was","are","be",
                "have","has","had","with","they","you","we","i","he","she","but","not","by","at",
                "so","if","on","do","did","your","our","my","its","their","from","as","up","out",
                "can","all","more","also","than","then","just","about","what","how","when","who","where","why","yes",
            ].into_iter().map(String::from).collect(),
            energy_high: vec!["hard","heavy","big","loud","strong","intense","power"].into_iter().map(String::from).collect(),
            energy_low:  vec!["soft","light","gentle","subtle","quiet","small","thin"].into_iter().map(String::from).collect(),
            vibes,
            loaded_at: Instant::now(),
            ttl_secs,
            from_db: false,
        }
    }
}

// ── SQL seeding helpers ───────────────────────────────────────────────────────

// ── Dataset seeding functions ─────────────────────────────────────────────────

// ── URL-based seeding ─────────────────────────────────────────────────────────

/// Download a file from any URL and seed words into the given Supabase category.
///
/// Supports: `.txt` (one word/line), `.csv`, `.tsv`, `.json`
/// Auto-detects format from URL extension or Content-Type header.
///
/// # Arguments
/// - `url`          — direct file URL (Kaggle, GitHub raw, any HTTP/HTTPS)
/// - `category`     — target vocab category (tone_funny, stop_words, etc.)
/// - `subcategory`  — optional (vibe name, language code for stop_words)
/// - `language`     — "id" | "en" | "mixed"
/// - `column`       — which column to use as word (0-based, for CSV/TSV)
/// - `skip_header`  — skip first line (CSV/TSV header)
/// - `label_filter` — only seed rows where column[1] contains this string
pub async fn seed_from_url(
    pool:         &PgPool,
    url:          &str,
    category:     &str,
    subcategory:  Option<&str>,
    language:     &str,
    column:       usize,
    skip_header:  bool,
    label_filter: Option<&str>,
) -> Result<usize> {
    info!("vocab: downloading from {url}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("clipper-vocab/1.0")
        .build()
        .unwrap_or_default();

    let resp = client.get(url).send().await
        .map_err(|e| anyhow::anyhow!("Failed to download: {e}"))?;

    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}: {}", resp.status(), url);
    }

    // Detect format from URL path or Content-Type
    let content_type = resp.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let url_lower = url.to_lowercase().split('?').next().unwrap_or(url).to_lowercase();
    let mut format = if url_lower.ends_with(".json") || content_type.contains("json") {
        "json"
    } else if url_lower.ends_with(".tsv") || content_type.contains("tab-separated") {
        "tsv"
    } else if url_lower.ends_with(".csv") || content_type.contains("csv") {
        "csv"
    } else {
        "txt"  // default: one word per line
    };

    let text = resp.text().await
        .map_err(|e| anyhow::anyhow!("Failed to read response: {e}"))?;

    // Heuristic: if detected as txt but starts with { or [, it's likely JSON
    if format == "txt" && (text.trim().starts_with('{') || text.trim().starts_with('[')) {
        format = "json";
    }

    info!("vocab: detected format={format}, {} bytes", text.len());

    // Special case: if category is "auto" and format is "json", we try to classify slang-to-formal mapping
    if category == "auto" && format == "json" {
        return seed_classified_json(pool, &text, language).await;
    }

    let words = match format {
        "json" => parse_json_words(&text),
        "csv"  => parse_delimited_words(&text, ',', column, skip_header, label_filter),
        "tsv"  => parse_delimited_words(&text, '\t', column, skip_header, label_filter),
        _      => parse_txt_words(&text),
    };

    info!("vocab: parsed {} candidate words", words.len());

    let mut count = 0usize;
    for word in &words {
        if word.is_empty() || word.len() < 2 { continue; }
        let r = sqlx::query(
            "INSERT INTO word_lists (category, subcategory, word, language, source)
             VALUES ($1, $2, $3, $4, 'url') ON CONFLICT DO NOTHING"
        )
        .bind(category)
        .bind(subcategory)
        .bind(word)
        .bind(language)
        .execute(pool)
        .await;
        if r.is_ok() { count += 1; }
    }

    info!("vocab: seeded {count}/{} words from URL → category={category}", words.len());
    Ok(count)
}

/// Seed words from a JSON mapping object, classifying them automatically.
async fn seed_classified_json(pool: &PgPool, text: &str, language: &str) -> Result<usize> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return Err(anyhow::anyhow!("Invalid JSON for classification"));
    };

    let Some(obj) = val.as_object() else {
        return Err(anyhow::anyhow!("JSON must be an object/map for 'auto' classification"));
    };

    let funny_formal_patterns = [
        "lucu", "senang", "bagus", "keren", "seru", "asik", "gila",
        "parah", "mantap", "hebat", "ajaib", "aneh", "menarik", "haha", "wkwk",
    ];

    let mut count = 0usize;
    for (slang, formal_val) in obj {
        let slang = slang.to_lowercase();
        if slang.is_empty() || slang.len() < 2 { continue; }

        let formal = formal_val.as_str().unwrap_or("").to_lowercase();

        // Classification logic
        let is_funny = funny_formal_patterns.iter().any(|&p| formal.contains(p) || slang.contains(p));
        let is_abbrev = slang.len() <= 3 && slang.chars().all(|c| c.is_alphabetic());

        let (category, sub) = if is_abbrev {
            ("stop_words", Some(language))
        } else if is_funny {
            ("tone_funny", None)
        } else {
            // Default to stop_words if it looks like a filler/informal word
            ("stop_words", Some(language))
        };

        let r = sqlx::query(
            "INSERT INTO word_lists (category, subcategory, word, language, source)
             VALUES ($1, $2, $3, $4, 'url_auto') ON CONFLICT DO NOTHING"
        )
        .bind(category).bind(sub).bind(&slang).bind(language)
        .execute(pool).await;
        if r.is_ok() { count += 1; }
    }

    Ok(count)
}

// ── Format parsers ────────────────────────────────────────────────────────────

/// Parse a plain text file: one word or phrase per line.
/// Strips comments (#), blank lines, and leading/trailing whitespace.
fn parse_txt_words(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
        .map(|l| l.trim().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// Parse a CSV or TSV file.
///
/// - `sep`          — separator character (',' or '\t')
/// - `column`       — which column to extract (0 = first)
/// - `skip_header`  — skip first line
/// - `label_filter` — only include rows where column[1] contains this string
fn parse_delimited_words(
    text:         &str,
    sep:          char,
    column:       usize,
    skip_header:  bool,
    label_filter: Option<&str>,
) -> Vec<String> {
    let mut words = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if skip_header && i == 0 { continue; }
        if line.trim().is_empty() || line.trim().starts_with('#') { continue; }

        let parts: Vec<&str> = line.splitn(column + 3, sep).collect();
        let word = parts.get(column).map(|w| w.trim().trim_matches('"')).unwrap_or("").to_lowercase();

        if word.is_empty() { continue; }

        // Apply label filter if provided
        if let Some(filter) = label_filter {
            let label = parts.get(1).map(|l| l.trim().to_lowercase()).unwrap_or_default();
            if !label.contains(filter) { continue; }
        }

        words.push(word);
    }
    words
}

/// Parse a JSON file.
///
/// Supports:
/// - `["word1", "word2", ...]`  — JSON array of strings
/// - `[{"word": "...", ...}, ...]` — array of objects with "word", "text", or "kata" key
/// - `{"words": [...]}` — object with a "words" array
fn parse_json_words(text: &str) -> Vec<String> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };

    if let Some(arr) = val.as_array() {
        return arr.iter()
            .filter_map(|v| {
                if let Some(s) = v.as_str() {
                    Some(s.to_lowercase())
                } else if v.is_object() {
                    for key in &["word", "text", "kata", "slang", "term", "value"] {
                        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                            return Some(s.to_lowercase());
                        }
                    }
                    None
                } else {
                    None
                }
            })
            .filter(|w| !w.is_empty())
            .collect();
    }

    if let Some(obj) = val.as_object() {
        // If it has a top-level "words" or "data" array, use that
        if let Some(arr) = obj.get("words").and_then(|v| v.as_array()) {
            return arr.iter().filter_map(|v| v.as_str().map(|s| s.to_lowercase())).collect();
        }
        if let Some(arr) = obj.get("data").and_then(|v| v.as_array()) {
            return arr.iter().filter_map(|v| v.as_str().map(|s| s.to_lowercase())).collect();
        }

        // Otherwise, treat the keys of the object itself as the words
        // (common in mapping files like slangwords.json)
        return obj.keys().map(|k| k.to_lowercase()).collect();
    }

    Vec::new()
}

/// Seed kamus-alay (Indonesian slang/informal dictionary) into Supabase.
///
/// Downloads the dataset from GitHub (nasalsabila/kamus-alay) and seeds:
/// - Common slang into `tone_funny` (humorous/informal words)
/// - Common abbreviations into `stop_words_{language}` (filler words)
///
/// Source: https://github.com/nasalsabila/kamus-alay
pub async fn seed_kamus_alay(pool: &PgPool, language: &str) -> Result<usize> {
    let url = "https://raw.githubusercontent.com/nasalsabila/kamus-alay/refs/heads/master/colloquial-indonesian-lexicon.csv";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let resp = client.get(url).send().await
        .map_err(|e| anyhow::anyhow!("Failed to download kamus-alay: {e}"))?;
    let text = resp.text().await?;

    let mut count = 0usize;
    let mut total_lines = 0usize;

    // Format: slang_word,formal_word
    // We import slang words that map to emotional/humorous formal words
    let funny_formal_patterns = [
        "lucu", "senang", "bagus", "keren", "seru", "asik", "gila",
        "parah", "mantap", "hebat", "ajaib", "aneh", "menarik",
    ];

    for line in text.lines().skip(1) {  // skip header
        let parts: Vec<&str> = line.splitn(2, ',').collect();
        if parts.len() < 2 { continue; }
        let slang  = parts[0].trim().to_lowercase();
        let formal = parts[1].trim().to_lowercase();

        if slang.is_empty() || slang.len() < 2 { continue; }
        total_lines += 1;

        // Classify: if formal word has funny/positive connotation → tone_funny
        let is_funny = funny_formal_patterns.iter().any(|&p| formal.contains(p));
        // Very short words (≤3 chars) are likely abbreviations → stop words
        let is_abbrev = slang.len() <= 3 && slang.chars().all(|c| c.is_alphabetic());

        let (category, sub) = if is_abbrev {
            ("stop_words", Some(language))
        } else if is_funny {
            ("tone_funny", None)
        } else {
            continue;  // skip neutral words
        };

        let r = sqlx::query(
            "INSERT INTO word_lists (category, subcategory, word, language, source)
             VALUES ($1, $2, $3, $4, 'kamus-alay') ON CONFLICT DO NOTHING"
        )
        .bind(category).bind(sub).bind(&slang).bind(language)
        .execute(pool).await;
        if r.is_ok() { count += 1; }
    }

    tracing::info!("kamus-alay: processed {total_lines} entries, inserted {count}");
    Ok(count)
}

/// Seed Indonesian stop words from OpenSLR/stopwords-iso dataset.
///
/// Source: https://github.com/stopwords-iso/stopwords-id
pub async fn seed_openslr_stopwords(pool: &PgPool, language: &str) -> Result<usize> {
    let url = "https://raw.githubusercontent.com/stopwords-iso/stopwords-id/master/stopwords-id.txt";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let resp = client.get(url).send().await
        .map_err(|e| anyhow::anyhow!("Failed to download OpenSLR stopwords: {e}"))?;
    let text = resp.text().await?;

    let mut count = 0usize;
    for line in text.lines() {
        let word = line.trim().to_lowercase();
        if word.is_empty() || word.starts_with('#') { continue; }
        let r = sqlx::query(
            "INSERT INTO word_lists (category, subcategory, word, language, source)
             VALUES ('stop_words', $1, $2, $3, 'openslr-stopwords') ON CONFLICT DO NOTHING"
        )
        .bind(language).bind(&word).bind(language)
        .execute(pool).await;
        if r.is_ok() { count += 1; }
    }

    tracing::info!("openslr-stopwords: inserted {count} words");
    Ok(count)
}

/// Seed all default word lists into Supabase (run once or to refresh).
/// Skips words that already exist (ON CONFLICT DO NOTHING).
pub async fn seed_defaults(pool: &PgPool) -> Result<usize> {
    let defaults = VocabCache::defaults(3600);
    let mut count = 0usize;

    async fn insert_batch(pool: &PgPool, category: &str, sub: Option<&str>, lang: &str, words: &[String]) -> usize {
        let mut n = 0;
        for word in words {
            let r = sqlx::query(
                "INSERT INTO word_lists (category, subcategory, word, language, source)
                 VALUES ($1, $2, $3, $4, 'default') ON CONFLICT DO NOTHING"
            )
            .bind(category).bind(sub).bind(word).bind(lang)
            .execute(pool).await;
            if r.is_ok() { n += 1; }
        }
        n
    }

    count += insert_batch(pool, "tone_funny",   None,        "id", &defaults.tone_funny).await;
    count += insert_batch(pool, "tone_serious",  None,        "id", &defaults.tone_serious).await;
    count += insert_batch(pool, "intro",         None,        "id", &defaults.intro).await;
    count += insert_batch(pool, "outro",         None,        "id", &defaults.outro).await;
    count += insert_batch(pool, "name_titles",   None,        "id", &defaults.name_titles).await;
    count += insert_batch(pool, "stop_words",    Some("id"),  "id", &defaults.stop_words_id.iter().cloned().collect::<Vec<_>>()).await;
    count += insert_batch(pool, "stop_words",    Some("en"),  "en", &defaults.stop_words_en.iter().cloned().collect::<Vec<_>>()).await;
    count += insert_batch(pool, "energy_high",   None,        "mixed", &defaults.energy_high).await;
    count += insert_batch(pool, "energy_low",    None,        "mixed", &defaults.energy_low).await;
    for (vibe, words) in &defaults.vibes {
        count += insert_batch(pool, "vibe", Some(vibe), "mixed", words).await;
    }

    info!("vocab: seeded {count} default entries to Supabase");
    Ok(count)
}
