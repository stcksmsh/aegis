use crate::config::BackupSource;
use crate::i18n::{t, tr};
use crate::logging::Redact;
use crate::notifications;
use crate::restic::{Restic, SnapshotInfo};
use crate::retention::RetentionPolicy;
use crate::state::{BackupProgress, RunPhase, RunResult, RunStatus, SharedState};
use crate::verify::{deep_verify, quick_verify};
use anyhow::Context;
use directories::BaseDirs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

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
    // Backups to the same drive run one after another: a USB stick isn't faster with two at once.
    let turn = drive_turn(&mount_path);
    let _turn = match turn.clone().try_lock_owned() {
        Ok(guard) => guard,
        Err(_) => {
            state.write().await.backup_progress.insert(
                drive_id.clone(),
                BackupProgress {
                    message: t("waiting_for_other_backup"),
                    ..Default::default()
                },
            );
            turn.lock_owned().await
        }
    };
    let started_epoch = now_epoch();
    set_phase(
        &state,
        RunPhase::BackingUp,
        RunStatus::Partial,
        &t("starting_backup"),
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
        guard
            .running_cancel_tokens
            .insert(drive_id.clone(), cancel.clone());
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
            debug!(
                "backup: initializing restic repository at {}",
                repo_path.display()
            );
            let repo_id = restic.init_repo(&repo_path, &passphrase).await?;
            repo_initialized = true;
            update_repo_id(&state, &drive_id, &repo_id).await?;
        }

        if !repo_initialized {
            return Err(anyhow::anyhow!("repository not initialized"));
        }

        let (sources, missing) = split_sources(&config.backup_sources_for_drive(&drive_id));
        if sources.is_empty() {
            return Err(anyhow::anyhow!(NO_FOLDERS));
        }
        debug!(
            "backup: sources count={} paths={:?}",
            sources.len(),
            sources
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
        );

        if config.delete_oldest_when_full && drive_almost_full(&mount_path) {
            set_phase(
                &state,
                RunPhase::Pruning,
                RunStatus::Partial,
                &t("cleaning_up_old_backups"),
                started_epoch,
                None,
                false,
            )
            .await;
            if let Some(date) = make_room(&restic, &repo_path, &passphrase, &mount_path).await {
                notifications::notify_made_room(&drive_label, &date);
            }
            set_phase(
                &state,
                RunPhase::BackingUp,
                RunStatus::Partial,
                &t("starting_backup"),
                started_epoch,
                None,
                false,
            )
            .await;
        }

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
                    message: tr(
                        "backing_up_files",
                        &[
                            ("pct", &pct.to_string()),
                            ("done", &report.files_done.to_string()),
                            ("total", &report.total_files.to_string()),
                        ],
                    ),
                    files_done: report.files_done,
                    total_files: report.total_files,
                    bytes_done: report.bytes_done,
                    total_bytes: report.total_bytes,
                };
                let mut guard = state_progress.write().await;
                guard
                    .backup_progress
                    .insert(drive_id_progress.clone(), progress.clone());
                if let Some(ref mut last_run) = guard.last_run {
                    last_run.message = progress.message;
                }
            }
        });

        let summary = backup_handle.await.context("backup task join")??;
        debug!(
            "backup: restic backup completed snapshot_id={:?}",
            summary.snapshot_id
        );

        let mut interrupted = false;
        let (mut status, mut message) = if !missing.is_empty() {
            (
                RunStatus::Partial,
                format!(
                    "{}{}",
                    tr("folders_not_found", &[("folders", &missing.join(", "))]),
                    if summary.incomplete {
                        format!(" {}", t("some_files_also_skipped"))
                    } else {
                        String::new()
                    }
                ),
            )
        } else if summary.incomplete {
            (RunStatus::Partial, t("files_skipped"))
        } else {
            (RunStatus::Success, t("everything_saved"))
        };

        if config.quick_verify {
            set_phase(
                &state,
                RunPhase::VerifyingQuick,
                RunStatus::Partial,
                &t("checking_backup"),
                started_epoch,
                summary.snapshot_id.clone(),
                false,
            )
            .await;
            if let Err(err) = quick_verify(&restic, &repo_path, &passphrase).await {
                error!("Quick verify failed: {}", Redact::new(err));
                status = RunStatus::Partial;
                message = t("verify_failed");
            }
        }

        if config.deep_verify {
            set_phase(
                &state,
                RunPhase::VerifyingDeep,
                RunStatus::Partial,
                &t("checking_backup_thoroughly"),
                started_epoch,
                summary.snapshot_id.clone(),
                false,
            )
            .await;
            if let Err(err) = deep_verify(&restic, &repo_path, &passphrase).await {
                error!("Deep verify failed: {}", Redact::new(err));
                status = RunStatus::Partial;
                message = t("verify_failed");
            }
        }

        if status == RunStatus::Success && config.retention.enabled {
            set_phase(
                &state,
                RunPhase::Pruning,
                RunStatus::Partial,
                &t("cleaning_up_old_backups"),
                started_epoch,
                summary.snapshot_id.clone(),
                false,
            )
            .await;
            if let Err(err) =
                apply_retention(&restic, &repo_path, &passphrase, &config.retention).await
            {
                error!("Retention failed: {}", Redact::new(err));
                status = RunStatus::Partial;
                message = t("cleanup_failed");
            }
        }

        let drive_connected = {
            let guard = state.read().await;
            guard.drive_status.has_instance(&drive_id)
        };
        if !drive_connected {
            interrupted = true;
            status = RunStatus::Failed;
            message = t("unplugged_during_backup");
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
            drive_almost_full: false,
        })
    }
    .await;

    match outcome {
        Ok(mut result) => {
            if result.status == RunStatus::Success {
                let kit_assets = state.read().await.kit_dir.clone();
                let root = mount_path.clone();
                let kit = tokio::task::spawn_blocking(move || {
                    crate::kit::refresh(&root, kit_assets.as_deref())
                })
                .await;
                match kit {
                    Ok(Ok(true)) => info!("restore kit on drive updated"),
                    Ok(Err(err)) => warn!("restore kit update failed: {}", Redact::new(err)),
                    _ => {}
                }
                if drive_almost_full(&mount_path) {
                    result.drive_almost_full = true;
                    notifications::notify_drive_almost_full(&drive_label);
                }
            }
            notifications::notify_backup_finished(&drive_label, &result.status, result.interrupted);
            let mut guard = state.write().await;
            guard.last_run = Some(result.clone());
            guard.config.update_last_seen(&drive_id);
            let epoch = result.finished_epoch.unwrap_or_else(now_epoch);
            guard
                .config
                .update_last_backup(&drive_id, epoch, result.snapshot_id.clone());
            let _ = guard.config.save();
            Ok(result)
        }
        Err(err) => {
            let drive_connected = {
                let guard = state.read().await;
                guard.drive_status.has_instance(&drive_id)
            };
            let interrupted = !drive_connected;
            let message = t(if interrupted {
                "unplugged_during_backup"
            } else if err.to_string() == crate::restic::WRONG_PASSPHRASE {
                "wrong_passphrase"
            } else if err.to_string() == NO_FOLDERS {
                "no_folders_found"
            } else {
                "backup_did_not_finish"
            });
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
                drive_almost_full: false,
            };
            notifications::notify_backup_finished(
                &drive_label,
                &RunStatus::Failed,
                result.interrupted,
            );
            let mut guard = state.write().await;
            guard.last_run = Some(result);
            Err(err)
        }
    }
}

