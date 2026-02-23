use crate::config::AgentConfig;
use crate::drive::{read_marker, write_marker, DriveMarker};
use crate::logging::Redact;
use crate::notifications;
use crate::restic::Restic;
use crate::retention::RetentionPolicy;
use crate::state::{BackupProgress, RunPhase, RunResult, RunStatus, SharedState};
use crate::verify::{deep_verify, quick_verify};
use anyhow::Context;
use directories::BaseDirs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error};

pub async fn run_backup(
    state: SharedState,
    drive_id: String,
    mount_path: PathBuf,
    passphrase: String,
) -> anyhow::Result<RunResult> {
    debug!(
        "backup: starting drive_id={} mount_path={}",
        drive_id,
        mount_path.display()
    );
    let started_epoch = now_epoch();
    set_phase(
        &state,
        RunPhase::BackingUp,
        RunStatus::Partial,
        "Starting backup",
        started_epoch,
        None,
        false,
    )
    .await;

    let drive_label = {
        let guard = state.read().await;
        guard
            .config
            .trusted_drives
            .get(&drive_id)
            .and_then(|d| d.label.clone())
            .unwrap_or_else(|| drive_id.chars().take(12).collect::<String>())
    };
    notifications::notify_backup_started(&drive_label);

    let cancel = CancellationToken::new();
    {
        let mut guard = state.write().await;
        guard.running_cancel_tokens.insert(drive_id.clone(), cancel.clone());
    }

    let outcome: anyhow::Result<RunResult> = async {
        let config = { state.read().await.config.clone() };
        let restic = Restic::resolve(config.restic_path.as_deref()).context("resolve restic")?;

        let repo_path = config
            .repository_path_for(&drive_id, &mount_path)
            .ok_or_else(|| anyhow::anyhow!("unknown drive"))?;
        debug!("backup: repo_path={}", repo_path.display());

        let mut repo_initialized = repo_path.join("config").exists();
        if !repo_initialized {
            debug!("backup: initializing restic repository at {}", repo_path.display());
            let repo_id = restic.init_repo(&repo_path, &passphrase).await?;
            repo_initialized = true;
            update_repo_id(&state, &drive_id, &repo_id).await?;
            if let Ok(Some(mut marker)) = read_marker(&mount_path) {
                marker.repository_id = Some(repo_id.clone());
                let _ = write_marker(&mount_path, &marker);
            }
        }

        if !repo_initialized {
            return Err(anyhow::anyhow!("repository not initialized"));
        }

        let sources = expand_sources(&config, &drive_id)?;
        if sources.is_empty() {
            return Err(anyhow::anyhow!("no backup sources configured for this drive"));
        }
        debug!("backup: sources count={} paths={:?}", sources.len(), sources.iter().map(|p| p.display().to_string()).collect::<Vec<_>>());

        let (progress_tx, mut progress_rx) = mpsc::channel(64);
        let restic_clone = restic.clone();
        let repo_path_clone = repo_path.clone();
        let passphrase_clone = passphrase.clone();
        let sources_clone = sources.clone();
        let includes = config.include_patterns.clone();
        let excludes = config.exclude_patterns.clone();
        let cancel_backup = cancel.clone();
        let backup_handle = tokio::spawn(async move {
            restic_clone
                .backup_with_progress(
                    &repo_path_clone,
                    &passphrase_clone,
                    &sources_clone,
                    &includes,
                    &excludes,
                    progress_tx,
                    cancel_backup,
                )
                .await
        });

        let state_progress = state.clone();
        let drive_id_progress = drive_id.clone();
        tokio::spawn(async move {
            while let Some(report) = progress_rx.recv().await {
                let pct = (report.percent_done * 100.0) as u32;
                let progress = BackupProgress {
                    percent_done: report.percent_done,
                    message: format!("Backing up: {}% ({} / {} files)", pct, report.files_done, report.total_files),
                    files_done: report.files_done,
                    total_files: report.total_files,
                    bytes_done: report.bytes_done,
                    total_bytes: report.total_bytes,
                };
                let mut guard = state_progress.write().await;
                guard.backup_progress.insert(drive_id_progress.clone(), progress.clone());
                if let Some(ref mut last_run) = guard.last_run {
                    last_run.message = progress.message;
                }
            }
        });

        let summary = backup_handle.await.context("backup task join")??;
        debug!("backup: restic backup completed snapshot_id={:?}", summary.snapshot_id);

        let mut interrupted = false;
        let mut status = RunStatus::Success;
        let mut message = "Backup completed".to_string();

        if config.quick_verify {
            set_phase(
                &state,
                RunPhase::VerifyingQuick,
                RunStatus::Partial,
                "Quick verification",
                started_epoch,
                summary.snapshot_id.clone(),
                false,
            )
            .await;
            if let Err(err) = quick_verify(&restic, &repo_path, &passphrase).await {
                error!("Quick verify failed: {}", Redact::new(err));
                status = RunStatus::Partial;
                message = "Backup completed, but verification failed".to_string();
            }
        }

        if config.deep_verify {
            set_phase(
                &state,
                RunPhase::VerifyingDeep,
                RunStatus::Partial,
                "Deep verification",
                started_epoch,
                summary.snapshot_id.clone(),
                false,
            )
            .await;
            if let Err(err) = deep_verify(&restic, &repo_path, &passphrase).await {
                error!("Deep verify failed: {}", Redact::new(err));
                status = RunStatus::Partial;
                message = "Backup completed, but deep verification failed".to_string();
            }
        }

        if status == RunStatus::Success && config.retention.enabled {
            set_phase(
                &state,
                RunPhase::Pruning,
                RunStatus::Partial,
                "Applying retention",
                started_epoch,
                summary.snapshot_id.clone(),
                false,
            )
            .await;
            if let Err(err) = apply_retention(&restic, &repo_path, &passphrase, &config.retention).await {
                error!("Retention failed: {}", Redact::new(err));
                status = RunStatus::Partial;
                message = "Backup completed, but retention failed".to_string();
            }
        }

        let drive_connected = {
            let guard = state.read().await;
            guard.drive_status.connected && guard.drive_status.drive_id.as_deref() == Some(&drive_id)
        };
        if !drive_connected {
            interrupted = true;
            status = RunStatus::Failed;
            message = "Interrupted (drive disconnected)".to_string();
        }

        let finished_epoch = now_epoch();
        let repository_id = {
            let guard = state.read().await;
            guard
                .config
                .trusted_drives
                .get(&drive_id)
                .and_then(|drive| drive.repository_id.clone())
        };
        Ok(RunResult {
            status,
            phase: RunPhase::Completed,
            started_epoch,
            finished_epoch: Some(finished_epoch),
            message,
            interrupted,
            snapshot_id: summary.snapshot_id,
            repository_id,
            data_added: summary.data_added,
            files_processed: summary.files_processed,
        })
    }
    .await;

    match outcome {
        Ok(result) => {
            notifications::notify_backup_finished(
                &drive_label,
                result.status == RunStatus::Success,
                result.interrupted,
            );
            let mut guard = state.write().await;
            guard.last_run = Some(result.clone());
            guard.config.update_last_seen(&drive_id);
            let epoch = result.finished_epoch.unwrap_or_else(now_epoch);
            guard.config.update_last_backup(&drive_id, epoch, result.snapshot_id.clone());
            let _ = guard.config.save();
            Ok(result)
        }
        Err(err) => {
            let drive_connected = {
                let guard = state.read().await;
                guard.drive_status.connected && guard.drive_status.drive_id.as_deref() == Some(&drive_id)
            };
            let interrupted = !drive_connected;
            let message = if interrupted {
                "Interrupted (drive disconnected)"
            } else {
                "Backup failed"
            };
            let result = RunResult {
                status: RunStatus::Failed,
                phase: RunPhase::Completed,
                started_epoch,
                finished_epoch: Some(now_epoch()),
                message: message.to_string(),
                interrupted,
                snapshot_id: None,
                repository_id: None,
                data_added: None,
                files_processed: None,
            };
            notifications::notify_backup_finished(&drive_label, false, result.interrupted);
            let mut guard = state.write().await;
            guard.last_run = Some(result);
            Err(err)
        }
    }
}

