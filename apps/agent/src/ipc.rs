use crate::backup::run_backup;
use crate::config::{AgentConfig, BackupSource, TrustedDrive};
use crate::devices;
use crate::config::sanitize_label;
use crate::drive::{read_marker, write_marker, DriveMarker};
use crate::keychain;
use crate::logging::Redact;
use crate::recovery::export_recovery_kit;
use crate::restic::Restic;
use crate::state::{BackupProgress, DriveStatus, RunResult, SharedState};
use crate::usb::resolve_device_for_mount;
use anyhow::Context;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use rand::distributions::Alphanumeric;
use rand::Rng;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, error};

fn default_drive_label(config: &AgentConfig) -> String {
    let mut rng = rand::thread_rng();
    for _ in 0..20 {
        let suffix: String = (0..6)
            .map(|_| char::from(rng.sample(Alphanumeric)))
            .collect::<String>()
            .to_lowercase();
        let label = format!("backup-{}", suffix);
        if !config.label_exists(&label, None) {
            return label;
        }
    }
    format!("backup-{}", rng.gen::<u32>() % 1_000_000)
}

#[derive(Debug, Serialize)]
struct TrustedDriveSummary {
    drive_id: String,
    label: String,
    /// True if this drive is currently connected (plugged in and mounted).
    is_connected: bool,
    /// When a backup to this drive last completed (epoch seconds); None if never.
    last_backup_epoch: Option<u64>,
    backup_source_labels: Vec<String>,
    /// Full sources (label + path) for UI display and open-folder.
    backup_sources: Vec<BackupSource>,
}

#[derive(Debug, Deserialize)]
struct DiscontinueDriveRequest {
    drive_id: String,
    /// User must type the drive label to confirm, e.g. "backup-abc123"
    confirm_label: String,
    /// If true and the drive is currently connected, unmount and securely wipe it (overwrite with zeros).
    #[serde(default)]
    wipe: bool,
}

#[derive(Debug, Serialize)]
struct StatusResponse {
    first_run: bool,
    drive: DriveStatus,
    last_run: Option<RunResult>,
    /// True if any backup is currently running.
    running: bool,
    /// Drive IDs with a backup in progress (enables UI to show per-drive state).
    running_drive_ids: Vec<String>,
    restic_available: bool,
    config: ConfigSummary,
    trusted_drives: Vec<TrustedDriveSummary>,
    /// Progress per drive (key = drive_id).
    backup_progress: std::collections::HashMap<String, BackupProgress>,
}

#[derive(Debug, Serialize)]
struct DevicesResponse {
    devices: Vec<devices::DeviceInfo>,
}

#[derive(Debug, Serialize)]
struct PreflightResponse {
    restic: bool,
    lsblk: bool,
    udisksctl: bool,
    mkfs_exfat: bool,
    pkexec: bool,
    udisksctl_format: bool,
}

#[derive(Debug, Serialize)]
struct ConfigSummary {
    backup_sources: Vec<String>,
    include_patterns: Vec<String>,
    exclude_patterns: Vec<String>,
    retention_enabled: bool,
    quick_verify: bool,
    deep_verify: bool,
    auto_backup_on_insert: bool,
    remember_passphrase: bool,
    paranoid_mode: bool,
}

#[derive(Debug, Deserialize)]
struct ConfigUpdateRequest {
    backup_sources: Vec<BackupSource>,
    include_patterns: Vec<String>,
    exclude_patterns: Vec<String>,
    retention: crate::retention::RetentionPolicy,
    quick_verify: bool,
    deep_verify: bool,
    auto_backup_on_insert: bool,
    remember_passphrase: bool,
    paranoid_mode: bool,
}

#[derive(Debug, Deserialize)]
struct SetupDriveRequest {
    mount_path: String,
    label: Option<String>,
    /// Sources to back up to this drive; if empty/absent, use global default.
    backup_sources: Option<Vec<BackupSource>>,
    passphrase: String,
    remember_passphrase: bool,
    paranoid_mode: bool,
}

#[derive(Debug, Serialize)]
struct SetupDriveResponse {
    drive_id: String,
    repository_id: String,
}

