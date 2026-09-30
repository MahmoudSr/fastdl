//! Tiny local HTTP endpoint the browser extension talks to.
//!
//! Security:
//! - listens on 127.0.0.1 only (not reachable from the network)
//! - only accepts requests whose Origin is our extension's fixed ID; browsers don't let
//!   web pages fake the Origin header, so websites can't push downloads into fastdl
//! - checks the Host header (blocks DNS-rebinding tricks)
//! - pairing key (shown in Settings, pasted into the extension once):
//!   * /v1/ping answers with HMAC(key, "ping:" + nonce), so the extension can tell the real
//!     fastdl from another program sitting on this port, before it sends any link or cookie
//!   * /v1/add must carry HMAC(key, "add:" + body), so other programs can't add downloads
//! - small size limits and timeouts; only two routes; only Cookie/Referer are passed on
//! - both routes are POST: Chrome only sends an extension's Origin on non-GET requests

use crate::engine::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const PORT: u16 = 17385;
const EXTENSION_ORIGIN: &str = "chrome-extension://hgcnppnappmlhghfbbpkbfinnmiadibg";
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;

/// False if another program already uses the port (shown in Settings).
pub static READY: AtomicBool = AtomicBool::new(false);

type HmacSha256 = Hmac<Sha256>;

/// The shared secret between fastdl and the extension, stored in the app's data folder.
pub struct Pairing { key: Mutex<[u8; 16]>, path: PathBuf }

impl Pairing {
    pub fn load(data_dir: &Path) -> Arc<Self> {
        let _ = std::fs::create_dir_all(data_dir);
        let path = data_dir.join("extension-key.txt");
        let key = std::fs::read_to_string(&path).ok().and_then(|s| from_hex(s.trim())).and_then(|v| v.try_into().ok());
        let p = Arc::new(Pairing { key: Mutex::new([0; 16]), path });
        match key {
            Some(k) => *p.key.lock().unwrap() = k,
            None => { p.regenerate(); }
        }
        p
    }

    /// Key as shown to the user, e.g. "3f9a-07c2-...".
    pub fn display(&self) -> String {
        let hex = to_hex(&*self.key.lock().unwrap());
        hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
    }

    /// Make a new key; the extension has to be paired again.
    pub fn regenerate(&self) -> String {
        let mut k = [0u8; 16];
        getrandom::fill(&mut k).expect("system random number generator");
        *self.key.lock().unwrap() = k;
        let _ = std::fs::write(&self.path, to_hex(&k));
        self.display()
    }

    fn mac(&self, msg: &[u8]) -> HmacSha256 {
        let mut m = HmacSha256::new_from_slice(&*self.key.lock().unwrap()).expect("any key size works");
        m.update(msg);
        m
    }
}

fn to_hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None; }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

#[derive(Deserialize)]
struct PingReq { nonce: String }

#[derive(Deserialize)]
struct AddReq {
    url: String,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(default)]
    cookies: Option<String>,
}

pub fn start(engine: Arc<Engine>, pairing: Arc<Pairing>, on_add: Arc<dyn Fn() + Send + Sync>) {
    // Bind right away (not in the background) so READY is correct before the window asks.
    let Ok(std_listener) = std::net::TcpListener::bind(("127.0.0.1", PORT)) else { return };
    if std_listener.set_nonblocking(true).is_err() { return; }
    READY.store(true, Relaxed);
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(std_listener) else { READY.store(false, Relaxed); return };
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let (e, p, f) = (engine.clone(), pairing.clone(), on_add.clone());
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(5), handle(sock, e, p, f)).await;
            });
        }
    });
}

async fn handle(mut sock: TcpStream, engine: Arc<Engine>, pairing: Arc<Pairing>, on_add: Arc<dyn Fn() + Send + Sync>) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(2048);
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i; }
        if buf.len() > MAX_HEAD { return reply(&mut sock, 431, r#"{"error":"headers too large"}"#).await; }
        if sock.read_buf(&mut buf).await? == 0 { return Ok(()); }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut req_line = head.split("\r\n").next().unwrap_or("").split(' ');
    let (method, path) = (req_line.next().unwrap_or(""), req_line.next().unwrap_or(""));
    let header = |name: &str| head.split("\r\n").skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
    });

    if header("origin").as_deref() != Some(EXTENSION_ORIGIN) {
        return reply(&mut sock, 403, r#"{"error":"forbidden"}"#).await;
    }
    let host_ok = matches!(header("host").as_deref(), Some(h) if h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}"));
    if !host_ok { return reply(&mut sock, 403, r#"{"error":"forbidden"}"#).await; }
    if method != "POST" { return reply(&mut sock, 404, r#"{"error":"not found"}"#).await; }

    // Read the body.
    let len: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY { return reply(&mut sock, 413, r#"{"error":"too large"}"#).await; }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let mut chunk = vec![0; len - body.len()];
        let n = sock.read(&mut chunk).await?;
        if n == 0 { break; }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);

    match path {
        "/v1/ping" => {
            let Ok(req) = serde_json::from_slice::<PingReq>(&body) else {
                return reply(&mut sock, 400, r#"{"error":"bad request"}"#).await;
            };
            if req.nonce.is_empty() || req.nonce.len() > 128 {
                return reply(&mut sock, 400, r#"{"error":"bad request"}"#).await;
            }
            let proof = to_hex(&pairing.mac(format!("ping:{}", req.nonce).as_bytes()).finalize().into_bytes());
            let resp = serde_json::json!({ "app": "fastdl", "version": env!("CARGO_PKG_VERSION"), "proof": proof });
            reply(&mut sock, 200, &resp.to_string()).await
        }
        "/v1/add" => {
            // Only the paired extension knows the key, so only it can sign requests.
            let signed = header("x-fastdl-auth").and_then(|v| from_hex(&v)).is_some_and(|sig| {
                let mut msg = b"add:".to_vec();
                msg.extend_from_slice(&body);
                pairing.mac(&msg).verify_slice(&sig).is_ok()
            });
            if !signed { return reply(&mut sock, 401, r#"{"error":"not paired"}"#).await; }
            let Ok(req) = serde_json::from_slice::<AddReq>(&body) else {
                return reply(&mut sock, 400, r#"{"error":"bad request"}"#).await;
            };
            let mut headers = Vec::new();
            if let Some(c) = req.cookies.filter(|c| !c.is_empty()) { headers.push(("Cookie".to_string(), c)); }
            if let Some(r) = req.referrer.filter(|r| r.starts_with("http://") || r.starts_with("https://")) {
                headers.push(("Referer".to_string(), r));
            }
            match engine.add(req.url, headers, true) {
                Ok(_) => { on_add(); reply(&mut sock, 200, r#"{"ok":true}"#).await }
                Err(e) => reply(&mut sock, 400, &serde_json::json!({ "error": e }).to_string()).await,
            }
        }
        _ => reply(&mut sock, 404, r#"{"error":"not found"}"#).await,
    }
}

async fn reply(sock: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let text = match status {
        200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found",
        413 => "Payload Too Large", 431 => "Request Header Fields Too Large", _ => "Error",
    };
    let resp = format!(
        "HTTP/1.1 {status} {text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes()).await?;
    sock.shutdown().await
}
