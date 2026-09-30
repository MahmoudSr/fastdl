//! Download engine: segmented multi-connection HTTP downloads with dynamic
//! splitting, polite connection ramp-up, pause/resume, a queue and a global speed limit.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Where engine events go (the UI in the app, a printer in tests).
pub type Emit = Box<dyn Fn(&str, serde_json::Value) + Send + Sync>;
use tokio_util::sync::CancellationToken;

const MIN_SPLIT: u64 = 512 * 1024; // never split into pieces smaller than this
const MAX_RETRIES: u32 = 10;
const STALL: Duration = Duration::from_secs(20);
// Connections 1-4 open at once (browsers open up to 6 per site, so this looks normal);
// the rest are added one by one, and adding stops as soon as the server pushes back.
const BURST: usize = 4;
const RAMP: Duration = Duration::from_millis(150);
const PART_EXT: &str = "fdlpart";
const MAX_NAME_BYTES: usize = 200; // leaves room for " (n)" and ".fdlpart" under NTFS's 255 limit
const MAX_SPEED_LIMIT_KBPS: u64 = 10_000_000;
const FILE_CHANGED: &str = "file-changed";
const CHANGED_MSG: &str = "The file on the server changed since this download started. Remove it and download it again.";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status { Pending, Queued, Downloading, Paused, Completed, Failed }

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub connections: u32,
    pub max_active: u32,
    pub dir: String,
    pub speed_limit_kbps: u64, // 0 = unlimited
    pub theme: String,         // system | light | dark
    /// Show a confirm window for downloads sent from the browser.
    #[serde(default = "yes")]
    pub ask_before_download: bool,
}

fn yes() -> bool { true }

#[derive(Serialize, Deserialize, Clone, Copy)]
struct SegRec { pos: u64, end: u64 }

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: u64,
    url: String,
    name: String,
    dir: String,
    size: Option<u64>,
    resumable: bool,
    probed: bool,
    status: Status,
    done: u64,
    #[serde(default)]
    segs: Vec<SegRec>,
    error: Option<String>,
    added: u64,
    finished: Option<u64>,
    /// Extra request headers from the browser (Cookie, Referer) so logged-in downloads work.
    /// Memory only: never written to disk, and wiped once the download finishes.
    #[serde(skip)]
    headers: Vec<(String, String)>,
    /// You picked the name yourself, so don't replace it with the server's name.
    #[serde(default)]
    custom_name: bool,
    /// ETag or Last-Modified from the first request. Sent as If-Range so a file that
    /// changed on the server is never stitched together with the old one.
    #[serde(default)]
    validator: Option<String>,
}

/// Build request headers, skipping any value that isn't a valid header.
fn header_map(h: &[(String, String)]) -> reqwest::header::HeaderMap {
    let mut m = reqwest::header::HeaderMap::new();
    for (k, v) in h {
        if let (Ok(k), Ok(v)) = (reqwest::header::HeaderName::from_bytes(k.as_bytes()), reqwest::header::HeaderValue::from_str(v)) {
            m.insert(k, v);
        }
    }
    m
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    id: u64,
    url: String,
    name: String,
    dir: String,
    size: Option<u64>,
    resumable: bool,
    probed: bool,
    status: Status,
    done: u64,
    error: Option<String>,
    added: u64,
    finished: Option<u64>,
}

#[derive(Serialize, Clone)]
struct Progress { id: u64, done: u64, speed: f64, conns: usize }

#[derive(Serialize)]
pub struct StateDto { items: Vec<ItemDto>, settings: Settings }

#[derive(Serialize, Deserialize)]
struct Saved { settings: Settings, items: Vec<Record>, next_id: u64 }

struct Seg { pos: u64, wpos: u64, end: u64, active: bool, errors: u32 }

struct Job {
    cancel: CancellationToken,
    delete_files: AtomicBool,
    received: AtomicU64,
    segs: Mutex<Vec<Seg>>,
    live: AtomicUsize,
    fatal: Mutex<Option<String>>,
    samples: Mutex<VecDeque<(Instant, u64)>>,
    part: Mutex<Option<PathBuf>>,
}

impl Job {
    fn new(done: u64) -> Self {
        Job {
            cancel: CancellationToken::new(),
            delete_files: AtomicBool::new(false),
            received: AtomicU64::new(done),
            segs: Mutex::new(Vec::new()),
            live: AtomicUsize::new(0),
            fatal: Mutex::new(None),
            samples: Mutex::new(VecDeque::new()),
            part: Mutex::new(None),
        }
    }
    fn active_conns(&self) -> usize { self.segs.lock().unwrap().iter().filter(|s| s.active).count() }
    fn seg_snapshot(&self) -> Vec<SegRec> {
        self.segs.lock().unwrap().iter().filter(|s| s.wpos <= s.end)
            .map(|s| SegRec { pos: s.wpos, end: s.end }).collect()
    }
    fn speed(&self) -> f64 {
        let now = Instant::now();
        let cur = self.received.load(Relaxed);
        let mut q = self.samples.lock().unwrap();
        q.push_back((now, cur));
        while q.len() > 1 && now.duration_since(q[0].0) > Duration::from_secs(3) { q.pop_front(); }
        let (t, b) = q[0];
        let dt = now.duration_since(t).as_secs_f64();
        if dt > 0.0 { cur.saturating_sub(b) as f64 / dt } else { 0.0 }
    }
}

