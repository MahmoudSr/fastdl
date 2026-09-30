'use strict';
// Tests the Rust engine (app/src-tauri) against the local throttled test server.
// Run: node test/engine-test.js   (builds the engine_check example first)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { startServer } = require('./server');

const crate = path.join(__dirname, '..', 'app', 'src-tauri');
const cargo = path.join(os.homedir(), '.cargo', 'bin', 'cargo');
console.log('Building engine_check...');
execFileSync(cargo, ['build', '--release', '--example', 'engine_check'], { cwd: crate, stdio: 'inherit' });
const bin = path.join(crate, 'target', 'release', 'examples', 'engine_check.exe');

const hashFile = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// The engine runs in a child process, so the server must keep serving meanwhile: use async spawn.
function run(url, conns, pauseMs) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fdl-engine-'));
  const args = [url, out, String(conns)];
  if (pauseMs) args.push(String(pauseMs));
  return new Promise(resolve => {
    const p = require('child_process').spawn(bin, args);
    let text = '';
    p.stdout.on('data', d => { text += d; });
    p.stderr.on('data', d => { text += d; });
    p.on('exit', () => {
      const m = /DONE ([\d.]+) (.+)/.exec(text);
      resolve({ out, text, secs: m ? Number(m[1]) : null, file: m ? m[2].trim() : null });
    });
  });
}

(async () => {
  const s = await startServer({ size: 40 * 1024 * 1024, perConnBps: 2 * 1024 * 1024 });
  const speeds = {};
  for (const c of [1, 8]) {
    const r = await run(s.url, c);
    const ok = r.file && hashFile(r.file) === s.sha256;
    speeds[c] = r.secs ? 40 / r.secs : 0;
    check(`${c} connection(s) -> file matches`, ok, ok ? `${speeds[c].toFixed(1)} MB/s` : r.text.trim());
    fs.rmSync(r.out, { recursive: true, force: true });
  }
  check('8 connections at least 4x faster than 1', speeds[8] > speeds[1] * 4, `${(speeds[8] / speeds[1]).toFixed(1)}x`);
  s.close();

  const f = await startServer({ size: 20 * 1024 * 1024, perConnBps: 8 * 1024 * 1024, dropRate: 0.01 });
  let r = await run(f.url, 8);
  check('survives dropped connections', r.file && hashFile(r.file) === f.sha256, r.file ? '' : r.text.trim());
  fs.rmSync(r.out, { recursive: true, force: true });
  f.close();

  const p = await startServer({ size: 30 * 1024 * 1024, perConnBps: 1024 * 1024 });
  r = await run(p.url, 8, 2500);
  check('pause + resume keeps file correct', r.file && hashFile(r.file) === p.sha256 && /PAUSED/.test(r.text), r.file ? '' : r.text.trim());
  fs.rmSync(r.out, { recursive: true, force: true });
  p.close();

  // A server that sends the wrong part of the file must never produce a "completed" file.
  const w = await startServer({ size: 8 * 1024 * 1024, perConnBps: 16 * 1024 * 1024, wrongRange: true });
  r = await run(w.url, 8);
  check('wrong-part server is rejected, not saved as done', !r.file && /FAILED/.test(r.text), r.text.trim().split('\n').pop());
  fs.rmSync(r.out, { recursive: true, force: true });
  w.close();

  console.log(failed ? `\n${failed} test(s) failed` : '\nAll engine tests passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
