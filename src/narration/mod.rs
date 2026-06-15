//! Narrator-driven narration (Animelorian spine).
//!
//! Generates ONE continuous narrator script (gossip-commentator style) for the
//! whole video, synthesizes it to a voiceover with per-word timings, and returns
//! everything the edit needs to build the video AROUND the narration: the MP3,
//! word timestamps (for synced word-pop subtitles + pacing), the spoken duration,
//! and the punchy hook line (for the 0–3s headline).
//!
//! Voice: ElevenLabs `with-timestamps` (natural, exact timing) → Edge TTS fallback.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tracing::{info, warn};

use crate::analyze::provider::LlmProvider;
use crate::config::{NewsConfig, ReactionConfig};
use crate::reaction::tts::synthesize_timed;
use crate::transcribe::model::WordTimestamp;

/// Everything the narration-driven edit consumes.
#[derive(Debug, Clone)]
pub struct Narration {
    /// Voiceover MP3 (the audio spine).
    pub mp3: PathBuf,
    /// Per-word timings for synced subtitles + footage pacing.
    pub words: Vec<WordTimestamp>,
    /// Spoken duration in seconds (= output video length).
    pub duration_secs: f64,
    /// Punchy hook sentence → giant 0–3s headline.
    pub hook: String,
    /// Full narration text (for logging / debug).
    pub text: String,
}

const SYSTEM: &str = "\
Lo kreator konten shorts viral Indonesia, spesialisasi RAGE-BAIT yang bikin orang gemes, \
heran, atau pengen share. Lo bukan reporter, bukan motivator, bukan ceramah. Lo adalah \
orang yang sinis, skeptis, heran — yang nge-judge kejadian aneh sambil ngakak sendiri. \
Sopan tapi TAJAM. Output HANYA JSON, gaada teks lain.";

