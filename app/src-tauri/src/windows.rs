//! fastdl's windows: the main window, and the small "New download" window that asks about a
//! download sent from the browser.
//!
//! The confirm window is its own small window (like IDM's) so that answering it never pulls the
//! main window out of the tray or in front of your browser. It is made when a download needs an
//! answer and closed once nothing is waiting any more.
//!
//! Both windows are built here, in code, so they share one WebView2 profile with the same
//! browser arguments: WebView2 refuses to open a second window on the same profile with
//! different ones (and in portable mode the profile lives next to the exe).

use crate::engine::Engine;
use crate::storage::Storage;
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

/// Labels of confirm windows start with this (capabilities/default.json allows "confirm-*").
pub const CONFIRM_PREFIX: &str = "confirm-";

/// Give a window fastdl's shared WebView2 profile and browser arguments.
pub fn with_profile<'a, R: Runtime, M: Manager<R>>(b: WebviewWindowBuilder<'a, R, M>, storage: &Storage) -> WebviewWindowBuilder<'a, R, M> {
    let b = b.additional_browser_args(crate::storage::WEBVIEW_ARGS);
    match &storage.webview_dir {
        Some(dir) => b.data_directory(dir.clone()),
        None => b,
    }
}

/// The confirm window, if one is open. Each new one gets a fresh label ("confirm-0", "confirm-1"…),
/// so a window that is still closing can never be mistaken for the one that should show.
#[derive(Default)]
pub struct ConfirmWindow {
    current: Mutex<Option<WebviewWindow>>,
    made: AtomicU32,
}

/// A download from the browser waits for an answer: show the confirm window, making it if needed.
/// Must not be called on the main thread (building a window waits for it); the bridge calls it
/// from its own thread.
pub fn show_confirm(app: &AppHandle) {
    let state = app.state::<ConfirmWindow>();
    let mut current = state.current.lock().unwrap();
    if let Some(w) = current.as_ref() {
        // Already open: it picks up the new download by itself (from the "item" event).
        let _ = w.unminimize();
        let _ = w.show();
        return;
    }
    let label = format!("{CONFIRM_PREFIX}{}", state.made.fetch_add(1, Relaxed));
    let storage = app.state::<Storage>();
    let builder = with_profile(WebviewWindowBuilder::new(app, &label, WebviewUrl::App("confirm.html".into())), &storage)
        .title("New download - fastdl")
        .inner_size(480.0, 330.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        // Above the browser you just clicked in, even though fastdl itself is in the background.
        .always_on_top(true)
        .center()
        .focused(true);
    match builder.build() {
        Ok(w) => *current = Some(w),
        Err(e) => {
            // Shouldn't happen; if it does, the download is still in the list (paused after a restart).
            eprintln!("fastdl: couldn't open the New download window: {e}");
        }
    }
}

/// Close the confirm window, unless a download (maybe one that just arrived) still waits for an
/// answer. Returns whether it closed. Shares the lock with `show_confirm`, so a download that
/// arrives while the window closes always gets a new window.
pub fn close_confirm_if_done(app: &AppHandle, engine: &Engine) -> bool {
    let state = app.state::<ConfirmWindow>();
    let mut current = state.current.lock().unwrap();
    if engine.has_pending() { return false; }
    if let Some(w) = current.take() { let _ = w.destroy(); }
    true
}

/// The confirm window's X (or Alt+F4) means Cancel for the download it shows, like Esc.
/// The page answers, then asks to be closed when nothing else is waiting.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !window.label().starts_with(CONFIRM_PREFIX) { return; }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.emit_to(window.label(), "confirm-cancel", ());
    }
}
