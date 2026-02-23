use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info};
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
pub(crate) struct ResticSummaryLine {
    message_type: Option<String>,
    snapshot_id: Option<String>,
    data_added: Option<u64>,
    total_files_processed: Option<u64>,
}

/// Progress update from a single restic --json status line.
#[derive(Debug, Clone)]
pub struct BackupProgressReport {
    pub percent_done: f64,
    pub files_done: u64,
    pub total_files: u64,
    pub bytes_done: u64,
    pub total_bytes: u64,
    #[allow(dead_code)]
    pub current_file: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ResticStatusLine {
    message_type: Option<String>,
    #[serde(default)]
    percent_done: Option<f64>,
    #[serde(default)]
    total_files: Option<u64>,
    #[serde(default)]
    files_done: Option<u64>,
    #[serde(default)]
    total_bytes: Option<u64>,
    #[serde(default)]
    bytes_done: Option<u64>,
    current_file: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ResticConfig {
    id: String,
}

impl Restic {
    pub fn resolve(override_path: Option<&str>) -> anyhow::Result<Self> {
        if let Some(path) = override_path {
            return Ok(Self {
                binary: PathBuf::from(path),
            });
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
        debug!("restic: init_repo repo={}", repo.display());
        self.run_capture(repo, passphrase, &["init".to_string()])
            .await?;
        self.repository_id(repo, passphrase).await
    }

    pub async fn repository_id(&self, repo: &Path, passphrase: &str) -> anyhow::Result<String> {
        debug!("restic: repository_id repo={}", repo.display());
        let output = self
            .run_capture(repo, passphrase, &["cat".to_string(), "config".to_string()])
            .await?;
        let config: ResticConfig =
            serde_json::from_slice(&output.stdout).context("parse restic config")?;
        Ok(config.id)
    }

    #[allow(dead_code)]
    pub async fn backup(
        &self,
        repo: &Path,
        passphrase: &str,
        sources: &[PathBuf],
        includes: &[String],
        excludes: &[String],
    ) -> anyhow::Result<BackupSummary> {
        debug!(
            "restic: backup repo={} sources_count={}",
            repo.display(),
            sources.len()
        );
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
        let mut summary = BackupSummary {
            snapshot_id: None,
            data_added: None,
            files_processed: None,
        };
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

    /// Run backup while streaming progress to `progress_tx`. If `cancel` is triggered (e.g. drive unplugged), the restic process is killed and an error is returned.
    #[allow(clippy::too_many_arguments)]
    pub async fn backup_with_progress(
        &self,
        repo: &Path,
        passphrase: &str,
        sources: &[PathBuf],
        includes: &[String],
        excludes: &[String],
        progress_tx: mpsc::Sender<BackupProgressReport>,
        cancel: CancellationToken,
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

        let mut command = Command::new(&self.binary);
        command
            .arg("--repo")
            .arg(repo)
            .args(&args)
            .env("RESTIC_PASSWORD", passphrase)
            .env("RESTIC_PROGRESS_FPS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().context("spawn restic")?;
        let stdout = child.stdout.take().context("stdout")?;
        let stderr = child.stderr.take().context("stderr")?;

        let stderr_handle = tokio::spawn(async move {
            let mut v = Vec::new();
            let _ = AsyncReadExt::read_to_end(&mut tokio::io::BufReader::new(stderr), &mut v).await;
            v
        });

        let mut summary = BackupSummary {
            snapshot_id: None,
            data_added: None,
            files_processed: None,
        };
        let mut last_log_percent: f64 = -1.0;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    let _ = stderr_handle.await;
                    return Err(anyhow!("backup cancelled (drive disconnected)"));
                }
                result = reader.read_line(&mut line) => {
                    let n = result?;
                    if n == 0 {
                        break;
                    }
                }
            }
            let line_trim = line.trim_end_matches('\n').trim();
            if line_trim.is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<ResticStatusLine>(line_trim) {
                if parsed.message_type.as_deref() == Some("status") {
                    let percent = parsed.percent_done.unwrap_or(0.0);
                    let files_done = parsed.files_done.unwrap_or(0);
                    let total_files = parsed.total_files.unwrap_or(0);
                    let bytes_done = parsed.bytes_done.unwrap_or(0);
                    let total_bytes = parsed.total_bytes.unwrap_or(0);
                    let report = BackupProgressReport {
                        percent_done: percent,
                        files_done,
                        total_files,
                        bytes_done,
                        total_bytes,
                        current_file: parsed.current_file,
                    };
                    let _ = progress_tx.send(report.clone()).await;
                    if (percent - last_log_percent >= 0.05)
                        || (percent >= 1.0 && last_log_percent < 1.0)
                    {
                        last_log_percent = percent;
                        let pct = (percent * 100.0) as u32;
                        let mb_done = bytes_done / 1_000_000;
                        let mb_total = total_bytes / 1_000_000;
                        info!(
                            "backup progress: {}% ({} / {} files, {} MB / {} MB)",
                            pct, files_done, total_files, mb_done, mb_total
                        );
                    }
                    continue;
                }
            }
            if let Ok(parsed) = serde_json::from_str::<ResticSummaryLine>(line_trim) {
                if parsed.message_type.as_deref() == Some("summary") {
                    summary.snapshot_id = parsed.snapshot_id;
                    summary.data_added = parsed.data_added;
                    summary.files_processed = parsed.total_files_processed;
                }
            }
        }

        let status = child.wait().await?;
        let _stderr = stderr_handle.await?;
        if !status.success() {
            return Err(anyhow!(
                "restic backup failed with exit code {:?}",
                status.code()
            ));
        }
        Ok(summary)
    }

    pub async fn snapshots(
        &self,
        repo: &Path,
        passphrase: &str,
    ) -> anyhow::Result<Vec<SnapshotInfo>> {
        let output = self
            .run_capture(
                repo,
                passphrase,
                &["snapshots".to_string(), "--json".to_string()],
            )
            .await?;
        let snapshots: Vec<SnapshotInfo> =
            serde_json::from_slice(&output.stdout).context("parse snapshots")?;
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
            &["check".to_string(), "--read-data-subset=1/20".to_string()],
        )
        .await?;
        Ok(())
    }

    pub async fn check_deep(&self, repo: &Path, passphrase: &str) -> anyhow::Result<()> {
        self.run_capture(
            repo,
            passphrase,
            &["check".to_string(), "--read-data".to_string()],
        )
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

    #[allow(dead_code)]
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

    /// Restore with cancellation support (e.g. when drive is unplugged).
    pub async fn restore_cancellable(
        &self,
        repo: &Path,
        passphrase: &str,
        snapshot_id: &str,
        target: &Path,
        includes: &[String],
        cancel: CancellationToken,
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
        self.run_capture_cancellable(repo, passphrase, &args, cancel)
            .await?;
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
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().context("spawn restic")?;
        let output = child.wait_with_output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            error!(
                "restic: command failed args={:?} status={:?} stdout={} stderr={}",
                args,
                output.status.code(),
                stdout.trim(),
                stderr.trim()
            );
            return Err(anyhow!("restic failed: {}", stderr.trim()));
        }
        Ok(output)
    }

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
            .stdin(Stdio::null())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_restic_status_line() {
        let json = r#"{"message_type":"status","percent_done":0.5,"total_files":100,"files_done":50,"total_bytes":1000,"bytes_done":500,"current_file":"/some/file"}"#;
        let parsed: ResticStatusLine = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.message_type.as_deref(), Some("status"));
        assert_eq!(parsed.percent_done, Some(0.5));
        assert_eq!(parsed.total_files, Some(100));
        assert_eq!(parsed.files_done, Some(50));
        assert_eq!(parsed.bytes_done, Some(500));
        assert_eq!(parsed.total_bytes, Some(1000));
        assert_eq!(parsed.current_file.as_deref(), Some("/some/file"));
    }

    #[test]
    fn parse_restic_summary_line() {
        let json = r#"{"message_type":"summary","snapshot_id":"abc123","data_added":1024,"total_files_processed":42}"#;
        let parsed: ResticSummaryLine = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.message_type.as_deref(), Some("summary"));
        assert_eq!(parsed.snapshot_id.as_deref(), Some("abc123"));
        assert_eq!(parsed.data_added, Some(1024));
        assert_eq!(parsed.total_files_processed, Some(42));
    }

    #[test]
    fn parse_restic_config() {
        let json = r#"{"id":"abc123def456"}"#;
        let parsed: ResticConfig = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.id, "abc123def456");
    }

    #[test]
    fn parse_status_line_minimal() {
        let json = r#"{"message_type":"status"}"#;
        let parsed: ResticStatusLine = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.percent_done, None);
        assert_eq!(parsed.files_done, None);
    }
}
