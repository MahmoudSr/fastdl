'use strict';
// Hands browser downloads to the fastdl app. If fastdl isn't running (or isn't paired),
// Chrome downloads normally.

importScripts('common.js');

const getSettings = () => chrome.storage.local.get({ enabled: true, cookies: false });

async function updateBadge() {
  const { enabled } = await getSettings();
  const { lastFallback } = await chrome.storage.local.get('lastFallback');
  const key = await getKey();
  const text = lastFallback ? '!' : !key ? 'pair' : enabled ? '' : 'off';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: lastFallback ? '#c2410c' : '#64748b' });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.create({ id: 'fastdl-link', title: 'Download with fastdl', contexts: ['link'] });
  updateBadge();
  // Freshly installed and fastdl is open: ask it right away, so all that's left is clicking Allow.
  if (reason === 'install' && !(await getKey())) connect({ quiet: true });
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') updateBadge(); });

// ---------- One-click pairing ----------
// The popup asks us to connect. The waiting happens here, not in the popup, because the popup
// closes as soon as you click into fastdl to press Allow. Progress goes to storage.session
// (cleared when the browser closes), where the popup picks it up.
const PAIR_TIMEOUT_MS = 2 * 60 * 1000;
const setPairing = state => chrome.storage.session.set({ pairing: { ...state, at: Date.now() } });
let connecting = null;

/** Start pairing, or join the attempt already running. `quiet`: say nothing if fastdl isn't open. */
function connect({ quiet = false } = {}) {
  connecting ||= runConnect()
    .catch(e => quiet && e.message === 'not-running' ? chrome.storage.session.remove('pairing') : setPairing({ state: e.message }))
    .finally(() => { connecting = null; });
  return connecting;
}

async function runConnect() {
  // Carry on with a request that an earlier (since stopped) service worker started, so fastdl
  // keeps showing the same window and code instead of refusing a second request.
  const { pairing: prev } = await chrome.storage.session.get('pairing');
  const resume = prev?.state === 'waiting' && prev.until > Date.now();
  const request = resume ? prev.request : toHex(crypto.getRandomValues(new Uint8Array(16)));
  const until = resume ? prev.until : Date.now() + PAIR_TIMEOUT_MS;
  const code = await pairCode(request);
  while (Date.now() < until) {
    // Each round is an extension API call, which also keeps this service worker from being stopped.
    await setPairing({ state: 'waiting', request, code, until });
    const r = await requestPairing(request);
    if (r.status === 'pending') continue;
    if (r.status !== 'approved') return setPairing({ state: r.status }); // denied | expired | busy
    const key = cleanKey(r.key);
    await verifyFastdl(key); // only keep a key that really works
    await chrome.storage.local.set({ key });
    await chrome.storage.local.remove('lastFallback');
    return setPairing({ state: 'paired' });
  }
  return setPairing({ state: 'expired' });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id === chrome.runtime.id && msg?.type === 'connect') connect();
});

// Login cookies are only sent if you switched them on in the popup AND granted the permission.
async function cookiesFor(url) {
  const { cookies } = await getSettings();
  if (!cookies || !chrome.cookies) return '';
  const granted = await chrome.permissions.contains({ permissions: ['cookies'], origins: ['<all_urls>'] });
  if (!granted) return '';
  const list = await chrome.cookies.getAll({ url }).catch(() => []);
  return list.map(c => `${c.name}=${c.value}`).join('; ');
}

const send = async (url, referrer) => sendToFastdl({ url, referrer: referrer || null, cookies: await cookiesFor(url) });

// When a download stays in Chrome, show "!" on the icon and remember why for the popup.
const REASONS = {
  'not-running': 'fastdl isn\'t running. Open the fastdl app.',
  'not-paired': 'The extension isn\'t paired with fastdl yet.',
  'wrong-key': 'The pairing key changed in fastdl. Pair again.',
  'in-browser': 'This site creates the file inside the browser, so only Chrome can save it.',
};

async function fellBack(code, url, detail) {
  const reason = REASONS[code] || `fastdl couldn't take it: ${detail || code}`;
  await chrome.storage.local.set({ lastFallback: { reason, url, time: Date.now() } });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
}

/**
 * Hand a browser download to fastdl. Resolves to true if fastdl took it (Chrome's copy is then
 * cancelled and removed from its list), false if it stays in Chrome.
 *
 * Chrome's download is never paused: many servers can't continue a paused download, so pausing
 * and resuming could break it exactly when it has to stay in Chrome (fastdl closed, not paired,
 * or refusing). Handing over takes milliseconds; cancelling also deletes Chrome's partial file.
 */
async function takeOver(item) {
  const { enabled } = await getSettings();
  const url = item.finalUrl || item.url;
  if (!enabled || item.state !== 'in_progress') return false;
  if (item.incognito) return false; // keep private-window downloads in the browser
  if (item.byExtensionId === chrome.runtime.id) return false; // our own fallback download
  if (!/^https?:\/\//i.test(url)) { await fellBack('in-browser', url); return false; } // blob:/data: links
  try {
    await send(url, item.referrer);
  } catch (e) {
    // fastdl isn't running, isn't paired, or refused it: Chrome carries on as if we weren't here.
    await fellBack(e.message, url, e.message);
    return false;
  }
  await chrome.downloads.cancel(item.id).catch(() => {});
  await chrome.downloads.erase({ id: item.id }).catch(() => {});
  await chrome.storage.local.remove('lastFallback');
  return true;
}

// Take downloads over while Chrome is still choosing the file name. Chrome waits for this before
// it shows its own "Save as" window (on by default in some browsers, e.g. Ungoogled Chromium), so
// for downloads fastdl takes, you only ever see fastdl's window. Anything fastdl doesn't take
// continues exactly as Chrome would have done it.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let answered = false;
  const letChromeContinue = () => { if (!answered) { answered = true; suggest(); } };
  takeOver(item).then(taken => { if (!taken) letChromeContinue(); }, letChromeContinue);
  return true; // we answer asynchronously
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'fastdl-link' || !info.linkUrl) return;
  try {
    await send(info.linkUrl, tab?.incognito ? null : tab?.url);
  } catch (e) {
    await fellBack(e.message, info.linkUrl, e.message);
    chrome.downloads.download({ url: info.linkUrl }); // fall back to Chrome
  }
});
