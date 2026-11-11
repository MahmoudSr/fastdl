'use strict';
// Tests the extension's protocol code (extension/common.js) on its own, then end to end against the
// app's real endpoint (app/src-tauri/src/bridge.rs, run headless by examples/bridge_check.rs):
// one-click pairing (allow, deny, busy), the ping proof, signed downloads and the Origin check.
// Run: node test/extension-test.js     (port 17385 must be free: close fastdl first)
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

const { expectedId } = require('../scripts/pack-extension');
const ORIGIN = `chrome-extension://${expectedId(null)}`; // the ID from manifest.json, checked against bridge.rs
const API = 'http://127.0.0.1:17385/v1';
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const rejects = async (p, message) => { try { await p; return false; } catch (e) { return e.message === message; } };

/** Load common.js the way the browser does, with a fake chrome.storage and a fetch that sends our Origin. */
function loadCommon(brands) {
  const store = {};
  const chrome = { storage: { local: {
    get: async defaults => ({ ...defaults, ...store }),
    set: async v => { Object.assign(store, v); },
  } } };
  const ctx = vm.createContext({
    chrome, crypto, TextEncoder, AbortSignal, DataView, Uint8Array, JSON, String, Error, Promise,
    navigator: { userAgentData: { brands } },
    fetch: (url, opts = {}) => fetch(url, { ...opts, headers: { ...opts.headers, Origin: ORIGIN } }),
  });
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'common.js'), 'utf8');
  const api = vm.runInContext(`${code}\n;({ cleanKey, pairCode, browserName, requestPairing, verifyFastdl, sendToFastdl, toHex })`, ctx);
  return { ...api, store };
}

(async () => {
  // ---------- Unit ----------
  const ext = loadCommon([{ brand: 'Not)A;Brand', version: '99' }, { brand: 'Chromium', version: '142' }]);
  // Same vectors as bridge.rs `code_matches_the_extension`.
  check('pair code matches the app (1)', await ext.pairCode('0123456789abcdef0123456789abcdef') === '9544');
  check('pair code matches the app (2)', await ext.pairCode('fedcba9876543210fedcba9876543210') === '2731');
  check('browser name: Ungoogled Chromium', ext.browserName() === 'Chromium');
  const edge = loadCommon([{ brand: 'Chromium', version: '142' }, { brand: 'Microsoft Edge', version: '142' }, { brand: 'Not_A Brand', version: '24' }]);
  check('browser name: Edge', edge.browserName() === 'Microsoft Edge');
  check('browser name: unknown', loadCommon([]).browserName() === 'Browser');
  check('pasted key is cleaned', ext.cleanKey('3F9A-07c2-b1d4-8e60-5a2f-c913-7d08-e4b6 ') === '3f9a07c2b1d48e605a2fc9137d08e4b6');
  check('short key is rejected', ext.cleanKey('3f9a-07c2') === null);

  // ---------- End to end against the real endpoint ----------
  check('says not-running when fastdl is closed', await rejects(ext.requestPairing('0'.repeat(32)), 'not-running'));

  const crate = path.join(__dirname, '..', 'app', 'src-tauri');
  const cargo = process.env.CARGO || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  console.log('Building bridge_check...');
  execFileSync(cargo, ['build', '--example', 'bridge_check'], { cwd: crate, stdio: 'inherit' });
  const bin = path.join(crate, 'target', 'debug', 'examples', process.platform === 'win32' ? 'bridge_check.exe' : 'bridge_check');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fdl-bridge-'));
  const app = spawn(bin, [data], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = [];
  const lines = [];
  readline.createInterface({ input: app.stdout }).on('line', line => {
    lines.push(line);
    for (const w of waiters.splice(0)) w();
  });
  /** Wait for the next output line starting with `prefix`. */
  const next = (prefix, after = lines.length) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${prefix}`)), 10000);
    const look = () => {
      const hit = lines.slice(after).find(l => l.startsWith(prefix));
      if (hit) { clearTimeout(timer); resolve(hit.split(' ')); } else waiters.push(look);
    };
    look();
  });
  const say = line => app.stdin.write(`${line}\n`);

  try {
    const [status] = await Promise.race([next('READY', 0), next('PORT-BUSY', 0)]);
    if (status === 'PORT-BUSY') throw new Error('port 17385 is in use: close fastdl and run again');

    // Websites (any other Origin) are refused outright.
    const site = await fetch(`${API}/pair`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
    check('other origins get 403', site.status === 403);
    const bad = await ext.requestPairing('not-a-valid-id').catch(e => e.message);
    check('malformed request ID is refused', bad === 'not-running');

    // Deny.
    const reqA = ext.toHex(crypto.getRandomValues(new Uint8Array(16)));
    let mark = lines.length;
    const denied = ext.requestPairing(reqA);
    const [, ticketA, codeA, browserA] = await next('ASK', mark);
    check('fastdl shows the same code as the extension', codeA === await ext.pairCode(reqA), codeA);
    check('fastdl shows the browser name', browserA === 'Chromium');
    say(`deny ${ticketA}`);
    check('Don\'t allow reaches the extension', (await denied).status === 'denied');

    // Only one request at a time.
    const reqB = ext.toHex(crypto.getRandomValues(new Uint8Array(16)));
    mark = lines.length;
    const approved = ext.requestPairing(reqB);
    const [, ticketB] = await next('ASK', mark);
    const other = await ext.requestPairing(ext.toHex(crypto.getRandomValues(new Uint8Array(16))));
    check('a second request while one waits is busy', other.status === 'busy');

    // Allow: the key arrives right away (long-poll), and it works.
    const t0 = Date.now();
    say(`allow ${ticketB}`);
    const r = await approved;
    check('Allow hands over the key', r.status === 'approved' && ext.cleanKey(r.key) === r.key);
    check('...without waiting for the long-poll timeout', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    check('the key passes the ping proof', (await ext.verifyFastdl(r.key)) === 'ok');
    check('a wrong key fails the ping proof', await rejects(ext.verifyFastdl('0'.repeat(32)), 'wrong-key'));
    // Asking again with the same ID starts a new request (a new Allow window); it doesn't get the key again.
    mark = lines.length;
    const again = ext.requestPairing(reqB);
    const [, ticketC] = await next('ASK', mark);
    say(`deny ${ticketC}`);
    check('the key is handed over only once', (await again).status === 'denied');

    // A signed download is accepted; an unsigned one isn't.
    ext.store.key = r.key;
    mark = lines.length;
    await ext.sendToFastdl({ url: 'http://127.0.0.1:9/file.bin', referrer: null, cookies: '' });
    await next('ADDED', mark);
    check('signed download is accepted', true);
    const unsigned = await fetch(`${API}/add`, { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({ url: 'http://127.0.0.1:9/x' }) });
    check('unsigned download gets 401', unsigned.status === 401);
  } catch (e) {
    check('end-to-end run', false, e.message);
  } finally {
    app.stdin.end();
    app.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