const NO_FOLDERS: &str = "None of the folders to back up were found on this computer. \
     Choose them under Your drives, Edit folders.";

/// One lock per drive (mount path); held for the whole backup.
fn drive_turn(mount: &Path) -> Arc<tokio::sync::Mutex<()>> {
    type Turns = std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>;
    static TURNS: OnceLock<Turns> = OnceLock::new();
    TURNS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(mount.to_path_buf())
        .or_default()
        .clone()
}

/// Folders that exist (for restic) and the labels of those that don't (for the user).
/// Paths are only used for restic; never surface them in logs or UI.
fn split_sources(sources: &[BackupSource]) -> (Vec<PathBuf>, Vec<String>) {
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for source in sources {
        let path = expand_home(&source.path);
        if path.exists() {
            found.push(path);
        } else {
            missing.push(source.label.clone());
        }
    }
    (found, missing)
}

/// `~/x` → `<home>/x` (UI shows and accepts home-relative paths on every OS).
pub(crate) fn expand_home(path: &str) -> PathBuf {
    let path = path.trim();
    match (path.strip_prefix("~/"), BaseDirs::new()) {
        (Some(rest), Some(dirs)) => dirs.home_dir().join(rest),
        _ => PathBuf::from(path),
    }
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

/// Under 10% free space left.
fn drive_almost_full(mount: &Path) -> bool {
    crate::usb::disk_space_for_mount(mount)
        .is_some_and(|(free, total)| total > 0 && free < total / 10)
}

/// The newest backups that "make room" never deletes.
const KEEP_NEWEST: usize = 3;

/// This computer's backups (the ones retention may delete), in restic's order: oldest first.
fn own_snapshots<'a>(snapshots: &'a [SnapshotInfo], host: &str) -> Vec<&'a SnapshotInfo> {
    snapshots
        .iter()
        .filter(|s| s.hostname.as_deref() == Some(host))
        .collect()
}

