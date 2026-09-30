mod bridge;
pub mod engine;

use engine::{Engine, ItemDto, Settings, StateDto};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Eng<'a> = State<'a, Arc<Engine>>;

#[tauri::command]
fn get_state(e: Eng) -> StateDto { e.state() }

#[tauri::command]
fn add_download(e: Eng, url: String) -> Result<ItemDto, String> { e.add(url, vec![], false) }

#[tauri::command]
fn confirm_download(e: Eng, id: u64, name: String, dir: String, start: bool) -> Result<(), String> {
    e.confirm(id, name, dir, start)
}

#[tauri::command]
fn pause(e: Eng, id: u64) { e.pause(id) }

#[tauri::command]
fn resume(e: Eng, id: u64) { e.resume(id) }

#[tauri::command]
fn remove(e: Eng, id: u64, delete_file: bool) { e.remove(id, delete_file) }

#[tauri::command]
fn clear_completed(e: Eng) { e.clear_completed() }

#[tauri::command]
fn set_settings(e: Eng, settings: Settings) { e.set_settings(settings) }

#[tauri::command]
fn open_file(app: tauri::AppHandle, e: Eng, id: u64) -> Result<(), String> {
    let (path, _) = e.file_path(id).ok_or("Not found")?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_in_folder(app: tauri::AppHandle, e: Eng, id: u64) -> Result<(), String> {
    let (path, _) = e.file_path(id).ok_or("Not found")?;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// Switch between the full window and the small always-on-top mini bar.
#[tauri::command]
fn set_mini(window: tauri::WebviewWindow, mini: bool, height: f64, reposition: bool) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    let r = (|| -> tauri::Result<()> {
        if mini {
            let size = LogicalSize::new(340.0, height.clamp(64.0, 400.0));
            window.set_decorations(false)?;
            window.set_resizable(false)?;
            window.set_min_size(Some(LogicalSize::new(300.0, 64.0)))?;
            window.set_size(size)?;
            window.set_always_on_top(true)?;
            if reposition {
                // Bottom-right corner, above the taskbar.
                if let Some(m) = window.current_monitor()? {
                    let scale = m.scale_factor();
                    let area = m.work_area();
                    let (x, y) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
                    let (w, h) = (area.size.width as f64 / scale, area.size.height as f64 / scale);
                    window.set_position(LogicalPosition::new(x + w - size.width - 16.0, y + h - size.height - 16.0))?;
                }
            }
        } else {
            window.set_always_on_top(false)?;
            window.set_decorations(true)?;
            window.set_resizable(true)?;
            window.set_min_size(Some(LogicalSize::new(720.0, 440.0)))?;
            window.set_size(LogicalSize::new(1040.0, 660.0))?;
            window.center()?;
        }
        Ok(())
    })();
    r.map_err(|e| e.to_string())
}

/// Key to paste into the browser extension, and whether the extension endpoint is running.
#[tauri::command]
fn extension_info(p: State<'_, Arc<bridge::Pairing>>) -> serde_json::Value {
    serde_json::json!({ "key": p.display(), "ready": bridge::READY.load(std::sync::atomic::Ordering::Relaxed), "port": bridge::PORT })
}

#[tauri::command]
fn new_extension_key(p: State<'_, Arc<bridge::Pairing>>) -> String { p.regenerate() }

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
    }).await.ok().flatten()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let downloads = app.path().download_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            let handle = app.handle().clone();
            let emit: engine::Emit = Box::new(move |ev, v| { let _ = handle.emit(ev, v); });
            let pairing = bridge::Pairing::load(&data);
            let engine = Engine::new(emit, data, downloads);
            // Downloads sent from the browser extension; bring the window forward so you see them.
            let handle = app.handle().clone();
            bridge::start(engine.clone(), pairing.clone(), Arc::new(move || {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }));
            app.manage(engine);
            app.manage(pairing);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state, add_download, confirm_download, pause, resume, remove, clear_completed,
            set_settings, open_file, show_in_folder, pick_folder, set_mini, extension_info, new_extension_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running fastdl");
}
