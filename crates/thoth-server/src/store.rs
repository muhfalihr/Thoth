// ponytail: JobStore is consumed by the Task 5 executor / Task 6 routes —
// not yet wired into main.rs, so cargo's dead_code lint doesn't see the
// future callers.
#![allow(dead_code)]

use anyhow::Result;
use redb::{Database, ReadableTable, TableDefinition};

use crate::job::JobRecord;

const JOBS: TableDefinition<&str, &str> = TableDefinition::new("jobs");

/// redb-backed job store. Values are JSON strings keyed by job id.
#[derive(Clone)]
pub struct JobStore {
    db: std::sync::Arc<Database>,
}

impl JobStore {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let db = Database::create(path)?;
        // Ensure the table exists.
        let w = db.begin_write()?;
        {
            let _ = w.open_table(JOBS)?;
        }
        w.commit()?;
        Ok(Self { db: std::sync::Arc::new(db) })
    }

    pub fn put(&self, rec: &JobRecord) -> Result<()> {
        let json = serde_json::to_string(rec)?;
        let w = self.db.begin_write()?;
        {
            let mut t = w.open_table(JOBS)?;
            t.insert(rec.id.as_str(), json.as_str())?;
        }
        w.commit()?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<JobRecord>> {
        let r = self.db.begin_read()?;
        let t = r.open_table(JOBS)?;
        match t.get(id)? {
            Some(v) => Ok(Some(serde_json::from_str(v.value())?)),
            None => Ok(None),
        }
    }

    pub fn list(&self) -> Result<Vec<JobRecord>> {
        let r = self.db.begin_read()?;
        let t = r.open_table(JOBS)?;
        let mut out = Vec::new();
        for row in t.iter()? {
            let (_k, v) = row?;
            out.push(serde_json::from_str(v.value())?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{JobSpec, JobStatus};

    fn rec(id: &str) -> JobRecord {
        JobRecord {
            id: id.to_owned(),
            spec: JobSpec {
                command: "run".into(),
                url: None,
                content_set: None,
                params: serde_json::Value::Null,
            },
            status: JobStatus::Queued,
            stage: None,
            pct: 0.0,
            error: None,
            created_at: "t0".into(),
            updated_at: "t0".into(),
            output_dir: "out".into(),
        }
    }

    #[test]
    fn put_get_list_round_trip() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}.redb", uuid::Uuid::new_v4()));
        let store = JobStore::open(&dir).unwrap();
        store.put(&rec("a")).unwrap();
        store.put(&rec("b")).unwrap();
        assert_eq!(store.get("a").unwrap().unwrap().id, "a");
        assert!(store.get("missing").unwrap().is_none());
        assert_eq!(store.list().unwrap().len(), 2);
        let _ = std::fs::remove_file(&dir);
    }
}
