//! Runs the browser-extension endpoint (127.0.0.1:17385) without a window, for test/extension-test.js.
//! Usage: cargo run --example bridge_check -- <data_dir>
//! Prints one line per event:  READY | PORT-BUSY | ASK <ticket> <code> <browser> | CLOSED <ticket> | ADDED
//! Reads answers on stdin:      allow <ticket> | deny <ticket>      (exits when stdin closes)

use fastdl_lib::bridge::{self, PairEvent, Pairing};
use fastdl_lib::engine::{Emit, Engine};
use std::io::BufRead;
use std::sync::atomic::Ordering;

fn main() {
    let data = std::path::PathBuf::from(std::env::args().nth(1).expect("usage: bridge_check <data_dir>"));
    let emit: Emit = Box::new(|_, _| {});
    let engine = Engine::new(emit, data.join("state"), data.to_string_lossy().into_owned());
    let pairing = Pairing::load(&data, Box::new(|e| match e {
        PairEvent::Ask(p) => println!("ASK {} {} {}", p.ticket, p.code, p.browser),
        PairEvent::Closed(t) => println!("CLOSED {t}"),
    }));
    bridge::start(engine, pairing.clone(), Box::new(|| println!("ADDED")));
    if !bridge::READY.load(Ordering::Relaxed) {
        println!("PORT-BUSY");
        return;
    }
    println!("READY");
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap_or_default();
        let mut words = line.split_whitespace();
        let (Some(cmd), Some(ticket)) = (words.next(), words.next().and_then(|t| t.parse().ok())) else { continue };
        if let Err(e) = pairing.answer(ticket, cmd == "allow") { println!("ERROR {e}"); }
    }
}
