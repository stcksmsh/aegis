use crate::restic::Restic;
use std::path::Path;

pub async fn quick_verify(restic: &Restic, repo: &Path, passphrase: &str) -> anyhow::Result<()> {
    restic.check_quick(repo, passphrase).await
}

pub async fn deep_verify(restic: &Restic, repo: &Path, passphrase: &str) -> anyhow::Result<()> {
    restic.check_deep(repo, passphrase).await
}
