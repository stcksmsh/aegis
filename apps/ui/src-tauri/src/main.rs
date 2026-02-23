#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

fn expand_path(path: &str) -> PathBuf {
    let path = path.trim();
    if path.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![select_folder, open_path, is_dev_build, toggle_devtools])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Aegis UI");
}
