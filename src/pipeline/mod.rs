pub mod job;
pub mod state;

use std::path::Path;

use anyhow::{Context, Result};
use tracing::{info, warn};
use crate::util::progress::stage_header;
use uuid::Uuid;

use crate::analyze::AnalyzeService;
use crate::cli::{LlmProviderName, OutputLayout as CliLayout, WhisperModelSize};
use crate::config::AppConfig;
use crate::edit::layout::OutputLayout;
use crate::edit::{AudioOptions, EditService};
use crate::ingest::IngestService;
use crate::news::EnrichService;
use crate::transcribe::TranscribeService;
use crate::util::fs::ensure_dir;

use job::JobContext;
use state::PipelineState;

pub struct PipelineRunner<'a> {
    config: &'a AppConfig,
}

impl<'a> PipelineRunner<'a> {
    pub fn new(config: &'a AppConfig) -> Self {
        Self { config }
    }

    pub async fn run(
        &self,
        url: &str,
        output_dir: &Path,
        provider: &LlmProviderName,
        model: &WhisperModelSize,
        max_clips: usize,
        layout: &CliLayout,
        focus_keywords: &[String],
        audio_opts: &AudioOptions,
        social_name:        &str,
        resume_id:          Option<&str>,
        style_profile_name: &str,
    ) -> Result<Vec<std::path::PathBuf>> {
        ensure_dir(output_dir)?;

        // Create or load job state
        let job_id = resume_id
            .map(|s| s.to_owned())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let job = JobContext::new(job_id.clone(), output_dir.to_owned())
            .context("failed to create job directories")?;

        let mut state = if resume_id.is_some() && job.state_path().exists() {
            let s = PipelineState::load(&job.state_path()).context("failed to load pipeline state")?;
            info!("resuming job {job_id}");
            s
        } else {
            PipelineState::new(job_id.clone(), url.to_owned())
        };

        // ── Stage 1: Ingest ──────────────────────────────────────────────
        if state.stages.ingest.is_none() {
            stage_header(1, 5, "Ingest  (yt-dlp download)");
            let svc = IngestService::new(self.config, &job);
            let result = svc.run(url, false).await?;
            state.stages.ingest = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 1/4: Ingest — skipped (already complete)");
        }

        // Clone fields out of ingest result before further borrows
        let ingest = state.stages.ingest.as_ref().unwrap();
        let video_path    = ingest.video_path.clone();
        let video_title   = ingest.title.clone();
        let video_channel = ingest.channel.clone();
        let video_duration = ingest.duration_secs;

        // ── Stage 2: Transcribe ──────────────────────────────────────────
        if state.stages.transcribe.is_none() {
            stage_header(2, 5, "Transcribe  (Groq Whisper API)");
            info!("  Video   : \"{}\"  ({:.0}s)", video_title, video_duration);
            let svc = TranscribeService::new(self.config, &job);
            let result = svc.run(&video_path, &model.to_string()).await?;
            state.stages.transcribe = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 2/4: Transcribe — skipped (already complete)");
        }

        // ── Stage 3: Analyze ─────────────────────────────────────────────
        if state.stages.analyze.is_none() {
            stage_header(3, 5, &format!("Analyze  ({} LLM)", provider));
            let svc = AnalyzeService::new(self.config, &job);
            let result = svc
                .run(
                    &job.transcript_path(),
                    &provider.to_string(),
                    max_clips,
                    focus_keywords,
                    Some(&video_path),   // enables visual frame analysis
                    &video_title,
                    &video_channel,
                )
                .await?;
            state.stages.analyze = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 3/5: Analyze — skipped (already complete)");
        }

        // ── Stage 4: Enrich  (news + reaction) ───────────────────────────
        if state.stages.enrich.is_none() && self.config.news.enabled {
            stage_header(4, 5, "Enrich  (news search)");
            let svc = EnrichService::new(self.config, &job);
            match svc
                .run(
                    &job.moments_path(),
                    &job.transcript_path(),
                    &video_title,
                    &video_channel,
                    &provider.to_string(),
                )
                .await
            {
                Ok(result) => {
                    state.stages.enrich = Some(result);
                    state.save(&job.state_path())?;
                }
                // Enrichment is best-effort — never fail the whole pipeline over it.
                Err(e) => warn!("Stage 4/5: Enrich failed — continuing without news: {e}"),
            }
        } else if state.stages.enrich.is_none() {
            info!("Stage 4/5: Enrich — skipped (news disabled)");
        } else {
            info!("Stage 4/5: Enrich — skipped (already complete)");
        }

        // ── Stage 4.5: Narration  (narrator-driven spine) ────────────────
        // Generate ONE continuous narrator voiceover (+ word timings) that the
        // edit builds the video around. Best-effort: never fails the pipeline.
        if self.config.narration.enabled && !job.narration_mp3().exists() {
            stage_header(4, 5, "Narration  (narrator voiceover)");
            match self.generate_narration(&job, provider).await {
                Ok(()) => {}
                Err(e) => warn!("Narration failed — continuing without narrator: {e}"),
            }
        }

        // ── Stage 5: Edit ────────────────────────────────────────────────
        if state.stages.edit.is_none() {
            stage_header(5, 5, &format!("Edit  (FFmpeg {layout} clips)"));
            let svc = EditService::new(self.config, &job);
            let out_layout = OutputLayout::from(layout);

            let result = svc
                .run(
                    &video_path,
                    &job.moments_path(),
                    &job.transcript_path(),
                    &out_layout,
                    audio_opts,
                    &video_channel,
                    social_name,
                    style_profile_name,
                )
                .await?;
            state.stages.edit = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 5/5: Edit — skipped (already complete)");
        }

        let edit = state.stages.edit.as_ref().unwrap();
        let paths: Vec<_> = edit.output_clips.iter().map(|c| c.path.clone()).collect();

        eprintln!("\n  ╔══════════════════════════════════════════════════╗");
        eprintln!("  ║  Pipeline complete  —  {} clip(s) ready              ║", paths.len());
        eprintln!("  ╚══════════════════════════════════════════════════╝");
        for (i, clip) in edit.output_clips.iter().enumerate() {
            eprintln!(
                "  [{}] \"{}\"  ({:.0}s)  →  {}",
                i + 1,
                clip.title,
                clip.duration_secs,
                clip.path.display()
            );
        }
        eprintln!();

        Ok(paths)
    }

