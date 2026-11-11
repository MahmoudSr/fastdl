//! Tiny local HTTP endpoint the browser extension talks to.
//!
//! Security:
//! - listens on 127.0.0.1 only (not reachable from the network)
//! - only accepts requests whose Origin is our extension's fixed ID; browsers don't let
//!   web pages fake the Origin header, so websites can't push downloads into fastdl
//! - checks the Host header (blocks DNS-rebinding tricks)
//! - pairing key, shared once between fastdl and the extension:
//!   * /v1/ping answers with HMAC(key, "ping:" + nonce), so the extension can tell the real
//!     fastdl from another program sitting on this port, before it sends any link or cookie
//!   * /v1/add must carry HMAC(key, "add:" + body), so other programs can't add downloads
//!   * /v1/pair hands the key over only after you click Allow in fastdl (one-click pairing).
//!     fastdl and the extension both show a short code derived from the request, so you can
//!     tell your browser's request from one another program made. The key can still be
//!     copied from Settings and pasted into the extension instead.
//! - small size limits and timeouts; only three routes; only Cookie/Referer are passed on
//! - all routes are POST: Chrome only sends an extension's Origin on non-GET requests

use crate::engine::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

pub const PORT: u16 = 17385;
const EXTENSION_ORIGIN: &str = "chrome-extension://egipjloapeelcbbaaamafhcopapmiedo";
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
/// A client gets this long to send its request.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// /v1/pair holds the request open this long waiting for your answer, then the extension asks again.
/// Kept under 30 s, the idle limit of an extension's service worker.
const PAIR_LONG_POLL: Duration = Duration::from_secs(20);
/// Hard cap on any one connection.
const MAX_CONNECTION: Duration = Duration::from_secs(30);
/// How long a pairing request waits for Allow / Don't allow.
const PAIR_TTL: Duration = Duration::from_secs(120);

/// False if another program already uses the port (shown in Settings).
pub static READY: AtomicBool = AtomicBool::new(false);

type HmacSha256 = Hmac<Sha256>;

/// A browser asking to pair, as shown in fastdl's "Allow this browser?" window.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairPrompt {
    pub ticket: u64,
    pub browser: String,
    pub code: String,
    pub expires_in_ms: u64,
}

pub enum PairEvent {
    /// Show the Allow window.
    Ask(PairPrompt),
    /// The request with this ticket is over (answered, collected or expired): close its window.
    Closed(u64),
}

pub type OnPairEvent = Box<dyn Fn(PairEvent) + Send + Sync>;

struct PairRequest {
    ticket: u64,
    /// Random ID the extension made; only it knows this, so only it can collect the key.
    request: String,
    browser: String,
    code: String,
    expires: Instant,
    answer: Option<bool>,
}

#[derive(Debug, PartialEq)]
enum PairPoll {
    Waiting { code: String },
    Approved { key: String },
    Denied,
    Expired,
    /// fastdl is already asking about a different request.
    Busy,
}

/// The shared secret between fastdl and the extension, stored in the app's data folder,
/// plus the one-click pairing request currently waiting for an answer (at most one).
pub struct Pairing {
    key: Mutex<[u8; 16]>,
    path: PathBuf,
    pending: Mutex<Option<PairRequest>>,
    /// Pinged when a request is answered, to wake the long-poll waiting for it.
    answered: watch::Sender<()>,
    next_ticket: AtomicU64,
    ttl: Duration,
    on_event: OnPairEvent,
}

impl Pairing {
    pub fn load(data_dir: &Path, on_event: OnPairEvent) -> Arc<Self> {
        Self::with_ttl(data_dir, on_event, PAIR_TTL)
    }

