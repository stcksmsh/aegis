#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updater;

use aegis_agent::i18n::{t, tr};
use std::path::PathBuf;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

fn expand_path(path: &str) -> PathBuf {
    let path = path.trim();
    if path.starts_with("~/") {
        // USERPROFILE is the Windows equivalent of HOME.
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(path.trim_start_matches("~/"));
        }
    }
    PathBuf::from(path)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open_in_file_manager(&expand_path(&path))
}

#[tauri::command]
fn open_logs() -> Result<(), String> {
    let dir = aegis_agent::log_dir().ok_or("Log folder not available")?;
    open_in_file_manager(&dir)
}

fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(windows)]
    let program = "explorer";
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A backup on the plugged-in drive, as the tray lists it.
#[derive(serde::Deserialize)]
struct TrayBackup {
    id: String,
    label: String,
    running: bool,
}

/// The tray's status line (updated in place) and what the menu was last built from.
struct TrayState(std::sync::Mutex<(Option<MenuItem<tauri::Wry>>, String)>);

/// Called by the frontend whenever it polls agent status. `drive`: the plugged-in drive's name.
/// The menu is rebuilt only when the drive or its backups change, so an open menu isn't closed
/// by every refresh.
#[tauri::command]
fn set_tray_status(app: AppHandle, text: String, backups: Vec<TrayBackup>, drive: Option<String>) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Aegis — {}", text)));
    }
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let mut current = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let key = format!(
        "{:?} {:?}",
        backups
            .iter()
            .map(|b| (&b.id, &b.label, b.running))
            .collect::<Vec<_>>(),
        drive
    );
    if current.1 == key {
        if let Some(item) = &current.0 {
            let _ = item.set_text(&text);
        }
        return;
    }
    if let (Ok((menu, status)), Some(tray)) = (
        tray_menu(&app, &text, &backups, drive.as_deref()),
        app.tray_by_id("main"),
    ) {
        let _ = tray.set_menu(Some(menu));
        *current = (Some(status), key);
    }
}

/// Status line; the plugged-in drive's name, then "Back up "<name>"" per backup on it, "Back up
/// all" when there are several, and "Eject"; Open; Quit.
fn tray_menu(
    app: &AppHandle,
    text: &str,
    backups: &[TrayBackup],
    drive: Option<&str>,
) -> tauri::Result<(Menu<tauri::Wry>, MenuItem<tauri::Wry>)> {
    let item = |id: String, label: String, enabled: bool| {
        MenuItem::with_id(app, id, label, enabled, None::<&str>)
    };
    let status = item("status".into(), text.into(), false)?;
    let menu = Menu::new(app)?;
    menu.append(&status)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if let Some(name) = drive {
        menu.append(&item("drive".into(), name.into(), false)?)?;
    }
    for b in backups {
        menu.append(&item(
            format!("backup:{}", b.id),
            tr("tray_back_up_name", &[("name", &b.label)]),
            !b.running,
        )?)?;
    }
    if backups.len() > 1 {
        menu.append(&item(
            "backup-all".into(),
            t("back_up_all"),
            backups.iter().any(|b| !b.running),
        )?)?;
    }
    if let Some(name) = drive {
        let busy = backups.iter().any(|b| b.running);
        menu.append(&item(
            "eject".into(),
            tr("tray_eject_name", &[("name", name)]),
            !busy,
        )?)?;
    }
    if drive.is_some() || !backups.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&item("open".into(), t("tray_open"), true)?)?;
    menu.append(&item("quit".into(), t("tray_quit"), true)?)?;
    Ok((menu, status))
}

#[tauri::command]
async fn select_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = oneshot::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |path| {
        let selection = path
            .and_then(|path| path.into_path().ok())
            .map(|path| path.to_string_lossy().to_string());
        let _ = tx.send(selection);
    });
    rx.await.unwrap_or(None)
}

