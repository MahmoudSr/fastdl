#!/usr/bin/env node
'use strict';
// Builds the browser extension for release:
//   fastdl-extension.zip  for "Load unpacked"
//   fastdl-extension.crx  a CRX3 package signed with the extension's private key, so it keeps
//                         the fixed extension ID that the app trusts (see app/src-tauri/src/bridge.rs)
//
// Usage:
//   node scripts/pack-extension.js --out dist                       # zip only
//   node scripts/pack-extension.js --out dist --key extension.pem   # zip + signed crx
//   FASTDL_EXTENSION_PEM="$(cat extension.pem)" node scripts/pack-extension.js --out dist
//   node scripts/pack-extension.js --verify dist/fastdl-extension.crx
//
// Before signing, it checks that the private key matches manifest.json "key" and that the ID
// derived from it is the one bridge.rs accepts. Afterwards it verifies the CRX it wrote. A
// mismatch anywhere fails with a non-zero exit code, so CI can never publish a CRX with the wrong ID.
//
// The private key is never written anywhere by this script. Keep it out of the repository.
//
// No dependencies: the zip and CRX3 formats are written by hand below.
// CRX3 format: https://source.chromium.org/chromium/chromium/src/+/main:components/crx_file/crx3.proto

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const BRIDGE_RS = path.join(ROOT, 'app', 'src-tauri', 'src', 'bridge.rs');

// ---------- Extension IDs ----------

/** Chrome's extension ID: SHA-256 of the DER public key, first 16 bytes, hex digits 0-f written as a-p. */
function extensionId(publicKeyDer) {
  const hex = crypto.createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function idFromCrxId(bytes) {
  return [...bytes.toString('hex')].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const publicKeyDer = privateKey => crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

// ---------- Zip (deflate, fixed timestamps so the same files give the same bytes) ----------

const DOS_TIME = 0;               // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_NAMES = 1 << 11;

/** Every file under `dir`, as forward-slash relative paths, sorted. Skips dotfiles. */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** @param {{name: string, data: Buffer}[]} files */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                 // version needed: 2.0
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);     // method: store / deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                 // extra length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);               // version made by
    central.writeUInt16LE(20, 6);               // version needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra length, comment length, disk number, internal attrs, external attrs: all 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

// ---------- Protobuf (just the bits CRX3 needs: length-delimited fields) ----------

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

const field = (num, bytes) => Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes]);

/** Parse a message of length-delimited fields into { fieldNumber: [Buffer, ...] }. */
function parseFields(buf) {
  const out = {};
  let i = 0;
  const readVarint = () => {
    let n = 0, shift = 0, b;
    do {
      if (i >= buf.length || shift > 28) throw new Error('bad protobuf varint');
      b = buf[i++];
      n += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return n;
  };
  while (i < buf.length) {
    const tag = readVarint();
    const num = Math.floor(tag / 8), type = tag % 8;
    if (type === 0) { readVarint(); continue; }
    if (type !== 2) throw new Error(`unsupported protobuf wire type ${type}`);
    const len = readVarint();
    if (i + len > buf.length) throw new Error('truncated protobuf field');
    (out[num] ||= []).push(buf.subarray(i, i + len));
    i += len;
  }
  return out;
}

// ---------- CRX3 ----------
// File: "Cr24" | uint32le 3 | uint32le header length | CrxFileHeader | zip
// CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
// AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
// SignedData { bytes crx_id = 1; }   (crx_id = first 16 bytes of SHA-256 of the public key)
// The signature covers: "CRX3 SignedData\0" | uint32le len(signed_header_data) | signed_header_data | zip

const MAGIC = Buffer.from('Cr24');
const SIGN_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'binary');
const HEADER_RSA = 2, HEADER_ECDSA = 3, HEADER_SIGNED_DATA = 10000;
const PROOF_KEY = 1, PROOF_SIG = 2, SIGNED_CRX_ID = 1;

function signedPayload(signedHeaderData, archive) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeaderData.length);
  return Buffer.concat([SIGN_CONTEXT, len, signedHeaderData, archive]);
}

