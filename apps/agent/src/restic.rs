use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use which::which;

#[derive(Debug, Clone)]
pub struct Restic {
    binary: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub id: String,
    pub time: String,
    pub hostname: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct BackupSummary {
    pub snapshot_id: Option<String>,
    pub data_added: Option<u64>,
    pub files_processed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotStats {
    pub total_size: u64,
    pub total_file_count: u64,
}

#[derive(Debug, Deserialize)]
struct ResticSummaryLine {
    message_type: Option<String>,
    snapshot_id: Option<String>,
    data_added: Option<u64>,
    total_files_processed: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ResticConfig {
    id: String,
}

impl Restic {
    pub fn resolve(override_path: Option<&str>) -> anyhow::Result<Self> {
        if let Some(path) = override_path {
            return Ok(Self { binary: PathBuf::from(path) });
        }

        if let Ok(exe) = std::env::current_exe() {
            if let Some(candidate) = exe
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.join("resources").join("restic").join("restic"))
            {
                if candidate.exists() {
                    return Ok(Self { binary: candidate });
                }
            }
        }

        let which_path = which("restic").context("restic not found in PATH")?;
        Ok(Self { binary: which_path })
    }

    pub async fn init_repo(&self, repo: &Path, passphrase: &str) -> anyhow::Result<String> {
        self.run_capture(repo, passphrase, &["init".to_string()]).await?;
        self.repository_id(repo, passphrase).await
    }

    pub async fn repository_id(&self, repo: &Path, passphrase: &str) -> anyhow::Result<String> {
        let output = self
            .run_capture(repo, passphrase, &["cat".to_string(), "config".to_string()])
            .await?;
        let config: ResticConfig = serde_json::from_slice(&output.stdout).context("parse restic config")?;
        Ok(config.id)
    }

    pub async fn backup(
        &self,
        repo: &Path,
        passphrase: &str,
        sources: &[PathBuf],
        includes: &[String],
        excludes: &[String],
    ) -> anyhow::Result<BackupSummary> {
        let mut args = vec!["backup".to_string(), "--json".to_string()];
        for include in includes {
            args.push("--include".to_string());
            args.push(include.clone());
        }
        for exclude in excludes {
            args.push("--exclude".to_string());
            args.push(exclude.clone());
        }
        for source in sources {
            args.push(source.to_string_lossy().to_string());
        }
        let output = self.run_capture(repo, passphrase, &args).await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut summary = BackupSummary { snapshot_id: None, data_added: None, files_processed: None };
        for line in stdout.lines() {
            if let Ok(parsed) = serde_json::from_str::<ResticSummaryLine>(line) {
                if parsed.message_type.as_deref() == Some("summary") {
                    summary.snapshot_id = parsed.snapshot_id;
                    summary.data_added = parsed.data_added;
                    summary.files_processed = parsed.total_files_processed;
                }
            }
        }
        Ok(summary)
    }

    pub async fn snapshots(&self, repo: &Path, passphrase: &str) -> anyhow::Result<Vec<SnapshotInfo>> {
        let output = self
            .run_capture(repo, passphrase, &["snapshots".to_string(), "--json".to_string()])
            .await?;
        let snapshots: Vec<SnapshotInfo> = serde_json::from_slice(&output.stdout).context("parse snapshots")?;
        Ok(snapshots)
    }

    pub async fn snapshot_stats(
        &self,
        repo: &Path,
        passphrase: &str,
        snapshot_id: &str,
    ) -> anyhow::Result<SnapshotStats> {
        let output = self
            .run_capture(
                repo,
                passphrase,
                &[
                    "stats".to_string(),
                    "--json".to_string(),
                    "--snapshot".to_string(),
                    snapshot_id.to_string(),
                ],
            )
            .await?;
        let stats: SnapshotStats = serde_json::from_slice(&output.stdout).context("parse stats")?;
        Ok(stats)
    }

    pub async fn check_quick(&self, repo: &Path, passphrase: &str) -> anyhow::Result<()> {
        self.run_capture(
            repo,
            passphrase,
            &[
                "check".to_string(),
                "--read-data-subset=1/20".to_string(),
            ],
        )
        .await?;
        Ok(())
    }

    pub async fn check_deep(&self, repo: &Path, passphrase: &str) -> anyhow::Result<()> {
        self.run_capture(repo, passphrase, &["check".to_string(), "--read-data".to_string()])
            .await?;
        Ok(())
    }

    pub async fn forget_prune(
        &self,
        repo: &Path,
        passphrase: &str,
        retention_args: &[String],
    ) -> anyhow::Result<()> {
        if retention_args.is_empty() {
            return Ok(());
        }
        let mut args = vec!["forget".to_string(), "--prune".to_string()];
        args.extend(retention_args.iter().cloned());
        self.run_capture(repo, passphrase, &args).await?;
        Ok(())
    }

    pub async fn restore(
        &self,
        repo: &Path,
        passphrase: &str,
        snapshot_id: &str,
        target: &Path,
        includes: &[String],
    ) -> anyhow::Result<()> {
        let mut args = vec![
            "restore".to_string(),
            snapshot_id.to_string(),
            "--target".to_string(),
            target.to_string_lossy().to_string(),
        ];
        for include in includes {
            args.push("--include".to_string());
            args.push(include.clone());
        }
        self.run_capture(repo, passphrase, &args).await?;
        Ok(())
    }

    async fn run_capture(
        &self,
        repo: &Path,
        passphrase: &str,
        args: &[String],
    ) -> anyhow::Result<std::process::Output> {
        let mut command = Command::new(&self.binary);
        command
            .arg("--repo")
            .arg(repo)
            .args(args)
            // Passphrase is provided via env to avoid CLI args and logs.
            .env("RESTIC_PASSWORD", passphrase)
            .env("RESTIC_PROGRESS_FPS", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = command.spawn().context("spawn restic")?.wait_with_output().await?;
        if !output.status.success() {
            return Err(anyhow!("restic failed"));
        }
        Ok(output)
    }

    #[allow(dead_code)]
    async fn run_capture_cancellable(
        &self,
        repo: &Path,
        passphrase: &str,
        args: &[String],
        cancel: CancellationToken,
    ) -> anyhow::Result<std::process::Output> {
        let mut command = Command::new(&self.binary);
        command
            .arg("--repo")
            .arg(repo)
            .args(args)
            .env("RESTIC_PASSWORD", passphrase)
            .env("RESTIC_PROGRESS_FPS", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().context("spawn restic")?;
        let mut stdout = child.stdout.take().context("capture stdout")?;
        let mut stderr = child.stderr.take().context("capture stderr")?;

        let stdout_task = tokio::spawn(async move {
            let mut buffer = Vec::new();
            stdout.read_to_end(&mut buffer).await?;
            Ok::<Vec<u8>, std::io::Error>(buffer)
        });
        let stderr_task = tokio::spawn(async move {
            let mut buffer = Vec::new();
            stderr.read_to_end(&mut buffer).await?;
            Ok::<Vec<u8>, std::io::Error>(buffer)
        });

        tokio::select! {
            status = child.wait() => {
                let status = status?;
                let stdout = stdout_task.await.context("join stdout task")??;
                let stderr = stderr_task.await.context("join stderr task")??;
                let output = std::process::Output { status, stdout, stderr };
                if !output.status.success() {
                    return Err(anyhow!("restic failed"));
                }
                Ok(output)
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                Err(anyhow!("restic cancelled"))
            }
        }
    }
}
