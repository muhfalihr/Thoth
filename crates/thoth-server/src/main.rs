mod auth;

use std::net::SocketAddr;

use axum::{middleware, routing::get, Router};

use auth::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let api_key = std::env::var("THOTH_API_KEY").unwrap_or_else(|_| "dev-key".to_owned());
    let state = AppState { api_key };

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
