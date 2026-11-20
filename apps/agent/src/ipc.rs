use crate::backup::run_backup;
use crate::config::sanitize_label;
use crate::config::{AgentConfig, BackupSource, TrustedDrive};
use crate::devices;
use crate::drive::{
    create_instance, ensure_writable_format, read_instance, read_marker, register_instance,
    write_marker, DriveMarker,
};
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
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
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
    can_list: bool,
    can_mount: bool,
    can_format: bool,
    can_wipe: bool,
    platform: String,
}

#[derive(Debug, Serialize)]
struct ConfigSummary {
    backup_sources: Vec<String>,
    include_patterns: Vec<String>,
    exclude_patterns: Vec<String>,
    retention: crate::retention::RetentionPolicy,
    quick_verify: bool,
    deep_verify: bool,
    auto_backup_on_insert: bool,
    remember_passphrase: bool,
    paranoid_mode: bool,
    reminder_days: u32,
    backup_interval_hours: u32,
    update_policy: crate::config::UpdatePolicy,
}

/// Partial update: each settings page sends only its own fields; missing ones are kept.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConfigUpdateRequest {
    backup_sources: Option<Vec<BackupSource>>,
    include_patterns: Option<Vec<String>>,
    exclude_patterns: Option<Vec<String>>,
    retention: Option<crate::retention::RetentionPolicy>,
    quick_verify: Option<bool>,
    deep_verify: Option<bool>,
    auto_backup_on_insert: Option<bool>,
    remember_passphrase: Option<bool>,
    paranoid_mode: Option<bool>,
    reminder_days: Option<u32>,
    backup_interval_hours: Option<u32>,
}

impl ConfigUpdateRequest {
    fn apply(self, config: &mut crate::config::AgentConfig) {
        if let Some(sources) = self.backup_sources {
            config.backup_sources = sources
                .into_iter()
                .map(|s| BackupSource {
                    label: sanitize_label(&s.label).unwrap_or_else(|| "Source".to_string()),
                    path: s.path,
                })
                .collect();
        }
        macro_rules! set {
            ($($field:ident),*) => { $(if let Some(v) = self.$field { config.$field = v; })* };
        }
        set!(
            include_patterns,
            exclude_patterns,
            retention,
            quick_verify,
            deep_verify,
            auto_backup_on_insert,
            remember_passphrase,
            paranoid_mode,
            reminder_days,
            backup_interval_hours
        );
        config.enforce_security_invariants();
    }
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
    /// Create a separate backup when the passphrase opens none of the drive's existing ones.
    #[serde(default)]
    new_instance: bool,
}

#[derive(Debug, Serialize)]
struct SetupDriveResponse {
    drive_id: String,
    repository_id: String,
    /// True if the passphrase opened a backup that already existed (e.g. handover to a new computer).
    existing: bool,
    /// For an existing backup: the computers that backed up to it and their folders (newest backup each).
    previous_computers: Vec<PreviousComputer>,
}

#[derive(Debug, Serialize)]
struct PreviousComputer {
    host: String,
    folders: Vec<String>,
    last_backup: String,
}

/// Newest snapshot per computer, newest computer first.
fn previous_computers(snapshots: Vec<crate::restic::SnapshotInfo>) -> Vec<PreviousComputer> {
    let mut latest: std::collections::HashMap<String, crate::restic::SnapshotInfo> =
        Default::default();
    for snap in snapshots {
        let host = snap.hostname.clone().unwrap_or_default();
        if latest.get(&host).is_none_or(|s| s.time < snap.time) {
            latest.insert(host, snap);
        }
    }
    let mut out: Vec<PreviousComputer> = latest
        .into_iter()
        .map(|(host, s)| PreviousComputer {
            host,
            folders: s.paths,
            last_backup: s.time,
        })
        .collect();
    out.sort_by(|a, b| b.last_backup.cmp(&a.last_backup));
    out
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
struct BrowseRequest {
    drive_id: String,
    snapshot_id: String,
    /// Snapshot-internal path to list; absent/empty lists the backup's top-level folders.
    path: Option<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
struct BrowseResponse {
    entries: Vec<crate::restic::BrowseEntry>,
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

/// Undoes the `drive_setups` count taken by a request handler, on every return path.
struct BusyGuard(SharedState);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let state = self.0.clone();
        tokio::spawn(async move { state.write().await.drive_setups -= 1 });
    }
}

fn updating() -> (StatusCode, String) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Aegis is installing an update. Try again in a minute.".to_string(),
    )
}

#[derive(Debug, Deserialize)]
struct MaintenanceRequest {
    hold: bool,
}

