/// Vector DB + RAG module — Supabase PostgreSQL + pgvector.
///
/// Provides long-term memory for Thoth:
/// - `embed`  — semantic embeddings via Gemini text-embedding-004
/// - `store`  — pgvector store/retrieve via sqlx + Supabase PostgreSQL

pub mod embed;
pub mod store;
pub mod vocab;

pub use store::{NarrationRef, RagStore, SimilarMoment};
pub use vocab::{VocabCache, SharedVocabCache};
