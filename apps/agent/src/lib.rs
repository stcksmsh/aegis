//! Aegis backup agent: USB watcher + local HTTP API (127.0.0.1:7878).
//! Runs standalone (`aegis-agent` binary) or embedded in the desktop app.

mod backup;
mod config;
mod devices;
mod drive;
mod errors;
mod ipc;
mod keychain;
mod logging;
mod notifications;
mod recovery;
mod restic;
mod retention;
mod state;
mod usb;
mod verify;

pub use crate::ipc::API_ADDR;
pub use crate::logging::init_logging;

use crate::config::AgentConfig;
use crate::logging::Redact;
use crate::restic::Restic;
use crate::state::{AgentRuntimeState, SharedState};
use anyhow::Context;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

/// Start IPC server + USB watcher; runs until either task exits.
/// Fails fast if the API port is taken (e.g. agent service already running).
pub async fn run() -> anyhow::Result<()> {
    info!("Aegis agent starting");
    let config = AgentConfig::load().context("load config")?;
    if Restic::resolve(config.restic_path.as_deref()).is_err() {
        warn!("Restic not available; backups will fail until restic is installed or bundled.");
    }
    let state: SharedState = Arc::new(RwLock::new(AgentRuntimeState::new(config)));
    let listener = tokio::net::TcpListener::bind(API_ADDR)
        .await
        .with_context(|| format!("bind {}", API_ADDR))?;
    let watcher = usb::build_watcher().context("init usb watcher")?;
    let usb_state = state.clone();
    tokio::spawn(async move {
        if let Err(err) = watcher.run(usb_state).await {
            error!("USB watcher failed: {}", Redact::new(err));
        }
    });
    ipc::serve(listener, state).await
}