/// The app takes a hold before installing an update and releases it if the install fails.
/// Taking it fails while a backup, restore or drive setup runs; while held, none can start.
async fn maintenance(
    State(state): State<SharedState>,
    Json(req): Json<MaintenanceRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let mut guard = state.write().await;
    if req.hold && guard.is_busy() {
        return Err((
            StatusCode::CONFLICT,
            "A backup or restore is running.".to_string(),
        ));
    }
    guard.update_hold = req.hold;
    tracing::info!("update hold: {}", req.hold);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct SheetRequest {
    drive_id: String,
}

#[derive(Debug, Serialize)]
struct SheetResponse {
    path: String,
}

/// Writes a printable passphrase sheet for one backup and returns where (UI opens it).
async fn passphrase_sheet(
    State(state): State<SharedState>,
    Json(req): Json<SheetRequest>,
) -> Result<Json<SheetResponse>, (StatusCode, String)> {
    let (label, drive_label) = {
        let guard = state.read().await;
        let drive = guard
            .config
            .trusted_drives
            .get(&req.drive_id)
            .ok_or((StatusCode::NOT_FOUND, "Drive not found.".to_string()))?;
        let marker_label = guard
            .drive_status
            .has_instance(&req.drive_id)
            .then(|| guard.drive_status.mount_path.clone())
            .flatten()
            .and_then(|m| read_marker(FsPath::new(&m)).ok().flatten())
            .and_then(|m| m.label);
        (drive.label.clone().unwrap_or_default(), marker_label)
    };
    let created = chrono_free_date();
    let path = crate::sheet::write_sheet(&crate::sheet::SheetInfo {
        instance_id: &req.drive_id,
        label: &label,
        drive_label: drive_label.as_deref(),
        created: &created,
    })
    .map_err(|e| {
        error!("passphrase sheet: {}", Redact::new(e));
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't create the passphrase sheet.".to_string(),
        )
    })?;
    Ok(Json(SheetResponse {
        path: path.to_string_lossy().to_string(),
    }))
}

/// Today's date as YYYY-MM-DD (UTC), without a date library.
fn chrono_free_date() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    ymd(days)
}

/// Days since 1970-01-01 → YYYY-MM-DD (Howard Hinnant's civil_from_days).
fn ymd(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
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

pub const API_ADDR: &str = "127.0.0.1:7878";

/// Origins of the bundled Tauri webview (Linux/macOS use tauri://, Windows http(s)://tauri.localhost).
const ALLOWED_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// Reject requests whose Host header is not loopback (blocks DNS-rebinding from web pages).
async fn check_host(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    let host = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host_allowed(host) {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

fn host_allowed(host: &str) -> bool {
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(name, "127.0.0.1" | "localhost")
}

pub async fn serve(listener: tokio::net::TcpListener, state: SharedState) -> anyhow::Result<()> {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(
            ALLOWED_ORIGINS.map(axum::http::HeaderValue::from_static),
        ))
        .allow_methods(Any)
        .allow_headers(Any);
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
        .route("/v1/snapshots/browse", post(browse_snapshot))
        .route("/v1/restore", post(restore_snapshot))
        .route("/v1/restore/cancel", post(cancel_restore))
        .route("/v1/recovery-kit", post(export_recovery))
        .route("/v1/drives/eject", post(eject_drive))
        .route("/v1/drives/discontinue", post(discontinue_drive))
        .route("/v1/drives/update", post(update_drive))
        .route("/v1/drives/passphrase-sheet", post(passphrase_sheet))
        .route("/v1/maintenance", post(maintenance))
        .with_state(state)
        .layer(cors)
        .layer(axum::middleware::from_fn(check_host));

    axum::serve(listener, app).await?;
    Ok(())
}

async fn list_devices(
    State(_state): State<SharedState>,
) -> Result<Json<DevicesResponse>, (StatusCode, String)> {
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

#[cfg(target_os = "linux")]
fn drive_tool_capabilities() -> (bool, bool, bool) {
    let lsblk = which::which("lsblk").is_ok();
    let udisksctl = which::which("udisksctl").is_ok();
    let mkfs_exfat = which::which("mkfs.exfat").is_ok() || which::which("mkfs.exfatfs").is_ok();
    let pkexec = which::which("pkexec").is_ok();
    let can_list = lsblk;
    let can_mount = udisksctl && lsblk;
    let can_format = devices::udisksctl_supports_format() || (mkfs_exfat && pkexec);
    (can_list, can_mount, can_format)
}

#[cfg(target_os = "linux")]
fn platform_name() -> &'static str {
    "linux"
}
#[cfg(target_os = "macos")]
fn platform_name() -> &'static str {
    "macos"
}
#[cfg(target_os = "windows")]
fn platform_name() -> &'static str {
    "windows"
}

async fn preflight(State(state): State<SharedState>) -> Json<PreflightResponse> {
    let guard = state.read().await;
    let restic = Restic::resolve(guard.config.restic_path.as_deref()).is_ok();
    #[cfg(target_os = "linux")]
    let (can_list, can_mount, can_format) = drive_tool_capabilities();
    #[cfg(not(target_os = "linux"))]
    let (can_list, can_mount, can_format) = (true, true, true);
    let can_wipe = cfg!(target_os = "linux") && which::which("pkexec").is_ok();
    Json(PreflightResponse {
        restic,
        can_list,
        can_mount,
        can_format,
        can_wipe,
        platform: platform_name().to_string(),
    })
}

