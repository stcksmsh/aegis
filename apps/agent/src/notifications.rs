//! Desktop notifications for backup events and trusted device detection.
//! Uses `notify-send` on Linux when available; no-op otherwise.

/// Send a desktop notification (fire-and-forget). Does not block.
pub fn notify(title: &str, body: &str) {
    #[cfg(target_os = "linux")]
    {
        let title = title.to_string();
        let body = body.to_string();
        std::thread::spawn(move || {
            let _ = std::process::Command::new("notify-send")
                .args(["-a", "Aegis", &title, &body])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (title, body);
    }
}

pub fn notify_backup_started(drive_label: &str) {
    notify(
        "Backup started",
        &format!("Backing up to \"{}\"…", drive_label),
    );
}

pub fn notify_backup_finished(drive_label: &str, success: bool, interrupted: bool) {
    let (title, body) = if interrupted {
        (
            "Backup interrupted",
            format!(
                "Backup to \"{}\" was interrupted (drive disconnected).",
                drive_label
            ),
        )
    } else if success {
        (
            "Backup completed",
            format!("Backup to \"{}\" completed successfully.", drive_label),
        )
    } else {
        (
            "Backup failed",
            format!("Backup to \"{}\" failed.", drive_label),
        )
    };
    notify(title, &body);
}

pub fn notify_trusted_device(drive_label: &str) {
    notify(
        "Aegis drive connected",
        &format!("\"{}\" is connected and ready to back up.", drive_label),
    );
}
