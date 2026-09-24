use crate::backup::run_backup;
use crate::drive::read_marker;
use crate::keychain;
use crate::logging::Redact;
use crate::state::{RunPhase, RunResult, RunStatus, SharedState};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "linux")]
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use tracing::{debug, error, info, warn};

pub enum UsbWatcher {
    #[cfg(target_os = "linux")]
    Linux(LinuxWatcher),
    #[cfg(not(target_os = "linux"))]
    Stub(StubWatcher),
}

impl UsbWatcher {
    pub async fn run(self, state: SharedState) -> anyhow::Result<()> {
        match self {
            #[cfg(target_os = "linux")]
            UsbWatcher::Linux(watcher) => watcher.run(state).await,
            #[cfg(not(target_os = "linux"))]
            UsbWatcher::Stub(watcher) => watcher.run(state).await,
        }
    }
}

pub fn build_watcher() -> anyhow::Result<UsbWatcher> {
    #[cfg(target_os = "linux")]
    {
        Ok(UsbWatcher::Linux(LinuxWatcher::new()?))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(UsbWatcher::Stub(StubWatcher))
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
enum UsbEvent {
    Added(PathBuf),
    Removed(PathBuf),
}

#[cfg(target_os = "linux")]
pub struct LinuxWatcher;

#[cfg(target_os = "linux")]
impl LinuxWatcher {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self)
    }

    pub async fn run(self, state: SharedState) -> anyhow::Result<()> {
        let (tx, mut rx) = mpsc::channel(64);
        tokio::task::spawn_blocking(move || {
            if let Err(err) = monitor_usb(tx) {
                tracing::error!("udev monitor failed: {}", Redact::new(err));
            }
        });

        // Scan existing mounts on startup.
        scan_existing_mounts(&state).await;
        // Scan block devices on startup to catch unmounted USB drives.
        scan_existing_devices(&state).await;

        while let Some(event) = rx.recv().await {
            match event {
                UsbEvent::Added(devnode) => {
                    if let Err(err) = handle_added(&state, &devnode).await {
                        error!("Handle add failed: {}", Redact::new(err));
                    }
                }
                UsbEvent::Removed(devnode) => {
                    if let Err(err) = handle_removed(&state, &devnode).await {
                        error!("Handle remove failed: {}", Redact::new(err));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn monitor_usb(sender: mpsc::Sender<UsbEvent>) -> anyhow::Result<()> {
    use udev::{EventType, MonitorBuilder};
    debug!("Starting udev monitor for block devices");
    let monitor = MonitorBuilder::new()?.match_subsystem("block")?.listen()?;
    for event in monitor.iter() {
        let event_type = event.event_type();
        let device = event.device();
        let devtype = device
            .property_value("DEVTYPE")
            .and_then(|v| v.to_str())
            .unwrap_or("");
        let devnode = device.devnode().map(PathBuf::from);
        let id_bus = device
            .property_value("ID_BUS")
            .and_then(|v| v.to_str())
            .unwrap_or("");
        let fs_usage = device
            .property_value("ID_FS_USAGE")
            .and_then(|v| v.to_str())
            .unwrap_or("");
        let is_usb = is_usb_device(&device);
        let removable = device
            .attribute_value("removable")
            .and_then(|v| v.to_str())
            .unwrap_or("");
        debug!(
            "udev event: action={:?} devtype={} devnode={} usb={} removable={} id_bus={} fs_usage={}",
            event_type,
            devtype,
            devnode.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "-".to_string()),
            is_usb,
            removable,
            id_bus,
            fs_usage
        );
        if devtype != "partition" && devtype != "disk" {
            continue;
        }
        if !is_usb {
            continue;
        }
        if let Some(devnode) = devnode {
            match event_type {
                EventType::Add => {
                    debug!("USB partition detected: {}", devnode.display());
                    let _ = sender.blocking_send(UsbEvent::Added(devnode));
                }
                EventType::Remove => {
                    debug!("USB partition removed: {}", devnode.display());
                    let _ = sender.blocking_send(UsbEvent::Removed(devnode));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub struct StubWatcher;

#[cfg(not(target_os = "linux"))]
impl StubWatcher {
    pub async fn run(self, state: SharedState) -> anyhow::Result<()> {
        // Scan already-mounted removable volumes on startup.
        scan_existing_mounts(&state).await;

        let mut known: std::collections::HashSet<PathBuf> =
            removable_mount_points().into_iter().collect();
        loop {
            sleep(Duration::from_secs(3)).await;
            let current: std::collections::HashSet<PathBuf> =
                removable_mount_points().into_iter().collect();
            for mount in current.difference(&known) {
                debug!("Removable volume appeared: {}", mount.display());
                if let Err(err) = handle_added(&state, mount).await {
                    error!("Handle add failed: {}", Redact::new(err));
                }
            }
            for mount in known.difference(&current) {
                debug!("Removable volume vanished: {}", mount.display());
                if let Err(err) = handle_removed(&state, mount).await {
                    error!("Handle remove failed: {}", Redact::new(err));
                }
            }
            known = current;
        }
    }
}

/// Removable, mounted volumes on non-Linux platforms (via `sysinfo`).
#[cfg(not(target_os = "linux"))]
fn removable_mount_points() -> Vec<PathBuf> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| is_removable_disk(disk))
        .map(|disk| disk.mount_point().to_path_buf())
        .collect()
}

/// sysinfo's `is_removable()` reports ejectable media; on macOS, external USB hard
/// drives mounted under /Volumes are often not flagged removable, so treat any
/// non-root volume mounted there as a candidate too.
#[cfg(not(target_os = "linux"))]
pub(crate) fn is_removable_disk(disk: &sysinfo::Disk) -> bool {
    if disk.is_removable() {
        return true;
    }
    // Windows reports USB hard drives/SSDs as fixed disks; a drive Aegis already set up counts.
    if crate::drive::marker_path(disk.mount_point()).exists() {
        return true;
    }
    if cfg!(target_os = "macos") {
        let mount = disk.mount_point();
        return mount.starts_with("/Volumes/") && mount != std::path::Path::new("/");
    }
    false
}

async fn scan_existing_mounts(state: &SharedState) {
    debug!("Scanning existing mounts for USB drives");
    let mounts = mount_table();
    for (dev, _mount) in mounts {
        #[cfg(target_os = "linux")]
        if !is_usb_devnode(&dev) {
            continue;
        }
        debug!("Existing USB mount detected for {}", dev.display());
        if let Err(err) = handle_added(state, &dev).await {
            error!("Initial mount scan failed: {}", Redact::new(err));
        }
    }
}

#[cfg(target_os = "linux")]
async fn scan_existing_devices(state: &SharedState) {
    debug!("Scanning existing USB block devices");
    let devnodes: Vec<(PathBuf, String)> = {
        let mut collected: Vec<(PathBuf, String)> = Vec::new();
        let mut enumerator = match udev::Enumerator::new() {
            Ok(enumerator) => enumerator,
            Err(err) => {
                error!("Failed to init udev enumerator: {}", Redact::new(err));
                return;
            }
        };
        if let Err(err) = enumerator.match_subsystem("block") {
            error!("Failed to match block subsystem: {}", Redact::new(err));
            return;
        }
        let devices = match enumerator.scan_devices() {
            Ok(devices) => devices,
            Err(err) => {
                error!("Failed to scan udev devices: {}", Redact::new(err));
                return;
            }
        };
        for device in devices {
            let devtype = device
                .property_value("DEVTYPE")
                .and_then(|v| v.to_str())
                .unwrap_or("");
            if devtype != "partition" && devtype != "disk" {
                continue;
            }
            if !is_usb_device(&device) {
                continue;
            }
            let removable = device
                .attribute_value("removable")
                .and_then(|v| v.to_str())
                .unwrap_or("");
            if let Some(devnode) = device.devnode() {
                collected.push((PathBuf::from(devnode), removable.to_string()));
            }
        }
        collected
    };

    for (devnode, removable) in devnodes {
        debug!(
            "Existing USB block device detected: {} removable={}",
            devnode.display(),
            removable
        );
        if let Err(err) = handle_added(state, &devnode).await {
            error!("Existing device handling failed: {}", Redact::new(err));
        }
    }
}

async fn handle_added(state: &SharedState, devnode: &Path) -> anyhow::Result<()> {
    debug!("Handling USB add for {}", devnode.display());
    let mount_path = wait_for_mount(devnode).await;
    let Some(mount_path) = mount_path else {
        info!("USB device present but not mounted: {}", devnode.display());
        let mut guard = state.write().await;
        guard.drive_status.connected = true;
        guard.drive_status.trusted = false;
        guard.drive_status.drive_id = None;
        guard.drive_status.label = None;
        guard.drive_status.mount_path = None;
        guard.drive_status.devnode = Some(devnode.to_string_lossy().to_string());
        return Ok(());
    };
    debug!("USB device mounted at {}", mount_path.display());

    let marker = read_marker(&mount_path)?;
    if let Some(marker) = marker {
        let trusted = {
            let guard = state.read().await;
            guard.config.trusted_drives.contains_key(&marker.drive_id)
        };
        debug!(
            "USB handle_added: devnode={} drive_id={} trusted={}",
            devnode.display(),
            marker.drive_id,
            trusted
        );

        {
            let mut guard = state.write().await;
            guard.drive_status.connected = true;
            guard.drive_status.trusted = trusted;
            guard.drive_status.drive_id = Some(marker.drive_id.clone());
            guard.drive_status.label = marker.label.clone();
            guard.drive_status.mount_path = Some(mount_path.to_string_lossy().to_string());
            guard.drive_status.devnode = Some(devnode.to_string_lossy().to_string());
            if trusted {
                guard.config.update_last_seen(&marker.drive_id);
                let _ = guard.config.save();
            }
        }

        if trusted {
            crate::notifications::notify_trusted_device(marker.label.as_deref().unwrap_or("drive"));
            attempt_auto_backup(state, &marker.drive_id, &mount_path).await;
        }
    } else {
        debug!(
            "USB handle_added: devnode={} mount_path={} no marker (unknown drive)",
            devnode.display(),
            mount_path.display()
        );
        let mut guard = state.write().await;
        guard.drive_status.connected = true;
        guard.drive_status.trusted = false;
        guard.drive_status.drive_id = None;
        guard.drive_status.label = None;
        guard.drive_status.mount_path = Some(mount_path.to_string_lossy().to_string());
        guard.drive_status.devnode = Some(devnode.to_string_lossy().to_string());
    }

    Ok(())
}

async fn handle_removed(state: &SharedState, devnode: &Path) -> anyhow::Result<()> {
    let was_drive_id = {
        let guard = state.read().await;
        let id = guard.drive_status.drive_id.clone();
        if let Some(mount_path) = &guard.drive_status.mount_path {
            if let Some(device) = resolve_device_for_mount(Path::new(mount_path)) {
                if device != devnode {
                    debug!(
                        "USB handle_removed: devnode={} not current drive, ignoring",
                        devnode.display()
                    );
                    return Ok(());
                }
            }
        }
        id
    };
    debug!(
        "USB handle_removed: devnode={} drive_id={:?} clearing drive_status",
        devnode.display(),
        was_drive_id
    );

    let mut guard = state.write().await;
    guard.drive_status.connected = false;
    guard.drive_status.trusted = false;
    guard.drive_status.drive_id = None;
    guard.drive_status.label = None;
    guard.drive_status.mount_path = None;
    guard.drive_status.devnode = None;

    if let Some(ref id) = was_drive_id {
        if let Some(cancel) = guard.running_cancel_tokens.remove(id) {
            cancel.cancel();
        }
        if guard.restore_drive_id.as_deref() == Some(id.as_str()) {
            guard.restore_drive_id = None;
            if let Some(cancel) = guard.restore_cancel_token.take() {
                cancel.cancel();
            }
        }
        if guard.running_drive_ids.remove(id) {
            guard.backup_progress.remove(id);
            guard.last_run = Some(RunResult {
                status: RunStatus::Failed,
                phase: RunPhase::Completed,
                started_epoch: now_epoch(),
                finished_epoch: Some(now_epoch()),
                message: "Interrupted (drive disconnected)".to_string(),
                interrupted: true,
                snapshot_id: None,
                repository_id: None,
                data_added: None,
                files_processed: None,
                drive_almost_full: false,
            });
        }
    }
    Ok(())
}

pub(crate) async fn attempt_auto_backup(state: &SharedState, drive_id: &str, mount_path: &Path) {
    let config = { state.read().await.config.clone() };
    if !config.auto_backup_on_insert {
        return;
    }
    start_backup_if_eligible(state, drive_id, mount_path).await;
}

/// Starts a backup for `drive_id` if none is already running, paranoid mode is off, and a
/// stored passphrase is available. Shared by auto-backup-on-insert and the periodic-while-plugged-in check.
async fn start_backup_if_eligible(state: &SharedState, drive_id: &str, mount_path: &Path) {
    let config = { state.read().await.config.clone() };
    {
        let guard = state.read().await;
        if guard.running_drive_ids.contains(drive_id) {
            return;
        }
    }
    if config.paranoid_mode {
        info!("Paranoid mode enabled; waiting for manual passphrase entry");
        return;
    }

    let passphrase = if config.remember_passphrase {
        match keychain::get_passphrase(drive_id) {
            Ok(Some(value)) => Some(value),
            Ok(None) => None,
            Err(err) => {
                warn!("Keychain read failed: {}", Redact::new(err));
                None
            }
        }
    } else {
        None
    };

    let Some(passphrase) = passphrase else {
        debug!("No stored passphrase; waiting for manual backup");
        return;
    };

    {
        let mut guard = state.write().await;
        guard.running_drive_ids.insert(drive_id.to_string());
    }
    let state_clone = state.clone();
    let drive_id = drive_id.to_string();
    let mount = mount_path.to_path_buf();
    tokio::spawn(async move {
        let result = run_backup(state_clone.clone(), drive_id.clone(), mount, passphrase).await;
        {
            let mut guard = state_clone.write().await;
            guard.running_drive_ids.remove(&drive_id);
            guard.backup_progress.remove(&drive_id);
            guard.running_cancel_tokens.remove(&drive_id);
        }
        if let Err(err) = result {
            error!("Auto backup failed: {}", Redact::new(err));
        }
    });
}

async fn wait_for_mount(devnode: &Path) -> Option<PathBuf> {
    for _ in 0..25 {
        if let Some(mount) = find_mount_for_device(devnode) {
            return Some(mount);
        }
        sleep(Duration::from_millis(400)).await;
    }
    debug!(
        "No mount found for {} after waiting; marking drive as connected (unmounted).",
        devnode.display()
    );
    None
}

pub fn find_mount_for_device(devnode: &Path) -> Option<PathBuf> {
    let devnode_canon = std::fs::canonicalize(devnode).ok()?;
    let mounts = mount_table();
    for (device, mount) in mounts {
        if std::fs::canonicalize(&device).ok().as_ref() == Some(&devnode_canon) {
            return Some(mount);
        }
    }
    None
}

pub fn resolve_device_for_mount(mount: &Path) -> Option<PathBuf> {
    let mounts = mount_table();
    for (device, mount_path) in mounts {
        if mount_path == mount {
            return Some(device);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn mount_table() -> Vec<(PathBuf, PathBuf)> {
    let content = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    content
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 {
                return None;
            }
            Some((
                PathBuf::from(parts[0]),
                PathBuf::from(unescape_mount(parts[1])),
            ))
        })
        .collect()
}

/// Non-Linux has no devnode concept; the mount path doubles as the device identifier.
#[cfg(not(target_os = "linux"))]
fn mount_table() -> Vec<(PathBuf, PathBuf)> {
    removable_mount_points()
        .into_iter()
        .map(|mount| (mount.clone(), mount))
        .collect()
}

#[cfg(target_os = "linux")]
fn unescape_mount(input: &str) -> String {
    input
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(target_os = "linux")]
fn is_usb_devnode(devnode: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    use udev::{Device, DeviceType};

    let metadata = match std::fs::metadata(devnode) {
        Ok(meta) => meta,
        Err(_) => return false,
    };
    let device = match Device::from_devnum(DeviceType::Block, metadata.rdev()) {
        Ok(dev) => dev,
        Err(_) => return false,
    };

    let mut current = Some(device);
    while let Some(dev) = current {
        if dev
            .property_value("ID_BUS")
            .and_then(|v| v.to_str())
            .map(|v| v == "usb")
            .unwrap_or(false)
        {
            return true;
        }
        current = dev.parent();
    }
    false
}

#[cfg(target_os = "linux")]
fn is_usb_device(device: &udev::Device) -> bool {
    if device
        .property_value("ID_BUS")
        .and_then(|v| v.to_str())
        .map(|v| v == "usb")
        .unwrap_or(false)
    {
        return true;
    }
    if is_removable_device(device) {
        return true;
    }
    let mut current = device.parent();
    while let Some(dev) = current {
        if dev
            .property_value("ID_BUS")
            .and_then(|v| v.to_str())
            .map(|v| v == "usb")
            .unwrap_or(false)
        {
            return true;
        }
        if is_removable_device(&dev) {
            return true;
        }
        current = dev.parent();
    }
    false
}

#[cfg(target_os = "linux")]
fn is_removable_device(device: &udev::Device) -> bool {
    if device
        .attribute_value("removable")
        .and_then(|v| v.to_str())
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        return true;
    }
    if device
        .property_value("ID_DRIVE_THUMB")
        .and_then(|v| v.to_str())
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        return true;
    }
    if device
        .property_value("ID_DRIVE_FLASH_SD")
        .and_then(|v| v.to_str())
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        return true;
    }
    if device
        .property_value("ID_DRIVE_FLASH")
        .and_then(|v| v.to_str())
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        return true;
    }
    false
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

const SECS_PER_DAY: u64 = 86_400;
const SECS_PER_HOUR: u64 = 3_600;

/// True if a "time to back up" reminder should fire now: the drive has backed up before
/// but not in `reminder_days`, and we haven't reminded about it in the last 24h.
/// Never backed up (no last_backup) or reminders off (reminder_days == 0) => never due.
pub(crate) fn reminder_due(
    now: u64,
    last_backup: Option<u64>,
    reminder_days: u32,
    last_reminded: Option<u64>,
) -> bool {
    if reminder_days == 0 {
        return false;
    }
    let Some(last_backup) = last_backup else {
        return false;
    };
    if now.saturating_sub(last_backup) < reminder_days as u64 * SECS_PER_DAY {
        return false;
    }
    match last_reminded {
        Some(last) => now.saturating_sub(last) >= SECS_PER_DAY,
        None => true,
    }
}

/// True if a periodic backup is due for a drive that's currently plugged in:
/// interval is on and the last backup (or never having backed up) is older than the interval.
pub(crate) fn interval_due(now: u64, last_backup: Option<u64>, interval_hours: u32) -> bool {
    if interval_hours == 0 {
        return false;
    }
    match last_backup {
        Some(last) => now.saturating_sub(last) >= interval_hours as u64 * SECS_PER_HOUR,
        None => true,
    }
}

/// (free_bytes, total_bytes) for the filesystem mounted at or containing `mount_path`, if found.
pub(crate) fn disk_space_for_mount(mount_path: &Path) -> Option<(u64, u64)> {
    use sysinfo::Disks;
    let canon = std::fs::canonicalize(mount_path).ok();
    let target = canon.as_deref().unwrap_or(mount_path);
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| (disk.available_space(), disk.total_space()))
}

/// Checks every trusted drive once: reminds about ones that are overdue and disconnected,
/// and starts a backup for the connected one if the plugged-in backup interval is due.
/// Run hourly from `run()`.
pub(crate) async fn run_periodic_checks(state: SharedState) {
    loop {
        sleep(Duration::from_secs(SECS_PER_HOUR)).await;
        check_reminders_and_intervals(&state).await;
    }
}

async fn check_reminders_and_intervals(state: &SharedState) {
    let now = now_epoch();
    let (config, connected_drive_id, mount_path) = {
        let guard = state.read().await;
        (
            guard.config.clone(),
            guard.drive_status.drive_id.clone(),
            guard.drive_status.mount_path.clone(),
        )
    };

    for (drive_id, drive) in &config.trusted_drives {
        let is_connected =
            connected_drive_id.as_deref() == Some(drive_id.as_str()) && mount_path.is_some();
        if is_connected {
            if let Some(mount) = &mount_path {
                if interval_due(now, drive.last_backup_epoch, config.backup_interval_hours) {
                    start_backup_if_eligible(state, drive_id, Path::new(mount)).await;
                }
            }
            continue;
        }
        let last_reminded = { state.read().await.reminder_last_sent.get(drive_id).copied() };
        if reminder_due(
            now,
            drive.last_backup_epoch,
            config.reminder_days,
            last_reminded,
        ) {
            let label = drive.label.clone().unwrap_or_else(|| "drive".to_string());
            let days = drive
                .last_backup_epoch
                .map(|last| now.saturating_sub(last) / SECS_PER_DAY)
                .unwrap_or(0);
            crate::notifications::notify_backup_reminder(&label, days);
            state
                .write()
                .await
                .reminder_last_sent
                .insert(drive_id.clone(), now);
        }
    }
}

#[cfg(test)]
mod reminder_tests {
    use super::*;

    #[test]
    fn reminder_off_never_due() {
        assert!(!reminder_due(1_000_000, Some(0), 0, None));
    }

    #[test]
    fn reminder_not_due_before_threshold() {
        let now = 10 * SECS_PER_DAY;
        // last backup 5 days ago, reminder set to 7 days
        assert!(!reminder_due(now, Some(now - 5 * SECS_PER_DAY), 7, None));
    }

    #[test]
    fn reminder_due_after_threshold_never_reminded() {
        let now = 10 * SECS_PER_DAY;
        assert!(reminder_due(now, Some(now - 8 * SECS_PER_DAY), 7, None));
    }

    #[test]
    fn reminder_never_backed_up_is_skipped() {
        assert!(!reminder_due(10 * SECS_PER_DAY, None, 7, None));
    }

    #[test]
    fn reminder_not_repeated_within_24h() {
        let now = 10 * SECS_PER_DAY;
        let last_backup = Some(now - 8 * SECS_PER_DAY);
        let last_reminded = Some(now - 3600); // 1h ago
        assert!(!reminder_due(now, last_backup, 7, last_reminded));
    }

    #[test]
    fn reminder_repeats_after_24h() {
        let now = 10 * SECS_PER_DAY;
        let last_backup = Some(now - 8 * SECS_PER_DAY);
        let last_reminded = Some(now - SECS_PER_DAY - 1);
        assert!(reminder_due(now, last_backup, 7, last_reminded));
    }

    #[test]
    fn interval_off_never_due() {
        assert!(!interval_due(1_000_000, Some(0), 0));
    }

    #[test]
    fn interval_not_due_before_threshold() {
        let now = 10 * SECS_PER_HOUR;
        assert!(!interval_due(now, Some(now - 2 * SECS_PER_HOUR), 6));
    }

    #[test]
    fn interval_due_after_threshold() {
        let now = 10 * SECS_PER_HOUR;
        assert!(interval_due(now, Some(now - 7 * SECS_PER_HOUR), 6));
    }

    #[test]
    fn interval_due_when_never_backed_up() {
        assert!(interval_due(10 * SECS_PER_HOUR, None, 6));
    }
}
