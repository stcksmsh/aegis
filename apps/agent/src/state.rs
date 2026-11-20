use crate::config::AgentConfig;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
    /// True if the drive had less than 10% free space after this backup.
    #[serde(default)]
    pub drive_almost_full: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveStatus {
    pub connected: bool,
    pub trusted: bool,
    /// Trusted: the first backup instance on this drive known to this computer (config key).
    /// Untrusted: the drive's own id from its marker, if any.
    pub drive_id: Option<String>,
    /// All instances on the connected drive that this computer backs up to (config keys).
    #[serde(default)]
    pub instance_ids: Vec<String>,
    pub label: Option<String>,
    pub mount_path: Option<String>,
    pub devnode: Option<String>,
    /// Free space on the drive's mount, in bytes (filled in when connected and trusted).
    #[serde(default)]
    pub free_bytes: Option<u64>,
    /// Total capacity of the drive's mount, in bytes (filled in when connected and trusted).
    #[serde(default)]
    pub total_bytes: Option<u64>,
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
    /// Epoch seconds a reminder notification was last sent for a drive (key = drive_id); avoids spamming.
    #[serde(skip)]
    pub reminder_last_sent: HashMap<String, u64>,
    /// Bundled restic programs for the restore kit on drives (see kit.rs).
    #[serde(skip)]
    pub kit_dir: Option<PathBuf>,
    /// Set while the app installs an update: no new backup, restore or drive setup starts.
    #[serde(skip)]
    pub update_hold: bool,
    /// Drive setups in progress (they write to the drive).
    #[serde(skip)]
    pub drive_setups: u32,
}

impl AgentRuntimeState {
    pub fn new(config: AgentConfig, kit_dir: Option<PathBuf>) -> Self {
        Self {
            config,
            drive_status: DriveStatus {
                connected: false,
                trusted: false,
                drive_id: None,
                instance_ids: Vec::new(),
                label: None,
                mount_path: None,
                devnode: None,
                free_bytes: None,
                total_bytes: None,
            },
            last_run: None,
            running_drive_ids: HashSet::new(),
            backup_progress: HashMap::new(),
            running_cancel_tokens: HashMap::new(),
            restore_drive_id: None,
            restore_cancel_token: None,
            reminder_last_sent: HashMap::new(),
            kit_dir,
            update_hold: false,
            drive_setups: 0,
        }
    }

    /// A backup, restore or drive setup is running (an update must wait).
    pub fn is_busy(&self) -> bool {
        !self.running_drive_ids.is_empty()
            || self.restore_drive_id.is_some()
            || self.drive_setups > 0
    }
}

impl DriveStatus {
    /// True if the drive holding this instance (config key) is plugged in.
    pub fn has_instance(&self, id: &str) -> bool {
        self.connected && self.instance_ids.iter().any(|i| i == id)
    }

    /// Forget the connected drive (unplugged, wiped, or unknown).
    pub fn clear_drive(&mut self) {
        self.trusted = false;
        self.drive_id = None;
        self.instance_ids.clear();
        self.label = None;
    }
}

pub type SharedState = Arc<RwLock<AgentRuntimeState>>;
