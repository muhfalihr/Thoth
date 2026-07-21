use std::{ffi::OsString, net::SocketAddr, path::PathBuf, sync::Arc};

use thoth_jobs::resolve_home;
use thoth_server::auth::{
    AppState, EnvCredentialProvider, legacy_output_root, server_db_path,
    worker_compatible_config_path,
};

fn parse_home_arg(args: impl IntoIterator<Item = OsString>) -> anyhow::Result<Option<PathBuf>> {
    let mut args = args.into_iter();
    let mut home = None;
    while let Some(arg) = args.next() {
        if arg == "--home" {
            let path = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("--home requires a path"))?;
            if home.replace(PathBuf::from(path)).is_some() {
                anyhow::bail!("--home may only be supplied once");
            }
        } else {
            anyhow::bail!("unknown argument: {}", arg.to_string_lossy());
        }
    }
    Ok(home)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load `.env` like the CLI/worker (thoth-core) do, so the credential gate
    // (`EnvCredentialProvider`) can see the same API keys the worker will use.
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().with_env_filter("info").init();

    let api_key = std::env::var("THOTH_API_KEY").unwrap_or_else(|_| "dev-key".to_owned());
    let explicit_home = parse_home_arg(std::env::args_os().skip(1))?;
    let home = resolve_home(explicit_home.as_deref())?;
    home.ensure_layout()?;
    // The compatibility route for unprofiled jobs has a managed output root;
    // typed project jobs resolve their own workspace paths.
    home.ensure_project_layout("legacy")?;
    let output_root = legacy_output_root(&home);
    let worker_config_path = worker_compatible_config_path()?;
    // The server and the `thoth worker` process meet ONLY here — the shared
    // SQLite/WAL job database. `THOTH_DB` remains a compatibility override;
    // the default is always inside the resolved Thoth home.
    let db_path = std::env::var_os("THOTH_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| server_db_path(&home));
    let db_path_text = db_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("database path is not valid Unicode"))?;
    let store = thoth_jobs::JobStore::connect_with_home(db_path_text, home.clone()).await?;

    let state = AppState {
        api_key,
        store,
        output_root,
        home,
        worker_config_path,
        scout: thoth_server::scout::new_supervisor(),
        credentials: Arc::new(EnvCredentialProvider),
    };

    // Liveness backstop: reclaim jobs whose independent worker crashed.
    thoth_server::reaper::spawn_reaper(state.store.clone(), 15, 30);

    let app = thoth_server::build_router(state);

    // Loopback:8787 by default; THOTH_ADDR overrides (e.g. "0.0.0.0:9000" to
    // expose, or another port when 8787 is taken). Parsed as a SocketAddr.
    let addr: SocketAddr = std::env::var("THOTH_ADDR")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8787)));
    tracing::info!(
        "thoth-server listening on http://{addr} (db: {})",
        db_path.display()
    );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
