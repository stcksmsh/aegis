use crate::retention::RetentionPolicy;
use anyhow::Context;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Max length for in-app drive/source labels (stored on drive and in config). Prevents abuse from untrusted marker files.
pub const LABEL_MAX_LEN: usize = 512;

/// Sanitize a label from user input or from disk (untrusted): trim, remove control chars, limit length. Returns None if empty after sanitize.
pub fn sanitize_label(s: &str) -> Option<String> {
    let t = s.trim();
    let out: String = t
        .chars()
        .filter(|c| !c.is_control())
        .take(LABEL_MAX_LEN)
        .collect();
    let out = out.trim();
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSource {
    pub label: String,
    /// Absolute or user-relative path. Never display this in logs/UI.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedDrive {
    pub drive_id: String,
    pub label: Option<String>,
    /// Repository path relative to the mount root.
    pub repository_path: String,
    pub repository_id: Option<String>,
    pub last_seen_epoch: Option<u64>,
    /// When a backup to this drive last completed successfully.
    #[serde(default)]
    pub last_backup_epoch: Option<u64>,
    /// Snapshot ID of that backup (for display/linking).
    #[serde(default)]
    pub last_backup_snapshot_id: Option<String>,
    /// If set, backup only these sources to this drive; otherwise use global backup_sources.
    #[serde(default)]
    pub backup_sources: Option<Vec<BackupSource>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub trusted_drives: HashMap<String, TrustedDrive>,
    pub backup_sources: Vec<BackupSource>,
    #[serde(default)]
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub retention: RetentionPolicy,
    pub quick_verify: bool,
    pub deep_verify: bool,
    pub auto_backup_on_insert: bool,
    pub remember_passphrase: bool,
    pub paranoid_mode: bool,
    /// Optional override for the restic binary path.
    pub restic_path: Option<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            trusted_drives: HashMap::new(),
            backup_sources: vec![
                BackupSource {
                    label: "Documents".to_string(),
                    path: "~/Documents".to_string(),
                },
                BackupSource {
                    label: "Pictures".to_string(),
                    path: "~/Pictures".to_string(),
                },
                BackupSource {
                    label: "Desktop".to_string(),
                    path: "~/Desktop".to_string(),
                },
            ],
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            retention: RetentionPolicy::default(),
            quick_verify: true,
            deep_verify: false,
            auto_backup_on_insert: true,
            remember_passphrase: true,
            paranoid_mode: false,
            restic_path: None,
        }
    }
}

