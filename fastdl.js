#!/usr/bin/env node
'use strict';
// fastdl - multi-connection downloader (IDM-style segmented downloading).
// Usage: node fastdl.js <url> [-c 8] [-o file]

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'fastdl/1.0'; // honest UA: fake browser UAs get flagged by anti-bot filters
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 256 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 256 }),
};
const MIN_SPLIT = 512 * 1024; // never split a segment into pieces smaller than this
const MAX_RETRIES = 10;       // per segment
const STALL_MS = 20000;       // drop a connection that sends nothing for this long
const RAMP_MS = 250;          // delay between opening each new connection

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url, headers = {}, redirects = 10) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      agent: agents[u.protocol],
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('Too many redirects'));
        return resolve(get(new URL(res.headers.location, u).href, headers, redirects - 1));
      }
      res.url = u.href;
      resolve(res);
    });
    req.on('error', reject);
    // Socket idle timeout: covers both slow connects and stalled transfers.
    req.setTimeout(STALL_MS, () => req.destroy(new Error('Connection stalled')));
  });
}

const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

function pickName(res) {
  const cd = res.headers['content-disposition'] || '';
  let m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  let name = m ? safeDecode(m[1].replace(/"/g, '')) : null;
  if (!name && (m = /filename="?([^";]+)"?/i.exec(cd))) name = m[1];
  if (!name) name = safeDecode(path.basename(new URL(res.url).pathname)) || 'download';
  // Also replace invisible characters that can disguise a file type (e.g. right-to-left override).
  return name.replace(/[<>:"/\\|?*\x00-\x1f​-‏‪-‮⁠-⁩﻿]/g, '_') || 'download';
}

// Ask for one byte to learn the size, final URL, and whether ranges work.
async function probe(url) {
  const res = await get(url, { Range: 'bytes=0-0' });
  res.destroy();
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
  let size = null, ranges = false;
  if (res.statusCode === 206) {
    const m = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
    if (m) { size = Number(m[1]); ranges = true; }
  } else if (res.headers['content-length']) {
    size = Number(res.headers['content-length']);
  }
  return { url: res.url, size, ranges, filename: pickName(res) };
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function download(url, opts = {}) {
  const conns = opts.connections || 8;
  const log = opts.quiet ? () => {} : s => process.stderr.write(s);
  const info = await probe(url);
  const out = path.resolve(opts.output || info.filename);
  const partPath = out + '.part';
  const statePath = out + '.part.json';
  const t0 = Date.now();
  let received = 0;

  // Progress / speed meter
  const samples = [];
  const meter = setInterval(() => {
    const now = Date.now();
    samples.push([now, received]);
    while (samples.length > 1 && now - samples[0][0] > 3000) samples.shift();
    const [t, b] = samples[0];
    const speed = now > t ? (received - b) / ((now - t) / 1000) : 0;
    const pct = info.size ? ((done() / info.size) * 100).toFixed(1) + '%' : '';
    const eta = info.size && speed ? Math.ceil((info.size - done()) / speed) + 's' : '-';
    log(`\r${pct.padStart(6)}  ${fmtBytes(done())} / ${info.size ? fmtBytes(info.size) : '?'}  ` +
        `${fmtBytes(speed)}/s  conns ${active()}  ETA ${eta}      `);
    if (opts.onProgress) opts.onProgress({ done: done(), size: info.size, speed });
  }, 500);

  let segs = [];
  const done = () => info.ranges ? segs.reduce((a, s) => a + (s.wpos - s.start), 0) : received;
  const active = () => segs.filter(s => s.active).length;

  try {
    if (!info.ranges || !info.size) {
      // Server can't do ranges: plain single-stream download.
      const res = await get(info.url);
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
      const ws = fs.createWriteStream(partPath);
      for await (const chunk of res) {
        received += chunk.length;
        if (!ws.write(chunk)) await new Promise(r => ws.once('drain', r));
      }
      await new Promise((r, j) => ws.end(e => e ? j(e) : r()));
    } else {
      // Resume from saved state if it matches this file.
      let state = null;
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
      if (state && state.size === info.size && fs.existsSync(partPath)) {
        segs = state.segs.map(s => ({ start: s.start, pos: s.wpos, wpos: s.wpos, end: s.end, active: false, errors: 0 }));
        log(`Resuming: ${fmtBytes(done())} already downloaded\n`);
      } else {
        const fd = fs.openSync(partPath, 'w');
        fs.ftruncateSync(fd, info.size);
        fs.closeSync(fd);
        const n = Math.max(1, Math.min(conns, Math.floor(info.size / MIN_SPLIT)));
        const step = Math.ceil(info.size / n);
        for (let s = 0; s < info.size; s += step) {
          segs.push({ start: s, pos: s, wpos: s, end: Math.min(s + step, info.size) - 1, active: false, errors: 0 });
        }
      }
      log(`${path.basename(out)}  ${fmtBytes(info.size)}  up to ${conns} connections\n`);

      const fh = await fs.promises.open(partPath, 'r+');
      const saveState = () => fs.writeFileSync(statePath, JSON.stringify({
        url: info.url, size: info.size,
        segs: segs.filter(s => s.wpos <= s.end).map(({ start, wpos, end }) => ({ start, wpos, end })),
      }));
      const saver = setInterval(saveState, 1000);
      let fatal = null;

      // Dynamic segmentation: when a connection is free, split the biggest
      // remaining segment in half and take the back half.
      const steal = () => {
        let best = null;
        for (const s of segs) if (s.active && (!best || s.end - s.pos > best.end - best.pos)) best = s;
        if (!best || best.end - best.pos + 1 < 2 * MIN_SPLIT) return null;
        const mid = best.pos + Math.floor((best.end - best.pos + 1) / 2);
        const ns = { start: mid, pos: mid, wpos: mid, end: best.end, active: false, errors: 0 };
        best.end = mid - 1;
        segs.push(ns);
        return ns;
      };

      const fetchSeg = async seg => {
        const res = await get(info.url, { Range: `bytes=${seg.pos}-${seg.end}` });
        if (res.statusCode !== 206) {
          res.destroy();
          const err = new Error(`HTTP ${res.statusCode} for range request`);
          const ra = Number(res.headers['retry-after']);
          if (ra > 0) err.retryAfter = Math.min(ra, 60) * 1000;
          throw err;
        }
        for await (const chunk of res) {
          const n = Math.min(chunk.length, seg.end - seg.pos + 1);
          if (n <= 0) break;
          const p = seg.pos;
          seg.pos += n;
          received += n;
          await fh.write(chunk, 0, n, p);
          seg.wpos = p + n;
          if (seg.pos > seg.end || fatal) break; // segment may have shrunk after a split
        }
      };

      // Servers that refuse too many connections: a failing worker retires
      // while others are still working, so we settle at what the server allows.
      let live = 0, refused = false;
      const worker = async () => {
        while (!fatal) {
          const seg = segs.find(s => !s.active && s.pos <= s.end) || steal();
          if (!seg) break;
          seg.active = true;
          try {
            await fetchSeg(seg);
            seg.errors = 0;
          } catch (e) {
            seg.pos = seg.wpos; // re-fetch anything not safely written
            seg.errors++;
            refused = true;
            if (live > 1) { seg.active = false; break; }
            if (seg.errors > MAX_RETRIES) fatal = e;
            else await sleep(e.retryAfter || Math.min(500 * 2 ** seg.errors, 8000));
          } finally {
            seg.active = false;
          }
        }
        live--;
      };

      // Ramp up one connection at a time; stop adding as soon as the server pushes back.
      const running = [];
      for (let i = 0; i < conns && !refused && !fatal; i++) {
        live++;
        running.push(worker());
        if (i < conns - 1) await sleep(RAMP_MS);
      }
      await Promise.all(running);
      clearInterval(saver);
      await fh.close();
      if (fatal) { saveState(); throw fatal; }
      if (segs.some(s => s.wpos <= s.end)) { saveState(); throw new Error('Download incomplete'); }
    }

    fs.rmSync(out, { force: true });
    fs.renameSync(partPath, out);
    fs.rmSync(statePath, { force: true });
    const secs = (Date.now() - t0) / 1000;
    const size = fs.statSync(out).size;
    log(`\nDone: ${fmtBytes(size)} in ${secs.toFixed(1)}s (${fmtBytes(size / secs)}/s) -> ${out}\n`);
    return { file: out, size, seconds: secs, speed: size / secs };
  } finally {
    clearInterval(meter);
  }
}

module.exports = { download, probe };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  let url = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') opts.connections = Number(args[++i]);
    else if (args[i] === '-o') opts.output = args[++i];
    else if (args[i] === '-q') opts.quiet = true;
    else url = args[i];
  }
  if (!url) {
    console.error('Usage: node fastdl.js <url> [-c connections] [-o output] [-q]');
    process.exit(1);
  }
  download(url, opts).then(() => process.exit(0), e => {
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  });
}
