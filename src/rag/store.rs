/// Supabase PostgreSQL + pgvector store for viral moments.
///
/// Stores finalized ViralMoment structs with semantic embeddings and retrieves
/// similar past moments for RAG-based prompt enrichment.

use anyhow::{Context, Result};
use pgvector::Vector;
use sqlx::PgPool;
use tracing::{debug, info, warn};

// Supabase column: halfvec(4096) — no approximate index (exact cosine search).
// pgvector::Vector (f32) is auto-cast to halfvec by PostgreSQL on INSERT/query.

use crate::analyze::schema::ViralMoment;

// ── Types ─────────────────────────────────────────────────────────────────────

/// A similar past moment retrieved from the vector database.
#[derive(Debug, Clone)]
pub struct SimilarMoment {
    pub title:            String,
    pub hook:             String,
    pub reason:           String,
    pub viral_type:       String,
    pub content_category: String,
    pub energy:           String,
    pub duration_sec:     f64,
    pub similarity:       f32,
}

impl SimilarMoment {
    /// Format as a reference entry for the LLM system prompt.
    pub fn to_prompt_line(&self, rank: usize) -> String {
        format!(
            "{rank}. [{} · {} · {} energy] \"{}\"\n   \
             Hook: {} | {:.0}s | similarity: {:.2}\n   \
             Why it worked: {}",
            self.viral_type, self.content_category, self.energy,
            self.title,
            self.hook, self.duration_sec, self.similarity,
            self.reason
        )
    }
}

/// A proven narration STRUCTURE retrieved from `narration_structures` (built by
/// `scripts/analyze_narration_structure.py`). Used as a reference exemplar so the
/// narrator LLM can copy arcs/hooks/lessons that worked.
#[derive(Debug, Clone)]
pub struct NarrationRef {
    pub narration_style:  String,
    pub narrator_posture: String,
    pub hook_format:      String,
    pub arc:              Vec<String>,
    pub hook_text:        String,
    pub quality_score:    f64,
    pub what_makes_it_work: String,
    pub lessons:          Vec<String>,
    pub similarity:       f32,
}

impl NarrationRef {
    /// Format as one reference entry for the narrator prompt.
    fn to_prompt_line(&self, rank: usize) -> String {
        let mut s = format!(
            "{rank}. [{} · {} · hook: {} · quality {:.1}/10]",
            if self.narration_style.is_empty() { "?" } else { &self.narration_style },
            if self.narrator_posture.is_empty() { "?" } else { &self.narrator_posture },
            if self.hook_format.is_empty() { "?" } else { &self.hook_format },
            self.quality_score,
        );
        if !self.arc.is_empty() {
            s.push_str(&format!("\n   Arc: {}", self.arc.join(" → ")));
        }
        if !self.hook_text.trim().is_empty() {
            s.push_str(&format!("\n   Contoh hook: \"{}\"", self.hook_text.trim()));
        }
        if !self.what_makes_it_work.trim().is_empty() {
            s.push_str(&format!("\n   Kenapa berhasil: {}", self.what_makes_it_work.trim()));
        }
        if !self.lessons.is_empty() {
            let l = self.lessons.iter().take(3)
                .map(|x| x.trim()).filter(|x| !x.is_empty())
                .collect::<Vec<_>>().join("; ");
            if !l.is_empty() { s.push_str(&format!("\n   Pelajaran: {l}")); }
        }
        s
    }
}

// ── RagStore ──────────────────────────────────────────────────────────────────

pub struct RagStore {
    pool: PgPool,
}

impl RagStore {
    /// Connect to Supabase using the provided PostgreSQL URI.
    pub async fn new(url: &str) -> Result<Self> {
        let pool = PgPool::connect(url)
            .await
            .context("failed to connect to Supabase")?;
        Ok(Self { pool })
    }

