use std::net::SocketAddr;
use std::path::PathBuf;

use thoth_server::auth::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let api_key = std::env::var("THOTH_API_KEY").unwrap_or_else(|_| "dev-key".to_owned());
    let output_root = std::env::var("THOTH_OUTPUT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("output"));
    // The server and the `thoth worker` process meet ONLY here — the shared
    // SQLite/WAL job database. No spawning, no worker binary path.
    let db_path = std::env::var("THOTH_DB").unwrap_or_else(|_| "thoth.db".to_owned());
    let store = thoth_jobs::JobStore::connect(&db_path).await?;

    let state = AppState {
        api_key,
        store,
        output_root,
    };

    // Liveness backstop: reclaim jobs whose independent worker crashed.
    thoth_server::reaper::spawn_reaper(state.store.clone(), 15, 30);

    let app = thoth_server::build_router(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8787));
    tracing::info!("thoth-server listening on http://{addr} (db: {db_path})");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
