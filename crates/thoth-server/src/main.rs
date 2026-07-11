use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{middleware, routing::get, Router};
use tokio::sync::Mutex;

use thoth_server::auth::{self, AppState};
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
        .unwrap_or_else(|_| PathBuf::from("thoth"));
    let store = JobStore::open(&output_root.join("jobs.redb"))?;

    let state = AppState {
        api_key,
        store,
        jobs: Arc::new(Mutex::new(HashMap::new())),
        worker_bin,
        output_root,
    };

    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    // /health is public; put it OUTSIDE the auth layer too for load-balancer probes.
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/api", api)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], 8787));
    tracing::info!("thoth-server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
