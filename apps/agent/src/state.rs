use crate::config::AgentConfig;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

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
    pub running: bool,
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
            running: false,
        }
    }
}

pub type SharedState = Arc<RwLock<AgentRuntimeState>>;
