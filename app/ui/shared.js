'use strict';
// Used by both windows (index.html and confirm.html), and by test/ui-test.js in Node.

const TYPES = {
  video: { label: 'Video', icon: 't-video', ext: 'mp4 mkv avi mov webm flv wmv m4v ts' },
  audio: { label: 'Music', icon: 't-audio', ext: 'mp3 wav flac aac ogg m4a opus wma' },
  doc: { label: 'Documents', icon: 't-doc', ext: 'pdf doc docx xls xlsx ppt pptx txt epub csv md rtf odt' },
  app: { label: 'Programs', icon: 't-app', ext: 'exe msi apk dmg deb rpm appimage iso img msix' },
  archive: { label: 'Archives', icon: 't-archive', ext: 'zip rar 7z tar gz bz2 xz zst tgz' },
  image: { label: 'Images', icon: 't-image', ext: 'jpg jpeg png gif webp svg bmp heic avif tif tiff' },
};
const extMap = {};
for (const [k, t] of Object.entries(TYPES)) for (const e of t.ext.split(' ')) extMap[e] = k;
const typeOf = name => extMap[(name.split('.').pop() || '').toLowerCase()] || 'other';
const typeIcon = name => (TYPES[typeOf(name)] || { icon: 't-file' }).icon;

function fmtBytes(n) {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${u[i]}`;
}

// ---------- Order of the list ----------
// Unfinished downloads come first, in the order things will happen: what's downloading now,
// then the queue in the order it will start, then paused ones. Below them, finished and failed
// downloads, newest first. The engine starts queued downloads oldest first (lowest id), so the
// list shows exactly what comes next.
const IN_PROGRESS = ['downloading', 'queued', 'paused'];
const isInProgress = it => IN_PROGRESS.includes(it.status);

function compareForList(a, b) {
  const ra = IN_PROGRESS.indexOf(a.status), rb = IN_PROGRESS.indexOf(b.status);
  if (ra >= 0 || rb >= 0) {
    if (ra < 0) return 1;
    if (rb < 0) return -1;
    return ra - rb || a.id - b.id;
  }
  return b.added - a.added || b.id - a.id;
}

/** id -> place in the queue (1 = starts next), for queued downloads only. */
function queuePositions(items) {
  const queued = items.filter(i => i.status === 'queued').sort((a, b) => a.id - b.id);
  return new Map(queued.map((it, n) => [it.id, n + 1]));
}

const queueText = pos => (pos === 1 ? 'Queued · next' : `Queued · #${pos}`);

/** "1 downloading · 99 queued · 2 paused" (parts that are 0 are left out). */
function progressSummary(items) {
  const n = s => items.filter(i => i.status === s).length;
  const parts = [[n('downloading'), 'downloading'], [n('queued'), 'queued'], [n('paused'), 'paused']];
  return parts.filter(([c]) => c).map(([c, w]) => `${c} ${w}`).join(' · ') || 'Nothing downloading';
}

// ---------- Browser-only helpers ----------
const T = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
const $ = s => document.querySelector(s);

/** The backend: Tauri in the app, or `mock()` when the page is opened in a plain browser. */
function connect(mock) {
  return T ? {
    invoke: (cmd, args) => T.core.invoke(cmd, args),
    listen: (ev, fn) => T.event.listen(ev, e => fn(e.payload)),
  } : mock();
}

function applyTheme(theme) {
  if (!theme || theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

if (typeof module !== 'undefined') {
  module.exports = { typeOf, typeIcon, fmtBytes, isInProgress, compareForList, queuePositions, queueText, progressSummary };
}
