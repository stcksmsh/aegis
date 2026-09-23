#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
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
    let expanded = expand_path(&path);
    if !expanded.exists() {
        return Err(format!("Path does not exist: {}", expanded.display()));
    }
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&expanded)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&expanded)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    std::process::Command::new("explorer")
        .arg(&expanded)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    return Err("Opening path not supported on this platform".to_string());
    Ok(())
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
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Tray icon keeps Aegis running (and watching for drives) after the window closes.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Aegis", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Aegis", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Aegis backup")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
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
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    // Guard must live for the whole process so file logs flush.
    let _log_guard = aegis_agent::init_logging();
    // Embedded agent: if the port is taken, a standalone agent service is already running; use it.
    tauri::async_runtime::spawn(async {
        if let Err(err) = aegis_agent::run().await {
            eprintln!("Embedded agent not started: {:#}", err);
        }
    });

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
        .invoke_handler(tauri::generate_handler![
            select_folder,
            open_path,
            is_dev_build,
            toggle_devtools,
            get_autostart,
            set_autostart
        ])
        .setup(|app| {
            default_autostart_once(app.handle());
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
