//! Desktop notifications for backup events and trusted device detection.
//! Uses `notify-rust` (Linux/macOS/Windows), fire-and-forget on a thread.

use crate::state::RunStatus;

/// Send a desktop notification (fire-and-forget). Does not block.
pub fn notify(title: &str, body: &str) {
    let title = title.to_string();
    let body = body.to_string();
    std::thread::spawn(move || {
        let _ = notify_rust::Notification::new()
            .appname("Aegis")
            .summary(&title)
            .body(&body)
            .show();
    });
}

pub fn notify_backup_started(drive_label: &str) {
    notify(
        "Backup started",
        &format!("Backing up to \"{}\"…", drive_label),
    );
}

pub fn notify_backup_finished(drive_label: &str, status: &RunStatus, interrupted: bool) {
    let (title, body) = if interrupted {
        (
            "Backup interrupted",
            format!(
                "The drive \"{}\" was unplugged during the backup. Plug it in and back up again.",
                drive_label
            ),
        )
    } else {
        match status {
            RunStatus::Success => (
                "Backup completed",
                format!("Backup to \"{}\" completed successfully.", drive_label),
            ),
            RunStatus::Partial => (
                "Backup finished with warnings",
                format!(
                    "Backup to \"{}\" finished, but not everything went as planned. Open Aegis for details.",
                    drive_label
                ),
            ),
            RunStatus::Failed => (
                "Backup failed",
                format!(
                    "Backup to \"{}\" didn't finish. Open Aegis to see why.",
                    drive_label
                ),
            ),
        }
    };
    notify(title, &body);
}

pub fn notify_trusted_device(drive_label: &str) {
    notify(
        "Aegis drive connected",
        &format!("\"{}\" is connected and ready to back up.", drive_label),
    );
}

pub fn notify_backup_reminder(drive_label: &str, days_since: u64) {
    notify(
        "Time to back up",
        &format!(
            "Time to back up: plug in \"{}\". Last backup was {} days ago.",
            drive_label, days_since
        ),
    );
}

pub fn notify_drive_almost_full(drive_label: &str) {
    notify(
        "Backup drive almost full",
        &format!(
            "Your backup drive \"{}\" is almost full. Turn on automatic cleanup of old backups in Aegis → Advanced.",
            drive_label
        ),
    );
}
