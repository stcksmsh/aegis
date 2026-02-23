use anyhow::Context;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tracing::{debug, error, info, warn};

/// Volume label used when Aegis formats a drive: "aegis" + 6 hex chars = 11 chars (exFAT max).
fn generate_aegis_disk_name() -> String {
    let n = rand::thread_rng().gen::<u32>() & 0xFF_FFFF; // 24 bits = exactly 6 hex digits
    format!("aegis{:06x}", n)
}

#[derive(Debug, Serialize, Clone)]
pub struct DeviceInfo {
    pub path: String,
    pub name: String,
    pub size: String,
    pub model: Option<String>,
    pub removable: bool,
    pub partitions: Vec<PartitionInfo>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PartitionInfo {
    pub path: String,
    pub name: String,
    pub size: String,
    pub fstype: Option<String>,
    pub mountpoints: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LsblkOutput {
    blockdevices: Vec<LsblkDevice>,
}

#[derive(Debug, Deserialize)]
struct LsblkDevice {
    name: Option<String>,
    path: Option<String>,
    size: Option<String>,
    model: Option<String>,
    rm: Option<bool>,
    #[serde(rename = "tran")]
    tran: Option<String>,
    #[serde(rename = "hotplug")]
    hotplug: Option<bool>,
    #[serde(rename = "type")]
    devtype: Option<String>,
    #[serde(rename = "fstype")]
    fstype: Option<String>,
    mountpoints: Option<Vec<Option<String>>>,
    children: Option<Vec<LsblkDevice>>,
}

pub fn list_removable_devices() -> anyhow::Result<Vec<DeviceInfo>> {
    debug!("device scan: running lsblk -J");
    let output = Command::new("lsblk")
        .args([
            "-J",
            "-o",
            "NAME,PATH,SIZE,MODEL,RM,TRAN,HOTPLUG,TYPE,FSTYPE,MOUNTPOINTS",
        ])
        .output()
        .context("run lsblk")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!(
            "device scan: lsblk failed status={:?} stderr={}",
            output.status.code(),
            stderr.trim()
        );
        return Err(anyhow::anyhow!("lsblk failed"));
    }
    let parsed: LsblkOutput = serde_json::from_slice(&output.stdout)
        .context("parse lsblk output")?;
    debug!(
        "device scan: parsed {} block device(s)",
        parsed.blockdevices.len()
    );
    let mut devices = Vec::new();
    for dev in parsed.blockdevices {
        if dev.devtype.as_deref() != Some("disk") {
            continue;
        }
        let removable = dev.rm.unwrap_or(false)
            || dev.hotplug.unwrap_or(false)
            || dev.tran.as_deref() == Some("usb");
        if !removable {
            continue;
        }
        let name = dev.name.unwrap_or_else(|| "unknown".to_string());
        let path = dev.path.unwrap_or_else(|| format!("/dev/{}", name));
        let size = dev.size.unwrap_or_else(|| "unknown".to_string());
        let partitions = dev
            .children
            .unwrap_or_default()
            .into_iter()
            .filter(|child| child.devtype.as_deref() == Some("part"))
            .map(|child| {
                let name = child.name.unwrap_or_else(|| "unknown".to_string());
                let path = child
                    .path
                    .unwrap_or_else(|| format!("/dev/{}", name.clone()));
                PartitionInfo {
                    name,
                    path,
                    size: child.size.unwrap_or_else(|| "unknown".to_string()),
                    fstype: child.fstype,
                    mountpoints: normalize_mountpoints(child.mountpoints),
                }
            })
            .collect();
        devices.push(DeviceInfo {
            path,
            name,
            size,
            model: dev.model,
            removable,
            partitions,
        });
    }
    log_devices_if_changed(&devices);
    debug!("device scan: returning {} removable disk(s)", devices.len());
    Ok(devices)
}

fn log_devices_if_changed(devices: &[DeviceInfo]) {
    static LAST_SNAPSHOT: OnceLock<Mutex<String>> = OnceLock::new();
    let snapshot = device_snapshot(devices);
    let lock = LAST_SNAPSHOT.get_or_init(|| Mutex::new(String::new()));
    let mut guard = match lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if *guard == snapshot {
        return;
    }
    *guard = snapshot;
    info!("device scan: {} removable disks", devices.len());
    for device in devices {
        let model = device.model.clone().unwrap_or_else(|| "unknown".to_string());
        debug!(
            "device: path={} size={} model={}",
            device.path, device.size, model
        );
        for part in &device.partitions {
            let mounts = if part.mountpoints.is_empty() {
                "unmounted".to_string()
            } else {
                part.mountpoints.join(", ")
            };
            debug!("device:  partition={} size={} mounts={}", part.path, part.size, mounts);
        }
    }
}

fn device_snapshot(devices: &[DeviceInfo]) -> String {
    let mut lines: Vec<String> = devices
        .iter()
        .map(|device| {
            let mut parts: Vec<String> = device
                .partitions
                .iter()
                .map(|part| {
                    let mut mounts = part.mountpoints.clone();
                    mounts.sort();
                    format!(
                        "{}:{}:{}:{}",
                        part.path,
                        part.size,
                        part.fstype.clone().unwrap_or_default(),
                        mounts.join("|")
                    )
                })
                .collect();
            parts.sort();
            format!(
                "{}|{}|{}|{}|{}",
                device.path,
                device.size,
                device.model.clone().unwrap_or_default(),
                device.removable,
                parts.join(";")
            )
        })
        .collect();
    lines.sort();
    lines.join("||")
}

pub fn find_mountpoint(devnode: &str) -> anyhow::Result<Option<String>> {
    let output = Command::new("lsblk")
        .args(["-J", "-o", "NAME,PATH,TYPE,FSTYPE,MOUNTPOINTS"])
        .output()
        .context("run lsblk")?;
    if !output.status.success() {
        warn!("find_mountpoint: lsblk failed for devnode={}", devnode);
        return Err(anyhow::anyhow!("lsblk failed"));
    }
    let parsed: LsblkOutput =
        serde_json::from_slice(&output.stdout).context("parse lsblk output")?;
    for dev in parsed.blockdevices {
        if let Some(found) = find_mount_in_device(&dev, devnode) {
            if let Some(ref mp) = found {
                debug!("find_mountpoint: {} is mounted at {}", devnode, mp);
            } else {
                debug!("find_mountpoint: {} is not mounted", devnode);
            }
            return Ok(found);
        }
    }
    debug!("find_mountpoint: {} not found in lsblk output", devnode);
    Ok(None)
}

fn find_mount_in_device(device: &LsblkDevice, devnode: &str) -> Option<Option<String>> {
    if device.path.as_deref() == Some(devnode) {
        let mps = normalize_mountpoints(device.mountpoints.clone());
        return Some(mps.into_iter().next());
    }
    if let Some(children) = &device.children {
        for child in children {
            if let Some(found) = find_mount_in_device(child, devnode) {
                return Some(found);
            }
        }
    }
    None
}

fn normalize_mountpoints(raw: Option<Vec<Option<String>>>) -> Vec<String> {
    raw.unwrap_or_default()
        .into_iter()
        .filter_map(|v| v)
        .filter(|v| !v.is_empty())
        .collect()
}

pub fn mount_partition(devnode: &str) -> anyhow::Result<String> {
    ensure_udisksctl()?;
    debug!("mount: request devnode={}", devnode);
    for attempt in 1..=3 {
        let output = Command::new("udisksctl")
            .args(["mount", "-b", devnode])
            .output()
            .context("run udisksctl mount")?;
        if output.status.success() {
            let mount =
                find_mountpoint(devnode)?.ok_or_else(|| anyhow::anyhow!("mount path not found"))?;
            info!("mount: success for devnode={}", devnode);
            return Ok(mount);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let retryable = stderr.contains("not a mountable filesystem");
        if retryable && attempt < 3 {
            debug!(
                "mount: device not yet seen as mountable (attempt {}/3), waiting for udev/udisks2…",
                attempt
            );
            std::thread::sleep(std::time::Duration::from_millis(1200));
            continue;
        }
        warn!(
            "mount: udisksctl failed (attempt {}/3) status {:?} stderr={}",
            attempt,
            output.status.code(),
            stderr.trim()
        );
        return Err(anyhow::anyhow!("mount failed: {}", stderr.trim()));
    }
    Err(anyhow::anyhow!("mount failed"))
}

/// Format partition as exFAT with a fixed Aegis volume label (aegis-xxxxxxxx). In-app name is stored only in the marker file on the drive.
pub fn format_partition_exfat(devnode: &str) -> anyhow::Result<()> {
    let disk_label = generate_aegis_disk_name();
    debug!("format: request devnode={} disk_label={}", devnode, disk_label);
    for attempt in 1..=3 {
        let mountpoint = match find_mountpoint(devnode)? {
            None => break,
            Some(m) => m,
        };
        debug!(
            "format: unmounting {} from {} (attempt {}/3)",
            devnode, mountpoint, attempt
        );
        if let Err(e) = unmount_partition(devnode) {
            if attempt < 3 {
                warn!("format: unmount failed (attempt {}), retrying: {}", attempt, e);
                std::thread::sleep(std::time::Duration::from_millis(800));
            } else {
                error!("format: unmount failed after {} attempts: {}", attempt, e);
                return Err(e);
            }
        }
    }
    debug!("format: devnode={} is unmounted (or was not mounted), proceeding", devnode);
    if udisksctl_supports_format() {
        ensure_udisksctl()?;
        debug!("format: using udisksctl format (devnode={})", devnode);
        let mut cmd = Command::new("udisksctl");
        cmd.args(["format", "-b", devnode, "--type", "exfat", "--label", &disk_label]);
        let output = cmd.output().context("run udisksctl format")?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&output.stdout);
            error!(
                "format: udisksctl format failed devnode={} status={:?} stdout={} stderr={}",
                devnode,
                output.status.code(),
                stdout.trim(),
                stderr.trim()
            );
            return Err(anyhow::anyhow!("format failed: {}", stderr.trim()));
        }
        info!("format: success for devnode={} (udisksctl)", devnode);
        return Ok(());
    }