    fn with_ttl(data_dir: &Path, on_event: OnPairEvent, ttl: Duration) -> Arc<Self> {
        let _ = std::fs::create_dir_all(data_dir);
        let path = data_dir.join("extension-key.txt");
        let key = std::fs::read_to_string(&path).ok().and_then(|s| from_hex(s.trim())).and_then(|v| v.try_into().ok());
        let p = Arc::new(Pairing {
            key: Mutex::new([0; 16]),
            path,
            pending: Mutex::new(None),
            answered: watch::Sender::new(()),
            next_ticket: AtomicU64::new(1),
            ttl,
            on_event,
        });
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

    /// The request waiting for an answer, if any (for a window that opens after it arrived).
    pub fn current_prompt(&self) -> Option<PairPrompt> {
        let now = Instant::now();
        let pending = self.pending.lock().unwrap();
        pending.as_ref().filter(|p| p.answer.is_none() && now < p.expires).map(|p| prompt_of(p, now))
    }

    /// Your answer in the Allow window. Fails if that request is no longer waiting.
    pub fn answer(&self, ticket: u64, allow: bool) -> Result<(), String> {
        {
            let mut pending = self.pending.lock().unwrap();
            match pending.as_mut() {
                Some(p) if p.ticket == ticket && p.answer.is_none() && Instant::now() < p.expires => p.answer = Some(allow),
                _ => return Err("This request has expired. Click Connect in the browser extension again.".into()),
            }
        }
        self.answered.send_replace(());
        Ok(())
    }

    /// One step of a pairing request: start it, report that it's still waiting, or hand over
    /// the result (once; the request is then finished).
    fn poll(&self, request: &str, browser: &str) -> PairPoll {
        let now = Instant::now();
        let mut events = Vec::new();
        let result = {
            let mut pending = self.pending.lock().unwrap();
            match pending.as_ref() {
                Some(p) if p.request == request => {
                    let ticket = p.ticket;
                    let result = match p.answer {
                        _ if now >= p.expires => PairPoll::Expired,
                        Some(true) => PairPoll::Approved { key: to_hex(&*self.key.lock().unwrap()) },
                        Some(false) => PairPoll::Denied,
                        None => return PairPoll::Waiting { code: p.code.clone() },
                    };
                    *pending = None;
                    events.push(PairEvent::Closed(ticket));
                    result
                }
                Some(p) if p.answer.is_none() && now < p.expires => PairPoll::Busy,
                // Nothing waiting (or only a finished request nobody collected): start this one.
                stale => {
                    if let Some(old) = stale { events.push(PairEvent::Closed(old.ticket)); }
                    let p = PairRequest {
                        ticket: self.next_ticket.fetch_add(1, Relaxed),
                        request: request.to_string(),
                        browser: browser.to_string(),
                        code: pair_code(request),
                        expires: now + self.ttl,
                        answer: None,
                    };
                    let code = p.code.clone();
                    events.push(PairEvent::Ask(prompt_of(&p, now)));
                    *pending = Some(p);
                    PairPoll::Waiting { code }
                }
            }
        };
        // Outside the lock: the callback talks to the UI.
        for e in events { (self.on_event)(e); }
        result
    }
}

fn prompt_of(p: &PairRequest, now: Instant) -> PairPrompt {
    PairPrompt {
        ticket: p.ticket,
        browser: p.browser.clone(),
        code: p.code.clone(),
        expires_in_ms: p.expires.saturating_duration_since(now).as_millis() as u64,
    }
}

/// 4-digit code shown in both fastdl and the extension. The extension computes the same thing
/// (see extension/common.js `pairCode`), so a request made by another program shows a different code.
fn pair_code(request: &str) -> String {
    let d = Sha256::digest(format!("fastdl-pair:{request}").as_bytes());
    format!("{:04}", u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 10_000)
}

/// The browser name for the Allow window: short, plain ASCII, never empty.
fn clean_browser(name: &str) -> String {
    let s: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || " .-()".contains(*c)).take(40).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() { "A browser".into() } else { s }
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

#[derive(Deserialize)]
struct PairReq {
    request: String,
    #[serde(default)]
    browser: String,
}

struct Ctx {
    engine: Arc<Engine>,
    pairing: Arc<Pairing>,
    on_add: Box<dyn Fn() + Send + Sync>,
}

pub fn start(engine: Arc<Engine>, pairing: Arc<Pairing>, on_add: Box<dyn Fn() + Send + Sync>) {
    // Bind right away (not in the background) so READY is correct before the window asks.
    let Ok(std_listener) = std::net::TcpListener::bind(("127.0.0.1", PORT)) else { return };
    if std_listener.set_nonblocking(true).is_err() { return; }
    READY.store(true, Relaxed);
    let ctx = Arc::new(Ctx { engine, pairing, on_add });
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(std_listener) else { READY.store(false, Relaxed); return };
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let ctx = ctx.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(MAX_CONNECTION, handle(sock, ctx)).await;
            });
        }
    });
}

