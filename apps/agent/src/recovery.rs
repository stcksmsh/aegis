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
    crate::i18n::tr(
        "recovery_note",
        &[("readme", &crate::i18n::t("kit_readme"))],
    )
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