/// Deletes the oldest backups one at a time (keep-last n-1, n-2, ...) until the drive has
/// 10% free again or only the newest `KEEP_NEWEST` are left. Restic decides what is oldest,
/// by real time. Returns the date (YYYY-MM-DD) of the oldest backup left, if any were deleted.
async fn make_room(
    restic: &Restic,
    repo_path: &Path,
    passphrase: &str,
    mount: &Path,
) -> Option<String> {
    let snapshots = match restic.snapshots(repo_path, passphrase).await {
        Ok(s) => s,
        Err(err) => {
            warn!("make room: listing backups failed: {}", Redact::new(err));
            return None;
        }
    };
    let count = own_snapshots(&snapshots, &restic.host).len();
    let mut removed = false;
    for keep in (KEEP_NEWEST..count).rev() {
        let args = [format!("--keep-last={keep}")];
        if let Err(err) = restic.forget_prune(repo_path, passphrase, &args).await {
            warn!("make room: delete failed: {}", Redact::new(err));
            break;
        }
        removed = true;
        if !drive_almost_full(mount) {
            break;
        }
    }
    if !removed {
        return None;
    }
    let left = match restic.snapshots(repo_path, passphrase).await {
        Ok(s) => s,
        Err(err) => {
            warn!("make room: listing backups failed: {}", Redact::new(err));
            return None;
        }
    };
    own_snapshots(&left, &restic.host)
        .first()
        .map(|s| s.time.chars().take(10).collect())
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
        drive_almost_full: false,
    });
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    #[test]
    fn one_backup_at_a_time_per_drive() {
        let a = drive_turn(Path::new("/media/test-turn-a"));
        let _held = a.clone().try_lock_owned().unwrap();
        assert!(drive_turn(Path::new("/media/test-turn-a"))
            .try_lock_owned()
            .is_err());
        assert!(drive_turn(Path::new("/media/test-turn-b"))
            .try_lock_owned()
            .is_ok());
    }

    use super::*;

    #[test]
    fn missing_folders_are_named_not_backed_up() {
        let dir = std::env::temp_dir();
        let src = |label: &str, path: &str| BackupSource {
            label: label.into(),
            path: path.into(),
        };
        let (found, missing) = split_sources(&[
            src("Temp", dir.to_str().unwrap()),
            src("Pictures", "/no/such/aegis/folder"),
        ]);
        assert_eq!(found, vec![dir]);
        assert_eq!(missing, vec!["Pictures".to_string()]);
    }
}
