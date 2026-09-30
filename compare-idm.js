'use strict';
// Head-to-head: browser-style (1 connection) vs fastdl vs IDM, same file.
// Run: node compare-idm.js [url] [fastdl connections]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { download, probe } = require('./fastdl');

const IDM = 'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe';
const url = process.argv[2] || 'https://sin-speed.hetzner.com/100MB.bin';
const conns = Number(process.argv[3]) || 8;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-compare-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mbps = (bytes, secs) => bytes / 1048576 / secs;

// IDM only writes the final file once the download is fully finished,
// so we time from launch until the file appears at its full size.
async function runIdm(size) {
  const name = 'idm-test.bin';
  const out = path.join(dir, name);
  const t0 = Date.now();
  spawn(IDM, ['/d', url, '/p', dir, '/f', name, '/n'], { detached: true, stdio: 'ignore' }).unref();
  while (true) {
    await sleep(100);
    try { if (fs.statSync(out).size === size) break; } catch {}
    const secs = (Date.now() - t0) / 1000;
    process.stderr.write(`\r  waiting for IDM... ${secs.toFixed(0)}s`);
    if (secs > 600) throw new Error('IDM did not finish within 10 minutes');
  }
  const secs = (Date.now() - t0) / 1000;
  process.stderr.write('\n');
  return secs;
}

(async () => {
  const { size } = await probe(url);
  console.log(`File: ${url} (${(size / 1048576).toFixed(0)} MB)\n`);
  const rows = [];

  console.log('1) Browser-style: 1 connection');
  let r = await download(url, { connections: 1, output: path.join(dir, 'single.bin') });
  rows.push(['Browser-style (1 conn)', r.seconds, r.speed / 1048576]);

  console.log(`\n2) fastdl: ${conns} connections`);
  r = await download(url, { connections: conns, output: path.join(dir, 'fastdl.bin') });
  rows.push([`fastdl (${conns} conns)`, r.seconds, r.speed / 1048576]);

  if (fs.existsSync(IDM)) {
    console.log('\n3) IDM (uses the connection count set in IDM > Options > Connection)');
    const secs = await runIdm(size);
    rows.push(['IDM', secs, mbps(size, secs)]);
  } else {
    console.log(`\nIDM not found at ${IDM}, skipping`);
  }

  const base = rows[0][2];
  console.log('\nResult                    Time      Speed        vs browser');
  for (const [name, secs, speed] of rows) {
    console.log(`${name.padEnd(25)} ${(secs.toFixed(1) + 's').padEnd(9)} ${(speed.toFixed(1) + ' MB/s').padEnd(12)} ${(speed / base).toFixed(1)}x`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('\n' + e.message); process.exit(1); });
