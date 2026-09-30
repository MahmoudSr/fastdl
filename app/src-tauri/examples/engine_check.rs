//! Headless check of the download engine (no window).
//! Usage: cargo run --release --example engine_check -- <url> <out_dir> <connections> [pause_after_ms]
//! Prints: DONE <seconds> <file path>   or   FAILED <error>

use fastdl_lib::engine::{Emit, Engine};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (url, out, conns) = (a[1].clone(), a[2].clone(), a[3].parse::<u32>().unwrap());
    let pause_after = a.get(4).and_then(|v| v.parse::<u64>().ok());

    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    let emit: Emit = Box::new(move |ev, v| { if ev == "item" { let _ = tx.send(v); } });
    let data = std::path::Path::new(&out).join(".state");
    let engine = Engine::new(emit, data, out.clone());
    let mut s: fastdl_lib::engine::Settings = serde_json::from_value(serde_json::to_value(engine.state()).unwrap()["settings"].clone()).unwrap();
    s.connections = conns;
    s.dir = out;
    engine.set_settings(s);

    let t0 = Instant::now();
    let id = engine.add(url, vec![], false).unwrap_or_else(|e| { println!("FAILED {e}"); std::process::exit(1) });
    let id = serde_json::to_value(id).unwrap()["id"].as_u64().unwrap();
    let mut paused_once = false;
    loop {
        let timeout = match pause_after {
            Some(ms) if !paused_once => Duration::from_millis(ms).saturating_sub(t0.elapsed()),
            _ => Duration::from_secs(600),
        };
        match rx.recv_timeout(timeout) {
            Ok(v) => match v["status"].as_str().unwrap() {
                "completed" => {
                    let path = std::path::Path::new(v["dir"].as_str().unwrap()).join(v["name"].as_str().unwrap());
                    println!("DONE {:.2} {}", t0.elapsed().as_secs_f64(), path.display());
                    return;
                }
                "failed" => { println!("FAILED {}", v["error"]); std::process::exit(1) }
                "paused" => {
                    println!("PAUSED after {:.1}s, resuming", t0.elapsed().as_secs_f64());
                    std::thread::sleep(Duration::from_millis(500));
                    engine.resume(id);
                }
                _ => {}
            },
            Err(mpsc::RecvTimeoutError::Timeout) if !paused_once && pause_after.is_some() => {
                paused_once = true;
                engine.pause(id);
            }
            Err(_) => { println!("FAILED timeout"); std::process::exit(1) }
        }
    }
}
