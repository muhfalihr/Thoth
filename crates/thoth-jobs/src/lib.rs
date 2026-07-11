pub mod types;
pub use types::*;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::{str::FromStr, time::Duration};

#[derive(Clone)]
pub struct JobStore {
    pub pool: sqlx::SqlitePool,
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
}