    /// Store a batch of finalized moments with their pre-computed embeddings.
    pub async fn store_moments(
        &self,
        moments:       &[ViralMoment],
        embeddings:    &[Vec<f32>],
        job_id:        &str,
        video_title:   &str,
        video_channel: &str,
        language:      &str,
    ) -> Result<usize> {
        let mut stored = 0usize;

        for (moment, emb) in moments.iter().zip(embeddings.iter()) {
            if emb.is_empty() {
                warn!("rag: skipping '{}' — empty embedding", moment.title);
                continue;
            }

            let vec = Vector::from(emb.clone());
            let dur    = moment.end_sec - moment.start_sec;
            let humor  = moment.visual_score.as_ref().map(|s| s.humor as i16);
            let impact = moment.visual_score.as_ref().map(|s| s.visual_impact as i16);
            let novelty= moment.visual_score.as_ref().map(|s| s.novelty as i16);
            let engage = moment.visual_score.as_ref().map(|s| s.engagement as i16);

            // Use sqlx::query (not query!) — avoids compile-time DATABASE_URL requirement
            // $22::halfvec — explicit cast from vector to halfvec column
            let result = sqlx::query(
                "INSERT INTO viral_moments (\
                    job_id, video_title, video_channel, language,\
                    moment_title, headline, hook, reason, caption, target_audience,\
                    viral_type, content_category, emotional_trigger, energy,\
                    start_sec, end_sec, duration_sec,\
                    humor_score, visual_impact_score, novelty_score, engagement_score,\
                    clip_style, sfx_vibe, bgm_vibe, subtitle_style,\
                    overlay_style, overlay_position, sfx_at_sec,\
                    embedding\
                ) VALUES (\
                    $1, $2, $3, $4,\
                    $5, $6, $7, $8, $9, $10,\
                    $11, $12, $13, $14,\
                    $15, $16, $17,\
                    $18, $19, $20, $21,\
                    $22, $23, $24, $25,\
                    $26, $27, $28,\
                    $29::halfvec\
                ) ON CONFLICT DO NOTHING"
            )
            .bind(job_id)
            .bind(video_title)
            .bind(video_channel)
            .bind(language)
            .bind(&moment.title)
            .bind(&moment.headline)
            .bind(&moment.hook)
            .bind(&moment.reason)
            .bind(&moment.caption)
            .bind(&moment.target_audience)
            .bind(&moment.viral_type)
            .bind(&moment.content_category)
            .bind(&moment.emotional_trigger)
            .bind(&moment.energy)
            .bind(moment.start_sec)
            .bind(moment.end_sec)
            .bind(dur)
            .bind(humor)
            .bind(impact)
            .bind(novelty)
            .bind(engage)
            // Production choices — enables learning what works for similar content
            .bind(&moment.clip_style)
            .bind(&moment.sfx_vibe)
            .bind(&moment.bgm_vibe)
            .bind(&moment.subtitle_style)
            .bind(&moment.overlay_style)
            .bind(&moment.overlay_position)
            .bind(moment.sfx_at_sec)
            .bind(vec)
            .execute(&self.pool)
            .await;

            match result {
                Ok(_)  => { stored += 1; }
                Err(e) => warn!("rag: failed to store '{}': {e}", moment.title),
            }
        }

        info!("rag: stored {stored}/{} moments to Supabase", moments.len());
        Ok(stored)
    }

    /// Retrieve the top-N most similar past moments using cosine similarity.
    pub async fn retrieve_similar(
        &self,
        query_embedding: &[f32],
        limit:           i64,
        min_similarity:  f32,
        exclude_job_id:  Option<&str>,
    ) -> Result<Vec<SimilarMoment>> {
        if query_embedding.is_empty() {
            return Ok(Vec::new());
        }

        let vec = Vector::from(query_embedding.to_vec());
        let excl = exclude_job_id.unwrap_or("__none__");

        // Cast Vector to halfvec for comparison with halfvec column
        let rows = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<f64>, Option<f64>)>(
            "SELECT \
                moment_title, hook, reason, viral_type, content_category, energy, \
                duration_sec, \
                CAST(1.0 - (embedding <=> $1::halfvec) AS FLOAT8) AS similarity \
            FROM viral_moments \
            WHERE job_id != $2 \
              AND (1.0 - (embedding <=> $1::halfvec)) >= $3 \
            ORDER BY embedding <=> $1::halfvec \
            LIMIT $4"
        )
        .bind(vec)
        .bind(excl)
        .bind(min_similarity as f64)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .context("failed to query similar moments")?;

