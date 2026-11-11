//! Where fastdl keeps its data (settings + download list, the extension key, the WebView profile).
//!
//! Installed mode (the default): the OS app-data folders. On Windows that's
//! `%APPDATA%\com.fastdl.desktop` for fastdl's files and `%LOCALAPPDATA%\com.fastdl.desktop`
//! for the WebView2 profile (named after `identifier` in tauri.conf.json).
//!
//! Portable mode (Windows): put a file named `fastdl.ini` next to `fastdl.exe`, and everything
//! goes in a `data` folder beside the exe instead, so fastdl can live on a USB stick and writes
//! nothing to AppData. If that folder can't be written (say, a read-only drive), fastdl falls back
//! to installed mode for this run and tells you why.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Its presence next to the executable turns portable mode on. The content isn't read (yet).
pub const MARKER: &str = "fastdl.ini";
const DATA_DIR: &str = "data";
const WEBVIEW_DIR: &str = "webview";

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode { Installed, Portable }

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub mode: Mode,
    /// fastdl's own files: downloads.json, extension-key.txt.
    pub data_dir: PathBuf,
    /// WebView2 profile folder. None = the WebView's default (installed mode).
    #[serde(skip)]
    pub webview_dir: Option<PathBuf>,
    /// Shown once at start-up, e.g. why portable mode couldn't be used.
    pub notice: Option<String>,
}

impl Storage {
    /// Decide where data goes. `exe_dir` is the folder holding the executable (None if unknown);
    /// `installed_dir` is the app-data folder used when not portable.
    pub fn resolve(exe_dir: Option<&Path>, installed_dir: PathBuf) -> Storage {
        let installed = |notice| Storage { mode: Mode::Installed, data_dir: installed_dir.clone(), webview_dir: None, notice };
        let Some(exe_dir) = exe_dir.filter(|d| d.join(MARKER).is_file()) else { return installed(None) };
        let data_dir = exe_dir.join(DATA_DIR);
        match ensure_writable(&data_dir) {
            Ok(()) => Storage { mode: Mode::Portable, webview_dir: Some(data_dir.join(WEBVIEW_DIR)), data_dir, notice: None },
            Err(e) => installed(Some(format!(
                "Portable mode is off for now: fastdl can't write to {} ({e}). Your settings are saved in {} instead.",
                data_dir.display(), installed_dir.display()
            ))),
        }
    }
}

/// Create the folder if needed and prove a file can be written there.
fn ensure_writable(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(".write-test");
    std::fs::write(&probe, b"ok")?;
    std::fs::remove_file(&probe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fastdl-storage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn installed_without_marker() {
        let exe = temp_dir("plain");
        let s = Storage::resolve(Some(&exe), PathBuf::from("appdata"));
        assert_eq!((s.mode, s.data_dir, s.webview_dir, s.notice), (Mode::Installed, PathBuf::from("appdata"), None, None));
        assert!(!exe.join(DATA_DIR).exists(), "nothing is created next to the exe");
        let _ = std::fs::remove_dir_all(exe);
    }

    #[test]
    fn installed_when_exe_dir_unknown() {
        assert_eq!(Storage::resolve(None, PathBuf::from("appdata")).mode, Mode::Installed);
    }

    #[test]
    fn portable_with_marker() {
        let exe = temp_dir("portable");
        std::fs::write(exe.join(MARKER), "").unwrap();
        let s = Storage::resolve(Some(&exe), PathBuf::from("appdata"));
        assert_eq!(s.mode, Mode::Portable);
        assert_eq!(s.data_dir, exe.join("data"));
        assert_eq!(s.webview_dir, Some(exe.join("data").join("webview")));
        assert!(s.notice.is_none());
        assert!(s.data_dir.is_dir());
        assert!(!s.data_dir.join(".write-test").exists(), "probe file is cleaned up");
        let _ = std::fs::remove_dir_all(exe);
    }

    #[test]
    fn marker_must_be_a_file() {
        let exe = temp_dir("marker-dir");
        std::fs::create_dir(exe.join(MARKER)).unwrap();
        assert_eq!(Storage::resolve(Some(&exe), PathBuf::from("appdata")).mode, Mode::Installed);
        let _ = std::fs::remove_dir_all(exe);
    }

    #[test]
    fn falls_back_when_data_dir_cant_be_written() {
        let exe = temp_dir("readonly");
        std::fs::write(exe.join(MARKER), "").unwrap();
        std::fs::write(exe.join(DATA_DIR), "a file where the folder should be").unwrap();
        let s = Storage::resolve(Some(&exe), PathBuf::from("appdata"));
        assert_eq!(s.mode, Mode::Installed);
        assert_eq!(s.data_dir, PathBuf::from("appdata"));
        assert!(s.webview_dir.is_none());
        assert!(s.notice.as_deref().is_some_and(|n| n.contains("Portable mode is off")));
        let _ = std::fs::remove_dir_all(exe);
    }
}