fn expand_sources(config: &AgentConfig, drive_id: &str) -> anyhow::Result<Vec<PathBuf>> {
    let base_dirs = BaseDirs::new().context("resolve home dir")?;
    let home = base_dirs.home_dir();
    let sources_list = config.backup_sources_for_drive(drive_id);
    let mut sources = Vec::new();
    for source in &sources_list {
        // Paths are only used for restic; never surface them in logs or UI.
        let path = if let Some(stripped) = source.path.strip_prefix("~/") {
            home.join(stripped)
        } else {
            PathBuf::from(&source.path)
        };
        sources.push(path);
    }
    Ok(sources)
}

async fn apply_retention(
    restic: &Restic,
    repo_path: &Path,
    passphrase: &str,
    retention: &RetentionPolicy,
) -> anyhow::Result<()> {
    let args = retention.to_forget_args();
    restic.forget_prune(repo_path, passphrase, &args).await
}

async fn update_repo_id(state: &SharedState, drive_id: &str, repo_id: &str) -> anyhow::Result<()> {
    let mut guard = state.write().await;
    if let Some(drive) = guard.config.trusted_drives.get_mut(drive_id) {
        drive.repository_id = Some(repo_id.to_string());
        guard.config.save()?;
    }
    Ok(())
}

async fn set_phase(
    state: &SharedState,
    phase: RunPhase,
    status: RunStatus,
    message: &str,
    started_epoch: u64,
    snapshot_id: Option<String>,
    interrupted: bool,
) {
    let mut guard = state.write().await;
    guard.last_run = Some(RunResult {
        status,
        phase,
        started_epoch,
        finished_epoch: None,
        message: message.to_string(),
        interrupted,
        snapshot_id,
        repository_id: None,
        data_added: None,
        files_processed: None,
    });
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[allow(dead_code)]
fn update_marker_repo_id(mount_path: &Path, repo_id: &str) -> anyhow::Result<()> {
    let mut marker = read_marker(mount_path)?.unwrap_or_else(|| DriveMarker::new(None));
    marker.repository_id = Some(repo_id.to_string());
    write_marker(mount_path, &marker)
}