impl AgentConfig {
    pub fn load() -> anyhow::Result<Self> {
        let path = Self::config_path()?;
        if !path.exists() {
            let config = Self::default();
            config.save()?;
            return Ok(config);
        }
        let content = fs::read_to_string(&path).context("read config")?;
        let mut config: AgentConfig = serde_json::from_str(&content).context("parse config")?;
        for drive in config.trusted_drives.values_mut() {
            if let Some(l) = &drive.label {
                drive.label = sanitize_label(l);
            }
            if let Some(ref mut sources) = drive.backup_sources {
                for src in sources.iter_mut() {
                    src.label = sanitize_label(&src.label).unwrap_or_else(|| "Source".to_string());
                }
            }
        }
        for src in &mut config.backup_sources {
            src.label = sanitize_label(&src.label).unwrap_or_else(|| "Source".to_string());
        }
        config.enforce_security_invariants();
        Ok(config)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path()?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).context("create config dir")?;
        }
        let content = serde_json::to_string_pretty(self).context("serialize config")?;
        fs::write(&path, content).context("write config")?;
        Ok(())
    }

    pub fn config_path() -> anyhow::Result<PathBuf> {
        let proj = ProjectDirs::from("com", "aegis", "Aegis").context("resolve config dir")?;
        Ok(proj.config_dir().join("config.json"))
    }

    pub fn update_last_seen(&mut self, drive_id: &str) {
        if let Some(drive) = self.trusted_drives.get_mut(drive_id) {
            drive.last_seen_epoch = Some(now_epoch());
        }
    }

    /// Record that a backup to this drive completed (for per-drive "last backup" in UI).
    pub fn update_last_backup(&mut self, drive_id: &str, epoch: u64, snapshot_id: Option<String>) {
        if let Some(drive) = self.trusted_drives.get_mut(drive_id) {
            drive.last_backup_epoch = Some(epoch);
            drive.last_backup_snapshot_id = snapshot_id;
        }
    }

    pub fn enforce_security_invariants(&mut self) {
        if self.paranoid_mode {
            self.remember_passphrase = false;
        }
    }

    pub fn is_first_run(&self) -> bool {
        self.trusted_drives.is_empty()
    }

    pub fn repository_path_for(&self, drive_id: &str, mount_root: &Path) -> Option<PathBuf> {
        let drive = self.trusted_drives.get(drive_id)?;
        Some(mount_root.join(&drive.repository_path))
    }

    /// Sources to back up for this drive: drive-specific if set, else global.
    pub fn backup_sources_for_drive(&self, drive_id: &str) -> Vec<BackupSource> {
        self.trusted_drives
            .get(drive_id)
            .and_then(|d| d.backup_sources.clone())
            .unwrap_or_else(|| self.backup_sources.clone())
    }

    /// True if another trusted drive already has this label (case-insensitive).
    pub fn label_exists(&self, label: &str, exclude_drive_id: Option<&str>) -> bool {
        let label_lower = label.trim().to_lowercase();
        if label_lower.is_empty() {
            return false;
        }
        for (id, drive) in &self.trusted_drives {
            if exclude_drive_id.map(|e| e == id.as_str()).unwrap_or(false) {
                continue;
            }
            if let Some(ref l) = drive.label {
                if l.trim().to_lowercase() == label_lower {
                    return true;
                }
            }
        }
        false
    }
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
    fn sanitize_label_empty_and_whitespace() {
        assert_eq!(sanitize_label(""), None);
        assert_eq!(sanitize_label("   "), None);
        assert_eq!(sanitize_label("\t\n"), None);
    }

    #[test]
    fn sanitize_label_trim() {
        assert_eq!(sanitize_label("  my drive  "), Some("my drive".to_string()));
    }

    #[test]
    fn sanitize_label_strips_control_chars() {
        assert_eq!(sanitize_label("a\u{00}b\u{1f}c"), Some("abc".to_string()));
        assert_eq!(sanitize_label("ok\u{0c}"), Some("ok".to_string()));
    }

    #[test]
    fn sanitize_label_caps_length() {
        let long = "a".repeat(LABEL_MAX_LEN + 100);
        let out = sanitize_label(&long).unwrap();
        assert_eq!(out.len(), LABEL_MAX_LEN);
        assert!(out.chars().all(|c| c == 'a'));
    }

    #[test]
    fn sanitize_label_unicode_ok() {
        assert_eq!(sanitize_label("ドライブ"), Some("ドライブ".to_string()));
    }

    #[test]
    fn repository_path_for_unknown_drive() {
        let config = AgentConfig::default();
        assert_eq!(
            config.repository_path_for("unknown", Path::new("/media/drive")),
            None
        );
    }

    #[test]
    fn repository_path_for_known_drive() {
        let mut config = AgentConfig::default();
        config.trusted_drives.insert(
            "drive-1".to_string(),
            TrustedDrive {
                drive_id: "drive-1".to_string(),
                label: Some("USB".to_string()),
                repository_path: "backup".to_string(),
                repository_id: None,
                last_seen_epoch: None,
                last_backup_epoch: None,
                last_backup_snapshot_id: None,
                backup_sources: None,
            },
        );
        let path = config
            .repository_path_for("drive-1", Path::new("/media/usb"))
            .expect("should be some");
        assert_eq!(path, Path::new("/media/usb/backup"));
    }
}

pub fn ensure_marker_dir(root: &Path) -> anyhow::Result<PathBuf> {
    let path = root.join(".aegis");
    fs::create_dir_all(&path).context("create marker dir")?;
    Ok(path)
}