/// Generate the continuous narrator script + hook line from the event transcript.
async fn generate_script(
    provider: &dyn LlmProvider,
    source_text: &str,
    language: &str,
    target_secs: u32,
    structure_refs: &str,
) -> Result<(String, String), String> {
    let words = (target_secs * 3).clamp(40, 220); // ~3 kata/detik (Indonesia)
    // Reference structures retrieved from the narration_structures corpus (RAG).
    // The narrator should imitate the proven ARC/HOOK/pacing, NOT copy the words.
    let refs_block = if structure_refs.trim().is_empty() {
        String::new()
    } else {
        format!(
            "REFERENSI STRUKTUR NARASI YANG TERBUKTI (dari video sejenis yang viral — \
             TIRU POLA arc/hook/pacing/punchline-nya, JANGAN salin kata-katanya, topiknya beda):\n\
             {structure_refs}\n\n",
            structure_refs = structure_refs.trim(),
        )
    };
    let user = format!(
        "Ini SUMBER KONTEKS sebuah kejadian. Bisa berisi beberapa blok: [Judul], \
         [Deskripsi], [Komentar Netizen Teratas], [Deskripsi Visual] (apa yang \
         TERLIHAT di layar dari model vision), [Analisa Momen] (kenapa momen ini \
         viral), [Transkrip Audio], dan/atau [Video Terkait]. Pahami TOPIK & FAKTA \
         nyatanya dari SEMUA blok:\n\
         ====================\n{src}\n====================\n\n\
         PENTING — GROUNDING: Narasi WAJIB berdasar fakta & topik NYATA di atas \
         (nama tokoh, kejadian, angka, sentimen komentar). Kalau transkrip audio \
         kosong/tipis, ambil cerita dari [Judul]+[Deskripsi]+[Komentar]+[Deskripsi Visual]. \
         DILARANG KERAS mengarang topik/tokoh/kejadian yang tidak ada di konteks.\n\n\
         {refs_block}\
         Bikin SATU narasi RAGE-BAIT menerus (bahasa {lang}) buat di-voiceover-in. \
         Pelajari DNA rage-bait konten viral Indonesia dan terapkan:\n\n\
         STRUKTUR WAJIB:\n\
         1. HOOK: Buka dengan ranking/list bikin penasaran ATAU pernyataan gila yang langsung \
            bikin dahi berkerut. Contoh pola: \"Ada N hal [tokoh] yang bikin geleng-geleng:\", \
            \"Bisa-bisanya [tokoh] ngaku [hal gila]\", \"Niatnya X eh malah Y\". \
            Jangan buka dengan sapaan 'Gais' atau 'Halo'.\n\
         2. ISI: Ceritakan dengan gaya SINIS + HERAN, bukan empati. Dari komentar, PILIH HANYA 1-2 \
            yang BENAR-BENAR lucu/nyeleneh/kontroversial — PARAFRASE jadi kalimat sendiri yang natural \
            (kutip singkat HANYA kalau punchy). ABAIKAN komentar RECEH/random: keluhan badan \
            ('paha gatel', 'pegel'), pujian umum ('keren','sehat','semangat'), emoji-doang, atau yang \
            gak nambah cerita. JANGAN dump banyak komentar mentah-mentah. Reaksi heran singkat & \
            VARIASIKAN tiap kali. Campur kalimat pendek & sedang biar NGALIR natural, bukan patah-patah.\n\
         3. PENUTUP: Tutup dengan satu pertanyaan tajam yang SPESIFIK ke kasus ini (sebut detail/\
            tokoh/angka-nya) yang memancing debat — BUKAN template generik yang bisa ditempel di \
            video mana pun. Boleh juga tutup dengan satu komentar heran pendek yang nyangkut ke \
            fakta terakhir. JANGAN pernah tutup dengan nasihat, motivasi, atau kesimpulan moral \
            ('kita harus lebih selektif','tetap bijak','semoga sadar', dll) — itu mematikan rage-bait.\n\n\
         NATURAL & ANTI-TEMPLATE (PENTING untuk kualitas diksi):\n\
         - Tulis bahasa Indonesia LISAN yang wajar diucapkan; hindari frasa kaku / terjemahan literal.\n\
         - JANGAN salin contoh frasa di prompt ini mentah-mentah — itu cuma arah GAYA, bukan kata wajib.\n\
         - JANGAN ulang FRASA KUNCI / sudut yang sama dua kali. Kalau HOOK sudah pakai satu frasa \
           (mis. 'jantung model apa', '15km tiap pagi'), JANGAN ulang frasa itu lagi di isi/penutup — \
           cari sudut & diksi lain. Tiap kalimat menambah info BARU, bukan mengulang yang sudah disebut.\n\
         - Variasikan diksi & pembuka kalimat; tiap naskah harus terasa BEDA, bukan cetakan ganti-nama.\n\n\
         LARANGAN KERAS:\n\
         - JANGAN kata kasar/umpatan (anjir, anjay, bangsat, goblok, dll). Sopan tapi tajam.\n\
         - JANGAN bahasa berita/formal: 'merupakan','tersebut','adapun','hal ini','beliau','sang'.\n\
         - JANGAN ceramah, nasihat, atau motivasi di mana pun dalam narasi.\n\
         - JANGAN sapaan alay berlebihan ('mantul!', 'gaspol!', 'ygy!') di akhir.\n\
         - JANGAN kalimat panjang bertele-tele.\n\n\
         REFERENSI VIBE yang BENAR:\n\
         Contoh topik 'penceramah ngaku penjaga gawang neraka': \
         \"Top dua pernyataan paling gila dari Abah Gufron. Yang pertama — katanya santrinya \
         yang kecelakaan selamat karena malaikat maut takut sama dia. Serius. Malaikat. Takut. \
         Yang kedua, ngaku jadi penjaga gawang neraka. Bisa-bisanya. Dan jamaahnya bilang 'betul'. \
         Jadi kalau gawang neraka dijaga Abah Gufron, yang nge-gol-in siapa dong?\"\n\
         → Notice: tidak ada sapaan, tidak ada nasihat, tidak ada 'mantul'. Fakta gila + \
         reaksi heran singkat + penutup pertanyaan yang SPESIFIK ke kasusnya (bukan template). \
         Itu rage-bait. (Ingat: JANGAN tiru kalimatnya — tiru POLA-nya saja.)\n\n\
         Panjang sekitar {words} kata (≈{secs} detik dibaca). Natural buat diucapin.\n\n\
         Output JSON:\n\
         {{\"hook\": \"hook penasaran ≤12 kata buat judul\", \
         \"narration\": \"naskah react gaul menerus...\"}}",
        src = source_text.chars().take(3500).collect::<String>().trim(),
        lang = language, words = words, secs = target_secs,
        refs_block = refs_block,
    );

    let raw = provider.chat_completion(SYSTEM, &user).await
        .map_err(|e| format!("LLM narration: {e}"))?;

    let cleaned = strip_fences(&raw);
    let json = cleaned.find('{').and_then(|s| cleaned.rfind('}').map(|e| &cleaned[s..=e]))
        .unwrap_or(cleaned.trim());
    let val: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("parse narration JSON: {e}: {json}"))?;
    let obj = val.as_object()
        .ok_or_else(|| format!("narration JSON not an object: {json}"))?;

    let hook = obj.get("hook").and_then(|v| v.as_str())
        .or_else(|| obj.get("title").and_then(|v| v.as_str()))
        .unwrap_or("").trim().to_string();

    // The model is wildly inconsistent with the narration key (narration / naration / narrating /
    // narrator / narasi / script / naskah / …). Rather than chase every spelling with serde aliases
    // (whack-a-mole — each run invents a new one), pick it robustly: prefer a string field whose KEY
    // looks like a narration key; otherwise fall back to the LONGEST string value that isn't the hook
    // (the script is always the longest field). This makes parsing key-name-agnostic.
    let key_like = |k: &str| {
        let k = k.to_ascii_lowercase();
        k.contains("narr") || k.contains("nara") || k == "script" || k == "naskah"
            || k == "text" || k == "body" || k == "voiceover" || k == "vo"
    };
    let narration = obj.iter()
        .filter(|(k, v)| k.as_str() != "hook" && v.is_string())
        .find(|(k, _)| key_like(k))
        .and_then(|(_, v)| v.as_str())
        .or_else(|| obj.iter()
            .filter(|(k, _)| k.as_str() != "hook")
            .filter_map(|(_, v)| v.as_str())
            .max_by_key(|s| s.len()))
        .unwrap_or("")
        .trim()
        .to_string();

    if narration.split_whitespace().count() < 8 {
        return Err(format!("narration too short / not found: {json}"));
    }
    Ok((narration, hook))
}

