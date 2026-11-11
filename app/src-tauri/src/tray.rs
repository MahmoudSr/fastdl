//! System tray: closing the window keeps fastdl running here (like IDM), so downloads from the
//! browser still reach it. Click the icon to open fastdl; right-click for Open / Quit.

use crate::engine::Engine;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

/// Launched like this (by "Start fastdl when I sign in"), fastdl starts in the tray, window hidden.
pub const START_HIDDEN_ARG: &str = "--tray";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open fastdl", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit fastdl", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("fastdl")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::bring_to_front(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::bring_to_front(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;
    Ok(())
}

/// Really quit: save first, so paused and running downloads resume where they stopped.
pub fn quit_app(app: &AppHandle) {
    if let Some(engine) = app.try_state::<Arc<Engine>>() { engine.flush(); }
    app.exit(0);
}

/// The window's X: hide to the tray instead of quitting, unless that's switched off in Settings.
/// The first time, the window asks the UI to explain where fastdl went (event "tray-hint").
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if window.label() != "main" { return; }
    let Some(engine) = window.try_state::<Arc<Engine>>() else { return };
    let settings = engine.settings();
    if !settings.close_to_tray {
        engine.flush(); // closing the last window quits fastdl
        return;
    }
    api.prevent_close();
    if settings.tray_hint_shown {
        let _ = window.hide();
    } else {
        let _ = window.emit("tray-hint", ());
    }
}
