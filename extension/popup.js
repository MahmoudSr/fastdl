'use strict';

const $ = id => document.getElementById(id);
const COOKIE_PERMS = { permissions: ['cookies'], origins: ['<all_urls>'] };
// Results of a pairing attempt are shown for this long, then the popup starts fresh.
const PAIR_RESULT_TTL_MS = 5 * 60 * 1000;

const PAIR_MESSAGES = {
  denied: 'fastdl didn\'t allow the connection. Click Connect to ask again.',
  expired: 'No answer from fastdl in time. Click Connect to try again.',
  busy: 'fastdl is already asking about another browser. Answer that first, then try again.',
  'not-running': 'Open the fastdl app first, then click Connect.',
  'old-app': 'This version of fastdl can\'t connect with one click. Update fastdl, or paste the key from its Settings.',
  'wrong-key': 'Connecting didn\'t work. Click Connect to try again.',
};

let showKeyForm = false;
// background.js does the actual pairing. It sends no reply, so ignore "no response" errors.
const askBackgroundToConnect = () => chrome.runtime.sendMessage({ type: 'connect' }).catch(() => {});
let renderSeq = 0;

function setStatus(kind, text, foot) {
  $('status').className = `status ${kind}`;
  $('status-text').textContent = text;
  $('foot').textContent = foot || 'Tip: right-click any link → Download with fastdl.';
}

/** What one-click pairing is doing (written by background.js), or null if nothing recent. */
async function getPairing() {
  const { pairing } = await chrome.storage.session.get('pairing');
  if (!pairing) return null;
  if (pairing.state === 'waiting') return pairing.until > Date.now() ? pairing : null;
  return Date.now() - pairing.at < PAIR_RESULT_TTL_MS ? pairing : null;
}

async function render() {
  const seq = ++renderSeq;
  const [key, pairing] = await Promise.all([getKey(), getPairing()]);
  let live = 'ok';
  try { await verifyFastdl(key); } catch (e) { live = e.message; }
  if (seq !== renderSeq) return; // a newer render started while we were checking

  $('unpair').hidden = !key;
  const connected = live === 'ok';
  const needsPairing = !connected && (!key || live === 'wrong-key');
  if (connected) setStatus('ok', 'Connected');
  else if (live === 'not-running') setStatus('off', 'fastdl not running', 'Open the fastdl app. Until then, Chrome downloads as usual.');
  else if (live === 'wrong-key') setStatus('off', 'Key doesn\'t match', 'The key changed in fastdl. Connect again.');
  else setStatus('off', 'Not connected', 'Until you connect, Chrome downloads as usual.');

  const waiting = pairing?.state === 'waiting';
  $('connect').hidden = !needsPairing;
  $('connect-code').hidden = !waiting;
  $('connect-btn').hidden = waiting;
  if (waiting) $('code').textContent = pairing.code;
  $('connect-text').textContent = waiting
    ? 'Click Allow in the fastdl window.'
    : 'Click Connect, then Allow in the fastdl window. You only do this once.';
  const message = !waiting && PAIR_MESSAGES[pairing?.state];
  $('connect-error').textContent = message || '';
  $('connect-error').hidden = !message;
  $('pair').hidden = !needsPairing || !(showKeyForm || pairing?.state === 'old-app');
  $('show-key').hidden = !$('pair').hidden;
}

// Explain the last download that stayed in Chrome (the "!" on the icon), then clear it.
async function showLastFallback() {
  const { lastFallback: f } = await chrome.storage.local.get('lastFallback');
  if (!f) return;
  let host = '';
  try { host = new URL(f.url).host; } catch {}
  const mins = Math.round((Date.now() - f.time) / 60000);
  const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : new Date(f.time).toLocaleString();
  $('notice').textContent = `A download${host ? ` from ${host}` : ''} went to Chrome (${when}): ${f.reason}`;
  $('notice').hidden = false;
  await chrome.storage.local.remove('lastFallback');
}

(async () => {
  showLastFallback();
  const s = await chrome.storage.local.get({ enabled: true, cookies: false });
  $('enabled').checked = s.enabled;
  $('cookies').checked = s.cookies && await chrome.permissions.contains(COOKIE_PERMS);
  // A pairing that's still waiting: make sure the background is still working on it.
  if ((await getPairing())?.state === 'waiting') askBackgroundToConnect();
  render();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'session' && changes.pairing) || (area === 'local' && changes.key)) render();
});

$('connect-btn').addEventListener('click', async () => {
  await chrome.storage.session.remove('pairing');
  askBackgroundToConnect();
});

$('show-key').addEventListener('click', () => {
  showKeyForm = true;
  render();
  $('key').focus();
});

$('pair').addEventListener('submit', async e => {
  e.preventDefault();
  const key = cleanKey($('key').value);
  const err = $('pair-error');
  err.hidden = true;
  if (!key) {
    err.textContent = 'That doesn\'t look like a fastdl key. It has 32 letters and numbers.';
    err.hidden = false;
    return;
  }
  try {
    await verifyFastdl(key);
  } catch (x) {
    err.textContent = x.message === 'not-running' ? 'Open the fastdl app first, then try again.' : 'That key doesn\'t match fastdl. Copy it again from Settings.';
    err.hidden = false;
    return;
  }
  await chrome.storage.local.set({ key });
  $('key').value = '';
  showKeyForm = false;
});

$('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove('key');
  await chrome.storage.session.remove('pairing');
});

$('enabled').addEventListener('change', e => chrome.storage.local.set({ enabled: e.target.checked }));

$('cookies').addEventListener('change', async e => {
  if (e.target.checked) {
    // Chrome shows its own permission prompt; nothing is granted unless you accept.
    const ok = await chrome.permissions.request(COOKIE_PERMS);
    e.target.checked = ok;
    await chrome.storage.local.set({ cookies: ok });
  } else {
    await chrome.storage.local.set({ cookies: false });
    await chrome.permissions.remove(COOKIE_PERMS);
  }
});