/// Global token-bucket speed limiter shared by all downloads.
struct Limiter { rate: AtomicU64, st: Mutex<(Instant, f64)> }

impl Limiter {
    async fn take(&self, n: usize) {
        let rate = self.rate.load(Relaxed);
        if rate == 0 { return; }
        let wait = {
            let mut g = self.st.lock().unwrap();
            let now = Instant::now();
            let r = rate as f64;
            let tokens = (g.1 + now.duration_since(g.0).as_secs_f64() * r).min(r) - n as f64;
            *g = (now, tokens);
            if tokens < 0.0 { Duration::from_secs_f64(-tokens / r) } else { Duration::ZERO }
        };
        if !wait.is_zero() { tokio::time::sleep(wait).await; }
    }
}

struct Item { rec: Record, job: Option<Arc<Job>> }

struct Inner { items: Vec<Item>, settings: Settings, next_id: u64 }

pub struct Engine {
    emit: Emit,
    client: reqwest::Client,
    limiter: Arc<Limiter>,
    inner: Mutex<Inner>,
    data_file: PathBuf,
}

fn clamp_settings(s: Settings) -> Settings {
    Settings {
        connections: s.connections.clamp(1, 32),
        max_active: s.max_active.clamp(1, 10),
        speed_limit_kbps: s.speed_limit_kbps.min(MAX_SPEED_LIMIT_KBPS),
        ..s
    }
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }

fn dto(r: &Record) -> ItemDto {
    ItemDto {
        id: r.id, url: r.url.clone(), name: r.name.clone(), dir: r.dir.clone(), size: r.size,
        resumable: r.resumable, probed: r.probed, status: r.status, done: r.done, error: r.error.clone(),
        added: r.added, finished: r.finished,
    }
}

/// Invisible characters that can disguise a file type, e.g. "invoice\u{202E}fdp.exe"
/// displays as "invoiceexe.pdf".
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}'
        | '\u{FEFF}' | '\u{061C}' | '\u{180E}')
}

/// Make a server- or user-supplied name safe to use as a file name on Windows.
fn sanitize(name: &str) -> String {
    let s: String = name.chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() || is_invisible(c) { '_' } else { c })
        .collect();
    let mut s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() { return "download".into(); }
    // Device names like CON or COM1.txt can't be used as files on Windows.
    let stem = s.split('.').next().unwrap_or("").trim_end().to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.as_bytes()[3].is_ascii_digit())
        || ["com\u{b9}", "com\u{b2}", "com\u{b3}", "lpt\u{b9}", "lpt\u{b2}", "lpt\u{b3}"].contains(&stem.as_str());
    if reserved { s.insert(0, '_'); }
    if s.len() > MAX_NAME_BYTES {
        // Keep the extension, shorten the rest.
        let ext = match s.rfind('.') { Some(i) if s.len() - i <= 16 && i > 0 => s[i..].to_string(), _ => String::new() };
        let mut cut = MAX_NAME_BYTES - ext.len();
        while !s.is_char_boundary(cut) { cut -= 1; }
        s = format!("{}{ext}", s[..cut].trim_end_matches(['.', ' ']));
    }
    s
}

fn name_from_url(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    sanitize(&percent_decode(last))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pick "name (1).ext" etc. if the file (or its partial file) already exists.
fn unique_name(dir: &Path, name: &str, taken: &[String]) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 0;
    loop {
        let cand = if n == 0 { name.to_string() } else { format!("{stem} ({n}){ext}") };
        let exists = dir.join(&cand).exists()
            || dir.join(format!("{cand}.{PART_EXT}")).exists()
            || taken.iter().any(|t| t.to_lowercase() == cand.to_lowercase());
        if !exists { return cand; }
        n += 1;
    }
}

fn write_at(file: &File, mut buf: &[u8], mut off: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_write(file, buf, off)?;
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::write_at(file, buf, off)?;
        if n == 0 { return Err(std::io::ErrorKind::WriteZero.into()); }
        buf = &buf[n..];
        off += n as u64;
    }
    Ok(())
}

struct ProbeInfo { size: Option<u64>, ranges: bool, name: String, validator: Option<String> }