#[derive(Debug, Deserialize)]
struct BackupRequest {
    drive_id: String,
    passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
struct BackupStartResponse {
    status: String,
}

#[derive(Debug, Deserialize)]
struct SnapshotsRequest {
    drive_id: String,
    passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
struct SnapshotsResponse {
    snapshots: Vec<crate::restic::SnapshotInfo>,
}

#[derive(Debug, Deserialize)]
struct SnapshotStatsRequest {
    drive_id: String,
    snapshot_id: String,
    passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
struct SnapshotStatsResponse {
    total_size: u64,
    total_file_count: u64,
}

#[derive(Debug, Deserialize)]
struct RestoreRequest {
    drive_id: String,
    snapshot_id: String,
    target_path: String,
    include_paths: Vec<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
struct RestoreResponse {
    status: String,
}

#[derive(Debug, Deserialize)]
struct RecoveryKitRequest {
    drive_id: String,
    destination_dir: String,
}

#[derive(Debug, Serialize)]
struct RecoveryKitResponse {
    status: String,
}

#[derive(Debug, Deserialize)]
struct EjectRequest {
    mount_path: String,
}

#[derive(Debug, Deserialize)]
struct MountRequest {
    devnode: String,
}

#[derive(Debug, Serialize)]
struct MountResponse {
    mount_path: String,
}

#[derive(Debug, Deserialize)]
struct UpdateDriveRequest {
    drive_id: String,
    /// New in-app name (sanitized; duplicate check excluding this drive).
    label: Option<String>,
    /// New backup sources for this drive only; if absent, leave unchanged.
    backup_sources: Option<Vec<BackupSource>>,
}

#[derive(Debug, Deserialize)]
struct FormatRequest {
    devnode: String,
    /// Ignored: disk volume label is always aegis-xxxxxxxx; in-app name is stored in the marker on the drive.
    #[allow(dead_code)]
    label: Option<String>,
}

#[derive(Debug, Serialize)]
struct FormatResponse {
    status: String,
}

pub async fn serve(state: SharedState) -> anyhow::Result<()> {
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    let app = Router::new()
        .route("/v1/status", get(get_status))
        .route("/v1/devices", get(list_devices))
        .route("/v1/preflight", get(preflight))
        .route("/v1/config", post(update_config))
        .route("/v1/drives/setup", post(setup_drive))
        .route("/v1/drives/mount", post(mount_drive))
        .route("/v1/drives/format", post(format_drive))
    .route("/v1/backup/run", post(start_backup))
    .route("/v1/snapshots", post(list_snapshots))
    .route("/v1/snapshots/stats", post(snapshot_stats))
    .route("/v1/restore", post(restore_snapshot))
        .route("/v1/recovery-kit", post(export_recovery))
        .route("/v1/drives/eject", post(eject_drive))
        .route("/v1/drives/discontinue", post(discontinue_drive))
        .route("/v1/drives/update", post(update_drive))
        .with_state(state)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:7878").await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn list_devices(State(_state): State<SharedState>) -> Result<Json<DevicesResponse>, (StatusCode, String)> {
    debug!("list_devices: request");
    let devices = devices::list_removable_devices().map_err(|e| {
        tracing::error!("list_devices: scan failed error={}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("device scan failed: {}", e),
        )
    })?;
    debug!("list_devices: returning {} device(s)", devices.len());
    Ok(Json(DevicesResponse { devices }))
}

async fn preflight(State(state): State<SharedState>) -> Json<PreflightResponse> {
    let guard = state.read().await;
    let restic = Restic::resolve(guard.config.restic_path.as_deref()).is_ok();
    let lsblk = which::which("lsblk").is_ok();
    let udisksctl = which::which("udisksctl").is_ok();
    let mkfs_exfat = which::which("mkfs.exfat").is_ok() || which::which("mkfs.exfatfs").is_ok();
    let pkexec = which::which("pkexec").is_ok();
    let udisksctl_format = devices::udisksctl_supports_format();
    Json(PreflightResponse {
        restic,
        lsblk,
        udisksctl,
        mkfs_exfat,
        pkexec,
        udisksctl_format,
    })
}

async fn get_status(State(state): State<SharedState>) -> Json<StatusResponse> {
    let guard = state.read().await;
    let config = &guard.config;
    let restic_available = Restic::resolve(config.restic_path.as_deref()).is_ok();
    let summary = ConfigSummary {
        backup_sources: config.backup_sources.iter().map(|s| s.label.clone()).collect(),
        include_patterns: config.include_patterns.clone(),
        exclude_patterns: config.exclude_patterns.clone(),
        retention_enabled: config.retention.enabled,
        quick_verify: config.quick_verify,
        deep_verify: config.deep_verify,
        auto_backup_on_insert: config.auto_backup_on_insert,
        remember_passphrase: config.remember_passphrase,
        paranoid_mode: config.paranoid_mode,
    };
    let current_drive_id = guard.drive_status.drive_id.as_ref();
    let trusted_drives: Vec<TrustedDriveSummary> = config
        .trusted_drives
        .iter()
        .map(|(id, d)| {
            let label = d
                .label
                .clone()
                .unwrap_or_else(|| format!("drive-{}", d.drive_id.chars().take(8).collect::<String>()));
            let is_connected = current_drive_id == Some(id) && guard.drive_status.connected;
            let sources = config.backup_sources_for_drive(id);
            let backup_source_labels = sources.iter().map(|s| s.label.clone()).collect();
            let backup_sources = sources;
            TrustedDriveSummary {
                drive_id: id.clone(),
                label,
                is_connected,
                last_backup_epoch: d.last_backup_epoch,
                backup_source_labels,
                backup_sources,
            }
        })
        .collect();
    Json(StatusResponse {
        first_run: config.is_first_run(),
        drive: guard.drive_status.clone(),
        last_run: guard.last_run.clone(),
        running: !guard.running_drive_ids.is_empty(),
        running_drive_ids: guard.running_drive_ids.iter().cloned().collect(),
        restic_available,
        config: summary,
        trusted_drives,
        backup_progress: guard.backup_progress.clone(),
    })
}

async fn update_config(
    State(state): State<SharedState>,
    Json(req): Json<ConfigUpdateRequest>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let mut guard = state.write().await;
    guard.config.backup_sources = req
        .backup_sources
        .into_iter()
        .map(|s| BackupSource {
            label: sanitize_label(&s.label).unwrap_or_else(|| "Source".to_string()),
            path: s.path,
        })
        .collect();
    guard.config.include_patterns = req.include_patterns;
    guard.config.exclude_patterns = req.exclude_patterns;
    guard.config.retention = req.retention;
    guard.config.quick_verify = req.quick_verify;
    guard.config.deep_verify = req.deep_verify;
    guard.config.auto_backup_on_insert = req.auto_backup_on_insert;
    guard.config.remember_passphrase = req.remember_passphrase;
    guard.config.paranoid_mode = req.paranoid_mode;
    guard.config.enforce_security_invariants();

    if guard.config.paranoid_mode {
        for drive_id in guard.config.trusted_drives.keys() {
            let _ = keychain::delete_passphrase(drive_id);
        }
    }

    // Avoid returning raw errors to the UI to prevent leaking paths.
    guard
        .config
        .save()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "config save failed".to_string()))?;
    drop(guard);
    Ok(get_status(State(state)).await)
}

async fn setup_drive(
    State(state): State<SharedState>,
    Json(req): Json<SetupDriveRequest>,
) -> Result<Json<SetupDriveResponse>, (StatusCode, String)> {
    debug!(
        "setup drive: request mount_path={} label_set={} backup_sources_count={}",
        req.mount_path,
        req.label.is_some(),
        req.backup_sources.as_ref().map(|v| v.len()).unwrap_or(0)
    );
    let mount_path = PathBuf::from(&req.mount_path);
    if !mount_path.exists() {
        tracing::warn!("setup drive: mount path does not exist path={}", req.mount_path);
        return Err((StatusCode::BAD_REQUEST, "mount path not found".to_string()));
    }
    if resolve_device_for_mount(&mount_path).is_none() {
        tracing::warn!("setup drive: mount path is not a mounted drive path={}", req.mount_path);
        return Err((StatusCode::BAD_REQUEST, "mount path is not a mounted drive".to_string()));
    }
    if req.passphrase.trim().is_empty() {
        tracing::warn!("setup drive: empty passphrase");
        return Err((StatusCode::BAD_REQUEST, "passphrase required".to_string()));
    }

    let (final_label, backup_sources) = {
        let guard = state.read().await;
        let config = &guard.config;
        let raw_label = req
            .label
            .as_ref()
            .and_then(|s| {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            })
            .unwrap_or_else(|| default_drive_label(config));
        let final_label = sanitize_label(&raw_label)
            .or_else(|| sanitize_label(&default_drive_label(config)))
            .unwrap_or_else(|| "backup".to_string());
        if config.label_exists(&final_label, None) {
            return Err((
                StatusCode::BAD_REQUEST,
                "A drive with this name already exists.".to_string(),
            ));
        }
        let sources = req
            .backup_sources
            .clone()
            .filter(|v| !v.is_empty())
            .map(|vec| {
                vec.into_iter()
                    .map(|s| BackupSource {
                        label: sanitize_label(&s.label).unwrap_or_else(|| "Source".to_string()),
                        path: s.path,
                    })
                    .collect()
            });
        (final_label, sources)
    };

    let restic = {
        let guard = state.read().await;
        Restic::resolve(guard.config.restic_path.as_deref())
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "restic not available".to_string()))?
    };