async fn get_status(State(state): State<SharedState>) -> Json<StatusResponse> {
    let guard = state.read().await;
    let config = &guard.config;
    let restic_available = Restic::resolve(config.restic_path.as_deref()).is_ok();
    let summary = ConfigSummary {
        backup_sources: config
            .backup_sources
            .iter()
            .map(|s| s.label.clone())
            .collect(),
        include_patterns: config.include_patterns.clone(),
        exclude_patterns: config.exclude_patterns.clone(),
        retention: config.retention.clone(),
        quick_verify: config.quick_verify,
        deep_verify: config.deep_verify,
        auto_backup_on_insert: config.auto_backup_on_insert,
        remember_passphrase: config.remember_passphrase,
        paranoid_mode: config.paranoid_mode,
        reminder_days: config.reminder_days,
        backup_interval_hours: config.backup_interval_hours,
        update_policy: config.update_policy,
    };
    let trusted_drives: Vec<TrustedDriveSummary> = config
        .trusted_drives
        .iter()
        .map(|(id, d)| {
            let label = d.label.clone().unwrap_or_else(|| {
                format!("drive-{}", d.drive_id.chars().take(8).collect::<String>())
            });
            let is_connected = guard.drive_status.has_instance(id);
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
    let mut drive_status = guard.drive_status.clone();
    if drive_status.connected && drive_status.trusted {
        if let Some(ref mount) = drive_status.mount_path {
            if let Some((free, total)) = crate::usb::disk_space_for_mount(FsPath::new(mount)) {
                drive_status.free_bytes = Some(free);
                drive_status.total_bytes = Some(total);
            }
        }
    }
    Json(StatusResponse {
        first_run: config.is_first_run(),
        drive: drive_status,
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
    req.apply(&mut guard.config);

    if guard.config.paranoid_mode {
        for drive_id in guard.config.trusted_drives.keys() {
            let _ = keychain::delete_passphrase(drive_id);
        }
    }

    // Avoid returning raw errors to the UI to prevent leaking paths.
    guard.config.save().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't save settings. Check free disk space and try again.".to_string(),
        )
    })?;
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
    // Setup writes to the drive (marker, new repo): counts as busy so an update waits for it.
    let _busy = {
        let mut guard = state.write().await;
        if guard.update_hold {
            return Err(updating());
        }
        guard.drive_setups += 1;
        BusyGuard(state.clone())
    };
    let mount_path = PathBuf::from(&req.mount_path);
    if !mount_path.exists() {
        tracing::warn!(
            "setup drive: mount path does not exist path={}",
            req.mount_path
        );
        return Err((
            StatusCode::BAD_REQUEST,
            "Drive not found. Unplug it and plug it back in.".to_string(),
        ));
    }
    if resolve_device_for_mount(&mount_path).is_none() && !devices::is_setup_candidate(&mount_path)
    {
        tracing::warn!(
            "setup drive: mount path is not a mounted drive path={}",
            req.mount_path
        );
        return Err((
            StatusCode::BAD_REQUEST,
            "That location isn't a USB drive.".to_string(),
        ));
    }
    if req.passphrase.trim().is_empty() {
        tracing::warn!("setup drive: empty passphrase");
        return Err((
            StatusCode::BAD_REQUEST,
            "Enter your passphrase.".to_string(),
        ));
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
        Restic::resolve(guard.config.restic_path.as_deref()).map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Backup engine missing. Please reinstall Aegis.".to_string(),
            )
        })?
    };

    let internal = |what: &str, e: anyhow::Error| {
        tracing::error!("setup drive: {} failed error={}", what, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Couldn't prepare the drive ({what}). Check that it isn't full or read-only."),
        )
    };

    debug!("setup drive: reading marker");
    let marker = match read_marker(&mount_path).map_err(|e| internal("read", e))? {
        Some(marker) => marker,
        None => {
            let marker = DriveMarker::new(Some(final_label.clone()));
            write_marker(&mount_path, &marker).map_err(|e| internal("write", e))?;
            marker
        }
    };
    ensure_writable_format(&marker).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    // A typed name used by a backup on another drive: refuse before creating anything here.
    if let Some(typed) = req.label.as_deref().and_then(sanitize_label) {
        let clash = state
            .read()
            .await
            .config
            .trusted_drives
            .iter()
            .any(|(id, d)| {
                !marker.instances.contains(id)
                    && d.label.as_deref().map(str::trim).map(str::to_lowercase)
                        == Some(typed.trim().to_lowercase())
            });
        if clash {
            return Err((
                StatusCode::BAD_REQUEST,
                "Another backup already uses this name. Choose a different name.".to_string(),
            ));
        }
    }

    // Find the instance this passphrase opens; restic itself checks the passphrase.
    let mut found = None;
    for id in &marker.instances {
        let Ok(meta) = read_instance(&mount_path, id) else {
            continue;
        };
        let repo = mount_path.join(&meta.repo_path);
        if !repo.join("config").exists() {
            continue;
        }
        match restic.repository_id(&repo, &req.passphrase).await {
            Ok(repo_id) => {
                found = Some((meta, repo_id));
                break;
            }
            Err(e) => debug!("setup drive: instance {} not opened: {}", id, e),
        }
    }

    let existing = found.is_some();
    let (meta, repo_id) = match found {
        Some(hit) => hit,
        None if marker.instances.is_empty() || req.new_instance => {
            debug!("setup drive: creating new instance");
            let (meta, repo) = create_instance(&mount_path).map_err(|e| internal("create", e))?;
            let repo_id = restic
                .init_repo(&repo, &req.passphrase)
                .await
                .map_err(|e| internal("initialize", e))?;
            register_instance(&mount_path, &meta.instance_id)
                .map_err(|e| internal("register", e))?;
            (meta, repo_id)
        }
        None => {
            return Err((
                StatusCode::CONFLICT,
                "This passphrase doesn't open any backup on this drive. Check it and try again, \
                 or create a separate new backup on this drive."
                    .to_string(),
            ))
        }
    };
    let instance_id = meta.instance_id.clone();

    // Setting up a backup this computer already knows (e.g. after reinstalling the drive list)
    // keeps its name and history unless a new name was typed.
    let known = {
        state
            .read()
            .await
            .config
            .trusted_drives
            .get(&instance_id)
            .cloned()
    };
    let typed_label = req
        .label
        .as_deref()
        .and_then(sanitize_label)
        .filter(|l| !l.trim().is_empty());
    let final_label = match (&known, typed_label) {
        (_, Some(typed)) => typed,
        (Some(k), None) => k.label.clone().unwrap_or(final_label),
        (None, None) => final_label,
    };
    if state
        .read()
        .await
        .config
        .label_exists(&final_label, Some(&instance_id))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Another backup already uses this name. Choose a different name.".to_string(),
        ));
    }

    let previous = if existing {
        let repo = mount_path.join(&meta.repo_path);
        restic
            .snapshots(&repo, &req.passphrase)
            .await
            .map(previous_computers)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut guard = state.write().await;
    guard.config.remember_passphrase = req.remember_passphrase;
    guard.config.paranoid_mode = req.paranoid_mode;
    guard.config.enforce_security_invariants();

    let trusted = TrustedDrive {
        drive_id: marker.drive_id.clone(),
        label: Some(final_label.clone()),
        repository_path: meta.repo_path,
        repository_id: Some(repo_id.clone()),
        last_seen_epoch: known.as_ref().and_then(|k| k.last_seen_epoch),
        last_backup_epoch: known.as_ref().and_then(|k| k.last_backup_epoch),
        last_backup_snapshot_id: known
            .as_ref()
            .and_then(|k| k.last_backup_snapshot_id.clone()),
        backup_sources: backup_sources
            .or_else(|| known.as_ref().and_then(|k| k.backup_sources.clone())),
        extra: known.map(|k| k.extra).unwrap_or_default(),
    };
    guard
        .config
        .trusted_drives
        .insert(instance_id.clone(), trusted);
    guard.config.save().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't save settings. Check free disk space and try again.".to_string(),
        )
    })?;

    // Mark the drive we just set up as connected and trusted so the dashboard shows it immediately.
    let mount_str = mount_path.to_string_lossy().to_string();
    guard.drive_status.connected = true;
    guard.drive_status.trusted = true;
    guard.drive_status.drive_id = Some(instance_id.clone());
    if !guard.drive_status.instance_ids.contains(&instance_id) {
        guard.drive_status.instance_ids.push(instance_id.clone());
    }
    guard.drive_status.label = Some(final_label);
    guard.drive_status.mount_path = Some(mount_str.clone());
    if let Some(device) = crate::usb::resolve_device_for_mount(&mount_path) {
        guard.drive_status.devnode = Some(device.to_string_lossy().to_string());
    }

    if guard.config.remember_passphrase {
        if let Err(err) = keychain::store_passphrase(&instance_id, &req.passphrase) {
            error!("Keychain store failed: {}", Redact::new(err));
        }
    }

    drop(guard);
    tracing::info!(
        "setup drive: success drive_id={} instance_id={} repository_id={}",
        marker.drive_id,
        instance_id,
        repo_id
    );
    Ok(Json(SetupDriveResponse {
        drive_id: instance_id,
        repository_id: repo_id,
        existing,
        previous_computers: previous,
    }))
}

