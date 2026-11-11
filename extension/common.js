'use strict';
// Shared by the background worker and the popup: talking to the fastdl app safely.
//
// fastdl and this extension share a random key. You get it into the extension once, either by
// clicking Connect and allowing it in fastdl (one-click pairing), or by pasting it from fastdl > Settings.
// - Before sending anything, we ask fastdl to sign a random number with the key. Only the real
//   fastdl can, so another program listening on the same port never sees your links or cookies.
// - Every download we send is signed too, so fastdl knows it really came from this extension.

const API = 'http://127.0.0.1:17385/v1';

const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));

/** Normalise a pasted key ("3f9a-07c2-…") to 32 hex characters, or null if it isn't one. */
function cleanKey(input) {
  const k = String(input || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return k.length === 32 ? k : null;
}

async function hmacHex(keyHex, message) {
  const key = await crypto.subtle.importKey('raw', fromHex(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}

const getKey = async () => (await chrome.storage.local.get({ key: null })).key;

/**
 * Check that the program on the port is the real fastdl, paired with this key.
 * Resolves to 'ok', or throws Error('not-running' | 'not-paired' | 'wrong-key').
 */
async function verifyFastdl(keyHex) {
  if (!keyHex) throw new Error('not-paired');
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  let res;
  try {
    res = await fetch(`${API}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    throw new Error('not-running');
  }
  if (!res.ok) throw new Error('not-running');
  const { proof } = await res.json().catch(() => ({}));
  if (proof !== await hmacHex(keyHex, `ping:${nonce}`)) throw new Error('wrong-key');
  return 'ok';
}

const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/**
 * 4-digit code for a pairing request. fastdl computes the same (bridge.rs `pair_code`) and shows it
 * in its Allow window, so you can check the request there is the one you started here.
 */
async function pairCode(request) {
  const d = await sha256(`fastdl-pair:${request}`);
  return String(new DataView(d.buffer).getUint32(0) % 10000).padStart(4, '0');
}

/** The browser's name for fastdl's Allow window, e.g. "Microsoft Edge", "Brave", "Chromium". */
function browserName() {
  const brands = (navigator.userAgentData?.brands || []).map(b => b.brand).filter(b => !/not.?a.?brand/i.test(b));
  return brands.find(b => b !== 'Chromium') || brands[0] || 'Browser';
}

/**
 * One step of one-click pairing: ask fastdl to show its Allow window (the first call) and wait
 * up to ~20 s for your answer. Call again with the same `request` while it says 'pending'.
 * Resolves to { status: 'pending' | 'approved' | 'denied' | 'expired' | 'busy', key? }.
 * Throws Error('not-running') if fastdl isn't there, or Error('old-app') if it's too old for this.
 */
async function requestPairing(request) {
  let res;
  try {
    res = await fetch(`${API}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, browser: browserName() }),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new Error('not-running');
  }
  if (res.status === 404) throw new Error('old-app');
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { status: 'busy' };
  if (!res.ok || !body.status) throw new Error('not-running');
  if (body.status === 'approved' && !cleanKey(body.key)) throw new Error('not-running');
  return body;
}

/** Verify fastdl, then send it a download. Throws if anything is off. */
async function sendToFastdl(payload) {
  const key = await getKey();
  await verifyFastdl(key);
  await addToFastdl(key, payload);
}

/** Send a download to a fastdl already verified with `key` (see verifyFastdl). Throws if it refuses. */
async function addToFastdl(key, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${API}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fastdl-Auth': await hmacHex(key, `add:${body}`) },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}
