use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _log_guard = aegis_agent::init_logging();
    tokio::select! {
        res = aegis_agent::run() => {
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