function buildCrx(archive, privateKey) {
  const pub = publicKeyDer(privateKey);
  const crxId = crypto.createHash('sha256').update(pub).digest().subarray(0, 16);
  const signedHeaderData = field(SIGNED_CRX_ID, crxId);
  const signature = crypto.sign('sha256', signedPayload(signedHeaderData, archive), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  const header = Buffer.concat([
    field(HEADER_RSA, Buffer.concat([field(PROOF_KEY, pub), field(PROOF_SIG, signature)])),
    field(HEADER_SIGNED_DATA, signedHeaderData),
  ]);
  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}

/**
 * Check a CRX3 the way Chrome does: every RSA proof must verify, and one of them must be the key
 * whose hash is the declared crx_id. Returns { id, archive }. Throws if anything is wrong.
 */
function verifyCrx(crx) {
  if (crx.length < 12 || !crx.subarray(0, 4).equals(MAGIC)) throw new Error('not a CRX file');
  if (crx.readUInt32LE(4) !== 3) throw new Error(`CRX version ${crx.readUInt32LE(4)}, expected 3`);
  const headerLen = crx.readUInt32LE(8);
  if (12 + headerLen > crx.length) throw new Error('truncated CRX header');
  const header = parseFields(crx.subarray(12, 12 + headerLen));
  const archive = crx.subarray(12 + headerLen);
  if (header[HEADER_ECDSA]) throw new Error('ECDSA proofs are not expected in this CRX');
  const signedHeaderData = header[HEADER_SIGNED_DATA]?.[0];
  if (!signedHeaderData) throw new Error('CRX has no signed header data');
  const crxId = parseFields(signedHeaderData)[SIGNED_CRX_ID]?.[0];
  if (!crxId || crxId.length !== 16) throw new Error('CRX has no valid crx_id');
  const proofs = header[HEADER_RSA] || [];
  if (!proofs.length) throw new Error('CRX has no RSA signature');
  const payload = signedPayload(signedHeaderData, archive);
  let declaredKeySigned = false;
  for (const raw of proofs) {
    const p = parseFields(raw);
    const key = p[PROOF_KEY]?.[0], sig = p[PROOF_SIG]?.[0];
    if (!key || !sig) throw new Error('incomplete RSA proof');
    const publicKey = crypto.createPublicKey({ key, format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', payload, { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, sig)) {
      throw new Error('CRX signature does not verify');
    }
    if (crypto.createHash('sha256').update(key).digest().subarray(0, 16).equals(crxId)) declaredKeySigned = true;
  }
  if (!declaredKeySigned) throw new Error('no signature from the key that crx_id names');
  return { id: idFromCrxId(crxId), archive };
}

// ---------- Project checks ----------

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
}

/** The ID that bridge.rs accepts as Origin. */
function bridgeId() {
  const m = fs.readFileSync(BRIDGE_RS, 'utf8').match(/EXTENSION_ORIGIN:\s*&str\s*=\s*"chrome-extension:\/\/([a-p]{32})"/);
  if (!m) throw new Error(`EXTENSION_ORIGIN not found in ${path.relative(ROOT, BRIDGE_RS)}`);
  return m[1];
}

/** manifest.json "key", bridge.rs and (if given) the private key must all name the same extension. */
function expectedId(privateKey) {
  const { key } = manifest();
  if (!key) throw new Error('extension/manifest.json has no "key"');
  const manifestKey = Buffer.from(key, 'base64');
  const id = extensionId(manifestKey);
  const bridge = bridgeId();
  if (id !== bridge) throw new Error(`manifest "key" gives ID ${id}, but bridge.rs accepts ${bridge}`);
  if (privateKey && !publicKeyDer(privateKey).equals(manifestKey)) {
    throw new Error(`this private key is not the one behind manifest.json "key" (it would give ID ${extensionId(publicKeyDer(privateKey))}, not ${id})`);
  }
  return id;
}

function loadPrivateKey(keyFile) {
  const pem = keyFile ? fs.readFileSync(keyFile, 'utf8') : process.env.FASTDL_EXTENSION_PEM;
  if (!pem || !pem.trim()) return null;
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`expected an RSA key, got ${key.asymmetricKeyType}`);
  return key;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--key' || a === '--verify') args[a.slice(2)] = argv[++i];
    else if (a === '--require-key') args.requireKey = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify) {
    const { id } = verifyCrx(fs.readFileSync(args.verify));
    const want = expectedId(null);
    if (id !== want) throw new Error(`${args.verify} has ID ${id}, expected ${want}`);
    console.log(`OK  ${args.verify}  signed, extension ID ${id}`);
    return;
  }
  if (!args.out) throw new Error('missing --out <dir>');
  const privateKey = loadPrivateKey(args.key);
  if (!privateKey && args.requireKey) throw new Error('no private key: pass --key <file> or set FASTDL_EXTENSION_PEM');
  const id = expectedId(privateKey);

  const { version } = manifest();
  const files = listFiles(EXTENSION_DIR).map(name => ({ name, data: fs.readFileSync(path.join(EXTENSION_DIR, name)) }));
  const archive = zip(files);
  fs.mkdirSync(args.out, { recursive: true });
  const zipPath = path.join(args.out, 'fastdl-extension.zip');
  fs.writeFileSync(zipPath, archive);
  console.log(`wrote ${zipPath}  (extension ${version}, ${files.length} files)`);

  if (!privateKey) { console.log('no private key given, so no .crx (zip only)'); return; }
  const crx = buildCrx(archive, privateKey);
  const check = verifyCrx(crx);
  if (check.id !== id) throw new Error(`built CRX has ID ${check.id}, expected ${id}`);
  const crxPath = path.join(args.out, 'fastdl-extension.crx');
  fs.writeFileSync(crxPath, crx);
  console.log(`wrote ${crxPath}  (signed, extension ID ${id})`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`pack-extension: ${e.message}`); process.exit(1); }
}

module.exports = { extensionId, listFiles, zip, buildCrx, verifyCrx, expectedId };
