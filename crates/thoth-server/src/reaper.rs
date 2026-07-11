use thoth_jobs::JobStore;

/// Reclaim jobs whose worker died (stale heartbeat): mark failed + emit a
/// terminal error event. This is the liveness net that replaces the supervisor
/// we gave up by running the worker as an independent peer process — nothing
/// else notices a crashed worker, so this timer is the only backstop.
pub fn spawn_reaper(store: JobStore, interval_secs: u64, stale_secs: i64) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        loop {
            tick.tick().await;
            match store.reap_stale(stale_secs).await {
                Ok(ids) if !ids.is_empty() => {
                    tracing::warn!("reaped {} stale job(s): {:?}", ids.len(), ids);
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("reaper error: {e}"),
            }
        }
    });
}
