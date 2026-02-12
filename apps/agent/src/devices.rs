use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tracing::{info, warn};

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
    let output = Command::new("lsblk")
        .args([
            "-J",
            "-o",
            "NAME,PATH,SIZE,MODEL,RM,TRAN,HOTPLUG,TYPE,FSTYPE,MOUNTPOINTS",
        ])
        .output()
        .context("run lsblk")?;
    if !output.status.success() {
        warn!("device scan: lsblk returned non-zero status: {:?}", output.status.code());
        return Err(anyhow::anyhow!("lsblk failed"));
    }
    let parsed: LsblkOutput = serde_json::from_slice(&output.stdout)
        .context("parse lsblk output")?;
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
        info!(
            "device: path={} size={} model={}",
            device.path, device.size, model
        );
        for part in &device.partitions {
            let mounts = if part.mountpoints.is_empty() {
                "unmounted".to_string()
            } else {
                part.mountpoints.join(", ")
            };
            info!("device:  partition={} size={} mounts={}", part.path, part.size, mounts);
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
        return Err(anyhow::anyhow!("lsblk failed"));
    }
    let parsed: LsblkOutput =
        serde_json::from_slice(&output.stdout).context("parse lsblk output")?;
    for dev in parsed.blockdevices {
        if let Some(found) = find_mount_in_device(&dev, devnode) {
            return Ok(found);
        }
    }
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
    info!("mount: request devnode={}", devnode);
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
        warn!(
            "mount: udisksctl failed (attempt {}/3) status {:?} stderr={}",
            attempt,
            output.status.code(),
            stderr.trim()
        );
        if attempt < 3 && stderr.contains("not a mountable filesystem") {
            std::thread::sleep(std::time::Duration::from_millis(500));
            continue;
        }
        return Err(anyhow::anyhow!("mount failed: {}", stderr.trim()));
    }
    Err(anyhow::anyhow!("mount failed"))
}

pub fn format_partition_exfat(devnode: &str, label: Option<&str>) -> anyhow::Result<()> {
    info!("format: request devnode={} label_set={}", devnode, label.is_some());
    if udisksctl_supports_format() {
        ensure_udisksctl()?;
        let mut cmd = Command::new("udisksctl");
        cmd.args(["format", "-b", devnode, "--type", "exfat"]);
        if let Some(label) = label {
            if !label.trim().is_empty() {
                cmd.args(["--label", label.trim()]);
            }
        }
        let output = cmd.output().context("run udisksctl format")?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(
                "format: udisksctl failed with status {:?} stderr={}",
                output.status.code(),
                stderr.trim()
            );
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Err(anyhow::anyhow!("format failed: {}", stderr.trim()));
        }
        info!("format: success for devnode={} (udisksctl)", devnode);
        return Ok(());
    }

    // Fallback to mkfs.exfat via pkexec.
    if let Some(mountpoint) = find_mountpoint(devnode)? {
        info!("format: unmounting {} from {}", devnode, mountpoint);
        unmount_partition(devnode)?;
    }
    let formatter = find_exfat_formatter().context("mkfs.exfat not found")?;
    run_mkfs_exfat(&formatter, devnode, label)?;
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

fn unmount_partition(devnode: &str) -> anyhow::Result<()> {
    ensure_udisksctl()?;
    let output = Command::new("udisksctl")
        .args(["unmount", "-b", devnode])
        .output()
        .context("run udisksctl unmount")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(anyhow::anyhow!("unmount failed: {}", stderr.trim()));
    }
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

fn run_mkfs_exfat(formatter: &str, devnode: &str, label: Option<&str>) -> anyhow::Result<()> {
    let use_pkexec = which::which("pkexec").is_ok();
    let mut args: Vec<String> = Vec::new();
    if let Some(label) = label {
        if !label.trim().is_empty() {
            args.push("-n".to_string());
            args.push(label.trim().to_string());
        }
    }
    args.push(devnode.to_string());

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
        maybe_udevadm_settle();
        return Ok(());
    }

    // Retry with -L if -n is not supported.
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stderr.contains("invalid option") || stderr.contains("unknown option") {
        let mut args_alt: Vec<String> = Vec::new();
        if let Some(label) = label {
            if !label.trim().is_empty() {
                args_alt.push("-L".to_string());
                args_alt.push(label.trim().to_string());
            }
        }
        args_alt.push(devnode.to_string());
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
            maybe_udevadm_settle();
            return Ok(());
        }
        let stderr_alt = String::from_utf8_lossy(&output_alt.stderr).to_string();
        return Err(anyhow::anyhow!("format failed: {}", stderr_alt.trim()));
    }

    Err(anyhow::anyhow!("format failed: {}", stderr.trim()))
}

fn maybe_udevadm_settle() {
    if which::which("udevadm").is_ok() {
        let _ = Command::new("udevadm").arg("settle").output();
    }
}
