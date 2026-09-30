'use strict';
// Hands browser downloads to the fastdl app. If fastdl isn't running (or isn't paired),
// Chrome downloads normally.

importScripts('common.js');

const getSettings = () => chrome.storage.local.get({ enabled: true, cookies: false });

async function updateBadge() {
  const { enabled } = await getSettings();
  const key = await getKey();
  await chrome.action.setBadgeText({ text: !key ? 'pair' : enabled ? '' : 'off' });
  await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'fastdl-link', title: 'Download with fastdl', contexts: ['link'] });
  updateBadge();
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener(updateBadge);

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

chrome.downloads.onCreated.addListener(async item => {
  const { enabled } = await getSettings();
  const url = item.finalUrl || item.url;
  if (!enabled || item.state !== 'in_progress' || !/^https?:\/\//i.test(url)) return;
  if (item.incognito) return; // keep private-window downloads in the browser
  if (item.byExtensionId === chrome.runtime.id) return; // our own fallback download
  // Pause Chrome's copy while we hand it over, so it doesn't race fastdl.
  await chrome.downloads.pause(item.id).catch(() => {});
  try {
    await send(url, item.referrer);
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
  } catch {
    // fastdl isn't running, isn't paired, or refused: let Chrome carry on as normal.
    await chrome.downloads.resume(item.id).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'fastdl-link' || !info.linkUrl) return;
  try {
    await send(info.linkUrl, tab?.incognito ? null : tab?.url);
  } catch {
    chrome.downloads.download({ url: info.linkUrl }); // fall back to Chrome
  }
});
