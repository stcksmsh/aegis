use crate::config::TrustedDrive;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryKit {
    pub drive_id: String,
    pub repository_id: Option<String>,
    pub repository_path: String,
    pub created_epoch: u64,
    pub instructions: String,
}

pub fn export_recovery_kit(
    drive: &TrustedDrive,
    destination_dir: &Path,
) -> anyhow::Result<RecoveryKit> {
    fs::create_dir_all(destination_dir).context("create recovery kit directory")?;

    let kit = RecoveryKit {
        drive_id: drive.drive_id.clone(),
        repository_id: drive.repository_id.clone(),
        repository_path: drive.repository_path.clone(),
        created_epoch: now_epoch(),
        instructions: default_instructions(),
    };

    let json_path = destination_dir.join("recovery.json");
    let txt_path = destination_dir.join("RECOVERY.txt");

    let json = serde_json::to_string_pretty(&kit).context("serialize recovery kit")?;
    fs::write(&json_path, json).context("write recovery.json")?;
    fs::write(&txt_path, kit.instructions.as_bytes()).context("write RECOVERY.txt")?;

    Ok(kit)
}

fn default_instructions() -> String {
    let mut text = String::new();
    text.push_str("Aegis Recovery Kit\n\n");
    text.push_str("This kit lets you restore backups on a new machine.\n");
    text.push_str("You will need:\n");
    text.push_str("- The USB drive containing the Aegis repository\n");
    text.push_str("- Your passphrase (Aegis never stores it on the drive)\n\n");
    text.push_str("Steps:\n");
    text.push_str("1) Install Aegis or restic on the new machine.\n");
    text.push_str("2) Locate the repository path from recovery.json.\n");
    text.push_str("3) Use the passphrase to unlock and restore.\n\n");
    text.push_str("Notes:\n");
    text.push_str("- This kit contains no secrets.\n");
    text.push_str("- If you enabled Paranoid Mode, the passphrase is never stored anywhere.\n");
    text
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
