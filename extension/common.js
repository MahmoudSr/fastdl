'use strict';
// Shared by the background worker and the popup: talking to the fastdl app safely.
//
// fastdl and this extension share a random key (shown in fastdl > Settings, pasted here once).
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

/** Send a download to fastdl (after verifying it). Throws if anything is off. */
async function sendToFastdl(payload) {
  const key = await getKey();
  await verifyFastdl(key);
  const body = JSON.stringify(payload);
  const res = await fetch(`${API}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fastdl-Auth': await hmacHex(key, `add:${body}`) },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}
