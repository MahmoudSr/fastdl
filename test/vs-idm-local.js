'use strict';
// fastdl (Rust engine) vs IDM on the local test server, which caps each connection
// like many real servers do. Runs entirely on this laptop: no internet used.
// Run: node test/vs-idm-local.js [MB] [per-connection MB/s]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { startServer } = require('./server');

const IDM = 'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe';
const bin = path.join(__dirname, '..', 'app', 'src-tauri', 'target', 'release', 'examples', 'engine_check.exe');
const MB = Number(process.argv[2]) || 60;
const perConn = Number(process.argv[3]) || 2;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hashFile = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runFastdl(url, out) {
  return new Promise(resolve => {
    const p = spawn(bin, [url, out, '8']);
    let text = '';
    p.stdout.on('data', d => { text += d; });
    p.on('exit', () => {
      const m = /DONE ([\d.]+) (.+)/.exec(text);
      resolve(m ? { secs: Number(m[1]), file: m[2].trim() } : { error: text.trim() });
    });
  });
}

async function runIdm(url, dir, size) {
  const file = path.join(dir, 'idm.bin');
  const t0 = Date.now();
  spawn(IDM, ['/d', url, '/p', dir, '/f', 'idm.bin', '/n'], { detached: true, stdio: 'ignore' }).unref();
  while (Date.now() - t0 < 600000) {
    await sleep(50);
    try { if (fs.statSync(file).size === size) return { secs: (Date.now() - t0) / 1000, file }; } catch {}
  }
  return { error: 'IDM did not finish in 10 minutes' };
}

(async () => {
  const s = await startServer({ size: MB * 1024 * 1024, perConnBps: perConn * 1024 * 1024 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdl-vs-idm-'));
  console.log(`Local server: ${MB} MB file, each connection capped at ${perConn} MB/s\n`);

  const results = [];
  const f = await runFastdl(s.url, dir);
  results.push(['fastdl (8 conns)', f]);
  await sleep(1000);
  const i = await runIdm(s.url, dir, MB * 1024 * 1024);
  results.push(['IDM (its own setting)', i]);

  console.log('Tool                    Time     Speed       File correct');
  for (const [name, r] of results) {
    if (r.error) { console.log(`${name.padEnd(23)} ERROR ${r.error}`); continue; }
    const ok = hashFile(r.file) === s.sha256;
    console.log(`${name.padEnd(23)} ${(r.secs.toFixed(1) + 's').padEnd(8)} ${((MB / r.secs).toFixed(1) + ' MB/s').padEnd(11)} ${ok ? 'yes' : 'NO'}`);
  }
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