/// Whether the desktop prefers a dark theme (None: no preference / unknown). Linux only: there the
/// web view's prefers-color-scheme and Tauri's theme check both miss many dark themes.
#[tauri::command]
fn system_dark() -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        use zbus::zvariant::Value;
        let conn = zbus::blocking::Connection::session().ok()?;
        let reply = conn
            .call_method(
                Some("org.freedesktop.portal.Desktop"),
                "/org/freedesktop/portal/desktop",
                Some("org.freedesktop.portal.Settings"),
                "Read",
                &("org.freedesktop.appearance", "color-scheme"),
            )
            .ok()?;
        let body = reply.body();
        let mut value: Value = body.deserialize().ok()?;
        // Read wraps the setting in one or two extra variants.
        while let Value::Value(inner) = value {
            value = *inner;
        }
        match u32::try_from(value).ok()? {
            1 => Some(true),
            2 => Some(false),
            _ => None,
        }
    }
    #[cfg(not(target_os = "linux"))]
    None
}

#[tauri::command]
fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
fn toggle_devtools(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
}

struct NoTray;

/// Passed by the login item so Aegis starts quietly in the tray.
const MINIMIZED_ARG: &str = "--minimized";

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let res = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    res.map_err(|e| e.to_string())
}

/// Start at login by default (plug-in backups need Aegis running); only once, so user opt-out sticks.
fn default_autostart_once(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let flag = dir.join("autostart-initialized");
    if flag.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    if app.autolaunch().enable().is_ok() {
        let _ = std::fs::write(flag, b"");
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // GNOME ignores un-minimize and raise requests from a background app (focus-stealing
        // prevention); hiding and showing the window again brings it to the front.
        if window.is_minimized().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
            let _ = window.hide();
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Tray icon keeps Aegis running (and watching for drives) after the window closes.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let (menu, status) = tray_menu(app, &t("tray_running"), &[], None)?;
    app.manage(TrayState(std::sync::Mutex::new((
        Some(status),
        String::new(),
    ))));
    let tray = TrayIconBuilder::with_id("main")
        .tooltip("Aegis")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            // The frontend runs the normal flows (may need to ask for the passphrase), so show it.
            if let Some(backup) = id.strip_prefix("backup:") {
                show_main(app);
                let _ = app.emit("tray-backup", Some(backup.to_string()));
            }
            match id {
                "open" => show_main(app),
                "backup-all" => {
                    show_main(app);
                    let _ = app.emit("tray-backup", None::<String>);
                }
                // The tray choice is the confirmation; the result comes as a notification.
                "eject" => {
                    let _ = app.emit("tray-eject", ());
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    // macOS menu bar: a black glyph the system recolours for light/dark. Elsewhere the colour
    // mark, which reads on both light and dark panels.
    #[cfg(target_os = "macos")]
    let tray = tray
        .icon(Image::from_bytes(include_bytes!(
            "../icons/tray/template.png"
        ))?)
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let tray = tray.icon(Image::from_bytes(include_bytes!(
        "../icons/tray/color.png"
    ))?);
    tray.build(app)?;
    Ok(())
}

fn main() {
    // Guard must live for the whole process so file logs flush.
    let _log_guard = aegis_agent::init_logging();
    tauri::Builder::default()
        // Must be first: a second launch just focuses the running window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_ARG]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            select_folder,
            open_path,
            is_dev_build,
            system_dark,
            toggle_devtools,
            get_autostart,
            set_autostart,
            open_logs,
            set_tray_status,
            updater::install_update
        ])
        .setup(|app| {
            // Embedded agent: if the port is taken, a standalone agent service is already running; use it.
            let kit_dir = app
                .path()
                .resource_dir()
                .ok()
                .map(|d| d.join("restore-kit"));
            tauri::async_runtime::spawn(async move {
                if let Err(err) = aegis_agent::run(kit_dir).await {
                    eprintln!("Embedded agent not started: {:#}", err);
                }
            });
            default_autostart_once(app.handle());
            updater::spawn(app.handle().clone());
            let tray_ok = match build_tray(app.handle()) {
                Ok(()) => true,
                Err(err) => {
                    // No tray (e.g. some Linux desktops): closing the window quits instead.
                    eprintln!("Tray unavailable: {}", err);
                    app.manage(NoTray);
                    false
                }
            };
            if !tray_ok || !std::env::args().any(|a| a == MINIMIZED_ARG) {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.try_state::<NoTray>().is_none() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Aegis UI");
}
