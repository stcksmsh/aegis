//! Restore kit on the backup drive: `AEGIS-RESTORE/` with restore scripts for every OS,
//! README (EN + SR), and the restic programs, so backups can be restored without Aegis.
//! Refreshed after each successful backup when outdated.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;

/// Bump when the scripts or README change, so drives get the new version.
pub const KIT_VERSION: u32 = 1;
pub const KIT_DIR: &str = "AEGIS-RESTORE";

/// (file name, content, Windows line endings)
const TEXT_FILES: &[(&str, &str, bool)] = &[
    ("README.txt", include_str!("../kit/README.txt"), true),
    ("PROCITAJ.txt", include_str!("../kit/PROCITAJ.txt"), true),
    (
        "restore-windows.bat",
        include_str!("../kit/restore-windows.bat"),
        false,
    ),
    (
        "restore-windows.ps1",
        include_str!("../kit/restore-windows.ps1"),
        true,
    ),
    (
        "restore-mac.command",
        include_str!("../kit/restore.sh"),
        false,
    ),
    ("restore-linux.sh", include_str!("../kit/restore.sh"), false),
];

#[derive(Debug, Serialize, Deserialize)]
struct KitInfo {
    kit_version: u32,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Writes or updates the kit on the drive at `root`. `assets` is the folder with the restic
/// archives + SHA256SUMS bundled with the app (None when running without them, e.g. dev builds).
/// Returns true if anything was written.
pub fn refresh(root: &Path, assets: Option<&Path>) -> anyhow::Result<bool> {
    let dir = root.join(KIT_DIR);
    let info_path = dir.join("kit.json");
    let installed = fs::read_to_string(&info_path)
        .ok()
        .and_then(|s| serde_json::from_str::<KitInfo>(&s).ok());
    if installed
        .as_ref()
        .is_some_and(|i| i.kit_version > KIT_VERSION)
    {
        return Ok(false); // written by a newer Aegis; never downgrade
    }
    let assets = assets.filter(|a| a.join("SHA256SUMS").is_file());
    let sums_differ = assets.is_some_and(|a| {
        fs::read(a.join("SHA256SUMS")).ok() != fs::read(dir.join("restic").join("SHA256SUMS")).ok()
    });
    if installed
        .as_ref()
        .is_some_and(|i| i.kit_version == KIT_VERSION)
        && !sums_differ
    {
        return Ok(false);
    }

    fs::create_dir_all(&dir).context("create kit dir")?;
    for (name, content, crlf) in TEXT_FILES {
        let text = if *crlf {
            content.replace('\n', "\r\n")
        } else {
            content.to_string()
        };
        write_atomic(&dir.join(name), text.as_bytes())?;
        #[cfg(unix)]
        if name.ends_with(".sh") || name.ends_with(".command") {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir.join(name), fs::Permissions::from_mode(0o755));
        }
    }

    if let Some(assets) = assets.filter(|_| sums_differ) {
        let restic_dir = dir.join("restic");
        fs::create_dir_all(&restic_dir).context("create kit restic dir")?;
        // Drop programs from an older restic version.
        for entry in fs::read_dir(&restic_dir).context("list kit")?.flatten() {
            let _ = fs::remove_file(entry.path());
        }
        // SHA256SUMS last: its presence means the programs next to it are complete.
        let mut names: Vec<_> = fs::read_dir(assets)
            .context("list bundled kit")?
            .flatten()
            .map(|e| e.file_name())
            .filter(|n| n != "SHA256SUMS")
            .collect();
        names.push("SHA256SUMS".into());
        for name in names {
            let bytes = fs::read(assets.join(&name)).context("read bundled kit file")?;
            write_atomic(&restic_dir.join(&name), &bytes)?;
        }
    }

    let mut info = installed.unwrap_or(KitInfo {
        kit_version: KIT_VERSION,
        extra: Map::new(),
    });
    info.kit_version = KIT_VERSION;
    let json = serde_json::to_string_pretty(&info).context("serialize kit info")?;
    write_atomic(&info_path, json.as_bytes())?;
    Ok(true)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let tmp = path.with_extension("part");
    fs::write(&tmp, bytes)
        .and_then(|_| fs::rename(&tmp, path))
        .inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })
        .with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_kit_once_and_refreshes_when_restic_changes() {
        let base = std::env::temp_dir().join(format!("aegis-kit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (root, assets) = (base.join("drive"), base.join("assets"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("restic_1_linux_amd64.bz2"), "old").unwrap();
        fs::write(assets.join("SHA256SUMS"), "v1").unwrap();

        assert!(refresh(&root, Some(&assets)).unwrap());
        let kit = root.join(KIT_DIR);
        assert!(kit.join("README.txt").is_file());
        assert!(kit.join("PROCITAJ.txt").is_file());
        assert!(kit.join("restore-mac.command").is_file());
        assert!(kit.join("restic/restic_1_linux_amd64.bz2").is_file());
        assert!(
            !refresh(&root, Some(&assets)).unwrap(),
            "up to date: no rewrite"
        );

        fs::remove_file(assets.join("restic_1_linux_amd64.bz2")).unwrap();
        fs::write(assets.join("restic_2_linux_amd64.bz2"), "new").unwrap();
        fs::write(assets.join("SHA256SUMS"), "v2").unwrap();
        assert!(refresh(&root, Some(&assets)).unwrap());
        assert!(!kit.join("restic/restic_1_linux_amd64.bz2").exists());
        assert!(kit.join("restic/restic_2_linux_amd64.bz2").is_file());

        // A kit from a newer Aegis is left alone.
        fs::write(kit.join("kit.json"), r#"{"kit_version": 99}"#).unwrap();
        assert!(!refresh(&root, None).unwrap());
        let _ = fs::remove_dir_all(&base);
    }
}
