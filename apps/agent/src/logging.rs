use directories::ProjectDirs;
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init_logging() -> Option<WorkerGuard> {
    // Debug builds: default to "debug" so all logs are visible. Release: default "info". RUST_LOG overrides.
    let default_level = if cfg!(debug_assertions) {
        "debug"
    } else {
        "info"
    };
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_level));
    let stdout_layer = fmt::layer().with_target(false).with_level(true);
    let registry = tracing_subscriber::registry()
        .with(filter)
        .with(stdout_layer);

    if let Some(log_dir) = log_dir() {
        let file_appender = tracing_appender::rolling::daily(log_dir, "agent.log");
        let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
        let file_layer = fmt::layer()
            .with_target(false)
            .with_level(true)
            .with_ansi(false)
            .with_writer(non_blocking);
        registry.with(file_layer).init();
        Some(guard)
    } else {
        registry.init();
        None
    }
}

fn log_dir() -> Option<PathBuf> {
    let proj = ProjectDirs::from("com", "aegis", "Aegis")?;
    let dir = proj.data_local_dir().join("logs");
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("Failed to create log dir: {}", err);
        return None;
    }
    Some(dir)
}

/// Wrapper to avoid leaking secrets or sensitive paths in logs.
pub struct Redact<T>(T);

impl<T> Redact<T> {
    pub fn new(value: T) -> Self {
        Self(value)
    }
}

impl<T> std::fmt::Display for Redact<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<redacted>")
    }
}
