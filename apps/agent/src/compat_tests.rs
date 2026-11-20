//! Compatibility contract (COMPATIBILITY.md): drives written by every released Aegis
//! (committed fixtures in tests/fixtures) must open, back up and restore with this build.

use crate::drive::{read_instance, read_marker, DRIVE_FORMAT};
use crate::restic::Restic;
use std::fs;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const PASS: &str = "fixture-passphrase";

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &dest);
        } else {
            fs::copy(entry.path(), dest).unwrap();
        }
    }
}

/// Fresh writable copy of a fixture drive.
fn fixture(name: &str) -> PathBuf {
    let src = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name);
    let dst = std::env::temp_dir().join(format!("aegis-compat-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dst);
    copy_dir(&src, &dst);
    dst
}

/// Opens the drive, then: restore the fixture's file, back up again, see both snapshots.
async fn open_backup_restore(root: &Path, expected_repo: &str, hello: &str) {
    let marker = read_marker(root).unwrap().unwrap();
    assert_eq!(marker.drive_format, DRIVE_FORMAT);
    assert_eq!(marker.instances.len(), 1);
    let meta = read_instance(root, &marker.instances[0]).unwrap();
    assert!(
        meta.repo_path.starts_with(expected_repo),
        "{}",
        meta.repo_path
    );

    let Some(restic) = Restic::for_test("compat") else {
        eprintln!("skipping restic part: no restic binary (run scripts/fetch-restic.sh)");
        return;
    };
    let repo = root.join(&meta.repo_path);
    let snaps = restic.snapshots(&repo, PASS).await.unwrap();
    assert_eq!(snaps.len(), 1);

    let target = root.join("restored");
    restic
        .restore_cancellable(
            &repo,
            PASS,
            &snaps[0].id,
            &target,
            &[],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let file = target
        .join(snaps[0].paths[0].rsplit('/').next().unwrap())
        .join("hello.txt");
    assert_eq!(fs::read_to_string(file).unwrap(), hello);

    let src = root.join("new-src");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("new.txt"), "new").unwrap();
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    restic
        .backup_with_progress(&repo, PASS, &[src], &[], &[], tx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(restic.snapshots(&repo, PASS).await.unwrap().len(), 2);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn format2_drive_from_1_0_works() {
    let root = fixture("drive-format2");
    open_backup_restore(&root, ".aegis/instances/", "hello from v1.0\n").await;
}