async fn discontinue_drive(
    State(state): State<SharedState>,
    Json(req): Json<DiscontinueDriveRequest>,
) -> Result<Json<StatusResponse>, (StatusCode, String)> {
    debug!(
        "discontinue drive: request drive_id={} wipe={}",
        req.drive_id, req.wipe
    );
    let mut guard = state.write().await;
    let drive = guard
        .config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| {
            tracing::warn!(
                "discontinue drive: drive not found drive_id={}",
                req.drive_id
            );
            (StatusCode::NOT_FOUND, "Drive not found.".to_string())
        })?;
    let expected = drive.label.as_deref().unwrap_or("");
    if expected.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "This drive has no name, so it can't be forgotten here.".to_string(),
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
        if !guard.drive_status.has_instance(&drive_id) || guard.drive_status.devnode.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Plug in the drive to erase it, then try again.".to_string(),
            ));
        }
        let others = guard
            .drive_status
            .mount_path
            .as_ref()
            .and_then(|m| read_marker(FsPath::new(m)).ok().flatten())
            .is_some_and(|m| m.instances.iter().any(|i| i != &drive_id));
        if others {
            return Err((
                StatusCode::BAD_REQUEST,
                "This drive also holds other backups, so it can't be erased. \
                 Forget it without erasing instead."
                    .to_string(),
            ));
        }
        guard.drive_status.devnode.clone()
    } else {
        None
    };
    // Erase first: if that fails, the drive stays on the list and the user can try again.
    if let Some(devnode) = devnode_to_wipe {
        drop(guard);
        if let Err(e) = devices::unmount_partition(&devnode) {
            tracing::warn!("discontinue wipe: unmount failed: {}", e);
        }
        if let Err(e) = devices::secure_wipe_block_device(&devnode) {
            tracing::error!("discontinue wipe failed: {}", e);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't erase the drive, so it wasn't forgotten. Unplug it, plug it back in, \
                 and try again, or forget it without erasing."
                    .to_string(),
            ));
        }
        guard = state.write().await;
        guard.drive_status.connected = false;
        guard.drive_status.clear_drive();
        guard.drive_status.mount_path = None;
        guard.drive_status.devnode = None;
    }
    guard.config.trusted_drives.remove(&drive_id);
    guard.drive_status.instance_ids.retain(|i| i != &drive_id);
    guard.drive_status.trusted = !guard.drive_status.instance_ids.is_empty();
    if guard.drive_status.drive_id.as_deref() == Some(drive_id.as_str()) {
        guard.drive_status.drive_id = guard.drive_status.instance_ids.first().cloned();
    }
    guard.config.save().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't save settings. Check free disk space and try again.".to_string(),
        )
    })?;
    drop(guard);
    let _ = keychain::delete_passphrase(&drive_id);
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
        return Err((StatusCode::NOT_FOUND, "Drive not found.".to_string()));
    }

    if let Some(raw_label) = &req.label {
        let new_label = sanitize_label(raw_label)
            .or_else(|| sanitize_label(raw_label.trim()))
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    "Please enter a drive name using letters and numbers.".to_string(),
                )
            })?;
        if guard.config.label_exists(&new_label, Some(&req.drive_id)) {
            return Err((
                StatusCode::BAD_REQUEST,
                "Another backup already uses this name. Choose a different name.".to_string(),
            ));
        }
        if let Some(drive) = guard.config.trusted_drives.get_mut(&req.drive_id) {
            drive.label = Some(new_label.clone());
        }
        if guard.drive_status.has_instance(&req.drive_id) {
            if guard.drive_status.drive_id.as_deref() == Some(req.drive_id.as_str()) {
                guard.drive_status.label = Some(new_label.clone());
            }
            if let Some(ref mount_path_str) = guard.drive_status.mount_path {
                let mount_path = PathBuf::from(mount_path_str.clone());
                drop(guard);
                // The drive's own name is public; only rename it if it holds a single backup.
                if let Ok(Some(mut marker)) =
                    read_marker(&mount_path).map(|m| m.filter(|m| m.instances.len() <= 1))
                {
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

    guard.config.save().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't save settings. Check free disk space and try again.".to_string(),
        )
    })?;
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
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't open the drive. Unplug it, plug it back in, and try again.".to_string(),
        )
    })?;
    tracing::info!(
        "mount drive: success devnode={} mount_path={}",
        req.devnode,
        mount_path
    );
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
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't erase the drive. Unplug it, plug it back in, and try again. If it still \
             fails, erase it with your computer's disk tool and choose \"exFAT\"."
                .to_string(),
        )
    })?;
    tracing::info!("format drive: success devnode={}", req.devnode);
    Ok(Json(FormatResponse {
        status: "ok".to_string(),
    }))
}

