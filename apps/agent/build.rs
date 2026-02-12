use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest_dir
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir.clone());

    let source = env::var("RESTIC_BUNDLE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("resources").join("restic").join("restic"));

    if !source.exists() {
        println!("cargo:warning=restic bundle not found at {}", source.display());
        return;
    }

    let target_dir = env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("target"));

    let dest_dir = target_dir.join("resources").join("restic");
    if let Err(err) = fs::create_dir_all(&dest_dir) {
        println!("cargo:warning=failed to create restic resources dir: {}", err);
        return;
    }

    let dest = dest_dir.join("restic");
    if let Err(err) = fs::copy(&source, &dest) {
        println!("cargo:warning=failed to copy restic: {}", err);
        return;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
    }

    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-env-changed=RESTIC_BUNDLE_PATH");
}