    // Fallback to mkfs.exfat via pkexec.
    let formatter = find_exfat_formatter().context("mkfs.exfat not found")?;
    debug!("format: udisksctl format not available, using mkfs formatter={}", formatter);
    run_mkfs_exfat(&formatter, devnode, &disk_label)?;
    info!("format: success for devnode={} (mkfs)", devnode);
    Ok(())
}

fn ensure_udisksctl() -> anyhow::Result<()> {
    which::which("udisksctl").context("udisksctl not found")?;
    Ok(())
}

pub fn udisksctl_supports_format() -> bool {
    static SUPPORTS: OnceLock<bool> = OnceLock::new();
    *SUPPORTS.get_or_init(|| {
        let output = Command::new("udisksctl").arg("help").output();
        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                return stdout
                    .lines()
                    .any(|line| line.trim_start().starts_with("format "));
            }
        }
        false
    })
}

pub fn unmount_partition(devnode: &str) -> anyhow::Result<()> {
    debug!("unmount: devnode={}", devnode);
    ensure_udisksctl()?;
    let output = Command::new("udisksctl")
        .args(["unmount", "-b", devnode])
        .output()
        .context("run udisksctl unmount")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        error!(
            "unmount: udisksctl unmount failed devnode={} status={:?} stdout={} stderr={}",
            devnode,
            output.status.code(),
            stdout.trim(),
            stderr.trim()
        );
        return Err(anyhow::anyhow!("unmount failed: {}", stderr.trim()));
    }
    debug!("unmount: success devnode={}", devnode);
    Ok(())
}

