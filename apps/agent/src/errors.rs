use thiserror::Error;

#[allow(dead_code)]
#[derive(Error, Debug)]
pub enum AgentError {
    #[error("configuration error")]
    Config,
    #[error("keychain error")]
    Keychain,
    #[error("restic error")]
    Restic,
    #[error("backup error")]
    Backup,
    #[error("verification error")]
    Verify,
    #[error("retention error")]
    Retention,
    #[error("usb watcher error")]
    Usb,
    #[error("ipc error")]
    Ipc,
    #[error("io error")]
    Io,
}
