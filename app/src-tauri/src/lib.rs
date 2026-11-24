pub mod bridge; // pub for examples/bridge_check.rs
pub mod engine;
mod storage;
mod tray;
mod windows;

use engine::{Engine, ItemDto, Settings, StateDto};
use std::sync::Arc;
use storage::Storage;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
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

/// "Don't ask again" in the New download window.
#[tauri::command]
fn stop_asking(e: Eng) { e.stop_asking() }

/// The New download window has nothing left to show. Async so it runs off the main thread,
/// like `windows::show_confirm`, with which it shares a lock.
#[tauri::command]
async fn close_confirm(app: AppHandle, e: Eng<'_>) -> Result<bool, ()> { Ok(windows::close_confirm_if_done(&app, &e)) }

#[tauri::command]
fn pause(e: Eng, id: u64) { e.pause(id) }

#[tauri::command]
fn resume(e: Eng, id: u64) { e.resume(id) }

#[tauri::command]
fn remove(e: Eng, id: u64, delete_file: bool) { e.remove(id, delete_file) }

/// Remove several downloads at once (select, then Del).
#[tauri::command]
fn remove_many(e: Eng, ids: Vec<u64>, delete_files: bool) { e.remove_many(&ids, delete_files) }

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

/// Key to paste into the browser extension, whether the extension endpoint is running,
/// and a one-click pairing request waiting for an answer (if any).
#[tauri::command]
fn extension_info(p: State<'_, Arc<bridge::Pairing>>) -> serde_json::Value {
    serde_json::json!({
        "key": p.display(),
        "ready": bridge::READY.load(std::sync::atomic::Ordering::Relaxed),
        "port": bridge::PORT,
        "prompt": p.current_prompt(),
    })
}

#[tauri::command]
fn new_extension_key(p: State<'_, Arc<bridge::Pairing>>) -> String { p.regenerate() }

/// Allow / Don't allow in the "Allow this browser?" window.
#[tauri::command]
fn answer_pairing(p: State<'_, Arc<bridge::Pairing>>, ticket: u64, allow: bool) -> Result<(), String> { p.answer(ticket, allow) }

/// Version, installed or portable mode, and where settings are kept.
#[tauri::command]
fn app_info(s: State<'_, Storage>) -> serde_json::Value {
    serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "storage": &*s })
}

#[tauri::command]
fn open_data_folder(app: AppHandle, s: State<'_, Storage>) -> Result<(), String> {
    app.opener().open_path(s.data_dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Hide to the tray (after the one-time tray note in the UI).
#[tauri::command]
fn hide_to_tray(window: tauri::WebviewWindow) -> Result<(), String> { window.hide().map_err(|e| e.to_string()) }

#[tauri::command]
fn quit_app(app: AppHandle) { tray::quit_app(&app) }

/// "Start fastdl when I sign in". Not offered in portable mode: it would write to the registry.
#[tauri::command]
fn autostart_info(app: AppHandle, s: State<'_, Storage>) -> serde_json::Value {
    let available = s.mode == storage::Mode::Installed;
    serde_json::json!({ "available": available, "enabled": available && app.autolaunch().is_enabled().unwrap_or(false) })
}

#[tauri::command]
fn set_autostart(app: AppHandle, s: State<'_, Storage>, enabled: bool) -> Result<(), String> {
    if s.mode != storage::Mode::Installed { return Err("Starting with Windows isn't available in portable mode.".into()); }
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

/// Folder picker, on top of the window that asked (the main window or New download).
#[tauri::command]
async fn pick_folder(window: tauri::WebviewWindow) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        window.dialog().file().set_parent(&window).blocking_pick_folder().map(|p| p.to_string())
    }).await.ok().flatten()
}

/// Bring the main window forward: a pairing request came in from the browser, fastdl was
/// opened a second time, or you clicked the tray icon. Downloads from the browser don't do
/// this: they either start quietly or ask in their own small window.
fn bring_to_front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first: a second launch hands over to the running fastdl and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| bring_to_front(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![tray::START_HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            tray::on_window_event(window, event);
            windows::on_window_event(window, event);
        })
        .setup(|app| {
            // Portable mode is Windows-only: elsewhere the WebView's data can't be moved next to the app.
            let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).filter(|_| cfg!(windows));
            let storage = Storage::resolve(exe_dir.as_deref(), app.path().app_data_dir()?);
            // Clear out caches older versions let grow, before any window opens and WebView2
            // holds them open. (Without a folder of our own, Tauri gives WebView2 the app's
            // local data folder.)
            let profile = match &storage.webview_dir { Some(dir) => Some(dir.clone()), None => app.path().app_local_data_dir().ok() };
            if let Some(profile) = profile { storage::trim_webview_profile(&profile); }
            app.manage(storage);
            app.manage(windows::ConfirmWindow::default());
            let storage = app.state::<Storage>();

            let downloads = app.path().download_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            let handle = app.handle().clone();
            let emit: engine::Emit = Box::new(move |ev, v| { let _ = handle.emit(ev, v); });
            let handle = app.handle().clone();
            let pairing = bridge::Pairing::load(&storage.data_dir, Box::new(move |event| match event {
                bridge::PairEvent::Ask(prompt) => {
                    let _ = handle.emit("pair-request", prompt);
                    bring_to_front(&handle);
                }
                bridge::PairEvent::Closed(ticket) => { let _ = handle.emit("pair-request-closed", ticket); }
            }));
            let engine = Engine::new(emit, storage.data_dir.clone(), downloads);
            app.manage(engine.clone());
            app.manage(pairing.clone());

            // Downloads sent from the browser extension. Only one that waits for your answer
            // shows a window (the small New download one); the rest start in the background.
            // Started after everything above is managed: the New download window may open at once.
            let handle = app.handle().clone();
            bridge::start(engine, pairing, Box::new(move |needs_answer| {
                if needs_answer { windows::show_confirm(&handle); }
            }));

            // The main window is created here rather than from tauri.conf.json ("create": false)
            // so that it gets the same WebView2 profile and arguments as the New download window
            // (in portable mode, that profile is next to the exe).
            let config = app.config().app.windows.iter().find(|w| w.label == "main").ok_or("no \"main\" window in tauri.conf.json")?;
            let start_hidden = std::env::args().any(|a| a == tray::START_HIDDEN_ARG);
            let window = windows::with_profile(tauri::WebviewWindowBuilder::from_config(app.handle(), config)?, &storage)
                .visible(!start_hidden);
            tray::create(app.handle())?;
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state, add_download, confirm_download, stop_asking, close_confirm, pause, resume, remove, remove_many, clear_completed,
            set_settings, open_file, show_in_folder, pick_folder, set_mini, extension_info, new_extension_key,
            answer_pairing, app_info, open_data_folder, hide_to_tray, quit_app, autostart_info, set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running fastdl");
}
