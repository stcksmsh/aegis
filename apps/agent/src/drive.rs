//! On-disk drive format.
//!
//! Format 1 (Aegis 0.x): `.aegis/drive.json` + one restic repo at `.aegis/repo`.
//! Format 2 (Aegis 1.x): `.aegis/drive.json` lists instance ids; each instance has
//! `.aegis/instances/<id>/instance.json` pointing at its repo. New instances keep their repo at
//! `.aegis/instances/<id>/repo`; a migrated format-1 repo stays at `.aegis/repo` (never moved, so
//! migration can't lose data and older Aegis versions keep working with the drive).
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
/// Repo location of a format-1 drive, relative to the drive root.
pub const LEGACY_REPO: &str = ".aegis/repo";

fn format_one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveMarker {
    /// Missing in format-1 markers.
    #[serde(default = "format_one")]
    pub drive_format: u32,
    pub drive_id: String,
    pub created_epoch: u64,
    pub label: Option<String>,
    /// Format 1 only: id of the single repo. Kept so older Aegis versions still work.
    #[serde(default)]
    pub repository_id: Option<String>,
    /// Format 2: ids of the instances on this drive.
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
            repository_id: None,
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

/// Only the two layouts Aegis itself writes are accepted.
fn valid_repo_path(id: &str, repo_path: &str) -> bool {
    repo_path == LEGACY_REPO || repo_path == new_instance_repo_path(id)
}

/// Reads the marker as-is (any format). Labels are sanitized; ids validated.
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
    if meta.instance_id != id || !valid_repo_path(id, &meta.repo_path) {
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

/// Reads the marker and upgrades a format-1 drive to format 2 in place.
///
/// Safe to re-run after a crash at any point: the legacy instance id is the drive id
/// (deterministic), each file is written atomically, and drive.json is written last.
pub fn open_or_migrate(root: &Path) -> anyhow::Result<Option<DriveMarker>> {
    let Some(mut marker) = read_marker(root)? else {
        return Ok(None);
    };
    if marker.drive_format >= 2 {
        return Ok(Some(marker));
    }
    let id = marker.drive_id.clone();
    if root.join(LEGACY_REPO).join("config").exists() {
        if read_instance(root, &id).is_err() {
            write_instance(
                root,
                &InstanceMeta::new(id.clone(), LEGACY_REPO.to_string()),
            )?;
        }
        if !marker.instances.contains(&id) {
            marker.instances.push(id);
        }
    }
    marker.drive_format = 2;
    write_marker(root, &marker)?;
    Ok(Some(marker))
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
    marker.drive_format = marker.drive_format.max(2);
    write_marker(root, &marker)?;
    Ok(marker)
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

    fn write_v1_drive(root: &Path, with_repo: bool) -> String {
        let id = "ab".repeat(32);
        fs::create_dir_all(root.join(".aegis")).unwrap();
        fs::write(
            marker_path(root),
            format!(
                r#"{{"drive_id":"{id}","created_epoch":1,"label":"Old","repository_id":"r1","future":42}}"#
            ),
        )
        .unwrap();
        if with_repo {
            fs::create_dir_all(root.join(LEGACY_REPO)).unwrap();
            fs::write(root.join(LEGACY_REPO).join("config"), "x").unwrap();
        }
        id
    }

    #[test]
    fn marker_path_joins_under_aegis() {
        let p = marker_path(Path::new("/media/usb"));
        assert_eq!(p, Path::new("/media/usb/.aegis/drive.json"));
    }

    #[test]
    fn migrates_v1_in_place_and_is_idempotent() {
        let root = tmp_root("migrate");
        let id = write_v1_drive(&root, true);

        let m = open_or_migrate(&root).unwrap().unwrap();
        assert_eq!(m.drive_format, 2);
        assert_eq!(m.instances, vec![id.clone()]);
        assert_eq!(m.extra.get("future"), Some(&Value::from(42)));
        let inst = read_instance(&root, &id).unwrap();
        assert_eq!(inst.repo_path, LEGACY_REPO);
        assert!(root.join(LEGACY_REPO).join("config").exists());

        let again = open_or_migrate(&root).unwrap().unwrap();
        assert_eq!(again.instances, vec![id]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_resumes_after_crash_before_marker_write() {
        let root = tmp_root("crash");
        let id = write_v1_drive(&root, true);
        // Crash after instance.json was written but before drive.json was updated.
        write_instance(&root, &InstanceMeta::new(id.clone(), LEGACY_REPO.into())).unwrap();
        let tmp = marker_path(&root).with_extension("json.tmp");
        fs::write(&tmp, "garbage").unwrap();

        let m = open_or_migrate(&root).unwrap().unwrap();
        assert_eq!(m.drive_format, 2);
        assert_eq!(m.instances, vec![id]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_without_repo_has_no_instances() {
        let root = tmp_root("norepo");
        write_v1_drive(&root, false);
        let m = open_or_migrate(&root).unwrap().unwrap();
        assert_eq!(m.drive_format, 2);
        assert!(m.instances.is_empty());
        let _ = fs::remove_dir_all(&root);
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
    fn rejects_hostile_ids_and_paths() {
        assert!(!valid_id("../etc"));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(65)));
        assert!(valid_id("0123abcdef"));
        assert!(!valid_repo_path("ab", "../../home"));
        assert!(!valid_repo_path("ab", ".aegis/instances/cd/repo"));
        assert!(valid_repo_path("ab", ".aegis/instances/ab/repo"));

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