    debug!("setup drive: reading/writing marker at mount_path");
    let mut marker = read_marker(&mount_path).map_err(|e| {
        tracing::error!("setup drive: marker read failed path={} error={}", req.mount_path, e);
        (StatusCode::INTERNAL_SERVER_ERROR, format!("marker read failed: {}", e))
    })?;
    let marker = match marker.take() {
        Some(marker) => {
            debug!("setup drive: found existing marker drive_id={}", marker.drive_id);
            marker
        }
        None => {
            let marker = DriveMarker::new(Some(final_label.clone()));
            write_marker(&mount_path, &marker).map_err(|e| {
                tracing::error!("setup drive: marker write failed path={} error={}", req.mount_path, e);
                (StatusCode::INTERNAL_SERVER_ERROR, format!("marker write failed: {}", e))
            })?;
            debug!("setup drive: wrote new marker drive_id={}", marker.drive_id);
            marker
        }
    };

    let repo_rel = ".aegis/repo".to_string();
    let repo_path = mount_path.join(&repo_rel);
    debug!("setup drive: creating repo dir path={}", repo_path.display());
    std::fs::create_dir_all(&repo_path).map_err(|e| {
        tracing::error!("setup drive: repo create_dir_all failed path={} error={}", repo_path.display(), e);
        (StatusCode::INTERNAL_SERVER_ERROR, format!("repo create failed: {}", e))
    })?;

