# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (the website). The product itself is a desktop app for Windows (primary) and macOS, plus a Chromium browser extension.

## Stack

Delegated (2026-11-24). The owner said "I don't really like static", meaning the site should not feel flat or lifeless; the technology was left to us. Choice: **Astro** in `site/`, prerendered to HTML (fast, nothing to run on a server), with small interactive pieces where they earn it, deployed to **GitHub Pages** by a GitHub Actions workflow. A custom domain is added later; until then it lives at `mahmoudsr.github.io/fastdl`.

## Users

People on Windows who download big or many files (installers, ISOs, videos, archives, course material) and find browser downloads slow or fragile. Many already know what a download manager is; they want one that is free with no trial, small, and that picks up their browser downloads on its own. Secondary: macOS users, and people who carry their tools on a USB stick (portable mode).

## Product Purpose

fastdl is a fast, small, modern download manager. It splits each file into pieces and downloads them over several connections at once, so it is often much faster than the browser. A browser extension hands browser downloads to the app. Success for the website: a visitor understands what fastdl does in seconds, trusts it enough to run an unsigned installer, downloads the right file for their system, and gets the extension connected without needing the README.

## Positioning

- Free and open source (GPL-3.0). No trial, no paid tier, no ads.
- Small: installer about 1.8 MB, about 30 MB of memory.
- Polite to servers: 8 connections by default, ramps up gradually, backs off when a server refuses, respects Retry-After, identifies itself honestly. It won't get your IP blocked.
- Keeps every connection busy to the end: when a piece finishes early, it splits the biggest remaining piece.
- Security designed in the open: localhost-only bridge, origin checks, HMAC-signed pairing with a 4-digit code, Mark-of-the-Web on finished files, file-name sanitising, opt-in cookies kept in memory only.

**Do not name competing products** (owner's instruction, 2026-11-24). Speed is shown against a plain browser download, not against other download managers.

## Operating Context

- Install: `fastdl_x.y.z_x64-setup.exe` (Windows installer), `fastdl_x.y.z_x64-portable.zip` (Windows portable), `fastdl_x.y.z_universal.dmg` (Mac). Downloads come from GitHub Releases; the latest is v0.2.1 (2026-11-24). Asset names contain the version, so links must resolve the latest release.
- The app is not code-signed: Windows SmartScreen shows "Windows protected your PC" (More info → Run anyway); macOS needs right-click → Open the first time.
- Extension: `fastdl-extension.crx` (Ungoogled Chromium and other Chromium builds: drag onto chrome://extensions with Developer mode) or `fastdl-extension.zip` (Chrome, Edge, Brave, Opera: Load unpacked). Not in any extension store yet.
- Connecting: fastdl asks "Allow this browser to connect?" with a matching 4-digit code; or click Connect in the extension. A key can be pasted instead.
- Daily use: browser downloads go to fastdl; with "Ask" on, a small New download window; with it off, downloads start silently. Lives in the tray. Mini view (Ctrl+M). In progress list shows running, then queue order, then paused.
- Portable mode: `fastdl.ini` next to `fastdl.exe` → everything in a `data` folder, nothing in AppData; needs the WebView2 runtime (built into Windows 10/11).

## Capabilities and Constraints

Confirmed features (README, v0.2.1): multi-connection downloads with dynamic piece splitting; pause/resume across restarts when the server supports it; browser extension for Chrome, Edge, Brave, Opera and Chromium builds; no browser Save-as window when fastdl takes a download; optional login cookies; queue; speed limit; dark and light themes; mini view; multi-select and bulk remove; tray with optional start at sign-in (off by default, not in portable mode); single instance; portable mode; built with Tauri and Rust.

Undecided: domain name; extension store listings; code signing.

## Brand Commitments

- Name is always lowercase: **fastdl**.
- App icon: white download arrow on a teal rounded square (`app/src-tauri/icons/`). App accent teal `#0d9488` (light) / `#2dd4bf` (dark).
- Voice (from the README): plain, short sentences, honest about limits ("No download manager can beat your line speed", "The honest limits"). No hype words.

## Evidence on Hand

- App screenshot: `docs/screenshot.png` (dark theme, simulated downloads). The UI can also be opened directly in a browser with simulated downloads (`app/ui/index.html`), so fresh screenshots can be made.
- Speed measurement (local server capping each connection at 2 MB/s): fastdl 60 MB in 4.9 s (12.2 MB/s), 250 MB in 19.0 s (13.1 MB/s); a single browser-style connection got 1.7 MB/s on the same server. On uncapped servers or when the line is the bottleneck, every tool is equally fast.
- Sizes: installer 1.8 MB, portable zip 2.4 MB, dmg 4.8 MB, extension 14 KB.
- No testimonials, user counts, download counts, press, or reviews exist. Do not invent any.

## Product Principles

1. Honest numbers only: every claim traces to the README or a release.
2. Get people to a working setup: download, past the unsigned-app warning, extension connected.
3. Respect the visitor the way fastdl respects servers: fast page, no trackers, no dark patterns.
4. Open by default: source, license and security model are one click away.

## Accessibility & Inclusion

WCAG 2.2 AA. Works with keyboard and screen readers, respects reduced motion, readable in light and dark.
