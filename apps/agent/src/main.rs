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

use crate::config::AgentConfig;
use crate::logging::{init_logging, Redact};
use crate::restic::Restic;
use crate::state::{AgentRuntimeState, SharedState};
use anyhow::Context;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _log_guard = init_logging();
    info!("Aegis agent starting");

    let config = AgentConfig::load().context("load config")?;
    if Restic::resolve(config.restic_path.as_deref()).is_err() {
        warn!("Restic not available; backups will fail until restic is installed or bundled.");
    }
    let shared_state: SharedState = Arc::new(RwLock::new(AgentRuntimeState::new(config)));

    let usb_watcher = usb::build_watcher().context("init usb watcher")?;

    let ipc_state = shared_state.clone();
    tokio::spawn(async move {
        if let Err(err) = ipc::serve(ipc_state).await {
            error!("IPC server failed: {}", Redact::new(err));
        }
    });

    let usb_state = shared_state.clone();
    tokio::spawn(async move {
        if let Err(err) = usb_watcher.run(usb_state).await {
            error!("USB watcher failed: {}", Redact::new(err));
        }
    });

    tokio::signal::ctrl_c().await?;
    info!("Aegis agent shutting down");
    Ok(())
}