    let repo_id = if repo_path.join("config").exists() {
        debug!("setup drive: existing repo config found, checking passphrase");
        restic.repository_id(&repo_path, &req.passphrase).await.map_err(|e| {
            tracing::error!("setup drive: repository_id failed error={}", e);
            (StatusCode::BAD_REQUEST, "invalid passphrase or repo".to_string())
        })?
    } else {
        debug!("setup drive: initializing new restic repo path={}", repo_path.display());
        restic.init_repo(&repo_path, &req.passphrase).await.map_err(|e| {
            tracing::error!("setup drive: init_repo failed error={}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, format!("failed to init repo: {}", e))
        })?
    };

    let mut updated_marker = marker.clone();
    updated_marker.repository_id = Some(repo_id.clone());
    let _ = write_marker(&mount_path, &updated_marker);

    let mut guard = state.write().await;
    guard.config.remember_passphrase = req.remember_passphrase;
    guard.config.paranoid_mode = req.paranoid_mode;
    guard.config.enforce_security_invariants();

    let trusted = TrustedDrive {
        drive_id: marker.drive_id.clone(),
        label: Some(final_label.clone()),
        repository_path: repo_rel,
        repository_id: Some(repo_id.clone()),
        last_seen_epoch: None,
        last_backup_epoch: None,
        last_backup_snapshot_id: None,
        backup_sources,
    };
    guard.config.trusted_drives.insert(marker.drive_id.clone(), trusted);
    guard
        .config
        .save()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "config save failed".to_string()))?;

    // Mark the drive we just set up as connected and trusted so the dashboard shows it immediately.
    let mount_str = mount_path.to_string_lossy().to_string();
    guard.drive_status.connected = true;
    guard.drive_status.trusted = true;
    guard.drive_status.drive_id = Some(marker.drive_id.clone());
    guard.drive_status.label = Some(final_label);
    guard.drive_status.mount_path = Some(mount_str.clone());
    if let Some(device) = crate::usb::resolve_device_for_mount(&mount_path) {
        guard.drive_status.devnode = Some(device.to_string_lossy().to_string());
    }

    if guard.config.remember_passphrase {
        if let Err(err) = keychain::store_passphrase(&marker.drive_id, &req.passphrase) {
            error!("Keychain store failed: {}", Redact::new(err));
        }
    }

    drop(guard);
    tracing::info!(
        "setup drive: success drive_id={} repository_id={}",
        marker.drive_id,
        repo_id
    );
    Ok(Json(SetupDriveResponse { drive_id: marker.drive_id, repository_id: repo_id }))
}