/// Parse "bytes a-b/total".
fn content_range(h: &reqwest::header::HeaderMap) -> Option<(u64, u64, u64)> {
    let v = h.get("content-range")?.to_str().ok()?.trim().strip_prefix("bytes ")?;
    let (range, total) = v.split_once('/')?;
    let (a, b) = range.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// Mark a finished download as coming from the internet (like browsers do), so Windows
/// SmartScreen and Office Protected View still check it.
fn mark_from_internet(path: &Path, url: &str) {
    #[cfg(windows)]
    {
        let host_url = reqwest::Url::parse(url).map(|mut u| { let _ = u.set_username(""); let _ = u.set_password(None); u.to_string() })
            .unwrap_or_default();
        let _ = std::fs::write(format!("{}:Zone.Identifier", path.display()),
            format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={host_url}\r\n"));
    }
    #[cfg(not(windows))]
    let _ = (path, url);
}

async fn probe(client: &reqwest::Client, url: &str, headers: &reqwest::header::HeaderMap) -> Result<ProbeInfo, String> {
    let resp = client.get(url).headers(headers.clone()).header("Range", "bytes=0-0").send().await.map_err(err_str)?;
    let st = resp.status();
    if !st.is_success() { return Err(format!("Server replied HTTP {}", st.as_u16())); }
    let h = resp.headers();
    let (mut size, mut ranges) = (None, false);
    if st.as_u16() == 206 {
        if let Some((_, _, total)) = content_range(h) {
            size = Some(total);
            ranges = true;
        }
    } else {
        size = resp.content_length();
    }
    let mut name = h.get("content-disposition").and_then(|v| v.to_str().ok()).and_then(|cd| {
        if let Some(i) = cd.to_ascii_lowercase().find("filename*=") {
            let v = cd[i + 10..].split(';').next()?.trim().trim_matches('"');
            let v = v.splitn(3, '\'').last()?;
            return Some(percent_decode(v));
        }
        let i = cd.to_ascii_lowercase().find("filename=")?;
        Some(cd[i + 9..].split(';').next()?.trim().trim_matches('"').to_string())
    }).map(|n| sanitize(&n));
    if name.is_none() { name = Some(name_from_url(resp.url().as_str())); }
    // Strong ETag preferred; weak ETags aren't allowed in If-Range.
    let validator = h.get("etag").and_then(|v| v.to_str().ok()).filter(|v| !v.starts_with("W/"))
        .or_else(|| h.get("last-modified").and_then(|v| v.to_str().ok()))
        .map(str::to_string);
    Ok(ProbeInfo { size, ranges, name: name.unwrap(), validator })
}

fn err_str(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src { msg = format!("{msg}: {s}"); src = s.source(); }
    msg
}

impl Engine {
    pub fn new(emit: Emit, data_dir: PathBuf, default_dir: String) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&data_dir);
        let data_file = data_dir.join("downloads.json");
        let saved: Option<Saved> = std::fs::read(&data_file).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let (mut settings, mut items, next_id) = match saved {
            Some(s) => (s.settings, s.items, s.next_id),
            None => (Settings { connections: 8, max_active: 3, dir: default_dir, speed_limit_kbps: 0, theme: "system".into(), ask_before_download: true }, vec![], 1),
        };
        settings = clamp_settings(settings);
        // Anything that was running when the app closed comes back paused.
        for r in &mut items { if matches!(r.status, Status::Downloading | Status::Pending) { r.status = Status::Paused; } }
        let client = reqwest::Client::builder()
            .user_agent(concat!("fastdl/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .pool_max_idle_per_host(32)
            .build().expect("http client");
        let engine = Arc::new(Engine {
            emit,
            client,
            limiter: Arc::new(Limiter { rate: AtomicU64::new(settings.speed_limit_kbps.saturating_mul(1024)), st: Mutex::new((Instant::now(), 0.0)) }),
            inner: Mutex::new(Inner { items: items.into_iter().map(|rec| Item { rec, job: None }).collect(), settings, next_id }),
            data_file,
        });
        let e = engine.clone();
        tauri::async_runtime::spawn(async move { e.ticker().await });
        engine
    }

    /// Emits progress for active downloads and periodically saves state.
    async fn ticker(self: Arc<Self>) {
        let mut n = 0u32;
        loop {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let progress: Vec<Progress> = {
                let inner = self.inner.lock().unwrap();
                inner.items.iter().filter_map(|it| it.job.as_ref().map(|j| Progress {
                    id: it.rec.id, done: j.received.load(Relaxed), speed: j.speed(), conns: j.active_conns(),
                })).collect()
            };
            if !progress.is_empty() {
                self.send("progress", &progress);
                n += 1;
                if n % 5 == 0 { self.save(); }
            }
        }
    }

    fn save(&self) {
        let saved = {
            let inner = self.inner.lock().unwrap();
            Saved {
                settings: inner.settings.clone(),
                next_id: inner.next_id,
                items: inner.items.iter().map(|it| {
                    let mut r = it.rec.clone();
                    if let Some(j) = &it.job { r.segs = j.seg_snapshot(); r.done = j.received.load(Relaxed); }
                    r
                }).collect(),
            }
        };
        let tmp = self.data_file.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(&saved).unwrap()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.data_file);
        }
    }

    fn send<T: Serialize>(&self, ev: &str, v: &T) { (self.emit)(ev, serde_json::to_value(v).unwrap()); }

    fn emit_item(&self, r: &Record) { self.send("item", &dto(r)); }

    pub fn state(&self) -> StateDto {
        let inner = self.inner.lock().unwrap();
        StateDto { items: inner.items.iter().map(|it| dto(&it.rec)).collect(), settings: inner.settings.clone() }
    }

    /// `ask`: wait for the user to confirm (downloads sent from the browser).
    pub fn add(self: &Arc<Self>, url: String, headers: Vec<(String, String)>, ask: bool) -> Result<ItemDto, String> {
        let url = url.trim().to_string();
        let parsed = reqwest::Url::parse(&url).map_err(|_| "That doesn't look like a valid link".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") { return Err("Only http:// and https:// links are supported".into()); }
        let d = {
            let mut inner = self.inner.lock().unwrap();
            let id = inner.next_id;
            inner.next_id += 1;
            if inner.settings.dir.trim().is_empty() { return Err("Choose a download folder in Settings first".into()); }
            let pending = ask && inner.settings.ask_before_download;
            let rec = Record {
                id, url: url.clone(), name: name_from_url(&url), dir: inner.settings.dir.clone(), size: None,
                resumable: false, probed: false, status: if pending { Status::Pending } else { Status::Queued },
                done: 0, segs: vec![], error: None, added: now_ms(), finished: None, headers, custom_name: false, validator: None,
            };
            let d = dto(&rec);
            inner.items.push(Item { rec, job: None });
            d
        };
        if d.status == Status::Pending { self.probe_pending(d.id); } else { self.schedule(); }
        self.save();
        Ok(d)
    }

    /// Look up the real file name and size while the confirm window is open.
    fn probe_pending(self: &Arc<Self>, id: u64) {
        let e = self.clone();
        tauri::async_runtime::spawn(async move {
            let Some((url, headers)) = e.inner.lock().unwrap().items.iter().find(|i| i.rec.id == id)
                .map(|i| (i.rec.url.clone(), header_map(&i.rec.headers))) else { return };
            let res = probe(&e.client, &url, &headers).await;
            let mut inner = e.inner.lock().unwrap();
            let taken: Vec<String> = inner.items.iter().filter(|i| i.rec.id != id).map(|i| i.rec.name.clone()).collect();
            let Some(it) = inner.items.iter_mut().find(|i| i.rec.id == id && i.rec.status == Status::Pending) else { return };
            match res {
                Ok(p) => {
                    if !it.rec.custom_name { it.rec.name = unique_name(Path::new(&it.rec.dir), &p.name, &taken); }
                    it.rec.size = p.size;
                    it.rec.resumable = p.ranges && p.size.unwrap_or(0) > 0;
                    it.rec.validator = p.validator;
                    it.rec.probed = true;
                    it.rec.error = None;
                }
                Err(err) => it.rec.error = Some(err),
            }
            e.emit_item(&it.rec);
        });
    }

    /// The user pressed Download (start = true) or Later (start = false) in the confirm window.
    pub fn confirm(self: &Arc<Self>, id: u64, name: String, dir: String, start: bool) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            let taken: Vec<String> = inner.items.iter().filter(|i| i.rec.id != id).map(|i| i.rec.name.clone()).collect();
            let it = inner.items.iter_mut().find(|i| i.rec.id == id && i.rec.status == Status::Pending)
                .ok_or("This download is no longer waiting")?;
            let dir_path = PathBuf::from(dir.trim());
            if dir.trim().is_empty() { return Err("Choose a folder to save to".into()); }
            std::fs::create_dir_all(&dir_path).map_err(|e| format!("Can't use that folder: {e}"))?;
            let name = sanitize(&name);
            it.rec.custom_name = name != it.rec.name;
            it.rec.name = unique_name(&dir_path, &name, &taken);
            it.rec.dir = dir_path.to_string_lossy().into_owned();
            it.rec.status = if start { Status::Queued } else { Status::Paused };
            it.rec.error = None;
            self.emit_item(&it.rec);
        }
        self.schedule();
        self.save();
        Ok(())
    }

    pub fn pause(self: &Arc<Self>, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(it) = inner.items.iter_mut().find(|i| i.rec.id == id) {
            match &it.job {
                Some(j) => j.cancel.cancel(), // run() finalises the status
                None if it.rec.status == Status::Queued => { it.rec.status = Status::Paused; self.emit_item(&it.rec); }
                None => {}
            }
        }
    }

    pub fn resume(self: &Arc<Self>, id: u64) {
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(it) = inner.items.iter_mut().find(|i| i.rec.id == id) {
                if it.job.is_none() && matches!(it.rec.status, Status::Paused | Status::Failed) {
                    it.rec.status = Status::Queued;
                    it.rec.error = None;
                    self.emit_item(&it.rec);
                }
            }
        }
        self.schedule();
    }

    pub fn remove(self: &Arc<Self>, id: u64, delete_file: bool) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(idx) = inner.items.iter().position(|i| i.rec.id == id) {
            let it = inner.items.remove(idx);
            match it.job {
                // The partial file is useless once the item is gone.
                Some(j) => { j.delete_files.store(true, Relaxed); j.cancel.cancel(); }
                None => {
                    let dir = Path::new(&it.rec.dir);
                    let _ = std::fs::remove_file(dir.join(format!("{}.{PART_EXT}", it.rec.name)));
                    if delete_file && it.rec.status == Status::Completed { let _ = std::fs::remove_file(dir.join(&it.rec.name)); }
                }
            }
            self.send("removed", &id);
        }
        drop(inner);
        self.save();
        self.schedule();
    }

    pub fn clear_completed(&self) {
        let ids: Vec<u64> = {
            let mut inner = self.inner.lock().unwrap();
            let ids = inner.items.iter().filter(|i| i.rec.status == Status::Completed).map(|i| i.rec.id).collect();
            inner.items.retain(|i| i.rec.status != Status::Completed);
            ids
        };
        for id in ids { self.send("removed", &id); }
        self.save();
    }

    pub fn set_settings(self: &Arc<Self>, s: Settings) {
        let s = clamp_settings(s);
        self.limiter.rate.store(s.speed_limit_kbps.saturating_mul(1024), Relaxed);
        self.inner.lock().unwrap().settings = s;
        self.save();
        self.schedule();
    }

    pub fn file_path(&self, id: u64) -> Option<(PathBuf, bool)> {
        let inner = self.inner.lock().unwrap();
        inner.items.iter().find(|i| i.rec.id == id).map(|i| {
            let dir = Path::new(&i.rec.dir);
            let done = i.rec.status == Status::Completed;
            (if done { dir.join(&i.rec.name) } else { dir.join(format!("{}.{PART_EXT}", i.rec.name)) }, done)
        })
    }

    /// Start queued downloads while there are free slots.
    fn schedule(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        let max = inner.settings.max_active as usize;
        let conns = inner.settings.connections;
        let mut running = inner.items.iter().filter(|i| i.job.is_some()).count();
        for it in inner.items.iter_mut() {
            if running >= max { break; }
            if it.job.is_some() || it.rec.status != Status::Queued { continue; }
            let job = Arc::new(Job::new(it.rec.done));
            it.job = Some(job.clone());
            it.rec.status = Status::Downloading;
            self.emit_item(&it.rec);
            running += 1;
            let (e, id) = (self.clone(), it.rec.id);
            tauri::async_runtime::spawn(async move { e.run(id, job, conns).await });
        }
    }

    async fn run(self: Arc<Self>, id: u64, job: Arc<Job>, conns: u32) {
        let res = self.download(id, &job, conns).await;
        {
            let mut inner = self.inner.lock().unwrap();
            let taken: Vec<String> = inner.items.iter().filter(|i| i.rec.id != id).map(|i| i.rec.name.clone()).collect();
            if let Some(it) = inner.items.iter_mut().find(|i| i.rec.id == id) {
                {
                    it.job = None;
                    it.rec.done = job.received.load(Relaxed);
                    it.rec.segs = job.seg_snapshot();
                    match res {
                        Ok(()) => {
                            // Move the finished .fdlpart into place.
                            let dir = PathBuf::from(&it.rec.dir);
                            let part = dir.join(format!("{}.{PART_EXT}", it.rec.name));
                            if dir.join(&it.rec.name).exists() { it.rec.name = unique_name(&dir, &it.rec.name, &taken); }
                            match std::fs::rename(&part, dir.join(&it.rec.name)) {
                                Ok(()) => {
                                    mark_from_internet(&dir.join(&it.rec.name), &it.rec.url);
                                    it.rec.status = Status::Completed;
                                    it.rec.finished = Some(now_ms());
                                    it.rec.segs.clear();
                                    it.rec.headers.clear();
                                    if it.rec.size.is_none() { it.rec.size = Some(it.rec.done); }
                                }
                                Err(e) => { it.rec.status = Status::Failed; it.rec.error = Some(format!("Couldn't save file: {e}")); }
                            }
                        }
                        Err(_) if job.cancel.is_cancelled() => it.rec.status = Status::Paused,
                        Err(e) if e == FILE_CHANGED => {
                            // Start over next time instead of mixing old and new data.
                            it.rec.status = Status::Failed;
                            it.rec.error = Some(CHANGED_MSG.into());
                            it.rec.segs.clear();
                            it.rec.done = 0;
                            it.rec.probed = false;
                            it.rec.validator = None;
                            let _ = std::fs::remove_file(PathBuf::from(&it.rec.dir).join(format!("{}.{PART_EXT}", it.rec.name)));
                        }
                        Err(e) => { it.rec.status = Status::Failed; it.rec.error = Some(e); }
                    }
                    self.emit_item(&it.rec);
                }
            } else if let Some(part) = job.part.lock().unwrap().take() {
                // Removed while finishing: nothing refers to the partial file any more.
                let _ = std::fs::remove_file(part);
            }
        }
        self.save();
        self.schedule();
    }

    async fn download(&self, id: u64, job: &Arc<Job>, conns: u32) -> Result<(), String> {
        let (url, dir, probed, headers) = {
            let inner = self.inner.lock().unwrap();
            let r = &inner.items.iter().find(|i| i.rec.id == id).ok_or("removed")?.rec;
            (r.url.clone(), PathBuf::from(&r.dir), r.probed, header_map(&r.headers))
        };
        if !probed {
            let p = tokio::select! {
                p = probe(&self.client, &url, &headers) => p?,
                _ = job.cancel.cancelled() => return Err("paused".into()),
            };
            std::fs::create_dir_all(&dir).map_err(|e| format!("Can't create folder: {e}"))?;
            let mut inner = self.inner.lock().unwrap();
            let taken: Vec<String> = inner.items.iter().filter(|i| i.rec.id != id).map(|i| i.rec.name.clone()).collect();
            let it = inner.items.iter_mut().find(|i| i.rec.id == id).ok_or("removed")?;
            if !it.rec.custom_name { it.rec.name = unique_name(&dir, &p.name, &taken); }
            it.rec.size = p.size;
            it.rec.resumable = p.ranges && p.size.unwrap_or(0) > 0;
            it.rec.validator = p.validator;
            it.rec.probed = true;
            self.emit_item(&it.rec);
        }
        let (name, size, resumable, saved_segs, validator) = {
            let inner = self.inner.lock().unwrap();
            let r = &inner.items.iter().find(|i| i.rec.id == id).ok_or("removed")?.rec;
            (r.name.clone(), r.size, r.resumable, r.segs.clone(), r.validator.clone())
        };
        let part = dir.join(format!("{name}.{PART_EXT}"));
        *job.part.lock().unwrap() = Some(part.clone());
        let result = if resumable {
            self.segmented(&url, &headers, validator.as_deref(), &part, size.unwrap(), saved_segs, job, conns).await
        } else {
            self.single(&url, &headers, &part, size, job).await
        };
        if job.delete_files.load(Relaxed) { let _ = std::fs::remove_file(&part); }
        result
    }

    async fn single(&self, url: &str, headers: &reqwest::header::HeaderMap, part: &Path, size: Option<u64>, job: &Arc<Job>) -> Result<(), String> {
        // No range support: can't resume, so always start from zero.
        job.received.store(0, Relaxed);
        let file = File::create(part).map_err(|e| format!("Can't write file: {e}"))?;
        let resp = self.client.get(url).headers(headers.clone()).send().await.map_err(err_str)?;
        if !resp.status().is_success() { return Err(format!("Server replied HTTP {}", resp.status().as_u16())); }
        let mut stream = resp.bytes_stream();
        let mut off = 0u64;
        loop {
            let chunk = tokio::select! {
                c = tokio::time::timeout(STALL, stream.next()) => c.map_err(|_| "Connection stalled".to_string())?,
                _ = job.cancel.cancelled() => return Err("paused".into()),
            };
            match chunk {
                None => break,
                Some(Err(e)) => return Err(err_str(e)),
                Some(Ok(b)) => {
                    self.limiter.take(b.len()).await;
                    write_at(&file, &b, off).map_err(|e| format!("Write failed: {e}"))?;
                    off += b.len() as u64;
                    job.received.store(off, Relaxed);
                }
            }
        }
        match size {
            Some(s) if off != s => Err(format!("Download ended early ({off} of {s} bytes). Try again.")),
            _ => Ok(()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn segmented(&self, url: &str, headers: &reqwest::header::HeaderMap, validator: Option<&str>, part: &Path, size: u64, saved: Vec<SegRec>, job: &Arc<Job>, conns: u32) -> Result<(), String> {
        let file = OpenOptions::new().create(true).write(true).truncate(false).open(part)
            .map_err(|e| format!("Can't write file: {e}"))?;
        let saved_ok = saved.iter().all(|r| r.pos <= r.end.saturating_add(1) && r.end < size);
        let fresh = saved.is_empty() || !saved_ok || file.metadata().map(|m| m.len() != size).unwrap_or(true);
        {
            let mut segs = job.segs.lock().unwrap();
            if fresh {
                file.set_len(size).map_err(|e| format!("Not enough disk space? {e}"))?;
                let n = (conns as u64).min(size / MIN_SPLIT).max(1);
                let step = size.div_ceil(n);
                let mut s = 0;
                while s < size {
                    let end = (s + step).min(size) - 1;
                    segs.push(Seg { pos: s, wpos: s, end, active: false, errors: 0 });
                    s = end + 1;
                }
                job.received.store(0, Relaxed);
            } else {
                for r in saved { segs.push(Seg { pos: r.pos, wpos: r.pos, end: r.end, active: false, errors: 0 }); }
                let left: u64 = segs.iter().map(|s| (s.end + 1).saturating_sub(s.pos)).sum();
                job.received.store(size.saturating_sub(left), Relaxed);
            }
        }
        let file = Arc::new(file);
        let validator = validator.and_then(|v| reqwest::header::HeaderValue::from_str(v).ok());
        let refused = Arc::new(AtomicBool::new(false));
        let mut want = conns as usize;
        loop {
            let mut handles = Vec::new();
            for i in 0..want {
                if refused.load(Relaxed) || job.cancel.is_cancelled() { break; }
                job.live.fetch_add(1, Relaxed);
                let w = Worker {
                    client: self.client.clone(), url: url.to_string(), headers: headers.clone(), validator: validator.clone(), size,
                    file: file.clone(), job: job.clone(), refused: refused.clone(), limiter: self.limiter.clone(),
                };
                handles.push(tokio::spawn(w.run()));
                if i + 1 >= BURST && i + 1 < want {
                    tokio::select! { _ = tokio::time::sleep(RAMP) => {}, _ = job.cancel.cancelled() => {} }
                }
            }
            let spawned = !handles.is_empty();
            for h in handles { let _ = h.await; }
            if job.cancel.is_cancelled() { file.sync_all().ok(); return Err("paused".into()); }
            if let Some(e) = job.fatal.lock().unwrap().clone() { file.sync_all().ok(); return Err(e); }
            if job.segs.lock().unwrap().iter().all(|s| s.wpos > s.end) { break; }
            // Rare: pieces left over after connections retired. Finish them with one connection.
            want = 1;
            refused.store(false, Relaxed);
            if !spawned { tokio::time::sleep(Duration::from_millis(500)).await; }
        }
        file.sync_all().ok();
        Ok(())
    }
}

/// Why a range request failed.
struct FetchError { msg: String, retry_after: Option<Duration>, fatal: bool }

impl FetchError {
    fn retry(msg: impl Into<String>) -> Self { FetchError { msg: msg.into(), retry_after: None, fatal: false } }
    fn changed() -> Self { FetchError { msg: FILE_CHANGED.into(), retry_after: None, fatal: true } }
}

struct Worker {
    headers: reqwest::header::HeaderMap,
    validator: Option<reqwest::header::HeaderValue>,
    size: u64,
    client: reqwest::Client,
    url: String,
    file: Arc<File>,
    job: Arc<Job>,
    refused: Arc<AtomicBool>,
    limiter: Arc<Limiter>,
}

impl Worker {
    /// Take a free segment, or split the biggest active one and take its back half.
    fn pick(&self) -> Option<usize> {
        let mut segs = self.job.segs.lock().unwrap();
        if let Some(i) = segs.iter().position(|s| !s.active && s.pos <= s.end) {
            segs[i].active = true;
            return Some(i);
        }
        let (bi, rem) = segs.iter().enumerate().filter(|(_, s)| s.active && s.pos <= s.end)
            .map(|(i, s)| (i, s.end + 1 - s.pos)).max_by_key(|&(_, r)| r)?;
        if rem < 2 * MIN_SPLIT { return None; }
        let mid = segs[bi].pos + rem / 2;
        let end = segs[bi].end;
        segs[bi].end = mid - 1;
        segs.push(Seg { pos: mid, wpos: mid, end, active: true, errors: 0 });
        Some(segs.len() - 1)
    }

    async fn run(self) {
        let mut retired = false;
        while !self.job.cancel.is_cancelled() && self.job.fatal.lock().unwrap().is_none() {
            let Some(i) = self.pick() else { break };
            let res = self.fetch(i).await;
            let errors = {
                let mut segs = self.job.segs.lock().unwrap();
                let s = &mut segs[i];
                s.active = false;
                match &res {
                    Ok(n) if *n > 0 => s.errors = 0,
                    Ok(_) => {}
                    Err(_) => {
                        s.pos = s.wpos; // re-fetch anything not safely written
                        s.errors += 1;
                    }
                }
                s.errors
            };
            match res {
                Ok(_) => {}
                Err(FetchError { fatal: true, msg, .. }) => { *self.job.fatal.lock().unwrap() = Some(msg); break; }
                Err(FetchError { msg: e, retry_after, .. }) => {
                    if self.job.cancel.is_cancelled() { break; }
                    self.refused.store(true, Relaxed);
                    // Retire this connection unless it's the last one left.
                    if self.job.live.fetch_update(Relaxed, Relaxed, |l| if l > 1 { Some(l - 1) } else { None }).is_ok() {
                        retired = true;
                        break;
                    }
                    if errors > MAX_RETRIES { *self.job.fatal.lock().unwrap() = Some(e); break; }
                    let backoff = retry_after.unwrap_or(Duration::from_millis((500u64 << errors.min(4)).min(8000)));
                    tokio::select! { _ = tokio::time::sleep(backoff) => {}, _ = self.job.cancel.cancelled() => break }
                }
            }
        }
        if !retired { self.job.live.fetch_sub(1, Relaxed); }
    }

    /// Download one segment. Returns how many bytes were written.
    async fn fetch(&self, i: usize) -> Result<u64, FetchError> {
        let (from, to) = { let s = &self.job.segs.lock().unwrap()[i]; (s.pos, s.end) };
        let mut req = self.client.get(&self.url).headers(self.headers.clone()).header("Range", format!("bytes={from}-{to}"));
        if let Some(v) = &self.validator { req = req.header("If-Range", v.clone()); }
        let resp = tokio::select! {
            r = tokio::time::timeout(STALL, req.send()) => r.map_err(|_| FetchError::retry("Connection timed out"))?.map_err(|e| FetchError::retry(err_str(e)))?,
            _ = self.job.cancel.cancelled() => return Ok(0),
        };
        let status = resp.status().as_u16();
        if status == 200 && self.validator.is_some() { return Err(FetchError::changed()); }
        if status != 206 {
            let ra = resp.headers().get("retry-after").and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok()).map(|s| Duration::from_secs(s.min(60)));
            return Err(FetchError { msg: format!("Server replied HTTP {status} to a range request"), retry_after: ra, fatal: false });
        }
        // The server must send exactly the part we asked for, of the same file.
        match content_range(resp.headers()) {
            Some((_, _, total)) if total != self.size => return Err(FetchError::changed()),
            Some((a, b, _)) if a == from && b >= a && b <= to => {}
            _ => return Err(FetchError::retry("Server sent the wrong part of the file")),
        }
        let mut stream = resp.bytes_stream();
        let mut written = 0u64;
        loop {
            let chunk = tokio::select! {
                c = tokio::time::timeout(STALL, stream.next()) => c.map_err(|_| FetchError::retry("Connection stalled"))?,
                _ = self.job.cancel.cancelled() => return Ok(written),
            };
            let bytes = match chunk {
                // Ending early is fine (the rest is retried), but ending with nothing is an error,
                // so a broken server gets backoff instead of an endless request loop.
                None if written == 0 => return Err(FetchError::retry("Server closed the connection without sending data")),
                None => return Ok(written),
                Some(Err(e)) => return Err(FetchError::retry(err_str(e))),
                Some(Ok(b)) => b,
            };
            self.limiter.take(bytes.len()).await;
            // Claim the bytes (the segment may have been shortened by a split).
            let (off, n) = {
                let mut segs = self.job.segs.lock().unwrap();
                let s = &mut segs[i];
                let n = (bytes.len() as u64).min((s.end + 1).saturating_sub(s.pos));
                if n == 0 { return Ok(written); }
                let off = s.pos;
                s.pos += n;
                (off, n)
            };
            write_at(&self.file, &bytes[..n as usize], off).map_err(|e| FetchError::retry(format!("Write failed: {e}")))?;
            self.job.received.fetch_add(n, Relaxed);
            written += n;
            let mut segs = self.job.segs.lock().unwrap();
            let s = &mut segs[i];
            s.wpos = off + n;
            if s.wpos > s.end { return Ok(written); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_cannot_escape_the_folder() {
        assert_eq!(sanitize("../../Windows/evil.exe"), ".._.._Windows_evil.exe");
        assert_eq!(sanitize(r"..\..\x.dll"), ".._.._x.dll");
        assert_eq!(sanitize(r"C:\boot.ini"), "C__boot.ini");
        assert_eq!(sanitize(".."), "download");
        assert_eq!(sanitize("   "), "download");
    }

    #[test]
    fn invisible_characters_cannot_fake_an_extension() {
        // Would display as "invoiceexe.pdf".
        assert_eq!(sanitize("invoice\u{202E}fdp.exe"), "invoice_fdp.exe");
        assert_eq!(sanitize("a\u{200B}b\u{2066}c.txt"), "a_b_c.txt");
    }

    #[test]
    fn windows_device_names_are_renamed() {
        assert_eq!(sanitize("CON"), "_CON");
        assert_eq!(sanitize("nul.txt"), "_nul.txt");
        assert_eq!(sanitize("COM1.tar.gz"), "_COM1.tar.gz");
        assert_eq!(sanitize("lpt9"), "_lpt9");
        assert_eq!(sanitize("console.log"), "console.log");
        assert_eq!(sanitize("com10.txt"), "com10.txt");
    }

    #[test]
    fn long_names_are_shortened_keeping_the_extension() {
        let long = format!("{}.mp4", "a".repeat(400));
        let s = sanitize(&long);
        assert!(s.len() <= MAX_NAME_BYTES && s.ends_with(".mp4"));
        let long_multibyte = format!("{}.zip", "é".repeat(300));
        let s = sanitize(&long_multibyte);
        assert!(s.len() <= MAX_NAME_BYTES && s.ends_with(".zip"));
    }

    #[test]
    fn content_range_is_parsed_strictly() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("content-range", "bytes 100-199/1000".parse().unwrap());
        assert_eq!(content_range(&h), Some((100, 199, 1000)));
        h.insert("content-range", "bytes 0-9/*".parse().unwrap());
        assert_eq!(content_range(&h), None);
        h.insert("content-range", "garbage".parse().unwrap());
        assert_eq!(content_range(&h), None);
    }
}
