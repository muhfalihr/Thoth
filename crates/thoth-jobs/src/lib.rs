mod validation;

#[cfg(test)]
mod home_tests {
    use std::path::Path;

    use super::home::{ThothHome, resolve_home_with_env};

    #[test]
    fn explicit_home_wins_over_environment() {
        let home =
            resolve_home_with_env(Some(Path::new("explicit")), Some(Path::new("env"))).unwrap();

        assert_eq!(home.root(), Path::new("explicit"));
    }

    #[test]
    fn project_output_is_owned_by_home() {
        let root = std::env::temp_dir().join(format!("thoth-home-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);

        home.ensure_layout().unwrap();

        assert!(home.data_dir().is_dir());
        assert!(home.root().join("projects").is_dir());
        assert!(home.root().join("cache").is_dir());
        assert!(home.root().join("logs").is_dir());
        assert_eq!(
            home.project_outputs("p1"),
            home.root().join("projects/p1/outputs")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_workspace_layout_is_created_under_home() {
        let root = std::env::temp_dir().join(format!("thoth-home-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);

        home.ensure_project_layout("p1").unwrap();

        let project = home.project_root("p1");
        assert!(project.join("content-sets").is_dir());
        assert!(project.join("sources").is_dir());
        assert!(project.join("outputs").is_dir());
        let _ = std::fs::remove_dir_all(root);
    }
}

mod home;

pub mod types;
pub use home::{ThothHome, resolve_home};
pub use types::*;
pub use validation::{
    JobValidationError, PROTECTED_EXTRA_FLAGS, SCALAR_PARAM_FLAGS, scalar_param_flag,
    validate_job_spec,
};

use sqlx::Row;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{str::FromStr, time::Duration};

#[derive(Clone)]
pub struct JobStore {
    pub pool: sqlx::SqlitePool,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn is_sqlite_busy(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "5" || code == "517")
}

const CANCEL_BUSY_MAX_ATTEMPTS: usize = 4;
const CANCEL_BUSY_BACKOFF: Duration = Duration::from_millis(5);

#[cfg(test)]
static CANCEL_BUSY_RETRIES: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
fn record_cancel_busy_retry() {
    CANCEL_BUSY_RETRIES.fetch_add(1, Ordering::Relaxed);
}

#[cfg(not(test))]
fn record_cancel_busy_retry() {}

#[cfg(test)]
fn reset_cancel_busy_retries() {
    CANCEL_BUSY_RETRIES.store(0, Ordering::Relaxed);
}

#[cfg(test)]
fn cancel_busy_retries() -> usize {
    CANCEL_BUSY_RETRIES.load(Ordering::Relaxed)
}

async fn backoff_after_cancel_busy(
    tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    error: sqlx::Error,
    busy_attempts: &mut usize,
) -> Result<(), sqlx::Error> {
    record_cancel_busy_retry();
    let _ = tx.rollback().await;
    *busy_attempts += 1;
    if *busy_attempts >= CANCEL_BUSY_MAX_ATTEMPTS {
        return Err(error);
    }
    tokio::time::sleep(CANCEL_BUSY_BACKOFF * (*busy_attempts as u32)).await;
    Ok(())
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

    pub async fn request_cancel(&self, id: &str) -> anyhow::Result<CancelRequestOutcome> {
        let mut busy_attempts = 0;
        loop {
            let mut tx = self.pool.begin().await?;
            let state: Option<(String, i64)> =
                sqlx::query_as("SELECT status, cancel_requested FROM jobs WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;

            let Some((status, cancel_requested)) = state else {
                tx.commit().await?;
                return Ok(CancelRequestOutcome::NotFound);
            };

            if status == "running" {
                if cancel_requested != 0 {
                    tx.commit().await?;
                    return Ok(CancelRequestOutcome::AlreadyRequested);
                }
                let result = match sqlx::query(
                    "UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=? AND status='running' AND cancel_requested=0",
                )
                .bind(now())
                .bind(id)
                .execute(&mut *tx)
                .await
                {
                    Ok(result) => result,
                    Err(error) if is_sqlite_busy(&error) => {
                        backoff_after_cancel_busy(tx, error, &mut busy_attempts).await?;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if result.rows_affected() == 0 {
                    tx.commit().await?;
                    continue;
                }
                tx.commit().await?;
                return Ok(CancelRequestOutcome::RunningRequested);
            }

            if status != "queued" {
                tx.commit().await?;
                let status = JobStatus::from_str(&status).map_err(anyhow::Error::msg)?;
                return Ok(CancelRequestOutcome::Terminal(status));
            }

            let ts = now();
            let result = match sqlx::query(
                "UPDATE jobs SET status='cancelled', finished_at=?, updated_at=? WHERE id=? AND status='queued'",
            )
            .bind(&ts)
            .bind(&ts)
            .bind(id)
            .execute(&mut *tx)
            .await
            {
                Ok(result) => result,
                Err(error) if is_sqlite_busy(&error) => {
                    backoff_after_cancel_busy(tx, error, &mut busy_attempts).await?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if result.rows_affected() == 0 {
                tx.commit().await?;
                continue;
            }
            sqlx::query(
                "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, 'cancelled', NULL, NULL, NULL, ?)",
            )
            .bind(id)
            .bind(&ts)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(CancelRequestOutcome::QueuedCancelled);
        }
    }

    pub async fn finish_running(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<&str>,
        event_kind: &str,
        message: Option<&str>,
    ) -> anyhow::Result<bool> {
        self.finish_running_transaction(id, status, error, event_kind, message, None)
            .await
    }

    async fn finish_running_transaction(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<&str>,
        event_kind: &str,
        message: Option<&str>,
        stale_before: Option<&str>,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            status.is_terminal(),
            "finish_running requires a terminal status"
        );
        let mut tx = self.pool.begin().await?;
        let ts = now();
        let pct = if status == JobStatus::Succeeded {
            Some(1.0_f64)
        } else {
            None
        };
        let result = if let Some(cutoff) = stale_before {
            sqlx::query(
                "UPDATE jobs SET status=?, error=?, finished_at=?, updated_at=?, pct=COALESCE(?, pct)
                 WHERE id=? AND status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
            )
            .bind(status.as_str())
            .bind(error)
            .bind(&ts)
            .bind(&ts)
            .bind(pct)
            .bind(id)
            .bind(cutoff)
            .execute(&mut *tx)
            .await?
        } else {
            sqlx::query(
                "UPDATE jobs SET status=?, error=?, finished_at=?, updated_at=?, pct=COALESCE(?, pct) WHERE id=? AND status='running'",
            )
            .bind(status.as_str())
            .bind(error)
            .bind(&ts)
            .bind(&ts)
            .bind(pct)
            .bind(id)
            .execute(&mut *tx)
            .await?
        };
        if result.rows_affected() == 0 {
            tx.commit().await?;
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, ?, NULL, NULL, ?, ?)",
        )
        .bind(id)
        .bind(event_kind)
        .bind(message)
        .bind(&ts)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(true)
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
        let mut reaped = Vec::with_capacity(ids.len());
        for id in ids {
            let message = "worker died (stale heartbeat)";
            if self
                .finish_running_transaction(
                    &id,
                    JobStatus::Failed,
                    Some(message),
                    "error",
                    Some(message),
                    Some(&cutoff),
                )
                .await?
            {
                reaped.push(id);
            }
        }
        Ok(reaped)
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
    async fn cancel_queued_transitions_and_emits_one_cancelled_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::QueuedCancelled);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Cancelled);
        let events = s.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "cancelled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_terminal_returns_terminal_without_another_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.request_cancel(&id).await.unwrap();

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::Terminal(JobStatus::Cancelled));
        assert_eq!(s.events_since(&id, 0).await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_running_sets_only_cancel_requested() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::RunningRequested);
        let job = s.get(&id).await.unwrap().unwrap();
        assert_eq!(job.status, JobStatus::Running);
        assert!(job.cancel_requested);
        assert!(s.events_since(&id, 0).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn second_running_cancel_returns_already_requested() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();
        s.request_cancel(&id).await.unwrap();

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::AlreadyRequested);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Running);
        assert!(s.events_since(&id, 0).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn queued_cancel_rereads_after_losing_terminal_race() {
        reset_cancel_busy_retries();
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let first = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let second = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&first, "u").await;

        let mut winning_tx = second.pool.begin().await.unwrap();
        let ts = now();
        sqlx::query(
            "UPDATE jobs SET status='cancelled', finished_at=?, updated_at=? WHERE id=? AND status='queued'",
        )
        .bind(&ts)
        .bind(&ts)
        .bind(&id)
        .execute(&mut *winning_tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, 'cancelled', NULL, NULL, NULL, ?)",
        )
        .bind(&id)
        .bind(&ts)
        .execute(&mut *winning_tx)
        .await
        .unwrap();
        let cancelling = {
            let store = first.clone();
            let id = id.clone();
            tokio::spawn(async move { store.request_cancel(&id).await })
        };
        for _ in 0..100 {
            if cancelling.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
        winning_tx.commit().await.unwrap();

        let outcome = cancelling.await.unwrap().unwrap();

        assert_eq!(outcome, CancelRequestOutcome::Terminal(JobStatus::Cancelled));
        let events = first.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "cancelled");
        assert!(
            cancel_busy_retries() > 0,
            "test must exercise the BUSY retry path"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_persistent_busy_returns_error_within_retry_budget() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let holder = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&holder, "u").await;
        let contender_options = SqliteConnectOptions::from_str(db.to_str().unwrap())
            .unwrap()
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_millis(1));
        let contender = JobStore {
            pool: SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(contender_options)
                .await
                .unwrap(),
        };

        let mut write_lock = holder.pool.begin().await.unwrap();
        sqlx::query("UPDATE jobs SET updated_at=updated_at WHERE id=?")
            .bind(&id)
            .execute(&mut *write_lock)
            .await
            .unwrap();

        let started = std::time::Instant::now();
        let result =
            tokio::time::timeout(Duration::from_millis(250), contender.request_cancel(&id))
                .await
                .expect("request_cancel exceeded retry budget");

        let error = result.unwrap_err();
        assert!(error.to_string().contains("database is locked"));
        assert!(started.elapsed() < Duration::from_millis(250));
        drop(write_lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn finish_running_succeeds_once_with_terminal_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();

        let finished = s
            .finish_running(
                &id,
                JobStatus::Succeeded,
                None,
                "complete",
                Some("done"),
            )
            .await
            .unwrap();

        assert!(finished);
        let job = s.get(&id).await.unwrap().unwrap();
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(job.pct, 1.0);
        let events = s.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        assert_eq!(events[0].message.as_deref(), Some("done"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn finish_running_on_terminal_returns_false_without_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();
        s.finish_running(&id, JobStatus::Succeeded, None, "complete", None)
            .await
            .unwrap();

        let finished = s
            .finish_running(
                &id,
                JobStatus::Failed,
                Some("late failure"),
                "error",
                Some("late failure"),
            )
            .await
            .unwrap();

        assert!(!finished);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Succeeded);
        let events = s.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn finish_running_rejects_non_terminal_status() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();

        let result = s
            .finish_running(&id, JobStatus::Running, None, "progress", None)
            .await;

        assert!(result.is_err());
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Running);
        assert!(s.events_since(&id, 0).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reaper_does_not_overwrite_terminal_or_duplicate_event() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let reaper_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let finisher_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&reaper_store, "u").await;
        reaper_store.claim_next("w1").await.unwrap();
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?")
            .bind("2000-01-01T00:00:00+00:00")
            .bind(&id)
            .execute(&reaper_store.pool)
            .await
            .unwrap();

        // Occupy this store's pool, then use FIFO acquisition to pause the
        // reaper after its stale-id query and before its terminal update.
        let mut held = Vec::new();
        for _ in 0..5 {
            held.push(reaper_store.pool.acquire().await.unwrap());
        }
        let reaper_task = {
            let store = reaper_store.clone();
            tokio::spawn(async move { store.reap_stale(30).await })
        };
        tokio::task::yield_now().await;
        let blocker = {
            let pool = reaper_store.pool.clone();
            tokio::spawn(async move { pool.acquire().await.unwrap() })
        };
        tokio::task::yield_now().await;
        drop(held.pop());
        let blocker = blocker.await.unwrap();

        assert!(
            finisher_store
                .finish_running(&id, JobStatus::Succeeded, None, "complete", Some("done"))
                .await
                .unwrap()
        );
        drop(blocker);
        drop(held);

        let reaped_ids = reaper_task.await.unwrap().unwrap();
        assert!(reaped_ids.is_empty());
        assert_eq!(
            finisher_store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Succeeded
        );
        let events = finisher_store.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reaper_does_not_fail_job_with_refreshed_heartbeat() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let reaper_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let heartbeat_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&reaper_store, "u").await;
        reaper_store.claim_next("w1").await.unwrap();
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?")
            .bind("2000-01-01T00:00:00+00:00")
            .bind(&id)
            .execute(&reaper_store.pool)
            .await
            .unwrap();

        let mut held = Vec::new();
        for _ in 0..5 {
            held.push(reaper_store.pool.acquire().await.unwrap());
        }
        let reaper_task = {
            let store = reaper_store.clone();
            tokio::spawn(async move { store.reap_stale(30).await })
        };
        tokio::task::yield_now().await;
        let blocker = {
            let pool = reaper_store.pool.clone();
            tokio::spawn(async move { pool.acquire().await.unwrap() })
        };
        tokio::task::yield_now().await;
        drop(held.pop());
        let blocker = blocker.await.unwrap();

        heartbeat_store.heartbeat(&id).await.unwrap();
        drop(blocker);
        drop(held);

        let reaped_ids = reaper_task.await.unwrap().unwrap();
        assert!(reaped_ids.is_empty());
        assert_eq!(
            heartbeat_store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Running
        );
        assert!(
            heartbeat_store
                .events_since(&id, 0)
                .await
                .unwrap()
                .is_empty()
        );
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
