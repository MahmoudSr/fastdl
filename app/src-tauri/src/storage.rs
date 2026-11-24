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

// ---------- Keeping the WebView2 profile small ----------
// fastdl's UI is a few local files, but by default WebView2 runs like a full Edge browser: it
// downloads components in the background (Widevine, hyphenation and speech data, Safe Browsing
// lists…), keeps a web cache, GPU shader caches and a usage-stats file per run. Over time that
// grew the profile to around 50 MB, next to a 5 MB app.

/// Browser arguments for every fastdl window (all windows on one profile must use the same ones).
pub const WEBVIEW_ARGS: &str = concat!(
    // Tauri's defaults, which setting our own replaces: no mini menu, PDF UI or SmartScreen.
    // PersistentHistograms writes usage stats (BrowserMetrics, about 1 MB per run).
    // Chromium reads only one --disable-features, so they all go in this one.
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,PersistentHistograms",
    // No background component downloads.
    " --disable-component-update",
    // Nothing fastdl shows comes from the web, so there's nothing worth caching.
    " --disk-cache-size=1",
    " --disable-gpu-shader-disk-cache",
);

/// Profile folders (and a few files) that hold only caches, downloaded components and usage
/// stats. fastdl needs none of them, and the arguments above stop them from filling up again,
/// but older versions filled them. Paths are relative to the profile's `EBWebView` folder.
const DISPOSABLE: &[&str] = &[
    "BrowserMetrics", "BrowserMetrics-spare.pma", "Crashpad/reports", "ShaderCache", "GrShaderCache", "GraphiteDawnCache", "GPUPersistentCache",
    "component_crx_cache", "extensions_crx_cache",
    // Components (WebView2 downloads them again if it ever needs them).
    "CertificateRevocation", "FirstPartySetsPreloaded", "hyphen-data", "MEIPreload", "OnDeviceHeadSuggestModel",
    "OriginTrials", "PKIMetadata", "Safe Browsing", "SafetyTips", "Speech Recognition", "Subresource Filter",
    "TpcdMetadata", "Trust Protection Lists", "TrustTokenKeyCommitments", "WidevineCdm", "ZxcvbnData",
    // Per-profile caches.
    "Default/Cache", "Default/Code Cache", "Default/GPUCache", "Default/DawnGraphiteCache", "Default/DawnWebGPUCache",
    "Default/Shared Dictionary",
];

/// Delete the disposable folders and files from a WebView2 profile (`profile_dir` is the folder
/// given to WebView2; it keeps its data in `EBWebView` inside it). Must run before any window
/// opens. Best effort: a file still in use is simply left for next time. Returns the bytes freed.
pub fn trim_webview_profile(profile_dir: &Path) -> u64 {
    let root = profile_dir.join("EBWebView");
    DISPOSABLE.iter().map(|rel| {
        let path = root.join(rel);
        // symlink_metadata: a link is neither a dir nor a file here, so it's never followed out of the profile.
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => {
                let size = dir_size(&path);
                if std::fs::remove_dir_all(&path).is_ok() { size } else { size.saturating_sub(dir_size(&path)) }
            }
            Ok(m) if m.is_file() => if std::fs::remove_file(&path).is_ok() { m.len() } else { 0 },
            _ => 0,
        }
    }).sum()
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries.flatten().map(|e| match e.file_type() {
        Ok(t) if t.is_dir() => dir_size(&e.path()),
        Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
        _ => 0,
    }).sum()
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

    #[test]
    fn trimming_removes_only_caches() {
        let profile = temp_dir("trim");
        let eb = profile.join("EBWebView");
        let write = |rel: &str, bytes: usize| {
            let p = eb.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, vec![0u8; bytes]).unwrap();
        };
        write("Default/Cache/Cache_Data/data_1", 1000);
        write("WidevineCdm/4.10/manifest.json", 200);
        write("BrowserMetrics/BrowserMetrics-1.pma", 300);
        write("BrowserMetrics-spare.pma", 50);
        // Kept: settings and storage the WebView itself needs.
        write("Local State", 10);
        write("Default/Preferences", 10);
        write("Default/Local Storage/leveldb/000003.log", 10);
        // fastdl's own files live outside EBWebView and are never looked at.
        std::fs::write(profile.join("downloads.json"), "{}").unwrap();

        assert_eq!(trim_webview_profile(&profile), 1550);
        for gone in ["Default/Cache", "WidevineCdm", "BrowserMetrics", "BrowserMetrics-spare.pma"] {
            assert!(!eb.join(gone).exists(), "{gone} is deleted");
        }
        for kept in ["Local State", "Default/Preferences", "Default/Local Storage/leveldb/000003.log"] {
            assert!(eb.join(kept).is_file(), "{kept} is kept");
        }
        assert!(profile.join("downloads.json").is_file());
        assert_eq!(trim_webview_profile(&profile), 0, "nothing left to trim");
        let _ = std::fs::remove_dir_all(profile);
    }

    #[test]
    fn trimming_a_missing_profile_is_fine() {
        assert_eq!(trim_webview_profile(&std::env::temp_dir().join("fastdl-no-such-profile")), 0);
    }

    #[test]
    fn webview_args_keep_tauris_defaults_in_one_flag() {
        // Chromium honours a single --disable-features, so a second one would drop Tauri's defaults.
        assert_eq!(WEBVIEW_ARGS.matches("--disable-features=").count(), 1);
        for f in ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"] { assert!(WEBVIEW_ARGS.contains(f), "{f}"); }
    }
}
