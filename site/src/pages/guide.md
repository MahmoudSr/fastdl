---
layout: ../layouts/Guide.astro
title: Guide
description: How to install fastdl on Windows and Mac, add the browser extension, connect it, and use portable mode. Also where fastdl keeps your settings and how its security works.
lede: Install fastdl, add the browser extension and connect the two. It takes a few minutes, once.
---

## Install fastdl

Download fastdl from the [latest release](https://github.com/MahmoudSr/fastdl/releases/latest). Pick one:

| File | For |
|---|---|
| `fastdl_x.y.z_x64-setup.exe` | Windows 10 and 11: the installer |
| `fastdl_x.y.z_x64-portable.zip` | Windows, without installing: see [portable mode](#portable-mode) |
| `fastdl_x.y.z_universal.dmg` | Mac |

### Windows

Run the installer. fastdl isn't code-signed yet, so Windows may show **Windows protected your PC**. Click **More info**, then **Run anyway**.

### Mac

Open the `.dmg` and drag fastdl to Applications. It isn't notarized yet, so the first time you start it, right-click fastdl and choose **Open**.

## Add the browser extension

The extension sends your browser downloads to fastdl. It works in Chrome, Edge, Brave, Opera and other Chromium browsers. It's optional: you can always paste links into fastdl yourself.

The extension isn't in the Chrome Web Store or Edge Add-ons yet, so you load it yourself. Both files are in the same release as the app.

### Chrome, Edge, Brave, Opera

1. Download `fastdl-extension.zip` and unzip it somewhere you'll keep it.
2. Open `chrome://extensions` (in Edge, `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder.

Chrome and Edge only accept `.crx` files from their own stores, which is why they need the unzipped folder.

### Ungoogled Chromium and other Chromium builds

1. Download `fastdl-extension.crx`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Drag the `.crx` file onto the page.

In Ungoogled Chromium you can also set `chrome://flags/#extension-mime-request-handling` to **Always prompt for install**, then just click the `.crx` link on the release page.

Both files have the same fixed extension ID, so fastdl trusts either one. A `.crx` you pack yourself gets a different ID, and fastdl won't accept it.

> Using another download manager's browser extension too? Turn it off, or both will try to take the same downloads.

## Connect the extension

You do this once per browser.

1. If fastdl is open when you install the extension, it asks **Allow this browser to connect?** by itself. Otherwise, click the fastdl icon in the browser's toolbar and click **Connect**.
2. fastdl and the extension each show a 4-digit code. Check they match.
3. Click **Allow** in fastdl.

The code is there so you can tell your browser's request apart from one made by another program. A request waits for 2 minutes at most.

Prefer typing? Click **Paste a key instead** in the extension, and copy the key from fastdl's **Settings**.

## Everyday use

**Browser downloads.** Click a download in your browser and fastdl takes it. With **Ask before starting downloads** on (in Settings), a small **New download** window asks where to save it while fastdl stays in the background. Tick **Don't ask again** and downloads start silently, with no window at all. If fastdl isn't running, the browser downloads the file normally.

**Pasting links.** Paste a link into the box at the top, or press `Ctrl+V` anywhere in the window.

**What's next.** **In progress** shows what's downloading now, then the queue in the order it will start ("Queued · next", "#2"…), then paused downloads. **All** shows the same, above your finished downloads.

**Mini view.** `Ctrl+M` turns fastdl into a small always-on-top bar with your active downloads.

**Cleaning up.** Select downloads with click, `Ctrl`+click or `Shift`+click, or press `Ctrl+A` for all of them, then `Del` to remove them. Double-click a finished download to open it.

**The tray.** Closing the window keeps fastdl running next to the clock, so browser downloads still reach it. Click the icon to open fastdl, right-click it to quit. fastdl can also start when you sign in to Windows (Settings, off by default).

**Downloads that need you to be signed in.** Some sites only let you download when you're logged in. In the extension, turn on sending login cookies; Chrome asks you to allow it first. It's off by default.

## Portable mode

The portable zip runs fastdl without installing it, from any folder or a USB stick.

1. Unzip `fastdl_x.y.z_x64-portable.zip` anywhere.
2. Run `fastdl.exe`.

The zip includes a file named `fastdl.ini` next to `fastdl.exe`. While it's there, fastdl keeps everything in a `data` folder next to `fastdl.exe` and writes nothing to AppData. Move the folder and your settings move with it. Delete `fastdl.ini` to go back to normal mode.

If fastdl can't write next to the exe (a read-only drive, or a folder like Program Files), it uses the normal folders for that run and tells you so.

**Start fastdl when I sign in** isn't available in portable mode, because it would have to write to the registry.

The portable app needs the Microsoft Edge WebView2 Runtime, which comes with Windows 10 and 11.

## Where your settings are

fastdl shows the folder in **Settings → Settings are saved in**, with a button to open it. It holds:

- `downloads.json`: your settings and the download list
- `extension-key.txt`: the key the browser extension uses

Installed on Windows, that's `%APPDATA%\com.fastdl.desktop`. The window's browser data (WebView2) is in `%LOCALAPPDATA%\com.fastdl.desktop` and stays a few MB: fastdl turns off the web caches WebView2 would otherwise keep.

fastdl doesn't keep settings in the registry. The `HKEY_CURRENT_USER\Software\fastdl` key only records where the installer put fastdl, for updates and uninstalling. The only value fastdl itself ever writes is the one Windows uses for **Start fastdl when I sign in**, and only while that's switched on.

## Upgrading from 0.1

The extension got a new, permanent ID in 0.2.0. Remove the old fastdl extension from `chrome://extensions`, install the new one, and click **Connect** once. Update the app too: fastdl 0.2 and later only accept the new extension.

## Security

### Between the extension and fastdl

- The extension talks to fastdl only through `127.0.0.1:17385`, which other computers can't reach.
- fastdl only accepts requests that carry the fastdl extension's fixed ID. Browsers don't let websites fake it, so websites can't push downloads into fastdl.
- fastdl and the extension share a random key. Before sending anything, the extension asks fastdl to prove it has the key (HMAC-SHA256), so another program listening on that port never receives your links or cookies. Every download request is signed too, so other programs can't add downloads.
- One-click pairing hands the key to the extension only after you click **Allow** in fastdl, and only one request can wait at a time.
- The `Host` header is checked, which blocks DNS-rebinding tricks, and requests have strict size limits and timeouts.

The honest limits: while you pair, the extension can't yet tell the real fastdl from a fake program that took its port while fastdl was closed. (When fastdl is running, it holds the port, so nothing else can be there.) And no local scheme like this can stop malware that already runs as your Windows user. Pairing keeps out websites and other programs; it isn't a defence against malware on your PC.

### Downloaded files

- Finished files get Windows' "downloaded from the internet" mark, like browser downloads, so SmartScreen and Office Protected View still check them.
- File names from servers are cleaned: no folder tricks (`../`), no invisible characters that could disguise `invoice.exe` as `invoice.pdf`, no Windows device names (`CON`, `NUL`…), no over-long names.
- Every piece a server sends is checked against what was asked for, so a broken server or proxy can't produce a silently corrupted file.
- When resuming, fastdl checks the file hasn't changed on the server, so you never get a mix of an old and a new version.

### Your data

By default the extension has no access to the websites you visit. Sending login cookies is an opt-in switch that Chrome asks you to allow. Cookies are kept in memory only, never written to disk, and dropped when the download finishes.

The Windows and Mac releases are built by GitHub Actions from the public code ([release.yml](https://github.com/MahmoudSr/fastdl/blob/main/.github/workflows/release.yml)). Found a security problem? Please [open an issue](https://github.com/MahmoudSr/fastdl/issues), or contact the maintainer privately first for anything serious.

## Questions

### Why is it faster than my browser?

Many servers limit how fast each connection may go. A browser downloads a file over one connection; fastdl uses several at once, each pulling its own piece. When one piece finishes early, fastdl splits the biggest piece left, so every connection stays busy until the end.

### Will it always be faster?

No. On a server that doesn't limit connections, or when your internet line is the slowest part, every tool gets the same speed. No download manager can beat your line speed.

### Will it get my IP blocked?

fastdl is careful not to: 8 connections by default, 4 at first and then one at a time, no new connections once a server refuses one, and it waits when a server asks it to.

### Does it cost anything?

No. fastdl is free and open source under the GPL-3.0 license. There's no trial, no ads and no account.

### Why does Windows warn me about it?

fastdl isn't code-signed yet, and signing certificates cost money every year. The code and the build are public: every release is built by GitHub Actions from the repository.