/// Full narration pipeline: LLM script → TTS (timed) → [`Narration`].
pub async fn produce(
    provider: &dyn LlmProvider,
    source_text: &str,
    reaction_cfg: &ReactionConfig,
    news_cfg: &NewsConfig,
    mp3_path: &Path,
    language: &str,
    target_secs: u32,
    structure_refs: &str,
) -> Result<Narration, String> {
    let (text, hook) = generate_script(provider, source_text, language, target_secs, structure_refs).await?;
    info!("🎙️  Narration script: {} words | hook: \"{}\"", text.split_whitespace().count(), hook);

    let timed = synthesize_timed(&text, mp3_path, reaction_cfg, news_cfg).await
        .map_err(|e| format!("narration TTS: {e}"))?;

    if timed.words.is_empty() {
        warn!("narration TTS returned no word timings — subtitles may be unsynced");
    }
    info!("🎙️  Narration voice: {:.1}s, {} word timings → {}",
          timed.duration_secs, timed.words.len(), timed.path.display());

    Ok(Narration {
        mp3: timed.path, words: timed.words, duration_secs: timed.duration_secs, hook, text,
    })
}

fn strip_fences(raw: &str) -> &str {
    let t = raw.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest.splitn(2, '\n').nth(1).unwrap_or(rest);
        return rest.trim_end().trim_end_matches("```").trim();
    }
    t
}