async fn start_backup(
    State(state): State<SharedState>,
    Json(req): Json<BackupRequest>,
) -> Result<Json<BackupStartResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    {
        let guard = state.read().await;
        if guard.running_drive_ids.contains(&req.drive_id) {
            return Err((
                StatusCode::CONFLICT,
                "A backup to this drive is already running.".to_string(),
            ));
        }
    }
    if !config.trusted_drives.contains_key(&req.drive_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "This drive isn't set up in Aegis on this computer.".to_string(),
        ));
    }
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;
    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;

    {
        let mut guard = state.write().await;
        if guard.update_hold {
            return Err(updating());
        }
        guard.running_drive_ids.insert(req.drive_id.clone());
    }
    let state_clone = state.clone();
    let drive_id = req.drive_id.clone();
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

    Ok(Json(BackupStartResponse {
        status: "started".to_string(),
    }))
}

async fn list_snapshots(
    State(state): State<SharedState>,
    Json(req): Json<SnapshotsRequest>,
) -> Result<Json<SnapshotsResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    let drive = config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "This drive isn't set up in Aegis on this computer.".to_string(),
            )
        })?
        .clone();

    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;

    let restic = Restic::resolve(config.restic_path.as_deref()).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Backup engine missing. Please reinstall Aegis.".to_string(),
        )
    })?;
    let repo_path = PathBuf::from(mount_path).join(&drive.repository_path);
    let snapshots = restic
        .snapshots(&repo_path, &passphrase)
        .await
        .map_err(|e| restic_err(e, "Could not read backups from this drive."))?;

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
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "This drive isn't set up in Aegis on this computer.".to_string(),
            )
        })?
        .clone();

    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;

    let restic = Restic::resolve(config.restic_path.as_deref()).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Backup engine missing. Please reinstall Aegis.".to_string(),
        )
    })?;
    let repo_path = PathBuf::from(mount_path).join(&drive.repository_path);
    let stats = restic
        .snapshot_stats(&repo_path, &passphrase, &req.snapshot_id)
        .await
        .map_err(|e| restic_err(e, "Could not read backup details."))?;

    Ok(Json(SnapshotStatsResponse {
        total_size: stats.total_size,
        total_file_count: stats.total_file_count,
    }))
}

