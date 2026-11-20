//! Automatic updates (Tauri updater, signed). Policy (COMPATIBILITY.md, "Versions"):
//! - fixes for this version (same major.minor, `track-X.Y`) install automatically;
//! - newer minors (`track-X`) install automatically only if flagged `"security": true`,
//!   otherwise the user is told and installs with one click;
//! - a new major never installs by itself;
//! - nothing installs while a backup, restore or drive setup runs (agent "hold").
//!
//! The policy comes from the agent config (`update_policy`: security | all | off).

use semver::Version;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES: &str = "https://github.com/stcksmsh/aegis/releases/download";
const AGENT: &str = "http://127.0.0.1:7878/v1";
const FIRST_CHECK: Duration = Duration::from_secs(120);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const BUSY_RETRY: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Security,
    All,
    Off,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Install,
    Notify,
    Ignore,
}

/// What to do with `candidate` while running `current`.
pub fn decide(current: &Version, candidate: &Version, security: bool, policy: Policy) -> Action {
    if policy == Policy::Off || candidate <= current {
        return Action::Ignore;
    }
    // Pre-releases only reach people already testing one (no beta channel yet).
    if !candidate.pre.is_empty() && current.pre.is_empty() {
        return Action::Ignore;
    }
    if candidate.major != current.major {
        return Action::Notify;
    }
    let same_minor = candidate.minor == current.minor;
    match policy {
        Policy::All => Action::Install,
        Policy::Security if same_minor || security => Action::Install,
        _ => Action::Notify,
    }
}

/// Update feeds to check, most specific first.
pub fn endpoints(current: &Version, policy: Policy) -> Vec<String> {
    let feed = |track: String| format!("{RELEASES}/{track}/latest.json");
    match policy {
        Policy::Off => vec![],
        Policy::All => vec![feed(format!("track-{}", current.major))],
        Policy::Security => vec![
            feed(format!("track-{}.{}", current.major, current.minor)),
            feed(format!("track-{}", current.major)),
        ],
    }
}

/// An update the user was told about, installed when they click.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

pub fn spawn(app: AppHandle) {
    app.manage(Pending::default());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(err) = check_once(&app).await {
                tracing::warn!("update check failed: {err:#}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

fn configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

async fn policy() -> Policy {
    let status: Option<serde_json::Value> = async {
        reqwest::get(format!("{AGENT}/status"))
            .await
            .ok()?
            .json()
            .await
            .ok()
    }
    .await;
    match status
        .as_ref()
        .and_then(|s| s["config"]["update_policy"].as_str())
    {
        Some("all") => Policy::All,
        Some("off") => Policy::Off,
        _ => Policy::Security,
    }
}

async fn check_once(app: &AppHandle) -> anyhow::Result<()> {
    if !configured(app) {
        tracing::debug!("updater: no signing key configured; skipping");
        return Ok(());
    }
    let policy = policy().await;
    let current = app.package_info().version.clone();
    for url in endpoints(&current, policy) {
        let updater = app
            .updater_builder()
            .endpoints(vec![url.parse()?])?
            .build()?;
        let Some(update) = updater.check().await? else {
            continue;
        };
        let candidate = Version::parse(&update.version)?;
        let security = update.raw_json["security"].as_bool().unwrap_or(false);
        match decide(&current, &candidate, security, policy) {
            Action::Install => {
                tracing::info!("updater: installing {candidate} automatically");
                return install_when_idle(app, update).await;
            }
            Action::Notify => {
                tracing::info!("updater: {candidate} available; asking the user");
                let _ = app.emit("update-available", candidate.to_string());
                *app.state::<Pending>().0.lock().unwrap() = Some(update);
            }
            Action::Ignore => {}
        }
    }
    Ok(())
}

/// Ask the agent to hold new work; fails while something runs.
async fn hold(on: bool) -> anyhow::Result<bool> {
    let res = reqwest::Client::new()
        .post(format!("{AGENT}/maintenance"))
        .json(&serde_json::json!({ "hold": on }))
        .send()
        .await?;
    Ok(res.status().is_success())
}

async fn install_when_idle(app: &AppHandle, update: Update) -> anyhow::Result<()> {
    while !hold(true).await? {
        tracing::info!("updater: backup or restore running; retrying later");
        tokio::time::sleep(BUSY_RETRY).await;
    }
    install(app, update).await
}

/// Agent hold must already be taken. Restarts the app on success.
async fn install(app: &AppHandle, update: Update) -> anyhow::Result<()> {
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            tracing::info!("updater: installed {}; restarting", update.version);
            app.restart();
        }
        Err(err) => {
            let _ = hold(false).await;
            Err(err.into())
        }
    }
}

/// "Install now" from the update banner (explicit consent; also for a new major).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let pending = app.state::<Pending>().0.lock().unwrap().take();
    let Some(update) = pending else {
        return Err("No update is waiting.".into());
    };
    if !hold(true).await.map_err(|e| e.to_string())? {
        *app.state::<Pending>().0.lock().unwrap() = Some(update);
        return Err("A backup or restore is running. Try again when it's done.".into());
    }
    install(&app, update).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn security_policy() {
        let p = Policy::Security;
        let cur = v("1.0.2");
        assert_eq!(
            decide(&cur, &v("1.0.3"), false, p),
            Action::Install,
            "patch"
        );
        assert_eq!(decide(&cur, &v("1.1.0"), false, p), Action::Notify, "minor");
        assert_eq!(
            decide(&cur, &v("1.1.0"), true, p),
            Action::Install,
            "security minor"
        );
        assert_eq!(
            decide(&cur, &v("2.0.0"), true, p),
            Action::Notify,
            "major never auto"
        );
        assert_eq!(decide(&cur, &v("1.0.2"), true, p), Action::Ignore, "same");
        assert_eq!(decide(&cur, &v("1.0.1"), true, p), Action::Ignore, "older");
    }

    #[test]
    fn all_and_off_policies() {
        let cur = v("1.0.0");
        assert_eq!(
            decide(&cur, &v("1.4.0"), false, Policy::All),
            Action::Install
        );
        assert_eq!(
            decide(&cur, &v("2.0.0"), false, Policy::All),
            Action::Notify
        );
        assert_eq!(decide(&cur, &v("1.0.1"), true, Policy::Off), Action::Ignore);
        assert!(endpoints(&cur, Policy::Off).is_empty());
    }

    #[test]
    fn prereleases() {
        assert_eq!(
            decide(&v("1.0.0"), &v("1.0.1-beta.1"), true, Policy::Security),
            Action::Ignore
        );
        assert_eq!(
            decide(&v("1.0.0-beta.1"), &v("1.0.0"), false, Policy::Security),
            Action::Install
        );
    }

    #[test]
    fn updater_config_parses() {
        // A bad plugin config stops the app from starting; check it like the plugin does.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let cfg: tauri_plugin_updater::Config =
            serde_json::from_value(conf["plugins"]["updater"].clone()).unwrap();
        assert!(cfg.require_signed_version);
    }

    #[test]
    fn feeds_most_specific_first() {
        assert_eq!(
            endpoints(&v("1.0.3"), Policy::Security),
            vec![
                format!("{RELEASES}/track-1.0/latest.json"),
                format!("{RELEASES}/track-1/latest.json"),
            ]
        );
        assert_eq!(
            endpoints(&v("1.2.0"), Policy::All),
            vec![format!("{RELEASES}/track-1/latest.json")]
        );
    }
}
