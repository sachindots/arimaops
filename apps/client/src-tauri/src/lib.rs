// SPDX-License-Identifier: AGPL-3.0-or-later

//! Unified Tauri v2 client core for ArimaOps v2.0 (Linux, macOS, Windows, Android).
//!
//! Manages persistent multi-server HQ profiles (`0600` on Unix), `/api/health` probing,
//! desktop system tray controls, and `switch_server` navigation back to the bundled picker.

pub mod profiles;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow};
use url::Url;

use crate::profiles::{
    probe_server_health, validate_server_url, HealthProbeResult, ProfileStore, ProfileStoreData,
    ServerProfile,
};

struct ClientState {
    store: ProfileStore,
}

/// Returns `true` ONLY when `url` is the bundled Tauri server-picker origin
/// (`tauri://localhost` on Linux/macOS or `http(s)://tauri.localhost` on Windows/Android).
#[must_use]
pub fn is_picker_origin(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}

fn ensure_picker_origin(window: &WebviewWindow) -> Result<(), String> {
    let current = window
        .url()
        .map_err(|e| format!("failed to inspect window origin: {e}"))?;
    if !is_picker_origin(&current) {
        return Err("this command is restricted to the built-in server picker".into());
    }
    Ok(())
}

#[tauri::command]
fn list_profiles(
    state: State<'_, ClientState>,
    window: WebviewWindow,
) -> Result<ProfileStoreData, String> {
    ensure_picker_origin(&window)?;
    state.store.load().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_profile(
    state: State<'_, ClientState>,
    window: WebviewWindow,
    id: Option<String>,
    name: String,
    url: String,
) -> Result<ProfileStoreData, String> {
    ensure_picker_origin(&window)?;
    let (_, data) = state
        .store
        .upsert(id.as_deref(), &name, &url)
        .map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
fn delete_profile(
    state: State<'_, ClientState>,
    window: WebviewWindow,
    id: String,
) -> Result<ProfileStoreData, String> {
    ensure_picker_origin(&window)?;
    state.store.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_health(
    window: WebviewWindow,
    url: String,
) -> Result<HealthProbeResult, String> {
    ensure_picker_origin(&window)?;
    Ok(probe_server_health(&url).await)
}

#[tauri::command]
fn connect_server(
    state: State<'_, ClientState>,
    window: WebviewWindow,
    id: String,
) -> Result<ServerProfile, String> {
    ensure_picker_origin(&window)?;
    let profile = state.store.mark_active(&id).map_err(|e| e.to_string())?;
    let clean = validate_server_url(&profile.url).map_err(|e| e.to_string())?;
    let target = Url::parse(&clean).map_err(|e| format!("invalid target URL: {e}"))?;
    window.navigate(target).map_err(|e| e.to_string())?;
    Ok(profile)
}

#[tauri::command]
fn switch_server(app: AppHandle) -> Result<(), String> {
    navigate_to_picker(&app)
}

fn picker_url() -> Url {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let raw = "http://tauri.localhost/index.html";
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let raw = "tauri://localhost/index.html";
    Url::parse(raw).expect("valid bundled picker url")
}

fn navigate_to_picker(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        win.navigate(picker_url()).map_err(|e| e.to_string())?;
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "main",
            WebviewUrl::App(PathBuf::from("index.html")),
        )
        .title("ArimaOps")
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(desktop)]
fn setup_desktop_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let open_item = MenuItem::with_id(app, "open", "Open ArimaOps", true, None::<&str>)?;
    let switch_item = MenuItem::with_id(app, "switch", "Switch Server", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &switch_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("ArimaOps")
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "open" => {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "switch" => {
                let _ = navigate_to_picker(app_handle);
            }
            "quit" => {
                app_handle.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _tray = builder.build(app)?;
    Ok(())
}

/// Entrypoint shared across Desktop (`main.rs`) and Android (`#[cfg_attr(mobile, tauri::mobile_entry_point)]`).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let store = ProfileStore::new(config_dir.join("profiles.json"));
            app.manage(ClientState { store });

            #[cfg(desktop)]
            {
                let _ = setup_desktop_tray(app);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            save_profile,
            delete_profile,
            probe_health,
            connect_server,
            switch_server,
        ])
        .run(tauri::generate_context!())
        .expect("error running ArimaOps client");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_origin_allows_only_bundled_tauri_origins() {
        assert!(is_picker_origin(&Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(is_picker_origin(&Url::parse("http://tauri.localhost/index.html").unwrap()));
        assert!(is_picker_origin(&Url::parse("https://tauri.localhost/").unwrap()));

        assert!(!is_picker_origin(&Url::parse("https://hq.example.com/").unwrap()));
        assert!(!is_picker_origin(&Url::parse("http://localhost:7420/").unwrap()));
        assert!(!is_picker_origin(&Url::parse("http://127.0.0.1:7420/").unwrap()));
        assert!(!is_picker_origin(&Url::parse("https://tauri.localhost.evil.com/").unwrap()));
        assert!(!is_picker_origin(&Url::parse("http://169.254.169.254/latest/meta-data/").unwrap()));
        assert!(!is_picker_origin(&Url::parse("tauri://evil.example/index.html").unwrap()));
    }
}
