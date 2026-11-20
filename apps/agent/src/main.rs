use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _log_guard = aegis_agent::init_logging();
    tokio::select! {
        res = aegis_agent::run(kit_dir()) => {
            if let Err(err) = &res {
                error!("Agent stopped: {:#}", err);
            }
            res
        }
        _ = tokio::signal::ctrl_c() => {
            info!("Aegis agent shutting down");
            Ok(())
        }
    }
}

/// Standalone agent: restore kit programs in `restore-kit/` next to the executable.
fn kit_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("restore-kit");
    dir.is_dir().then_some(dir)
}
