use crate::config::{ensure_marker_dir, sanitize_label};
use anyhow::Context;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveMarker {
    pub drive_id: String,
    pub created_epoch: u64,
    pub label: Option<String>,
    pub repository_id: Option<String>,
}

impl DriveMarker {
    pub fn new(label: Option<String>) -> Self {
        let mut random = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut random);
        let drive_id = hex::encode(Sha256::digest(random));
        Self {
            drive_id,
            created_epoch: now_epoch(),
            label,
            repository_id: None,
        }
    }
}

pub fn marker_path(root: &Path) -> PathBuf {
    root.join(".aegis").join("drive.json")
}

pub fn read_marker(root: &Path) -> anyhow::Result<Option<DriveMarker>> {
    let path = marker_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).context("read marker")?;
    let mut marker: DriveMarker = serde_json::from_str(&content).context("parse marker")?;
    // Sanitize label from disk (untrusted removable media).
    marker.label = marker.label.as_ref().and_then(|s| sanitize_label(s));
    Ok(Some(marker))
}

pub fn write_marker(root: &Path, marker: &DriveMarker) -> anyhow::Result<()> {
    let dir = ensure_marker_dir(root)?;
    let path = dir.join("drive.json");
    let content = serde_json::to_string_pretty(marker).context("serialize marker")?;
    fs::write(&path, content).context("write marker")?;
    Ok(())
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn marker_path_joins_under_aegis() {
        let p = marker_path(Path::new("/media/usb"));
        assert_eq!(p, Path::new("/media/usb/.aegis/drive.json"));
    }
}
