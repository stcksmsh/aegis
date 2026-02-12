use crate::backup::run_backup;
use crate::config::{BackupSource, TrustedDrive};
use crate::devices;
use crate::drive::{read_marker, write_marker, DriveMarker};
use crate::keychain;
use crate::logging::Redact;
use crate::recovery::export_recovery_kit;
use crate::restic::Restic;
use crate::state::{DriveStatus, RunResult, SharedState};
use crate::usb::resolve_device_for_mount;
use anyhow::Context;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use tower_http::cors::{Any, CorsLayer};
use tracing::error;

#[derive(Debug, Serialize)]
struct StatusResponse {
    first_run: bool,
    drive: DriveStatus,
    last_run: Option<RunResult>,
    running: bool,
    restic_available: bool,
    config: ConfigSummary,
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
struct FormatRequest {
    devnode: String,
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
        .with_state(state)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:7878").await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn list_devices(State(_state): State<SharedState>) -> Result<Json<DevicesResponse>, (StatusCode, String)> {
    let devices = devices::list_removable_devices()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "device scan failed".to_string()))?;
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
    Json(StatusResponse {
        first_run: config.is_first_run(),
        drive: guard.drive_status.clone(),
        last_run: guard.last_run.clone(),
        running: guard.running,
        restic_available,
        config: summary,
    })
}

async fn update_config(
    State(state): State<SharedState>,
    Json(req): Json<ConfigUpdateRequest>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    let mut guard = state.write().await;
    guard.config.backup_sources = req.backup_sources;
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
    tracing::info!("setup drive: request received (label set = {})", req.label.is_some());
    let mount_path = PathBuf::from(&req.mount_path);
    if !mount_path.exists() {
        return Err((StatusCode::BAD_REQUEST, "mount path not found".to_string()));
    }
    if resolve_device_for_mount(&mount_path).is_none() {
        return Err((StatusCode::BAD_REQUEST, "mount path is not a mounted drive".to_string()));
    }
    if req.passphrase.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "passphrase required".to_string()));
    }

    let restic = {
        let guard = state.read().await;
        Restic::resolve(guard.config.restic_path.as_deref())
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "restic not available".to_string()))?
    };

    let mut marker = read_marker(&mount_path)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "marker read failed".to_string()))?;
    let marker = match marker.take() {
        Some(marker) => marker,
        None => {
            let marker = DriveMarker::new(req.label.clone());
            write_marker(&mount_path, &marker)
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "marker write failed".to_string()))?;
            marker
        }
    };

    let repo_rel = ".aegis/repo".to_string();
    let repo_path = mount_path.join(&repo_rel);
    std::fs::create_dir_all(&repo_path)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "repo create failed".to_string()))?;

    let repo_id = if repo_path.join("config").exists() {
        restic.repository_id(&repo_path, &req.passphrase).await
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid passphrase or repo".to_string()))?
    } else {
        restic.init_repo(&repo_path, &req.passphrase).await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "failed to init repo".to_string()))?
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
        label: marker.label.clone(),
        repository_path: repo_rel,
        repository_id: Some(repo_id.clone()),
        last_seen_epoch: None,
    };
    guard.config.trusted_drives.insert(marker.drive_id.clone(), trusted);
    guard
        .config
        .save()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "config save failed".to_string()))?;

    if guard.config.remember_passphrase {
        if let Err(err) = keychain::store_passphrase(&marker.drive_id, &req.passphrase) {
            error!("Keychain store failed: {}", Redact::new(err));
        }
    }

    drop(guard);
    Ok(Json(SetupDriveResponse { drive_id: marker.drive_id, repository_id: repo_id }))
}

async fn mount_drive(
    State(_state): State<SharedState>,
    Json(req): Json<MountRequest>,
) -> Result<Json<MountResponse>, (StatusCode, String)> {
    tracing::info!("mount drive: request devnode={}", req.devnode);
    let mount_path = devices::mount_partition(&req.devnode).map_err(|err| {
        let msg = err.to_string();
        if msg.to_lowercase().contains("not authorized")
            || msg.to_lowercase().contains("authentication")
        {
            return (StatusCode::FORBIDDEN, "authorization required".to_string());
        }
        (StatusCode::INTERNAL_SERVER_ERROR, "mount failed".to_string())
    })?;
    tracing::info!("mount drive: success devnode={}", req.devnode);
    Ok(Json(MountResponse { mount_path }))
}

async fn format_drive(
    State(_state): State<SharedState>,
    Json(req): Json<FormatRequest>,
) -> Result<Json<FormatResponse>, (StatusCode, String)> {
    tracing::info!("format drive: request devnode={} label_set={}", req.devnode, req.label.is_some());
    devices::format_partition_exfat(&req.devnode, req.label.as_deref()).map_err(|err| {
        let msg = err.to_string();
        if msg.to_lowercase().contains("not authorized")
            || msg.to_lowercase().contains("authentication")
        {
            return (StatusCode::FORBIDDEN, "authorization required".to_string());
        }
        (StatusCode::INTERNAL_SERVER_ERROR, "format failed".to_string())
    })?;
    tracing::info!("format drive: success devnode={}", req.devnode);
    Ok(Json(FormatResponse { status: "ok".to_string() }))
}

async fn start_backup(
    State(state): State<SharedState>,
    Json(req): Json<BackupRequest>,
) -> Result<Json<BackupStartResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    if state.read().await.running {
        return Err((StatusCode::CONFLICT, "backup already running".to_string()));
    }
    let Some(drive) = config.trusted_drives.get(&req.drive_id) else {
        return Err((StatusCode::BAD_REQUEST, "unknown drive".to_string()));
    };
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;
    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;

    let state_clone = state.clone();
    let drive_id = drive.drive_id.clone();
    let mount = PathBuf::from(mount_path);
    tokio::spawn(async move {
        if let Err(err) = run_backup(state_clone, drive_id, mount, passphrase).await {
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

    let repo_path = PathBuf::from(mount_path).join(&drive.repository_path);
    restic
        .restore(&repo_path, &passphrase, &req.snapshot_id, FsPath::new(&req.target_path), &req.include_paths)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "restore failed".to_string()))?;

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
