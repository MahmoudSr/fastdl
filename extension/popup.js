'use strict';

const $ = id => document.getElementById(id);
const COOKIE_PERMS = { permissions: ['cookies'], origins: ['<all_urls>'] };

function setStatus(kind, text, foot) {
  $('status').className = `status ${kind}`;
  $('status-text').textContent = text;
  $('foot').textContent = foot || 'Tip: right-click any link → Download with fastdl.';
}

async function refreshStatus() {
  const key = await getKey();
  $('unpair').hidden = !key;
  try {
    await verifyFastdl(key);
    $('pair').hidden = true;
    setStatus('ok', 'Connected');
  } catch (e) {
    if (e.message === 'not-running') {
      $('pair').hidden = Boolean(key);
      setStatus('off', 'fastdl not running', 'Open the fastdl app. Until then, Chrome downloads as usual.');
    } else if (e.message === 'wrong-key') {
      $('pair').hidden = false;
      setStatus('off', 'Key doesn\'t match', 'The key changed in fastdl. Paste the new one above.');
    } else {
      $('pair').hidden = false;
      setStatus('off', 'Not paired', 'Until you pair, Chrome downloads as usual.');
    }
  }
}

(async () => {
  const s = await chrome.storage.local.get({ enabled: true, cookies: false });
  $('enabled').checked = s.enabled;
  $('cookies').checked = s.cookies && await chrome.permissions.contains(COOKIE_PERMS);
  refreshStatus();
})();

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
  refreshStatus();
});

$('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove('key');
  refreshStatus();
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
