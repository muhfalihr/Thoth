use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use thoth_server::auth::AppState;
use thoth_server::store::JobStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let api_key = std::env::var("THOTH_API_KEY").unwrap_or_else(|_| "dev-key".to_owned());
    let output_root = std::env::var("THOTH_OUTPUT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("output"));
    let worker_bin = std::env::var("THOTH_WORKER_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("target/release/thoth.exe"));
    if !worker_bin.exists() {
        // Mirrors the CLI's "python not found" degrade: log loudly but still
        // bind so the dashboard UI loads (job creation will fail per-request).
        tracing::error!(
            "worker binary not found at {}: jobs will fail to spawn until THOTH_WORKER_BIN is set correctly",
            worker_bin.display()
        );
    }
    let store = JobStore::open(&output_root.join("jobs.redb"))?;

    let state = AppState {
        api_key,
        store,
        jobs: Arc::new(Mutex::new(HashMap::new())),
        worker_bin,
        output_root,
    };

    let app = thoth_server::build_router(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8787));
    tracing::info!("thoth-server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
