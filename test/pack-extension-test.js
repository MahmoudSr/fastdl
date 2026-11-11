'use strict';
// Tests scripts/pack-extension.js: the zip, CRX3 signing/verifying, and the extension-ID checks.
// Run: node test/pack-extension-test.js
// If Chrome is installed, it also packs the same extension with Chrome itself and checks that our
// verifier accepts Chrome's CRX and that our packer produces byte-identical output from the same zip.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extensionId, listFiles, zip, buildCrx, verifyCrx, expectedId } = require('../scripts/pack-extension');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const throws = fn => { try { fn(); return false; } catch { return true; } };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const extDir = path.join(__dirname, '..', 'extension');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fdl-pack-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

// The fixed ID: expectedId throws if manifest.json "key" and bridge.rs disagree.
check('manifest key and bridge.rs give the same ID', /^[a-p]{32}$/.test(expectedId(null)), expectedId(null));
check('a different private key is rejected', throws(() => expectedId(privateKey)));

// Zip: extract with the system's tar (bsdtar reads zip on Windows/macOS) and compare every file.
const names = listFiles(extDir);
const files = names.map(name => ({ name, data: fs.readFileSync(path.join(extDir, name)) }));
const archive = zip(files);
check('zip is deterministic', archive.equals(zip(files)));
const zipPath = path.join(tmp, 'ext.zip');
fs.writeFileSync(zipPath, archive);
const unzipDir = path.join(tmp, 'unzipped');
fs.mkdirSync(unzipDir);
// On Windows use the built-in bsdtar, not a GNU tar that may come first on PATH (it can't read zip).
const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const tar = spawnSync(tarBin, ['-xf', zipPath, '-C', unzipDir]);
if (tar.status === 0) {
  const same = names.every(n => sha(fs.readFileSync(path.join(unzipDir, n))) === sha(fs.readFileSync(path.join(extDir, n))));
  check('zip extracts to identical files', same && listFiles(unzipDir).length === names.length, `${names.length} files`);
} else {
  console.log('SKIP  zip extraction (no tar that reads zip)');
}

// CRX3 round trip.
const crx = buildCrx(archive, privateKey);
const v = verifyCrx(crx);
check('CRX verifies and names the signing key', v.id === extensionId(pubDer), v.id);
check('CRX contains the zip unchanged', v.archive.equals(archive));
const tampered = Buffer.from(crx);
tampered[tampered.length - 30] ^= 1;
check('tampered archive is rejected', throws(() => verifyCrx(tampered)));
const badMagic = Buffer.from(crx);
badMagic[0] = 0x58;
check('non-CRX file is rejected', throws(() => verifyCrx(badMagic)));
check('truncated CRX is rejected', throws(() => verifyCrx(crx.subarray(0, 40))));

// Cross-check with Chrome's own packer.
// Runs locally by default. In CI only when CHROME_PATH is set, since headless Chrome on runners is flaky.
const chrome = [
  process.env.CHROME_PATH,
  ...(process.env.CI ? [] : [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  ]),
].find(p => p && fs.existsSync(p));
if (chrome) {
  const src = path.join(tmp, 'ext');
  fs.cpSync(extDir, src, { recursive: true });
  const pemPath = path.join(tmp, 'test-key.pem');
  fs.writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const r = spawnSync(chrome, [`--pack-extension=${src}`, `--pack-extension-key=${pemPath}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-message-box', '--headless'], { timeout: 60000 });
  const chromeCrxPath = `${src}.crx`;
  if (fs.existsSync(chromeCrxPath)) {
    const chromeCrx = fs.readFileSync(chromeCrxPath);
    const c = verifyCrx(chromeCrx);
    check('our verifier accepts Chrome\'s CRX', c.id === extensionId(pubDer), c.id);
    check('our packer matches Chrome byte for byte', buildCrx(c.archive, privateKey).equals(chromeCrx));
  } else {
    check('Chrome packed the extension', false, `exit ${r.status} ${r.stderr}`);
  }
} else {
  console.log('SKIP  Chrome cross-check (no Chrome found, or running in CI; set CHROME_PATH)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
