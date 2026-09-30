'use strict';
// Real-world benchmark: download the same URL with 1 connection (what a browser does)
// and with more connections, then compare.
// Run: node bench.js <url> [1,8,16,32]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { download } = require('./fastdl');

const url = process.argv[2];
const counts = (process.argv[3] || '1,8,16,32').split(',').map(Number);
if (!url) {
  console.error('Usage: node bench.js <url> [1,8,16,32]');
  process.exit(1);
}

(async () => {
  const rows = [];
  for (const c of counts) {
    const out = path.join(os.tmpdir(), `fastdl-bench-${c}.bin`);
    process.stderr.write(`\n--- ${c} connection(s) ---\n`);
    const r = await download(url, { connections: c, output: out });
    rows.push({ c, secs: r.seconds, mbps: r.speed / 1048576 });
    fs.rmSync(out, { force: true });
  }
  const base = rows.find(r => r.c === 1);
  console.log('\nConnections   Time      Speed        vs 1 conn (browser)');
  for (const r of rows) {
    console.log(`${String(r.c).padEnd(13)} ${(r.secs.toFixed(1) + 's').padEnd(9)} ` +
      `${(r.mbps.toFixed(1) + ' MB/s').padEnd(12)} ${base ? (r.mbps / base.mbps).toFixed(1) + 'x' : ''}`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