async fn discontinue_drive(
    State(state): State<SharedState>,
    Json(req): Json<DiscontinueDriveRequest>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    debug!(
        "discontinue drive: request drive_id={} wipe={}",
        req.drive_id,
        req.wipe
    );
    let mut guard = state.write().await;
    let drive = guard
        .config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| {
            tracing::warn!("discontinue drive: drive not found drive_id={}", req.drive_id);
            (StatusCode::NOT_FOUND, "Drive not found.".to_string())
        })?;
    let expected = drive
        .label
        .as_deref()
        .unwrap_or("");
    if expected.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Drive has no label; cannot discontinue by name.".to_string(),
        ));
    }
    let confirmed = req.confirm_label.trim();
    if confirmed != expected {
        return Err((
            StatusCode::BAD_REQUEST,
            "Confirmation does not match. Type the drive name exactly to confirm.".to_string(),
        ));
    }
    let drive_id = req.drive_id.clone();
    let devnode_to_wipe: Option<String> = if req.wipe {
        if guard.drive_status.drive_id.as_deref() != Some(&drive_id) || guard.drive_status.devnode.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Drive must be connected to wipe. Plug in the drive and try again.".to_string(),
            ));
        }
        guard.drive_status.devnode.clone()
    } else {
        None
    };
    guard.config.trusted_drives.remove(&drive_id);
    guard
        .config
        .save()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "config save failed".to_string()))?;
    drop(guard);
    let _ = keychain::delete_passphrase(&drive_id);
    if let Some(devnode) = devnode_to_wipe {
        if let Err(e) = devices::unmount_partition(&devnode) {
            tracing::warn!("discontinue wipe: unmount failed: {}", e);
        }
        if let Err(e) = devices::secure_wipe_block_device(&devnode) {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Secure wipe failed: {}", e),
            ));
        }
        let mut guard = state.write().await;
        guard.drive_status.connected = false;
        guard.drive_status.trusted = false;
        guard.drive_status.drive_id = None;
        guard.drive_status.label = None;
        guard.drive_status.mount_path = None;
        guard.drive_status.devnode = None;
    }
    Ok(get_status(State(state)).await)
}

async fn update_drive(
    State(state): State<SharedState>,
    Json(req): Json<UpdateDriveRequest>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    debug!(
        "update drive: drive_id={} label_set={} backup_sources_set={}",
        req.drive_id,
        req.label.is_some(),
        req.backup_sources.is_some()
    );
    let mut guard = state.write().await;
    if !guard.config.trusted_drives.contains_key(&req.drive_id) {
        drop(guard);
        return Err((
            StatusCode::NOT_FOUND,
            "Drive not found.".to_string(),
        ));
    }

    if let Some(raw_label) = &req.label {
        let new_label = sanitize_label(raw_label)
            .or_else(|| sanitize_label(&raw_label.trim().to_string()))
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                (StatusCode::BAD_REQUEST, "Label is empty or invalid after sanitization.".to_string())
            })?;
        if guard.config.label_exists(&new_label, Some(&req.drive_id)) {
            return Err((
                StatusCode::BAD_REQUEST,
                "A drive with this name already exists.".to_string(),
            ));
        }
        if let Some(drive) = guard.config.trusted_drives.get_mut(&req.drive_id) {
            drive.label = Some(new_label.clone());
        }
        if guard.drive_status.drive_id.as_deref() == Some(req.drive_id.as_str()) {
            guard.drive_status.label = Some(new_label.clone());
            if let Some(ref mount_path_str) = guard.drive_status.mount_path {
                let mount_path = PathBuf::from(mount_path_str.clone());
                drop(guard);
                if let Ok(Some(mut marker)) = read_marker(&mount_path) {
                    marker.label = Some(new_label);
                    let _ = write_marker(&mount_path, &marker);
                }
                guard = state.write().await;
            }
        }
    }

    if let Some(sources) = &req.backup_sources {
        let sanitized: Vec<BackupSource> = sources
            .iter()
            .map(|s| BackupSource {
                label: sanitize_label(&s.label).unwrap_or_else(|| "Source".to_string()),
                path: s.path.clone(),
            })
            .collect();
        if let Some(drive) = guard.config.trusted_drives.get_mut(&req.drive_id) {
            drive.backup_sources = Some(sanitized);
        }
    }

    guard
        .config
        .save()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "config save failed".to_string()))?;
    drop(guard);
    Ok(get_status(State(state)).await)
}

