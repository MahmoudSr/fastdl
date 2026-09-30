'use strict';
// Correctness + speed tests against the local throttled server.
// Run: node test/test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { startServer } = require('./server');
const { download } = require('../fastdl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastdl-'));
const hashFile = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

(async () => {
  // 1. Speed: server caps each connection at 2 MB/s, like many real servers.
  const s = await startServer({ size: 40 * 1024 * 1024, perConnBps: 2 * 1024 * 1024 });
  const results = {};
  for (const c of [1, 4, 16]) {
    const out = path.join(tmp, `speed-${c}.bin`);
    const r = await download(s.url, { connections: c, output: out, quiet: true });
    results[c] = r.speed;
    check(`${c} connection(s) -> file matches`, hashFile(out) === s.sha256, `${(r.speed / 1048576).toFixed(1)} MB/s`);
  }
  check('16 connections at least 5x faster than 1', results[16] > results[1] * 5,
    `${(results[16] / results[1]).toFixed(1)}x`);
  s.close();

  // 2. Flaky server: 1% chance per chunk that the connection drops.
  const f = await startServer({ size: 20 * 1024 * 1024, perConnBps: 8 * 1024 * 1024, dropRate: 0.01 });
  const fout = path.join(tmp, 'flaky.bin');
  await download(f.url, { connections: 16, output: fout, quiet: true });
  check('survives dropped connections', hashFile(fout) === f.sha256);
  f.close();

  // 3. Resume: kill the process halfway, restart, file must still be correct.
  const r = await startServer({ size: 30 * 1024 * 1024, perConnBps: 1024 * 1024 });
  const rout = path.join(tmp, 'resume.bin');
  const cli = path.join(__dirname, '..', 'fastdl.js');
  const child = spawn(process.execPath, [cli, r.url, '-c', '8', '-o', rout, '-q']);
  await new Promise(res => setTimeout(res, 2000));
  child.kill();
  await new Promise(res => child.on('exit', res));
  const saved = JSON.parse(fs.readFileSync(rout + '.part.json', 'utf8'));
  const partial = saved.segs.reduce((a, x) => a + (x.wpos - x.start), 0);
  const t = Date.now();
  await download(r.url, { connections: 8, output: rout, quiet: true });
  check('resume after kill', hashFile(rout) === r.sha256 && partial > 0,
    `${(partial / 1048576).toFixed(1)} MB kept, finished in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  r.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
