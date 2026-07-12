pub mod types;
pub use types::*;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::Row;
use std::{str::FromStr, time::Duration};

#[derive(Clone)]
pub struct JobStore {
    pub pool: sqlx::SqlitePool,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl JobStore {
    pub async fn connect(db_path: &str) -> anyhow::Result<JobStore> {
        let opts = SqliteConnectOptions::from_str(db_path)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new().max_connections(5).connect_with(opts).await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(JobStore { pool })
    }

    fn row_to_record(row: &sqlx::sqlite::SqliteRow) -> JobRecord {
        let params: String = row.get("params");
        JobRecord {
            id: row.get("id"),
            spec: JobSpec {
                command: row.get("command"),
                url: row.get("url"),
                content_set: row.get("content_set"),
                params: serde_json::from_str(&params).unwrap_or(serde_json::Value::Null),
            },
            status: JobStatus::from_str(&row.get::<String, _>("status")).unwrap_or(JobStatus::Failed),
            stage: row.get("stage"),
            pct: row.get::<f64, _>("pct") as f32,
            error: row.get("error"),
            output_dir: row.get("output_dir"),
            worker_id: row.get("worker_id"),
            cancel_requested: row.get::<i64, _>("cancel_requested") != 0,
            created_at: row.get("created_at"),
            started_at: row.get("started_at"),
            finished_at: row.get("finished_at"),
            heartbeat_at: row.get("heartbeat_at"),
            updated_at: row.get("updated_at"),
        }
    }

    /// Insert a queued job. The caller supplies `id` so it can derive a matching
    /// `output_dir` (the artifact route serves `output_root/<id>`) and hand the
    /// id back to the client without a round-trip.
    pub async fn enqueue(&self, id: &str, spec: &JobSpec, output_dir: &str) -> anyhow::Result<()> {
        let ts = now();
        sqlx::query(
            "INSERT INTO jobs (id, command, url, content_set, params, status, output_dir, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
        )
        .bind(id).bind(&spec.command).bind(&spec.url).bind(&spec.content_set)
        .bind(spec.params.to_string()).bind(output_dir).bind(&ts).bind(&ts)
        .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn get(&self, id: &str) -> anyhow::Result<Option<JobRecord>> {
        let row = sqlx::query("SELECT * FROM jobs WHERE id = ?").bind(id)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(|r| Self::row_to_record(&r)))
    }

    pub async fn list(&self) -> anyhow::Result<Vec<JobRecord>> {
        let rows = sqlx::query("SELECT * FROM jobs ORDER BY created_at DESC")
            .fetch_all(&self.pool).await?;
        Ok(rows.iter().map(Self::row_to_record).collect())
    }

    pub async fn claim_next(&self, worker_id: &str) -> anyhow::Result<Option<JobRecord>> {
        let ts = now();
        let row = sqlx::query(
            "UPDATE jobs SET status='running', worker_id=?, started_at=?, heartbeat_at=?, updated_at=?
             WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
             RETURNING *",
        )
        .bind(worker_id).bind(&ts).bind(&ts).bind(&ts)
        .fetch_optional(&self.pool).await?;
        Ok(row.map(|r| Self::row_to_record(&r)))
    }

    pub async fn append_event(&self, job_id: &str, kind: &str, stage: Option<&str>, pct: Option<f32>, message: Option<&str>) -> anyhow::Result<i64> {
        let seq: i64 = sqlx::query(
            "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
        )
        .bind(job_id).bind(kind).bind(stage).bind(pct.map(|p| p as f64)).bind(message).bind(now())
        .fetch_one(&self.pool).await?.get("seq");
        Ok(seq)
    }

    pub async fn update_progress(&self, id: &str, stage: &str, pct: f32) -> anyhow::Result<()> {
        sqlx::query("UPDATE jobs SET stage=?, pct=?, heartbeat_at=?, updated_at=? WHERE id=?")
            .bind(stage).bind(pct as f64).bind(now()).bind(now()).bind(id)
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn heartbeat(&self, id: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?").bind(now()).bind(id)
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn is_cancel_requested(&self, id: &str) -> anyhow::Result<bool> {
        let v: Option<i64> = sqlx::query_scalar("SELECT cancel_requested FROM jobs WHERE id=?")
            .bind(id).fetch_optional(&self.pool).await?;
        Ok(v.unwrap_or(0) != 0)
    }

    pub async fn request_cancel(&self, id: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?")
            .bind(now()).bind(id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn finish(&self, id: &str, status: JobStatus, error: Option<&str>) -> anyhow::Result<()> {
        let ts = now();
        let pct = if status == JobStatus::Succeeded { Some(1.0_f64) } else { None };
        sqlx::query(
            "UPDATE jobs SET status=?, error=?, finished_at=?, updated_at=?, pct=COALESCE(?, pct) WHERE id=?",
        )
        .bind(status.as_str()).bind(error).bind(&ts).bind(&ts).bind(pct).bind(id)
        .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn events_since(&self, job_id: &str, after_seq: i64) -> anyhow::Result<Vec<JobEvent>> {
        let rows = sqlx::query("SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq")
            .bind(job_id).bind(after_seq).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| JobEvent {
            seq: r.get("seq"),
            job_id: r.get("job_id"),
            kind: r.get("type"),
            stage: r.get("stage"),
            pct: r.get::<Option<f64>, _>("pct").map(|p| p as f32),
            message: r.get("message"),
            ts: r.get("ts"),
        }).collect())
    }

    pub async fn reap_stale(&self, older_than_secs: i64) -> anyhow::Result<Vec<String>> {
        let cutoff = (chrono::Utc::now() - chrono::Duration::seconds(older_than_secs)).to_rfc3339();
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM jobs WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
        ).bind(&cutoff).fetch_all(&self.pool).await?;
        for id in &ids {
            self.finish(id, JobStatus::Failed, Some("worker died (stale heartbeat)")).await?;
            self.append_event(id, "error", None, None, Some("worker died (stale heartbeat)")).await?;
        }
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_creates_schema() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        // both tables exist
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('jobs','job_events')",
        ).fetch_one(&store.pool).await.unwrap();
        assert_eq!(n, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn fresh() -> (JobStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = JobStore::connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        (store, dir)
    }
    fn run_spec(url: &str) -> JobSpec {
        JobSpec { command: "run".into(), url: Some(url.into()), content_set: None, params: serde_json::json!({}) }
    }
    async fn enq(s: &JobStore, url: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        s.enqueue(&id, &run_spec(url), "out/j").await.unwrap();
        id
    }

    #[tokio::test]
    async fn enqueue_get_roundtrip() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "https://x/y").await;
        let rec = s.get(&id).await.unwrap().unwrap();
        assert_eq!(rec.status, JobStatus::Queued);
        assert_eq!(rec.spec.url.as_deref(), Some("https://x/y"));
        assert_eq!(rec.output_dir, "out/j");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn claim_is_atomic_single_winner() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        let (a, b) = tokio::join!(s.claim_next("w1"), s.claim_next("w2"));
        let claims: Vec<_> = [a.unwrap(), b.unwrap()].into_iter().flatten().collect();
        assert_eq!(claims.len(), 1, "exactly one worker claims the job");
        assert_eq!(claims[0].id, id);
        assert_eq!(claims[0].status, JobStatus::Running);
        // a second claim finds nothing
        assert!(s.claim_next("w3").await.unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn events_since_orders_and_resumes() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        let s1 = s.append_event(&id, "progress", Some("ingest"), Some(0.1), None).await.unwrap();
        let s2 = s.append_event(&id, "log", None, None, Some("hello")).await.unwrap();
        assert!(s2 > s1);
        let after_first = s.events_since(&id, s1).await.unwrap();
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0].seq, s2);
        assert_eq!(after_first[0].kind, "log");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reap_marks_stale_running_failed() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();
        // force a stale heartbeat well in the past
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?")
            .bind("2000-01-01T00:00:00+00:00").bind(&id).execute(&s.pool).await.unwrap();
        let reaped = s.reap_stale(30).await.unwrap();
        assert_eq!(reaped, vec![id.clone()]);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Failed);
        // a terminal error event was appended
        let evs = s.events_since(&id, 0).await.unwrap();
        assert!(evs.iter().any(|e| e.kind == "error"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
