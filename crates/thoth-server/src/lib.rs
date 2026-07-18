pub mod auth;
pub mod artifact;
pub mod reaper;
pub mod routes;
pub mod scout;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};

use auth::AppState;

/// Assemble the full HTTP router: REST `/api/jobs*`, per-job SSE, artifact
/// serving, and the SPA static fallback. Shared by `main.rs` and the
/// in-process HTTP integration tests so they can't drift.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/jobs", get(routes::list_jobs).post(routes::create_job))
        .route("/jobs/:id", get(routes::get_job))
        .route("/jobs/:id/cancel", post(routes::cancel_job))
        .route(
            "/artifacts/:id/*path",
            get(routes::get_artifact).head(routes::get_artifact),
        )
        .route("/jobs/:id/manifest", get(routes::get_manifest))
        .route(
            "/config",
            get(routes::get_config).put(routes::put_config),
        )
        .route("/style-profiles", get(routes::get_style_profiles))
        .route("/scout/status", get(routes::scout_status))
        .route("/scout/browser/start", post(routes::scout_browser_start))
        .route("/scout/discover", post(routes::scout_discover))
        .route("/scout/run", post(routes::scout_run))
        .route("/scout/validate", post(routes::scout_validate))
        .route("/scout/cancel", post(routes::scout_cancel))
        .route("/scout/topics", get(routes::scout_topics))
        .route(
            "/scout/content-set",
            get(routes::scout_content_set).put(routes::scout_content_set_save),
        )
        .route("/scout/content-set/data", get(routes::scout_content_set_data))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    // SSE is OUTSIDE the header-auth layer (EventSource can't send headers);
    // it authenticates via ?token= inside the handler.
    let api = api
        .route("/jobs/:id/stream", get(routes::stream_job))
        .route("/scout/stream", get(routes::scout_stream))
        .route(
            "/scout/output/*path",
            get(routes::scout_output_file).head(routes::scout_output_file),
        );

    Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/api", api)
        .fallback_service(tower_http::services::ServeDir::new("dashboard/dist"))
        .with_state(state)
}
