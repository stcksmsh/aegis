//! Desktop notifications for backup events and trusted device detection.
//! Linux: freedesktop D-Bus; macOS/Windows: `notify-rust`. Fire-and-forget on a thread.

use crate::state::RunStatus;

/// Send a desktop notification (fire-and-forget). Does not block.
pub fn notify(title: &str, body: &str) {
    let title = title.to_string();
    let body = body.to_string();
    std::thread::spawn(move || {
        if let Err(e) = show(&title, &body) {
            tracing::warn!("notification not shown: {}", e);
        }
    });
}

/// GNOME deletes an installed app's notifications as soon as the D-Bus connection that sent
/// them closes, so keep one session connection open for as long as Aegis runs.
#[cfg(target_os = "linux")]
fn show(title: &str, body: &str) -> zbus::Result<()> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    static CONN: OnceLock<zbus::blocking::Connection> = OnceLock::new();
    let conn = match CONN.get() {
        Some(c) => c,
        None => {
            let c = zbus::blocking::Connection::session()?;
            CONN.get_or_init(|| c)
        }
    };
    let hints: HashMap<&str, zbus::zvariant::Value> = HashMap::new();
    conn.call_method(
        Some("org.freedesktop.Notifications"),
        "/org/freedesktop/Notifications",
        Some("org.freedesktop.Notifications"),
        "Notify",
        &(
            "Aegis",
            0u32,
            "aegis-ui",
            title,
            body,
            Vec::<&str>::new(),
            hints,
            -1i32,
        ),
    )?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn show(title: &str, body: &str) -> notify_rust::error::Result<()> {
    let mut n = notify_rust::Notification::new();
    // Without this Windows shows the toast as coming from PowerShell. The installer tags the
    // Start menu shortcut with the bundle identifier (tauri.conf.json), so toasts show as Aegis.
    #[cfg(target_os = "windows")]
    n.app_id("io.github.stcksmsh.aegis");
    n.appname("Aegis")
        .summary(title)
        .body(body)
        .show()
        .map(|_| ())
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
            "Your backup drive \"{}\" is almost full. Keep fewer old backups in Aegis → Advanced.",
            drive_label
        ),
    );
}
