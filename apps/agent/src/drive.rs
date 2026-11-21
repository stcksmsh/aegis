//! On-disk drive format.
//!
//! Format 2 (Aegis 1.x): `.aegis/drive.json` lists instance ids; each instance has
//! `.aegis/instances/<id>/instance.json` pointing at its repo at `.aegis/instances/<id>/repo`.
//!
//! Everything on the drive is untrusted: ids and paths are validated, labels sanitized, and
//! unknown fields are preserved on write so newer 1.x versions can add fields safely.

use crate::config::{ensure_marker_dir, sanitize_label};
use anyhow::{bail, Context};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Newest drive format this build can read and write.
pub const DRIVE_FORMAT: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveMarker {
    pub drive_format: u32,
    pub drive_id: String,
    pub created_epoch: u64,
    pub label: Option<String>,
    /// Ids of the backups (instances) on this drive.
    #[serde(default)]
    pub instances: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl DriveMarker {
    pub fn new(label: Option<String>) -> Self {
        let mut random = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut random);
        Self {
            drive_format: DRIVE_FORMAT,
            drive_id: hex::encode(Sha256::digest(random)),
            created_epoch: now_epoch(),
            label,
            instances: Vec::new(),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceMeta {
    pub instance_id: String,
    /// Repo path relative to the drive root, `/`-separated.
    pub repo_path: String,
    pub created_epoch: u64,
    /// Optional public hint shown before unlocking (e.g. "Office").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Reserved for encrypted labels (not used yet).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_enc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_kdf: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_nonce: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl InstanceMeta {
    fn new(instance_id: String, repo_path: String) -> Self {
        Self {
            instance_id,
            repo_path,
            created_epoch: now_epoch(),
            hint: None,
            label_enc: None,
            label_kdf: None,
            label_nonce: None,
            extra: Map::new(),
        }
    }
}

pub fn marker_path(root: &Path) -> PathBuf {
    root.join(".aegis").join("drive.json")
}

fn instance_dir(root: &Path, id: &str) -> PathBuf {
    root.join(".aegis").join("instances").join(id)
}

fn new_instance_repo_path(id: &str) -> String {
    format!(".aegis/instances/{id}/repo")
}

/// Ids come from untrusted media and become path components: hex only, bounded length.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Reads the marker. Labels are sanitized; ids validated.
pub fn read_marker(root: &Path) -> anyhow::Result<Option<DriveMarker>> {
    let path = marker_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).context("read marker")?;
    let mut marker: DriveMarker = serde_json::from_str(&content).context("parse marker")?;
    marker.label = marker.label.as_ref().and_then(|s| sanitize_label(s));
    if !valid_id(&marker.drive_id) {
        bail!("invalid drive id in marker");
    }
    marker.instances.retain(|id| valid_id(id));
    Ok(Some(marker))
}

/// Writes the marker atomically. Refuses to write a format this build doesn't understand.
pub fn write_marker(root: &Path, marker: &DriveMarker) -> anyhow::Result<()> {
    ensure_writable_format(marker)?;
    let dir = ensure_marker_dir(root)?;
    write_json_atomic(&dir.join("drive.json"), marker)
}

pub fn ensure_writable_format(marker: &DriveMarker) -> anyhow::Result<()> {
    if marker.drive_format > DRIVE_FORMAT {
        bail!("This drive was set up by a newer version of Aegis. Please update Aegis.");
    }
    Ok(())
}

pub fn read_instance(root: &Path, id: &str) -> anyhow::Result<InstanceMeta> {
    if !valid_id(id) {
        bail!("invalid instance id");
    }
    let path = instance_dir(root, id).join("instance.json");
    let content = fs::read_to_string(&path).context("read instance")?;
    let mut meta: InstanceMeta = serde_json::from_str(&content).context("parse instance")?;
    if meta.instance_id != id || meta.repo_path != new_instance_repo_path(id) {
        bail!("invalid instance metadata");
    }
    meta.hint = meta.hint.as_ref().and_then(|s| sanitize_label(s));
    Ok(meta)
}

fn write_instance(root: &Path, meta: &InstanceMeta) -> anyhow::Result<()> {
    let dir = instance_dir(root, &meta.instance_id);
    fs::create_dir_all(&dir).context("create instance dir")?;
    write_json_atomic(&dir.join("instance.json"), meta)
}

/// Creates a new, empty instance directory and metadata. Returns (meta, absolute repo path).
/// The caller initializes the repo, then calls [`register_instance`].
pub fn create_instance(root: &Path) -> anyhow::Result<(InstanceMeta, PathBuf)> {
    let mut random = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut random);
    let id = hex::encode(random);
    let meta = InstanceMeta::new(id.clone(), new_instance_repo_path(&id));
    let repo = root.join(&meta.repo_path);
    fs::create_dir_all(&repo).context("create instance repo dir")?;
    write_instance(root, &meta)?;
    Ok((meta, repo))
}

/// Adds an instance id to drive.json (atomic). Until this runs the instance is invisible.
pub fn register_instance(root: &Path, id: &str) -> anyhow::Result<DriveMarker> {
    let mut marker = read_marker(root)?.context("drive marker missing")?;
    if !marker.instances.iter().any(|i| i == id) {
        marker.instances.push(id.to_string());
    }
    write_marker(root, &marker)?;
    Ok(marker)
}

/// Removes a backup from the drive: first from the marker (so a half-finished delete only leaves
/// unused files behind), then its folder with the repository.
pub fn delete_instance(root: &Path, id: &str) -> anyhow::Result<()> {
    anyhow::ensure!(valid_id(id), "invalid backup id");
    let mut marker = read_marker(root)?.context("drive marker missing")?;
    marker.instances.retain(|i| i != id);
    write_marker(root, &marker)?;
    let dir = instance_dir(root, id);
    if dir.exists() {
        fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
    }
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    let content = serde_json::to_string_pretty(value).context("serialize")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))?;
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

    fn tmp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aegis-drive-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn marker_path_joins_under_aegis() {
        let p = marker_path(Path::new("/media/usb"));
        assert_eq!(p, Path::new("/media/usb/.aegis/drive.json"));
    }

    #[test]
    fn newer_format_is_never_written() {
        let root = tmp_root("newer");
        let mut m = DriveMarker::new(None);
        m.drive_format = DRIVE_FORMAT + 1;
        assert!(write_marker(&root, &m).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_and_register_instance() {
        let root = tmp_root("create");
        write_marker(&root, &DriveMarker::new(None)).unwrap();
        let (meta, repo) = create_instance(&root).unwrap();
        assert!(repo.ends_with(format!("instances/{}/repo", meta.instance_id)));
        let m = register_instance(&root, &meta.instance_id).unwrap();
        assert_eq!(m.instances, vec![meta.instance_id.clone()]);
        assert_eq!(
            read_instance(&root, &meta.instance_id).unwrap().repo_path,
            meta.repo_path
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_instance_keeps_the_other_backup() {
        let root = tmp_root("delete");
        write_marker(&root, &DriveMarker::new(None)).unwrap();
        let (a, _) = create_instance(&root).unwrap();
        let (b, _) = create_instance(&root).unwrap();
        register_instance(&root, &a.instance_id).unwrap();
        register_instance(&root, &b.instance_id).unwrap();
        delete_instance(&root, &a.instance_id).unwrap();
        let m = read_marker(&root).unwrap().unwrap();
        assert_eq!(m.instances, vec![b.instance_id.clone()]);
        assert!(!instance_dir(&root, &a.instance_id).exists());
        assert!(read_instance(&root, &b.instance_id).is_ok());
        assert!(delete_instance(&root, "../x").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_hostile_ids_and_paths() {
        assert!(!valid_id("../etc"));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(65)));
        assert!(valid_id("0123abcdef"));
        let root = tmp_root("hostile");
        let dir = instance_dir(&root, "ab");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("instance.json"),
            r#"{"instance_id":"ab","repo_path":"/etc","created_epoch":0}"#,
        )
        .unwrap();
        assert!(read_instance(&root, "ab").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