struct Request { path: String, head: String, body: Vec<u8> }

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.split("\r\n").skip(1).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
}

async fn handle(mut sock: TcpStream, ctx: Arc<Ctx>) -> std::io::Result<()> {
    let req = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut sock)).await {
        Ok(Ok(Some(req))) => req,
        Ok(Ok(None)) | Err(_) => return Ok(()), // already answered, or too slow
        Ok(Err(e)) => return Err(e),
    };
    let (status, body) = route(&req, &ctx).await;
    reply(&mut sock, status, &body).await
}

/// Read one request and run the checks every route needs. Replies and returns None if it fails one.
async fn read_request(sock: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf = Vec::with_capacity(2048);
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i; }
        if buf.len() > MAX_HEAD { reply(sock, 431, r#"{"error":"headers too large"}"#).await?; return Ok(None); }
        if sock.read_buf(&mut buf).await? == 0 { return Ok(None); }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut req_line = head.split("\r\n").next().unwrap_or("").split(' ');
    let (method, path) = (req_line.next().unwrap_or("").to_string(), req_line.next().unwrap_or("").to_string());
    let mut req = Request { path, head, body: Vec::new() };

    if req.header("origin") != Some(EXTENSION_ORIGIN) {
        reply(sock, 403, r#"{"error":"forbidden"}"#).await?;
        return Ok(None);
    }
    let host_ok = matches!(req.header("host"), Some(h) if h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}"));
    if !host_ok { reply(sock, 403, r#"{"error":"forbidden"}"#).await?; return Ok(None); }
    if method != "POST" { reply(sock, 404, r#"{"error":"not found"}"#).await?; return Ok(None); }

    let len: usize = req.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY { reply(sock, 413, r#"{"error":"too large"}"#).await?; return Ok(None); }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let mut chunk = vec![0; len - body.len()];
        let n = sock.read(&mut chunk).await?;
        if n == 0 { break; }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    req.body = body;
    Ok(Some(req))
}

const BAD_REQUEST: &str = r#"{"error":"bad request"}"#;

async fn route(req: &Request, ctx: &Ctx) -> (u16, String) {
    match req.path.as_str() {
        "/v1/ping" => {
            let Ok(ping) = serde_json::from_slice::<PingReq>(&req.body) else { return (400, BAD_REQUEST.into()) };
            if ping.nonce.is_empty() || ping.nonce.len() > 128 { return (400, BAD_REQUEST.into()); }
            let proof = to_hex(&ctx.pairing.mac(format!("ping:{}", ping.nonce).as_bytes()).finalize().into_bytes());
            (200, serde_json::json!({ "app": "fastdl", "version": env!("CARGO_PKG_VERSION"), "proof": proof }).to_string())
        }
        "/v1/add" => {
            // Only the paired extension knows the key, so only it can sign requests.
            let signed = req.header("x-fastdl-auth").and_then(from_hex).is_some_and(|sig| {
                let mut msg = b"add:".to_vec();
                msg.extend_from_slice(&req.body);
                ctx.pairing.mac(&msg).verify_slice(&sig).is_ok()
            });
            if !signed { return (401, r#"{"error":"not paired"}"#.into()); }
            let Ok(add) = serde_json::from_slice::<AddReq>(&req.body) else { return (400, BAD_REQUEST.into()) };
            let mut headers = Vec::new();
            if let Some(c) = add.cookies.filter(|c| !c.is_empty()) { headers.push(("Cookie".to_string(), c)); }
            if let Some(r) = add.referrer.filter(|r| r.starts_with("http://") || r.starts_with("https://")) {
                headers.push(("Referer".to_string(), r));
            }
            match ctx.engine.add(add.url, headers, true) {
                Ok(_) => { (ctx.on_add)(); (200, r#"{"ok":true}"#.into()) }
                Err(e) => (400, serde_json::json!({ "error": e }).to_string()),
            }
        }
        "/v1/pair" => {
            let Ok(pair) = serde_json::from_slice::<PairReq>(&req.body) else { return (400, BAD_REQUEST.into()) };
            let valid_id = pair.request.len() == 32 && pair.request.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
            if !valid_id { return (400, BAD_REQUEST.into()); }
            pair_long_poll(&ctx.pairing, &pair.request, &clean_browser(&pair.browser)).await
        }
        _ => (404, r#"{"error":"not found"}"#.into()),
    }
}

/// Wait (up to PAIR_LONG_POLL) for you to answer, so the extension hears back the moment you click.
async fn pair_long_poll(pairing: &Pairing, request: &str, browser: &str) -> (u16, String) {
    let deadline = tokio::time::Instant::now() + PAIR_LONG_POLL;
    // Subscribe before polling, so an answer given in between still wakes us.
    let mut answered = pairing.answered.subscribe();
    loop {
        match pairing.poll(request, browser) {
            PairPoll::Waiting { code } => {
                if tokio::time::timeout_at(deadline, answered.changed()).await.is_err() {
                    return (200, serde_json::json!({ "status": "pending", "code": code }).to_string());
                }
            }
            PairPoll::Approved { key } => return (200, serde_json::json!({ "status": "approved", "key": key }).to_string()),
            PairPoll::Denied => return (200, r#"{"status":"denied"}"#.into()),
            PairPoll::Expired => return (200, r#"{"status":"expired"}"#.into()),
            PairPoll::Busy => return (409, r#"{"status":"busy"}"#.into()),
        }
    }
}

async fn reply(sock: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let text = match status {
        200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found",
        409 => "Conflict", 413 => "Payload Too Large", 431 => "Request Header Fields Too Large", _ => "Error",
    };
    let resp = format!(
        "HTTP/1.1 {status} {text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes()).await?;
    sock.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQ_A: &str = "0123456789abcdef0123456789abcdef";
    const REQ_B: &str = "fedcba9876543210fedcba9876543210";

    /// A Pairing in a fresh temp folder that records the events it sends to the UI.
    fn pairing(ttl: Duration) -> (Arc<Pairing>, Arc<Mutex<Vec<String>>>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fastdl-pair-test-{}-{}", std::process::id(), rand_u64()));
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        let p = Pairing::with_ttl(&dir, Box::new(move |e| l.lock().unwrap().push(match e {
            PairEvent::Ask(p) => format!("ask {} {} {}", p.ticket, p.browser, p.code),
            PairEvent::Closed(t) => format!("closed {t}"),
        })), ttl);
        (p, log, dir)
    }

    fn rand_u64() -> u64 { let mut b = [0u8; 8]; getrandom::fill(&mut b).unwrap(); u64::from_le_bytes(b) }

    fn key_hex(p: &Pairing) -> String { to_hex(&*p.key.lock().unwrap()) }

    #[test]
    fn approve_hands_over_the_key_once() {
        let (p, log, dir) = pairing(PAIR_TTL);
        let code = pair_code(REQ_A);
        assert_eq!(p.poll(REQ_A, "Chromium"), PairPoll::Waiting { code: code.clone() });
        assert_eq!(p.poll(REQ_A, "Chromium"), PairPoll::Waiting { code: code.clone() }, "polling again doesn't restart it");
        let prompt = p.current_prompt().expect("prompt is waiting");
        assert_eq!((prompt.browser.as_str(), prompt.code.as_str()), ("Chromium", code.as_str()));
        p.answer(prompt.ticket, true).unwrap();
        assert!(p.current_prompt().is_none(), "answered requests aren't shown again");
        assert_eq!(p.poll(REQ_A, "Chromium"), PairPoll::Approved { key: key_hex(&p) });
        // Collected: the next poll with the same ID starts a brand new request, it doesn't get the key again.
        assert_eq!(p.poll(REQ_A, "Chromium"), PairPoll::Waiting { code });
        assert_eq!(*log.lock().unwrap(), vec![
            format!("ask 1 Chromium {}", pair_code(REQ_A)),
            "closed 1".to_string(),
            format!("ask 2 Chromium {}", pair_code(REQ_A)),
        ]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn deny_and_answering_twice() {
        let (p, _, dir) = pairing(PAIR_TTL);
        p.poll(REQ_A, "Edge");
        let t = p.current_prompt().unwrap().ticket;
        p.answer(t, false).unwrap();
        assert!(p.answer(t, true).is_err(), "can't change an answer");
        assert_eq!(p.poll(REQ_A, "Edge"), PairPoll::Denied);
        assert!(p.answer(t, true).is_err(), "can't answer a finished request");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn one_request_at_a_time() {
        let (p, _, dir) = pairing(PAIR_TTL);
        p.poll(REQ_A, "Chromium");
        assert_eq!(p.poll(REQ_B, "Other"), PairPoll::Busy);
        let prompt = p.current_prompt().unwrap();
        assert_eq!(prompt.code, pair_code(REQ_A), "the second request didn't replace the first");
        assert!(p.answer(prompt.ticket + 1, true).is_err(), "wrong ticket");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn uncollected_answer_doesnt_block_the_next_request() {
        let (p, log, dir) = pairing(PAIR_TTL);
        p.poll(REQ_A, "Chromium");
        p.answer(p.current_prompt().unwrap().ticket, true).unwrap();
        // The extension never came back for the key (e.g. the browser closed). A new request starts.
        assert_eq!(p.poll(REQ_B, "Chromium"), PairPoll::Waiting { code: pair_code(REQ_B) });
        assert_eq!(p.poll(REQ_A, "Chromium"), PairPoll::Busy, "the old ID can't collect the key any more");
        assert_eq!(log.lock().unwrap()[1], "closed 1");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn requests_expire() {
        let (p, log, dir) = pairing(Duration::from_millis(30));
        p.poll(REQ_A, "Chromium");
        let t = p.current_prompt().unwrap().ticket;
        std::thread::sleep(Duration::from_millis(60));
        assert!(p.current_prompt().is_none());
        assert!(p.answer(t, true).is_err());
        assert_eq!(p.poll(REQ_A, "Chromium"), PairPoll::Expired);
        assert_eq!(log.lock().unwrap().last().unwrap(), "closed 1");
        // An expired request doesn't block a new one.
        p.poll(REQ_B, "Chromium");
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(p.poll(REQ_A, "Chromium"), PairPoll::Waiting { code: pair_code(REQ_A) });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn long_poll_wakes_up_on_answer() {
        let (p, _, dir) = pairing(PAIR_TTL);
        let p2 = p.clone();
        let waiter = tokio::spawn(async move { pair_long_poll(&p2, REQ_A, "Chromium").await });
        // Wait for the request to show up, then answer it.
        let ticket = loop {
            if let Some(pr) = p.current_prompt() { break pr.ticket; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        let started = Instant::now();
        p.answer(ticket, true).unwrap();
        let (status, body) = waiter.await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "answered right away, not at the long-poll timeout");
        assert_eq!(status, 200);
        assert_eq!(body, serde_json::json!({ "status": "approved", "key": key_hex(&p) }).to_string());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn code_matches_the_extension() {
        // test/extension-test.js checks extension/common.js `pairCode` gives the same codes.
        for (request, code) in PAIR_CODE_VECTORS { assert_eq!(pair_code(request), *code, "{request}"); }
    }
    const PAIR_CODE_VECTORS: &[(&str, &str)] = &[(REQ_A, "9544"), (REQ_B, "2731")];

    #[test]
    fn browser_names_are_cleaned() {
        assert_eq!(clean_browser("Microsoft Edge"), "Microsoft Edge");
        assert_eq!(clean_browser("  <script>alert(1)</script>  "), "scriptalert(1)script");
        assert_eq!(clean_browser("Brave\u{202e}exe.pdf"), "Braveexe.pdf");
        assert_eq!(clean_browser(""), "A browser");
        assert_eq!(clean_browser(&"x".repeat(100)).len(), 40);
    }

    #[test]
    fn key_survives_a_restart() {
        let (p, _, dir) = pairing(PAIR_TTL);
        let shown = p.display();
        let again = Pairing::load(&dir, Box::new(|_| {}));
        assert_eq!(again.display(), shown);
        assert_eq!(shown.len(), 32 + 7, "32 hex digits in 8 groups");
        let _ = std::fs::remove_dir_all(dir);
    }
}
