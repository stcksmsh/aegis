use crate::config::AgentConfig;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RunStatus {
    Success,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RunPhase {
    Idle,
    WaitingForDrive,
    BackingUp,
    VerifyingQuick,
    VerifyingDeep,
    Pruning,
    Completed,
}

/// Live progress during a running backup (from restic --json status lines).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BackupProgress {
    /// 0.0 .. 1.0
    pub percent_done: f64,
    pub message: String,
    pub files_done: u64,
    pub total_files: u64,
    pub bytes_done: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub status: RunStatus,
    pub phase: RunPhase,
    pub started_epoch: u64,
    pub finished_epoch: Option<u64>,
    pub message: String,
    pub interrupted: bool,
    pub snapshot_id: Option<String>,
    pub repository_id: Option<String>,
    pub data_added: Option<u64>,
    pub files_processed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveStatus {
    pub connected: bool,
    pub trusted: bool,
    pub drive_id: Option<String>,
    pub label: Option<String>,
    pub mount_path: Option<String>,
    pub devnode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeState {
    pub config: AgentConfig,
    pub drive_status: DriveStatus,
    pub last_run: Option<RunResult>,
    /// Drive IDs that currently have a backup in progress. Enables parallel backup per drive.
    pub running_drive_ids: HashSet<String>,
    /// Progress per drive (key = drive_id). Cleared when that drive's backup finishes.
    pub backup_progress: HashMap<String, BackupProgress>,
    /// Cancel tokens for in-progress backups; cancelling aborts restic when the drive is unplugged.
    #[serde(skip)]
    pub running_cancel_tokens: HashMap<String, CancellationToken>,
    /// If a restore is in progress, the drive being restored and its cancel token (so unplug aborts it).
    #[serde(skip)]
    pub restore_drive_id: Option<String>,
    #[serde(skip)]
    pub restore_cancel_token: Option<CancellationToken>,
}

impl AgentRuntimeState {
    pub fn new(config: AgentConfig) -> Self {
        Self {
            config,
            drive_status: DriveStatus {
                connected: false,
                trusted: false,
                drive_id: None,
                label: None,
                mount_path: None,
                devnode: None,
            },
            last_run: None,
            running_drive_ids: HashSet::new(),
            backup_progress: HashMap::new(),
            running_cancel_tokens: HashMap::new(),
            restore_drive_id: None,
            restore_cancel_token: None,
        }
    }
}

pub type SharedState = Arc<RwLock<AgentRuntimeState>>;