        let results = rows.into_iter().map(|(title, hook, reason, vtype, cat, energy, dur, sim)| {
            SimilarMoment {
                title,
                hook:             hook.unwrap_or_default(),
                reason:           reason.unwrap_or_default(),
                viral_type:       vtype.unwrap_or_default(),
                content_category: cat.unwrap_or_default(),
                energy:           energy.unwrap_or_default(),
                duration_sec:     dur.unwrap_or(0.0),
                similarity:       sim.unwrap_or(0.0) as f32,
            }
        }).collect::<Vec<_>>();

        debug!("rag: retrieved {} similar moments", results.len());
        Ok(results)
    }

    /// Format retrieved moments as a RAG context block for the LLM prompt.
    pub fn format_for_prompt(moments: &[SimilarMoment]) -> String {
        if moments.is_empty() { return String::new(); }
        moments.iter()
            .enumerate()
            .map(|(i, m)| m.to_prompt_line(i + 1))
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Retrieve the top-N most similar proven narration structures from the
    /// `narration_structures` table (cosine similarity on the analysis embedding).
    pub async fn retrieve_narration_structures(
        &self,
        query_embedding: &[f32],
        limit:           i64,
        min_similarity:  f32,
    ) -> Result<Vec<NarrationRef>> {
        if query_embedding.is_empty() {
            return Ok(Vec::new());
        }
        let vec = Vector::from(query_embedding.to_vec());

        let rows = sqlx::query_as::<_, (
            Option<String>, Option<String>, Option<String>, Option<Vec<String>>,
            Option<String>, Option<f64>, Option<String>, Option<String>, Option<f64>,
        )>(
            "SELECT \
                narration_style, narrator_posture, hook_format, arc_template, \
                hook_text, quality_score, \
                analysis->>'what_makes_it_work' AS wmiw, \
                analysis->>'lessons_for_generation' AS lessons, \
                CAST(1.0 - (embedding <=> $1::halfvec) AS FLOAT8) AS similarity \
            FROM narration_structures \
            WHERE embedding IS NOT NULL \
              AND (1.0 - (embedding <=> $1::halfvec)) >= $2 \
            ORDER BY embedding <=> $1::halfvec \
            LIMIT $3"
        )
        .bind(vec)
        .bind(min_similarity as f64)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .context("failed to query narration structures")?;

        let refs = rows.into_iter().map(|(style, posture, hookfmt, arc, hook, q, wmiw, lessons, sim)| {
            // `lessons` is the JSON-array text from `analysis->>'lessons_for_generation'`.
            let lessons_vec: Vec<String> = lessons
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .unwrap_or_default();
            NarrationRef {
                narration_style:  style.unwrap_or_default(),
                narrator_posture: posture.unwrap_or_default(),
                hook_format:      hookfmt.unwrap_or_default(),
                arc:              arc.unwrap_or_default(),
                hook_text:        hook.unwrap_or_default(),
                quality_score:    q.unwrap_or(0.0),
                what_makes_it_work: wmiw.unwrap_or_default(),
                lessons:          lessons_vec,
                similarity:       sim.unwrap_or(0.0) as f32,
            }
        }).collect::<Vec<_>>();

        debug!("rag: retrieved {} narration structure(s)", refs.len());
        Ok(refs)
    }

    /// Format retrieved narration structures as a reference block for the prompt.
    pub fn format_narration_refs(refs: &[NarrationRef]) -> String {
        if refs.is_empty() { return String::new(); }
        refs.iter()
            .enumerate()
            .map(|(i, r)| r.to_prompt_line(i + 1))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}