    /// Generate the narrator voiceover spine: read the event transcript, ask the
    /// LLM for one continuous commentator script, synthesize it (timed), and save
    /// `narration.mp3` + `narration_words.json`. Best-effort.
    async fn generate_narration(
        &self,
        job: &JobContext,
        provider: &LlmProviderName,
    ) -> Result<()> {
        use crate::transcribe::model::Transcript;

        let raw = tokio::fs::read_to_string(job.transcript_path())
            .await
            .context("read transcript for narration")?;
        let transcript: Transcript =
            serde_json::from_str(&raw).context("parse transcript for narration")?;
        let main_text = transcript
            .segments.iter().map(|s| s.text.as_str())
            .collect::<Vec<_>>().join(" ");

        // Build the narration SOURCE from every real story signal OpenClaw gives
        // us — not the spoken audio alone. Raw b-roll (e.g. a 29s arrest clip) has a
        // near-empty transcript, so the title + platform caption + top viral
        // comments carry the actual topic; feeding only the transcript made the LLM
        // hallucinate an unrelated hook. Order = orientation → facts → sentiment.
        let mut sources: Vec<String> = Vec::new();
        if let Some(ctx) = crate::ingest::content_search::load_main_context(&job.base_dir) {
            if !ctx.title.trim().is_empty() {
                sources.push(format!("[Judul]\n{}", ctx.title.trim()));
            }
            if !ctx.description.trim().is_empty() {
                sources.push(format!("[Deskripsi]\n{}", ctx.description.trim()));
            }
            // The real subject(s) — person/org/community OpenClaw identified. Naming them
            // explicitly stops the narrator inventing or mislabelling who the story is about.
            if !ctx.figures.is_empty() {
                let lines: Vec<String> = ctx.figures.iter()
                    .filter(|f| !f.name.trim().is_empty())
                    .map(|f| {
                        let mut s = format!("- {}", f.name.trim());
                        if !f.role.trim().is_empty() { s.push_str(&format!(" ({})", f.role.trim())); }
                        if !f.description.trim().is_empty() { s.push_str(&format!(": {}", f.description.trim())); }
                        s
                    })
                    .collect();
                if !lines.is_empty() {
                    sources.push(format!("[Tokoh]\n{}", lines.join("\n")));
                }
            }
        }
        let mut comments = crate::edit::comment_card::load_comment_pool(&job.base_dir);
        if !comments.is_empty() {
            comments.sort_by(|a, b| b.likes.cmp(&a.likes)); // most-liked first
            let lines: Vec<String> = comments.iter().take(12)
                .map(|c| if c.likes > 0 {
                    format!("- {} ({} like): {}", c.author, c.likes, c.text)
                } else {
                    format!("- {}: {}", c.author, c.text)
                })
                .collect();
            sources.push(format!("[Komentar Netizen Teratas]\n{}", lines.join("\n")));
        }

        // Vision model's account of what's literally ON SCREEN (analyze stage,
        // `describe_video`). For raw b-roll this is the only objective record of the
        // event itself — feed it so the narrator describes what actually happens.
        if let Ok(raw) = std::fs::read_to_string(job.video_descriptions_path()) {
            if let Ok(descs) = serde_json::from_str::<Vec<crate::analyze::VideoDescription>>(&raw) {
                let lines: Vec<String> = descs.iter()
                    .filter(|d| !d.text.trim().is_empty())
                    .take(20) // keep the prompt tight
                    .map(|d| format!("- [{:.0}s] {}", d.timestamp_sec, d.text.trim()))
                    .collect();
                if !lines.is_empty() {
                    sources.push(format!("[Deskripsi Visual]\n{}", lines.join("\n")));
                }
            }
        }

        // Analysis results (analyze stage): the ranked viral angles + each moment's
        // vision note. Gives the narrator the "why this matters" framing.
        if let Ok(raw) = std::fs::read_to_string(job.moments_path()) {
            if let Ok(list) = serde_json::from_str::<crate::analyze::ViralMomentList>(&raw) {
                let lines: Vec<String> = list.moments.iter().take(4).filter_map(|m| {
                    let note = m.visual_score.as_ref().map(|v| v.note.trim()).unwrap_or("");
                    let basis = if !note.is_empty() { note } else { m.reason.trim() };
                    (!basis.is_empty()).then(|| format!("- {basis}"))
                }).collect();
                if !lines.is_empty() {
                    sources.push(format!("[Analisa Momen]\n{}", lines.join("\n")));
                }
            }
        }

        let transcript_has_speech = main_text.split_whitespace().count() >= 8;
        if transcript_has_speech {
            sources.push(format!("[Transkrip Audio]\n{}", main_text.trim()));
        }

        // Enrich with subtitles from related videos in the footage pool (extra
        // angles on the topic) without changing the main video used for the edit.
        let enrich_text = self.fetch_enrichment_texts(&job.base_dir).await;
        if !enrich_text.is_empty() {
            sources.push(format!("[Video Terkait]\n{}", enrich_text.join("\n\n")));
        }

        if sources.is_empty() {
            anyhow::bail!(
                "no narration source: empty transcript and no OpenClaw title/description/comments"
            );
        }
        let source_text = sources.join("\n\n");
        tracing::info!(
            "🎙️  Narration context: {} block(s){}",
            sources.len(),
            if transcript_has_speech { "" } else { " — transcript empty, grounded on title/desc/comments" }
        );

        // Narration may use a more creative model than analyze (e.g. deepseek-v4-flash for natural
        // Indonesian prose) without breaking analyze's structured JSON extraction. Override the
        // ACTIVE provider's model with `[narration] model` when set; provider stays the same.
        let nm = self.config.narration.model.trim().to_string();
        let llm = if nm.is_empty() {
            crate::analyze::provider::build_llm_provider(self.config, &provider.to_string())
        } else {
            let mut cfg = self.config.clone();
            match provider.to_string().as_str() {
                "claude" => cfg.llm.claude_model = nm.clone(),
                "gemini" => cfg.llm.gemini_model = nm.clone(),
                "openai" => cfg.llm.openai_model = nm.clone(),
                "vllm"   => cfg.llm.vllm_model = nm.clone(),
                _         => cfg.llm.novita_model = nm.clone(), // novita & other OpenAI-compat
            }
            tracing::info!("🎙️  Narration model override: {nm} (analyze tetap pakai [llm] model)");
            crate::analyze::provider::build_llm_provider(&cfg, &provider.to_string())
        }
        .map_err(|e| anyhow::anyhow!("narration provider: {e}"))?;

        // RAG: retrieve proven narration STRUCTURES (arc/hook/lessons) from the
        // `narration_structures` corpus and inject them as a reference block so the
        // script imitates what worked. Best-effort; empty when disabled/unavailable.
        let structure_refs = self.build_narration_structure_refs(&source_text).await;

        let narr = crate::narration::produce(
            llm.as_ref(),
            &source_text,
            &self.config.reaction,
            &self.config.news,
            &job.narration_mp3(),
            &self.config.narration.language,
            self.config.narration.target_secs,
            &structure_refs,
        )
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

        // Persist word timings for the edit stage.
        let words_json = serde_json::to_string(&narr.words).unwrap_or_else(|_| "[]".into());
        let _ = std::fs::write(job.narration_words(), words_json);
        // Persist the hook line so the edit can use it for the 0–3s headline.
        let _ = std::fs::write(job.narration_dir().join("hook.txt"), &narr.hook);
        // Persist the full narration script so the structure verifier
        // (scripts/verify_narration_structure.py) can check it against the corpus.
        let _ = std::fs::write(job.narration_dir().join("narration.txt"), &narr.text);
        Ok(())
    }