async fn browse_snapshot(
    State(state): State<SharedState>,
    Json(req): Json<BrowseRequest>,
) -> Result<Json<BrowseResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    let drive = config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "This drive isn't set up in Aegis on this computer.".to_string(),
            )
        })?
        .clone();

    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;

    let restic = Restic::resolve(config.restic_path.as_deref()).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Backup engine missing. Please reinstall Aegis.".to_string(),
        )
    })?;
    let repo_path = PathBuf::from(mount_path).join(&drive.repository_path);

    let dir = match req.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => p.to_string(),
        None => {
            let snapshots = restic
                .snapshots(&repo_path, &passphrase)
                .await
                .map_err(|e| restic_err(e, "Could not read backups from this drive."))?;
            let snapshot_paths = snapshots
                .into_iter()
                .find(|s| s.id == req.snapshot_id || s.id.starts_with(&req.snapshot_id))
                .map(|s| s.paths)
                .unwrap_or_default();
            Restic::browse_root(&snapshot_paths)
        }
    };

    let entries = restic
        .ls_dir(&repo_path, &passphrase, &req.snapshot_id, &dir)
        .await
        .map_err(|e| restic_err(e, "Could not read the contents of this backup."))?;

    Ok(Json(BrowseResponse { entries }))
}

async fn restore_snapshot(
    State(state): State<SharedState>,
    Json(req): Json<RestoreRequest>,
) -> Result<Json<RestoreResponse>, (StatusCode, String)> {
    if !crate::backup::expand_home(&req.target_path).is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a folder to restore into (use Browse…).".to_string(),
        ));
    }

    let config = { state.read().await.config.clone() };
    let drive = config
        .trusted_drives
        .get(&req.drive_id)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "This drive isn't set up in Aegis on this computer.".to_string(),
            )
        })?
        .clone();

    let mount_path = ensure_mounted_drive(&state, &req.drive_id).await?;
    let passphrase = resolve_passphrase(&config, &req.drive_id, req.passphrase)?;

    let restic = Restic::resolve(config.restic_path.as_deref()).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Backup engine missing. Please reinstall Aegis.".to_string(),
        )
    })?;

    let repo_path = PathBuf::from(mount_path.clone()).join(&drive.repository_path);
    let cancel = CancellationToken::new();
    {
        let mut guard = state.write().await;
        if guard.update_hold {
            return Err(updating());
        }
        guard.restore_drive_id = Some(req.drive_id.clone());
        guard.restore_cancel_token = Some(cancel.clone());
    }
    let result = restic
        .restore_cancellable(
            &repo_path,
            &passphrase,
            &req.snapshot_id,
            &crate::backup::expand_home(&req.target_path),
            &req.include_paths,
            cancel.clone(),
        )
        .await
        .map_err(|e| {
            if cancel.is_cancelled() {
                return (
                    StatusCode::CONFLICT,
                    "Restore stopped. Files restored so far are in the folder.".to_string(),
                );
            }
            restic_err(
                e,
                "Restore failed. Check that the drive is still connected.",
            )
        });
    {
        let mut guard = state.write().await;
        guard.restore_drive_id = None;
        guard.restore_cancel_token = None;
    }
    result?;
    Ok(Json(RestoreResponse {
        status: "completed".to_string(),
    }))
}