async fn mount_drive(
    State(_state): State<SharedState>,
    Json(req): Json<MountRequest>,
) -> Result<Json<MountResponse>, (StatusCode, String)> {
    debug!("mount drive: request devnode={}", req.devnode);
    let mount_path = devices::mount_partition(&req.devnode).map_err(|err| {
        let msg = err.to_string();
        tracing::error!("mount drive failed devnode={} error={}", req.devnode, msg);
        if msg.to_lowercase().contains("not authorized")
            || msg.to_lowercase().contains("authentication")
        {
            return (StatusCode::FORBIDDEN, "authorization required".to_string());
        }
        (StatusCode::INTERNAL_SERVER_ERROR, msg)
    })?;
    tracing::info!("mount drive: success devnode={} mount_path={}", req.devnode, mount_path);
    Ok(Json(MountResponse { mount_path }))
}

async fn format_drive(
    State(_state): State<SharedState>,
    Json(req): Json<FormatRequest>,
) -> Result<Json<FormatResponse>, (StatusCode, String)> {
    debug!("format drive: request devnode={}", req.devnode);
    devices::format_partition_exfat(&req.devnode).map_err(|err| {
        let msg = err.to_string();
        tracing::error!("format drive failed devnode={} error={}", req.devnode, msg);
        if msg.to_lowercase().contains("not authorized")
            || msg.to_lowercase().contains("authentication")
        {
            return (StatusCode::FORBIDDEN, "authorization required".to_string());
        }
        (StatusCode::INTERNAL_SERVER_ERROR, msg)
    })?;
    tracing::info!("format drive: success devnode={}", req.devnode);
    Ok(Json(FormatResponse { status: "ok".to_string() }))
}

async fn start_backup(
    State(state): State<SharedState>,
    Json(req): Json<BackupRequest>,
) -> Result<Json<BackupStartResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    {
        let guard = state.read().await;
        if guard.running_drive_ids.contains(&req.drive_id) {
            return Err((StatusCode::CONFLICT, "backup already running for this drive".to_string()));
        }
    }
    let Some(drive) = config.trusted_drives.get(&req.drive_id) else {
        return Err((StatusCode::BAD_REQUEST, "unknown drive".to_string()));
    };
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;
    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;

    {
        let mut guard = state.write().await;
        guard.running_drive_ids.insert(req.drive_id.clone());
    }
    let state_clone = state.clone();
    let drive_id = drive.drive_id.clone();
    let mount = PathBuf::from(mount_path);
    tokio::spawn(async move {
        let result = run_backup(state_clone.clone(), drive_id.clone(), mount, passphrase).await;
        {
            let mut guard = state_clone.write().await;
            guard.running_drive_ids.remove(&drive_id);
            guard.backup_progress.remove(&drive_id);
            guard.running_cancel_tokens.remove(&drive_id);
        }
        if let Err(err) = result {
            error!("Manual backup failed: {}", Redact::new(err));
        }
    });

    Ok(Json(BackupStartResponse { status: "started".to_string() }))
}

async fn list_snapshots(
    State(state): State<SharedState>,
    Json(req): Json<SnapshotsRequest>,
) -> Result<Json<SnapshotsResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    let drive = config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "unknown drive".to_string()))?
        .clone();

    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;

    let restic = Restic::resolve(config.restic_path.as_deref())
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "restic not available".to_string()))?;
    let repo_path = PathBuf::from(mount_path).join(&drive.repository_path);
    let snapshots = restic
        .snapshots(&repo_path, &passphrase)
        .await
        .map_err(|_| (StatusCode::BAD_REQUEST, "unable to list snapshots".to_string()))?;

    Ok(Json(SnapshotsResponse { snapshots }))
}