/// Securely wipe a block device (partition or disk) by overwriting with zeros.
/// Requires root (e.g. pkexec). Use only when the drive is discontinuing and unmounted.
pub fn secure_wipe_block_device(devnode: &str) -> anyhow::Result<()> {
    if which::which("pkexec").is_err() {
        return Err(anyhow::anyhow!("pkexec not found; cannot run secure wipe"));
    }
    info!("wipe: starting secure wipe of {}", devnode);
    let status = Command::new("pkexec")
        .args([
            "dd",
            "if=/dev/zero",
            &format!("of={}", devnode),
            "bs=4M",
            "status=progress",
        ])
        .status()
        .context("run pkexec dd")?;
    if !status.success() {
        return Err(anyhow::anyhow!("secure wipe failed"));
    }
    info!("wipe: completed for {}", devnode);
    Ok(())
}

fn find_exfat_formatter() -> Option<String> {
    if let Ok(path) = which::which("mkfs.exfat") {
        return Some(path.to_string_lossy().to_string());
    }
    if let Ok(path) = which::which("mkfs.exfatfs") {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

fn run_mkfs_exfat(formatter: &str, devnode: &str, disk_label: &str) -> anyhow::Result<()> {
    let use_pkexec = which::which("pkexec").is_ok();
    let args: Vec<String> = vec!["-n".to_string(), disk_label.to_string(), devnode.to_string()];
    debug!(
        "format: run_mkfs_exfat formatter={} use_pkexec={} args={:?}",
        formatter, use_pkexec, args
    );

    let output = if use_pkexec {
        Command::new("pkexec")
            .arg(formatter)
            .args(&args)
            .output()
            .context("run pkexec mkfs.exfat")?
    } else {
        Command::new(formatter)
            .args(&args)
            .output()
            .context("run mkfs.exfat")?
    };

    if output.status.success() {
        debug!("format: mkfs.exfat succeeded, waiting for udev");
        wait_for_udev_after_format();
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    error!(
        "format: mkfs.exfat failed devnode={} status={:?} stdout={} stderr={}",
        devnode,
        output.status.code(),
        stdout.trim(),
        stderr.trim()
    );

    // Retry with -L if -n is not supported.
    if stderr.contains("invalid option") || stderr.contains("unknown option") {
        debug!("format: retrying mkfs with -L (label) instead of -n");
        let args_alt: Vec<String> = vec!["-L".to_string(), disk_label.to_string(), devnode.to_string()];
        let output_alt = if use_pkexec {
            Command::new("pkexec")
                .arg(formatter)
                .args(&args_alt)
                .output()
                .context("run pkexec mkfs.exfat (alt)")?
        } else {
            Command::new(formatter)
                .args(&args_alt)
                .output()
                .context("run mkfs.exfat (alt)")?
        };
        if output_alt.status.success() {
            debug!("format: mkfs.exfat (alt -L) succeeded, waiting for udev");
            wait_for_udev_after_format();
            return Ok(());
        }
        let stderr_alt = String::from_utf8_lossy(&output_alt.stderr).to_string();
        let stdout_alt = String::from_utf8_lossy(&output_alt.stdout).to_string();
        error!(
            "format: mkfs.exfat (alt) failed devnode={} stdout={} stderr={}",
            devnode, stdout_alt.trim(), stderr_alt.trim()
        );
        return Err(anyhow::anyhow!("format failed: {}", stderr_alt.trim()));
    }

    Err(anyhow::anyhow!("format failed: {}", stderr.trim()))
}

/// After formatting a block device (e.g. whole disk with mkfs), udev and udisks2
/// need a moment before the device is seen as mountable. Settle udev and wait
/// so the first mount attempt is more likely to succeed.
fn wait_for_udev_after_format() {
    if which::which("udevadm").is_ok() {
        debug!("format: running udevadm settle");
        let _ = Command::new("udevadm").arg("settle").output();
    } else {
        debug!("format: udevadm not found, skipping settle");
    }
    debug!("format: sleeping 1200ms for udev/udisks2");
    std::thread::sleep(std::time::Duration::from_millis(1200));
}