/// Stops a running restore (the user clicked "Stop restore"). No-op if none runs.
async fn cancel_restore(State(state): State<SharedState>) -> StatusCode {
    if let Some(cancel) = state.read().await.restore_cancel_token.as_ref() {
        cancel.cancel();
    }
    StatusCode::NO_CONTENT
}

async fn export_recovery(
    State(state): State<SharedState>,
    Json(req): Json<RecoveryKitRequest>,
) -> Result<Json<RecoveryKitResponse>, (StatusCode, String)> {
    let config = { state.read().await.config.clone() };
    let drive = config.trusted_drives.get(&req.drive_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "This drive isn't set up in Aegis on this computer.".to_string(),
        )
    })?;

    export_recovery_kit(drive, &crate::backup::expand_home(&req.destination_dir)).map_err(
        |_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't save the recovery kit to that folder.".to_string(),
            )
        },
    )?;

    Ok(Json(RecoveryKitResponse {
        status: "created".to_string(),
    }))
}

#[cfg(target_os = "linux")]
async fn do_eject(device: &FsPath) -> Result<(), (StatusCode, String)> {
    let status = crate::command("udisksctl")
        .arg("unmount")
        .arg("-b")
        .arg(device)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("unmount")
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
            )
        })?;
    if !status.success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
        ));
    }

    let status = crate::command("udisksctl")
        .arg("power-off")
        .arg("-b")
        .arg(device)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("power off")
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
            )
        })?;
    if !status.success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn do_eject(device: &FsPath) -> Result<(), (StatusCode, String)> {
    let status = crate::command("diskutil")
        .arg("eject")
        .arg(device)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("diskutil eject")
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
            )
        })?;
    if !status.success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn do_eject(device: &FsPath) -> Result<(), (StatusCode, String)> {
    // device is the mount path (e.g. "E:\"); validate it's a drive root before it reaches a shell command.
    let drive = windows_drive_root_letter(device).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Couldn't identify the drive. Unplug it and plug it back in.".to_string(),
        )
    })?;
    let script = format!(
        "(New-Object -comObject Shell.Application).Namespace(17).ParseName('{}\\').InvokeVerb('Eject')",
        drive
    );
    let status = crate::command("powershell")
        .args(["-NoProfile", "-Command", &script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("powershell eject")
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
            )
        })?;
    if !status.success() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't eject the drive. Close any files open on it and try again.".to_string(),
        ));
    }
    Ok(())
}

/// Validates a Windows drive letter (e.g. "E:\" or "E:") and returns the bare "E:" form,
/// so only a single drive letter can ever reach the PowerShell command line.
#[cfg(any(target_os = "windows", test))]
fn windows_drive_root_letter(path: &FsPath) -> Option<String> {
    let s = path.to_str()?;
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        Some((bytes[0] as char).to_ascii_uppercase().to_string() + ":")
    } else {
        None
    }
}

async fn eject_drive(
    State(_state): State<SharedState>,
    Json(req): Json<EjectRequest>,
) -> Result<Json<BackupStartResponse>, (StatusCode, String)> {
    let mount_path = PathBuf::from(req.mount_path);
    let Some(device) = resolve_device_for_mount(&mount_path) else {
        return Err((
            StatusCode::BAD_REQUEST,
            "Drive not found. Unplug it and plug it back in.".to_string(),
        ));
    };

    do_eject(&device).await?;

    Ok(Json(BackupStartResponse {
        status: "ejected".to_string(),
    }))
}

async fn ensure_mounted_drive(
    state: &SharedState,
    drive_id: &str,
) -> Result<String, (StatusCode, String)> {
    let guard = state.read().await;
    if !guard.drive_status.connected || !guard.drive_status.trusted {
        return Err((
            StatusCode::BAD_REQUEST,
            "Plug in your Aegis drive first.".to_string(),
        ));
    }
    if !guard.drive_status.has_instance(drive_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "A different drive is plugged in. Plug in the right Aegis drive.".to_string(),
        ));
    }
    guard.drive_status.mount_path.clone().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "The drive isn't ready yet. Wait a moment and try again.".to_string(),
        )
    })
}

/// User-facing error for a failed restic call: wrong passphrase is surfaced, rest gets `fallback`.
fn restic_err(err: anyhow::Error, fallback: &str) -> (StatusCode, String) {
    error!("restic call failed: {:#}", err);
    let msg = err.to_string();
    if msg == crate::restic::WRONG_PASSPHRASE {
        (StatusCode::BAD_REQUEST, msg)
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, fallback.to_string())
    }
}