async fn snapshot_stats(
    State(state): State<SharedState>,
    Json(req): Json<SnapshotStatsRequest>,
) -> Result<Json<SnapshotStatsResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    let drive = config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "unknown drive".to_string()))?
        .clone();

    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;

    let restic = Restic::resolve(config.restic_path.as_deref())
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "restic not available".to_string()))?;
    let repo_path = PathBuf::from(mount_path).join(&drive.repository_path);
    let stats = restic
        .snapshot_stats(&repo_path, &passphrase, &req.snapshot_id)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "stats failed".to_string()))?;

    Ok(Json(SnapshotStatsResponse { total_size: stats.total_size, total_file_count: stats.total_file_count }))
}

async fn restore_snapshot(
    State(state): State<SharedState>,
    Json(req): Json<RestoreRequest>,
) -> Result<Json<RestoreResponse>, (StatusCode, String)> {
    if req.target_path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "target path required".to_string()));
    }

    let config = { state.read().await.config.clone() };
    let drive = config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "unknown drive".to_string()))?
        .clone();

    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;

    let restic = Restic::resolve(config.restic_path.as_deref())
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "restic not available".to_string()))?;

    let repo_path = PathBuf::from(mount_path.clone()).join(&drive.repository_path);
    let cancel = CancellationToken::new();
    {
        let mut guard = state.write().await;
        guard.restore_drive_id = Some(req.drive_id.clone());
        guard.restore_cancel_token = Some(cancel.clone());
    }
    let result = restic
        .restore_cancellable(
            &repo_path,
            &passphrase,
            &req.snapshot_id,
            FsPath::new(&req.target_path),
            &req.include_paths,
            cancel,
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("restore failed: {}", e)));
    {
        let mut guard = state.write().await;
        guard.restore_drive_id = None;
        guard.restore_cancel_token = None;
    }
    result?;
    Ok(Json(RestoreResponse { status: "completed".to_string() }))
}

async fn export_recovery(
    State(state): State<SharedState>,
    Json(req): Json<RecoveryKitRequest>,
) -> Result<Json<RecoveryKitResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    let drive = config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "unknown drive".to_string()))?;

    export_recovery_kit(drive, FsPath::new(&req.destination_dir))
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "recovery export failed".to_string()))?;

    Ok(Json(RecoveryKitResponse { status: "created".to_string() }))
}

async fn eject_drive(
    State(_state): State<SharedState>,
    Json(req): Json<EjectRequest>,
) -> Result<Json<BackupStartResponse>, (StatusCode, String)> {
    let mount_path = PathBuf::from(req.mount_path);
    let Some(device) = resolve_device_for_mount(&mount_path) else {
        return Err((StatusCode::BAD_REQUEST, "device not found".to_string()));
    };

    let status = tokio::process::Command::new("udisksctl")
        .arg("unmount")
        .arg("-b")
        .arg(&device)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("unmount")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "eject failed".to_string()))?;

    if !status.success() {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, "eject failed".to_string()));
    }

    let status = tokio::process::Command::new("udisksctl")
        .arg("power-off")
        .arg("-b")
        .arg(&device)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("power off")
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "eject failed".to_string()))?;

    if !status.success() {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, "eject failed".to_string()));
    }

    Ok(Json(BackupStartResponse { status: "ejected".to_string() }))
}

async fn ensure_mounted_drive(state: &SharedState, drive_id: &str) -> Result<String, (StatusCode, String)> {
    let guard = state.read().await;
    if !guard.drive_status.connected || !guard.drive_status.trusted {
        return Err((StatusCode::BAD_REQUEST, "trusted drive not connected".to_string()));
    }
    if guard.drive_status.drive_id.as_deref() != Some(drive_id) {
        return Err((StatusCode::BAD_REQUEST, "drive mismatch".to_string()));
    }
    guard
        .drive_status
        .mount_path
        .clone()
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "drive not mounted".to_string()))
}

fn resolve_passphrase(
    config: &crate::config::AgentConfig,
    drive_id: &str,
    provided: Option<String>,
) -> Result<String, (StatusCode, String)> {
    if let Some(pass) = provided {
        if pass.trim().is_empty() {
            return Err((StatusCode::BAD_REQUEST, "passphrase required".to_string()));
        }
        return Ok(pass);
    }
    if config.remember_passphrase && !config.paranoid_mode {
        return keychain::get_passphrase(drive_id)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "keychain error".to_string()))?
            .ok_or_else(|| (StatusCode::BAD_REQUEST, "passphrase required".to_string()));
    }
    Err((StatusCode::BAD_REQUEST, "passphrase required".to_string()))
}