    /// Retrieve proven narration structures from the `narration_structures` Supabase
    /// table (built by `scripts/analyze_narration_structure.py`) most similar to this
    /// video's context, and format them as a reference block for the narrator prompt.
    ///
    /// Gated on `[narration] structure_rag` + a configured `CLIPPER_SUPABASE_URL` +
    /// a valid embed provider. Independent of `[vector_db] enabled` (moments-RAG).
    /// Returns an empty string on any miss — narration always proceeds.
    async fn build_narration_structure_refs(&self, source_text: &str) -> String {
        let ncfg = &self.config.narration;
        let vdb = &self.config.vector_db;
        if !ncfg.structure_rag || vdb.supabase_url.is_empty() {
            return String::new();
        }
        let embed_cfg = crate::rag::embed::EmbedConfig::from_app_config(self.config);
        if !embed_cfg.is_valid() {
            tracing::debug!("narration RAG: embed provider invalid — skip");
            return String::new();
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();

        // Query embedding from the assembled narration context (topic + sentiment).
        let query_text: String = source_text.chars().take(2000).collect();
        let embedding = match crate::rag::embed::embed_text_with_config(
            &query_text, &embed_cfg, &client,
        ).await {
            Some(e) => e,
            None => { tracing::debug!("narration RAG: embedding failed — skip"); return String::new(); }
        };

        let store = match crate::rag::RagStore::new(&vdb.supabase_url).await {
            Ok(s) => s,
            Err(e) => { tracing::warn!("narration RAG: cannot connect to Supabase: {e}"); return String::new(); }
        };

        let refs = match store.retrieve_narration_structures(
            &embedding,
            ncfg.structure_rag_count as i64,
            ncfg.structure_rag_min_similarity,
        ).await {
            Ok(r) => r,
            Err(e) => { tracing::warn!("narration RAG: retrieval failed: {e}"); return String::new(); }
        };

        if refs.is_empty() {
            tracing::debug!("narration RAG: no reference structures found");
            return String::new();
        }
        tracing::info!(
            "🧠 Narration RAG: {} reference structure(s) injected (top similarity {:.2})",
            refs.len(), refs.first().map(|r| r.similarity).unwrap_or(0.0)
        );
        crate::rag::RagStore::format_narration_refs(&refs)
    }

    /// Fetch subtitle text from enrichment pool YouTube videos to enrich the
    /// narrator's context. Uses yt-dlp `--skip-download --write-auto-sub` which
    /// is very fast (<2s per video). Returns plain text, one entry per video.
    async fn fetch_enrichment_texts(&self, base_dir: &std::path::Path) -> Vec<String> {
        use crate::ingest::content_search::ContentResult;

        let enrich_path = base_dir.join(crate::edit::enrichment::ENRICHMENT_FILE);
        let raw = match std::fs::read_to_string(&enrich_path) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let pool: Vec<ContentResult> = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        // Take up to N YouTube videos from the pool (skip non-YouTube — subtitle
        // download only works reliably on YouTube).
        let max_extra = self.config.narration.max_enrichment_sources.min(4) as usize;
        let candidates: Vec<&ContentResult> = pool.iter()
            .filter(|r| r.platform == "youtube" && !r.url.is_empty() && r.relevance != "unverified")
            .take(max_extra)
            .collect();

        if candidates.is_empty() { return Vec::new(); }

        let ytdlp = &self.config.ingest.ytdlp_path;
        let tmp = base_dir.join(".narr_subs");
        let _ = std::fs::create_dir_all(&tmp);
        let mut texts: Vec<String> = Vec::new();

        for cand in candidates {
            let out_tmpl = tmp.join("%(id)s.%(ext)s");
            let mut cmd = tokio::process::Command::new(ytdlp);
            cmd.args([
                "--skip-download", "--write-auto-sub",
                "--sub-lang", "id-orig,id,en",
                "--sub-format", "vtt",
                "--ignore-errors", "--quiet",
                "-o", &out_tmpl.to_string_lossy(),
                &cand.url,
            ]);
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                cmd.output(),
            ).await;

            // Parse the downloaded VTT → plain text
            if let Some(text) = Self::parse_vtt_dir(&tmp) {
                if !text.trim().is_empty() {
                    let label = if !cand.title.is_empty() {
                        format!("[{}]\n{}", cand.title.chars().take(60).collect::<String>(), text)
                    } else { text };
                    texts.push(label);
                    tracing::debug!("enrichment sub: {} chars from {}", texts.last().unwrap().len(), cand.url);
                }
            }
            // Clean up vtt files after each video
            let _ = std::fs::read_dir(&tmp).map(|rd| {
                for e in rd.flatten() { let _ = std::fs::remove_file(e.path()); }
            });
        }
        let _ = std::fs::remove_dir(&tmp);
        texts
    }

    /// Parse all .vtt files in a directory → deduplicated plain text.
    fn parse_vtt_dir(dir: &std::path::Path) -> Option<String> {
        let mut out = String::new();
        let Ok(entries) = std::fs::read_dir(dir) else { return None; };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("vtt") { continue; }
            let Ok(content) = std::fs::read_to_string(&p) else { continue };
            let mut prev = String::new();
            for line in content.lines() {
                let l = line.trim();
                if l.is_empty() || l.starts_with("WEBVTT") || l.starts_with("Kind:")
                    || l.starts_with("Language:") || l.contains("-->") || l.parse::<u64>().is_ok()
                    || l.contains('<') { continue; }
                let clean: String = l.chars().filter(|c| !c.is_control()).collect();
                if clean != prev && !clean.is_empty() {
                    if !out.is_empty() { out.push(' '); }
                    out.push_str(&clean);
                    prev = clean;
                }
            }
        }
        if out.is_empty() { None } else { Some(out) }
    }
}