fn resolve_passphrase(
    config: &crate::config::AgentConfig,
    drive_id: &str,
    provided: Option<String>,
) -> Result<String, (StatusCode, String)> {
    if let Some(pass) = provided {
        if pass.trim().is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Enter your passphrase.".to_string(),
            ));
        }
        return Ok(pass);
    }
    if config.remember_passphrase && !config.paranoid_mode {
        return keychain::get_passphrase(drive_id)
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Couldn't read the saved passphrase. Enter it instead.".to_string(),
                )
            })?
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    "Enter your passphrase.".to_string(),
                )
            });
    }
    Err((
        StatusCode::BAD_REQUEST,
        "Enter your passphrase.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn config_update_keeps_fields_it_does_not_send() {
        let mut config = crate::config::AgentConfig::default();
        config.retention.enabled = true;
        config.retention.keep_last = 5;
        config.remember_passphrase = true;
        let req: super::ConfigUpdateRequest = serde_json::from_value(
            serde_json::json!({"quick_verify": false, "paranoid_mode": true}),
        )
        .unwrap();
        req.apply(&mut config);
        assert!(!config.quick_verify);
        assert!(config.retention.enabled && config.retention.keep_last == 5);
        assert!(
            config.paranoid_mode && !config.remember_passphrase,
            "invariants still enforced"
        );
    }

    #[tokio::test]
    async fn update_hold_waits_for_backups_and_blocks_new_ones() {
        use super::*;
        let state: SharedState = std::sync::Arc::new(tokio::sync::RwLock::new(
            crate::state::AgentRuntimeState::new(AgentConfig::default(), None),
        ));
        let hold =
            |h: bool| maintenance(State(state.clone()), Json(MaintenanceRequest { hold: h }));

        state.write().await.running_drive_ids.insert("d1".into());
        assert_eq!(hold(true).await.unwrap_err().0, StatusCode::CONFLICT);
        state.write().await.running_drive_ids.clear();

        state.write().await.drive_setups = 1;
        assert!(hold(true).await.is_err(), "drive setup in progress");
        state.write().await.drive_setups = 0;

        // A connected, set-up drive, so start_backup gets as far as the hold check.
        {
            let mut g = state.write().await;
            let drive: TrustedDrive = serde_json::from_value(serde_json::json!({
                "drive_id": "p1", "label": "D", "repository_path": ".aegis/repo",
                "repository_id": null, "last_seen_epoch": null
            }))
            .unwrap();
            g.config.trusted_drives.insert("d1".into(), drive);
            g.drive_status.connected = true;
            g.drive_status.trusted = true;
            g.drive_status.instance_ids = vec!["d1".into()];
            g.drive_status.mount_path = Some(std::env::temp_dir().to_string_lossy().into());
        }
        assert!(hold(true).await.is_ok());
        let backup = start_backup(
            State(state.clone()),
            Json(BackupRequest {
                drive_id: "d1".into(),
                passphrase: Some("x".into()),
            }),
        )
        .await;
        assert_eq!(backup.unwrap_err(), updating());
        assert!(state.read().await.running_drive_ids.is_empty());
        assert!(hold(false).await.is_ok());
        assert!(!state.read().await.update_hold);
    }

    #[test]
    fn ymd_from_days() {
        assert_eq!(super::ymd(0), "1970-01-01");
        assert_eq!(super::ymd(20512), "2026-02-28");
    }

    #[test]
    fn previous_computers_keeps_newest_per_host() {
        let snap = |host: &str, time: &str, path: &str| crate::restic::SnapshotInfo {
            id: "ab".into(),
            time: time.into(),
            hostname: Some(host.into()),
            tags: None,
            paths: vec![path.into()],
        };
        let out = super::previous_computers(vec![
            snap("laptop", "2026-01-01T10:00:00Z", "/old"),
            snap("laptop", "2026-02-01T10:00:00Z", "/home/k/Firma"),
            snap("office", "2026-03-01T10:00:00Z", "C:\\Firma"),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].host, "office");
        assert_eq!(out[1].folders, vec!["/home/k/Firma".to_string()]);
    }

    use super::host_allowed;

    #[test]
    fn host_check_allows_only_loopback() {
        assert!(host_allowed("127.0.0.1:7878"));
        assert!(host_allowed("localhost:7878"));
        assert!(!host_allowed("evil.example:7878"));
        assert!(!host_allowed("127.0.0.1.evil.example"));
        assert!(!host_allowed(""));
    }

    #[test]
    fn windows_drive_root_letter_validates() {
        use super::windows_drive_root_letter;
        use std::path::Path;
        assert_eq!(
            windows_drive_root_letter(Path::new("e:\\")),
            Some("E:".to_string())
        );
        assert_eq!(
            windows_drive_root_letter(Path::new("E:")),
            Some("E:".to_string())
        );
        assert_eq!(windows_drive_root_letter(Path::new("/mnt/e")), None);
        assert_eq!(windows_drive_root_letter(Path::new("")), None);
    }
}
