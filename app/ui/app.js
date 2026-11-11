'use strict';

// ---------- Backend bridge (Tauri, or a simulated one when opened in a plain browser) ----------
const T = window.__TAURI__;
const api = T ? {
  invoke: (cmd, args) => T.core.invoke(cmd, args),
  listen: (ev, fn) => T.event.listen(ev, e => fn(e.payload)),
} : mockBackend();

// ---------- State ----------
const items = new Map();   // id -> item (+ speed, conns)
const rows = new Map();    // id -> row element
let settings = null;
let filter = { status: 'all', type: 'all', q: '' };

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

// ---------- Formatting ----------
function fmtBytes(n) {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${u[i]}`;
}
function fmtEta(s) {
  if (!isFinite(s) || s <= 0) return '';
  if (s < 60) return `${Math.ceil(s)}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s left`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
}
const STATUS_TEXT = { queued: 'Queued', downloading: 'Downloading', paused: 'Paused', completed: 'Completed', failed: 'Failed' };

// ---------- Rendering ----------
const $ = s => document.querySelector(s);
const list = $('#list');

function matches(it) {
  if (it.status === 'pending') return false; // shown in the confirm window instead
  const s = filter.status;
  if (s === 'waiting' ? !['queued', 'paused'].includes(it.status) : s !== 'all' && it.status !== s) return false;
  if (filter.type !== 'all' && typeOf(it.name) !== filter.type) return false;
  if (filter.q && !it.name.toLowerCase().includes(filter.q)) return false;
  return true;
}

function iconBtn(icon, label, action, cls = '') {
  return `<button class="icon-btn ${cls}" data-act="${action}" aria-label="${label}" title="${label}"><svg><use href="#${icon}"/></svg></button>`;
}

function buildRow(it) {
  const el = document.createElement('div');
  el.className = 'item';
  el.setAttribute('role', 'listitem');
  el.dataset.id = it.id;
  el.innerHTML = `
    <div class="ftype"><svg><use href="#${(TYPES[typeOf(it.name)] || { icon: 't-file' }).icon}"/></svg></div>
    <div class="body">
      <div class="name"></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div>
      <div class="meta"><span class="st"></span><span class="sz"></span><span class="sp"></span><span class="eta"></span><span class="cn"></span></div>
    </div>
    <div class="acts"></div>`;
  el._ = {
    name: el.querySelector('.name'), bar: el.querySelector('.bar'), fill: el.querySelector('.fill'),
    st: el.querySelector('.st'), sz: el.querySelector('.sz'), sp: el.querySelector('.sp'),
    eta: el.querySelector('.eta'), cn: el.querySelector('.cn'), acts: el.querySelector('.acts'),
    icon: el.querySelector('.ftype use'),
  };
  return el;
}

// Full update: status/name/actions. Called on status changes only.
function renderRow(it) {
  let el = rows.get(it.id);
  if (!el) { el = buildRow(it); rows.set(it.id, el); }
  const r = el._;
  el.dataset.status = it.status;
  r.name.textContent = it.name;
  r.name.title = it.url;
  r.icon.setAttribute('href', '#' + (TYPES[typeOf(it.name)] || { icon: 't-file' }).icon);
  let acts = '';
  if (it.status === 'downloading' || it.status === 'queued') acts += iconBtn('i-pause', 'Pause', 'pause');
  if (it.status === 'paused') acts += iconBtn('i-play', 'Resume', 'resume');
  if (it.status === 'failed') acts += iconBtn('i-retry', 'Retry', 'resume');
  if (it.status === 'completed') acts += iconBtn('t-file', 'Open file', 'open');
  acts += iconBtn('i-folder', 'Show in folder', 'folder');
  acts += iconBtn('i-x', 'Remove', 'remove', 'rm');
  if (el._acts !== acts) { r.acts.innerHTML = acts; el._acts = acts; }
  renderProgress(it);
}

// Cheap update: text + transform only, called on every progress tick.
function renderProgress(it) {
  const el = rows.get(it.id);
  if (!el) return;
  const r = el._;
  const pct = it.size ? Math.min(100, (it.done / it.size) * 100) : 0;
  r.fill.style.transform = `scaleX(${pct / 100})`;
  r.bar.setAttribute('aria-valuenow', pct.toFixed(0));
  const live = it.status === 'downloading';
  r.st.textContent = live && it.size ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : STATUS_TEXT[it.status];
  if (it.status === 'completed') r.sz.textContent = fmtBytes(it.size ?? it.done);
  else r.sz.textContent = `${fmtBytes(it.done)} of ${it.size ? fmtBytes(it.size) : 'unknown size'}`;
  r.sp.textContent = live ? `${fmtBytes(it.speed || 0)}/s` : '';
  r.eta.textContent = live && it.size && it.speed ? fmtEta((it.size - it.done) / it.speed) : '';
  r.cn.textContent = live && it.conns ? `${it.conns} conn${it.conns > 1 ? 's' : ''}` : '';
  if (it.status === 'failed' && it.error) { r.eta.textContent = it.error; r.eta.className = 'eta err'; r.eta.title = it.error; }
  else if (r.eta.className !== 'eta') { r.eta.className = 'eta'; r.eta.title = ''; }
  if (it.status === 'completed' && it.finished) r.cn.textContent = new Date(it.finished).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  if (!it.resumable && live && it.size == null) r.cn.textContent = 'single connection';
}

// Re-order / filter the visible list (newest first).
function renderList() {
  const visible = [...items.values()].filter(matches).sort((a, b) => b.added - a.added);
  const frag = document.createDocumentFragment();
  for (const it of visible) { if (!rows.has(it.id)) renderRow(it); frag.appendChild(rows.get(it.id)); }
  list.replaceChildren(frag);
  $('#empty').hidden = visible.length > 0;
  list.hidden = visible.length === 0;
  // Never keep hidden downloads selected: Del must only remove what you can see.
  const shown = new Set(visible.map(i => i.id));
  for (const id of selected) if (!shown.has(id)) selected.delete(id);
  renderSelection();
  renderCounts();
}

function renderCounts() {
  const all = [...items.values()].filter(i => i.status !== 'pending');
  const c = {
    all: all.length,
    downloading: all.filter(i => i.status === 'downloading').length,
    waiting: all.filter(i => i.status === 'queued' || i.status === 'paused').length,
    completed: all.filter(i => i.status === 'completed').length,
    failed: all.filter(i => i.status === 'failed').length,
  };
  for (const [k, v] of Object.entries(c)) document.querySelector(`[data-count="${k}"]`).textContent = v || '';
  $('#active-count').textContent = `${c.downloading} active${c.waiting ? ` · ${c.waiting} waiting` : ''}`;
  $('#clear-done').hidden = c.completed === 0;
}

function renderTypes() {
  const nav = $('#types');
  nav.innerHTML = `<button class="nav ${filter.type === 'all' ? 'on' : ''}" data-type="all"><svg><use href="#t-file"/></svg>All types</button>` +
    Object.entries(TYPES).map(([k, t]) =>
      `<button class="nav ${filter.type === k ? 'on' : ''}" data-type="${k}"><svg><use href="#${t.icon}"/></svg>${t.label}</button>`).join('');
}

function renderStatusBar() {
  let total = 0;
  for (const it of items.values()) if (it.status === 'downloading') total += it.speed || 0;
  $('#total-speed').textContent = `${fmtBytes(total)}/s`;
  $('#limit-label').textContent = settings && settings.speedLimitKbps ? `Limit ${fmtBytes(settings.speedLimitKbps * 1024)}/s` : '';
}

function applyTheme() {
  const t = settings?.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Actions ----------
async function addUrl(url) {
  const err = $('#add-error');
  err.hidden = true;
  try {
    const it = await api.invoke('add_download', { url });
    items.set(it.id, { ...it, speed: 0, conns: 0 });
    $('#url').value = '';
    renderList();
  } catch (e) {
    err.textContent = String(e);
    err.hidden = false;
  }
}

// ---------- Selecting downloads: click, Ctrl+click, Shift+click, Ctrl+A; Del removes ----------
const selected = new Set();
let anchor = null; // the row a Shift+click range starts from

const visibleIds = () => [...list.children].map(el => Number(el.dataset.id));

function renderSelection() {
  for (const [id, el] of rows) el.classList.toggle('selected', selected.has(id));
  $('#sel-bar').hidden = selected.size === 0;
  $('#sel-count').textContent = `${selected.size} selected`;
}

function setSelection(ids) {
  selected.clear();
  for (const id of ids) selected.add(id);
  renderSelection();
}

list.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); }); // no text selection on Shift+click

list.addEventListener('click', e => {
  if (e.target.closest('[data-act]')) return; // a row button, handled below
  const row = e.target.closest('.item');
  if (!row) { setSelection([]); return; } // empty space clears the selection
  const id = Number(row.dataset.id);
  if (e.shiftKey && anchor != null && visibleIds().includes(anchor)) {
    const ids = visibleIds();
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
    setSelection([...(e.ctrlKey ? selected : []), ...ids.slice(a, b + 1)]);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    renderSelection();
  } else {
    setSelection([id]);
  }
  anchor = id;
});

// Double-click a finished download to open it.
list.addEventListener('dblclick', e => {
  const row = e.target.closest('.item');
  if (!row || e.target.closest('[data-act]')) return;
  const id = Number(row.dataset.id);
  if (items.get(id)?.status === 'completed') api.invoke('open_file', { id }).catch(err => toast(String(err)));
});

$('#sel-all').addEventListener('click', () => setSelection(visibleIds()));
$('#sel-clear').addEventListener('click', () => setSelection([]));
$('#sel-remove').addEventListener('click', () => confirmRemove([...selected]));

// ---------- Removing (one row's X, or the selection) ----------
let pendingRemove = [];

function confirmRemove(ids) {
  const its = ids.map(id => items.get(id)).filter(Boolean);
  if (!its.length) return;
  pendingRemove = its.map(i => i.id);
  const one = its.length === 1;
  const finished = its.filter(i => i.status === 'completed').length;
  $('#rm-title').textContent = one ? 'Remove download?' : `Remove ${its.length} downloads?`;
  $('#rm-name').textContent = one ? its[0].name
    : its.slice(0, 3).map(i => i.name).join(', ') + (its.length > 3 ? ` and ${its.length - 3} more` : '');
  $('#rm-delete').checked = false;
  $('#rm-delete-wrap').hidden = finished === 0;
  $('#rm-delete-text').textContent = one ? 'Also delete the file from disk'
    : `Also delete the ${finished} finished file${finished > 1 ? 's' : ''} from disk`;
  $('#confirm-remove').showModal();
}

list.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.item').dataset.id);
  const act = btn.dataset.act;
  try {
    if (act === 'pause') await api.invoke('pause', { id });
    else if (act === 'resume') await api.invoke('resume', { id });
    else if (act === 'open') await api.invoke('open_file', { id });
    else if (act === 'folder') await api.invoke('show_in_folder', { id });
    else if (act === 'remove') confirmRemove([id]);
  } catch (err) { toast(String(err)); }
});

$('#confirm-remove').addEventListener('close', async () => {
  const ids = pendingRemove;
  pendingRemove = [];
  if ($('#confirm-remove').returnValue !== 'ok' || !ids.length) return;
  try { await api.invoke('remove_many', { ids, deleteFiles: $('#rm-delete').checked }); }
  catch (err) { toast(String(err)); }
});

$('#add-form').addEventListener('submit', e => { e.preventDefault(); addUrl($('#url').value); });

// Paste a link anywhere (outside inputs) to start downloading it.
document.addEventListener('paste', e => {
  if (e.target.closest('input, textarea, select')) return;
  const text = (e.clipboardData.getData('text') || '').trim();
  if (/^https?:\/\/\S+$/i.test(text)) { e.preventDefault(); addUrl(text); }
});

document.addEventListener('keydown', e => {
  // Selection keys only act on the list: not while typing, in a dialog, or in the mini view.
  const free = !e.target.closest('input, textarea, select') && !document.querySelector('dialog[open]') && !mini;
  if (free && e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(visibleIds()); return; }
  if (free && e.key === 'Delete' && selected.size) { e.preventDefault(); confirmRemove([...selected]); return; }
  if (free && e.key === 'Escape' && selected.size) { setSelection([]); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('#url').focus(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'm') { e.preventDefault(); setMini(!mini); }
});

$('.side').addEventListener('click', e => {
  const b = e.target.closest('.nav');
  if (!b || b.id === 'open-settings') return;
  if (b.dataset.status) {
    filter.status = b.dataset.status;
    document.querySelectorAll('[data-status]').forEach(n => n.classList.toggle('on', n === b));
    $('#view-title').textContent = { all: 'All downloads', downloading: 'Active', waiting: 'Queued & paused', completed: 'Completed', failed: 'Failed' }[filter.status];
  } else if (b.dataset.type) {
    filter.type = b.dataset.type;
    renderTypes();
  }
  renderList();
});

$('#q').addEventListener('input', e => { filter.q = e.target.value.trim().toLowerCase(); renderList(); });
$('#clear-done').addEventListener('click', () => api.invoke('clear_completed'));

// Settings dialog
const sd = $('#settings');
function updateConnHint() {
  const v = Number($('#s-conns').value);
  $('#s-conns-out').textContent = v;
  const h = $('#s-conns-hint');
  h.classList.toggle('warn', v > 16);
  h.textContent = v > 16
    ? 'High. Many servers limit connections per IP and may block you temporarily. fastdl backs off automatically, but 8 is safer.'
    : '8 is safe for almost every server. Higher can be faster, but some servers block you for it.';
}
$('#open-settings').addEventListener('click', () => {
  $('#s-conns').value = settings.connections;
  $('#s-active').value = settings.maxActive;
  $('#s-limit').value = settings.speedLimitKbps;
  $('#s-dir').value = settings.dir;
  $('#s-theme').value = settings.theme;
  $('#s-ask').checked = settings.askBeforeDownload;
  $('#s-tray').checked = settings.closeToTray;
  loadAutostart();
  updateConnHint();
  loadExtensionInfo();
  loadStorageInfo();
  sd.showModal();
});
$('#s-conns').addEventListener('input', updateConnHint);

async function loadExtensionInfo() {
  const info = await api.invoke('extension_info');
  $('#s-key').value = info.key;
  if (!info.ready) {
    $('#s-key-hint').firstChild.textContent = `Another program is using port ${info.port}, so the extension can't connect. Close it and restart fastdl. `;
    $('#s-key-hint').classList.add('warn');
  }
}
// "Start fastdl when I sign in" lives in Windows (not in settings), so read it fresh each time.
let autostartWas = false;
async function loadAutostart() {
  const info = await api.invoke('autostart_info').catch(() => ({ available: false, enabled: false }));
  autostartWas = info.enabled;
  $('#s-autostart').checked = info.enabled;
  $('#s-autostart').disabled = !info.available;
  $('#s-autostart-hint').textContent = info.available
    ? "fastdl starts in the tray, so your browser's downloads always reach it."
    : 'Not available in portable mode: it would have to write to the Windows registry.';
}

async function loadStorageInfo() {
  const { storage } = await api.invoke('app_info');
  const portable = storage.mode === 'portable';
  $('#s-data').value = storage.dataDir;
  $('#s-mode').textContent = portable ? 'Portable' : 'Installed';
  $('#s-data-hint').textContent = portable
    ? 'Portable mode: everything stays in this folder next to fastdl.exe. Delete fastdl.ini to turn it off.'
    : 'To run fastdl portable, put a file named fastdl.ini next to fastdl.exe and restart it.';
}
$('#s-open-data').addEventListener('click', () => api.invoke('open_data_folder').catch(e => toast(String(e))));
$('#s-copy-key').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#s-key').value); toast('Key copied. Paste it into the fastdl extension.'); }
  catch { $('#s-key').select(); }
});
$('#s-new-key').addEventListener('click', async () => {
  $('#s-key').value = await api.invoke('new_extension_key');
  toast('New key made. Pair the extension again with it.');
});
$('#s-theme').addEventListener('change', e => { document.documentElement.dataset.theme = e.target.value; if (e.target.value === 'system') document.documentElement.removeAttribute('data-theme'); });
$('#s-browse').addEventListener('click', async () => {
  const dir = await api.invoke('pick_folder');
  if (dir) $('#s-dir').value = dir;
});
sd.addEventListener('close', async () => {
  if (sd.returnValue === 'save') {
    settings = {
      connections: Number($('#s-conns').value),
      maxActive: Math.max(1, Number($('#s-active').value) || 3),
      speedLimitKbps: Math.max(0, Number($('#s-limit').value) || 0),
      dir: $('#s-dir').value,
      theme: $('#s-theme').value,
      askBeforeDownload: $('#s-ask').checked,
      closeToTray: $('#s-tray').checked,
      trayHintShown: settings.trayHintShown,
    };
    await api.invoke('set_settings', { settings });
    const autostart = $('#s-autostart').checked;
    if (!$('#s-autostart').disabled && autostart !== autostartWas) {
      try { await api.invoke('set_autostart', { enabled: autostart }); }
      catch (e) { toast(`Couldn't change "Start fastdl when I sign in": ${e}`, 5000); return; }
    }
    toast('Settings saved');
  }
  applyTheme();
  renderStatusBar();
});

// ---------- Mini view ----------
let mini = false;
let miniKey = '';
let miniHeight = 0;

async function setMini(on) {
  mini = on;
  document.body.classList.toggle('mini-mode', on);
  $('#mini').hidden = !on;
  $('.app').hidden = on;
  miniKey = '';
  renderMini();
  if (T) await api.invoke('set_mini', { mini: on, height: $('#mini').scrollHeight, reposition: on }).catch(e => toast(String(e)));
  miniHeight = on ? $('#mini').scrollHeight : 0;
}

function renderMini() {
  if (!mini) return;
  const rank = { downloading: 0, queued: 1 };
  const list = [...items.values()].filter(i => i.status in rank).sort((a, b) => rank[a.status] - rank[b.status] || a.added - b.added);
  const shown = list.slice(0, 4);
  const key = shown.map(i => `${i.id}:${i.status}:${i.name}`).join(',') + `|${list.length}`;
  const box = $('#mini-list');
  if (key !== miniKey) {
    miniKey = key;
    box.innerHTML = shown.length ? '' : '<p class="mini-empty">No active downloads</p>';
    for (const it of shown) {
      const row = document.createElement('div');
      row.className = 'mini-row';
      row.dataset.id = it.id;
      row.dataset.status = it.status;
      row.innerHTML = '<span class="name"></span><span class="pct"></span><div class="bar"><div class="fill"></div></div>';
      row.querySelector('.name').textContent = it.name;
      row.title = it.name;
      box.appendChild(row);
    }
    if (list.length > shown.length) box.insertAdjacentHTML('beforeend', `<p class="mini-more">+${list.length - shown.length} more</p>`);
    // Grow/shrink the window to fit the rows.
    const h = $('#mini').scrollHeight;
    if (T && h !== miniHeight) { miniHeight = h; api.invoke('set_mini', { mini: true, height: h, reposition: false }).catch(() => {}); }
  }
  for (const row of box.querySelectorAll('.mini-row')) {
    const it = items.get(Number(row.dataset.id));
    if (!it) continue;
    const pct = it.size ? Math.min(100, (it.done / it.size) * 100) : 0;
    row.querySelector('.fill').style.transform = `scaleX(${pct / 100})`;
    row.querySelector('.pct').textContent = it.status === 'queued' ? 'Queued' : it.size ? `${pct.toFixed(0)}%` : fmtBytes(it.done);
  }
  let total = 0;
  for (const it of items.values()) if (it.status === 'downloading') total += it.speed || 0;
  $('#mini-speed').textContent = `${fmtBytes(total)}/s`;
  const n = list.filter(i => i.status === 'downloading').length;
  $('#mini-count').textContent = n ? `· ${n} active` : '';
}

$('#mini-on').addEventListener('click', () => setMini(true));
$('#mini-off').addEventListener('click', () => setMini(false));
$('.mini-bar').addEventListener('dblclick', e => { if (!e.target.closest('button')) setMini(false); });
$('#mini-min').addEventListener('click', () => T?.window.getCurrentWindow().minimize());

// ---------- New download confirm window (downloads sent from the browser) ----------
const ndDialog = $('#new-dl');
const nd = { id: null, nameEdited: false };

function fillNewDownload(it) {
  if (!nd.nameEdited) $('#nd-name').value = it.name;
  if (!$('#nd-dir').value) $('#nd-dir').value = it.dir;
  $('#nd-icon').setAttribute('href', '#' + (TYPES[typeOf($('#nd-name').value)] || { icon: 't-file' }).icon);
  try { $('#nd-from').textContent = `From ${new URL(it.url).host}`; } catch { $('#nd-from').textContent = ''; }
  $('#nd-from').title = it.url;
  const info = $('#nd-info');
  info.classList.toggle('warn', Boolean(it.error) || (it.probed && !it.resumable));
  if (it.error) info.textContent = `Couldn't check the file (${it.error}). You can still try to download it.`;
  else if (!it.probed) info.textContent = 'Getting file info…';
  else info.textContent = `${it.size != null ? fmtBytes(it.size) : 'Unknown size'} · ` +
    (it.resumable ? 'Can pause and resume' : "Can't pause or resume (the server doesn't allow it)");
}

function showNextPending() {
  if (ndDialog.open) return;
  const next = [...items.values()].filter(i => i.status === 'pending').sort((a, b) => a.added - b.added)[0];
  if (!next) return;
  nd.id = next.id;
  nd.nameEdited = false;
  $('#nd-dir').value = '';
  $('#nd-error').hidden = true;
  fillNewDownload(next);
  ndDialog.showModal();
  $('#nd-start').focus();
}

$('#nd-name').addEventListener('input', () => {
  nd.nameEdited = true;
  $('#nd-icon').setAttribute('href', '#' + (TYPES[typeOf($('#nd-name').value)] || { icon: 't-file' }).icon);
});
$('#nd-browse').addEventListener('click', async () => {
  const dir = await api.invoke('pick_folder');
  if (dir) $('#nd-dir').value = dir;
});

// Download / Later: validate with the engine before closing, so errors show in the window.
$('#nd-form').addEventListener('submit', async e => {
  const choice = e.submitter?.value;
  if (choice !== 'start' && choice !== 'later') return; // Cancel closes normally
  e.preventDefault();
  try {
    await api.invoke('confirm_download', { id: nd.id, name: $('#nd-name').value.trim(), dir: $('#nd-dir').value, start: choice === 'start' });
    ndDialog.close('done');
  } catch (err) {
    $('#nd-error').textContent = String(err);
    $('#nd-error').hidden = false;
  }
});

// Cancel button or Esc: drop the download.
ndDialog.addEventListener('close', async () => {
  const id = nd.id;
  nd.id = null;
  if (ndDialog.returnValue !== 'done' && id != null) await api.invoke('remove', { id, deleteFile: false });
  ndDialog.returnValue = '';
  setTimeout(showNextPending, 0);
});

// ---------- "Allow this browser?" (one-click pairing started from the extension) ----------
const prDialog = $('#pair-req');
let pairPrompt = null;
let pairTimer;

function showPairPrompt(p) {
  pairPrompt = p;
  $('#pr-browser').textContent = p.browser;
  $('#pr-code').textContent = p.code;
  clearTimeout(pairTimer);
  pairTimer = setTimeout(() => closePairPrompt(p.ticket), p.expiresInMs);
  if (mini) setMini(false);
  if (!prDialog.open) prDialog.showModal();
}

// The request ended without an answer from this window (it expired, or a newer one replaced it).
function closePairPrompt(ticket) {
  if (pairPrompt?.ticket === ticket && prDialog.open) prDialog.close('gone');
}

// Allow / Don't allow. Esc counts as Don't allow.
prDialog.addEventListener('close', async () => {
  const p = pairPrompt;
  const choice = prDialog.returnValue;
  pairPrompt = null;
  prDialog.returnValue = '';
  clearTimeout(pairTimer);
  if (!p || choice === 'gone') return;
  const allow = choice === 'allow';
  try {
    await api.invoke('answer_pairing', { ticket: p.ticket, allow });
    if (allow) toast(`${p.browser} is connected. Its downloads now go to fastdl.`, 4000);
  } catch (e) { toast(String(e), 4000); }
});

api.listen('pair-request', showPairPrompt);
api.listen('pair-request-closed', closePairPrompt);

// ---------- First close: explain the tray ----------
const trayDialog = $('#tray-hint');
api.listen('tray-hint', () => { if (mini) setMini(false); if (!trayDialog.open) trayDialog.showModal(); });
trayDialog.addEventListener('close', async () => {
  const choice = trayDialog.returnValue;
  trayDialog.returnValue = '';
  if (choice !== 'ok' && choice !== 'quit') return; // Esc: stay open, and explain again next time
  settings = { ...settings, trayHintShown: true };
  await api.invoke('set_settings', { settings });
  await api.invoke(choice === 'quit' ? 'quit_app' : 'hide_to_tray');
});

// ---------- Events from the engine ----------
api.listen('progress', list => {
  for (const p of list) {
    const it = items.get(p.id);
    if (!it) continue;
    it.done = p.done; it.speed = p.speed; it.conns = p.conns;
    renderProgress(it);
  }
  renderStatusBar();
  renderMini();
});
api.listen('item', it => {
  const prev = items.get(it.id);
  const merged = { ...prev, ...it };
  if (it.status === 'pending') {
    items.set(it.id, merged);
    if (mini) setMini(false); // the confirm window needs the full view
    if (nd.id === it.id) fillNewDownload(merged); else showNextPending();
    return;
  }
  if (it.status !== 'downloading') { merged.speed = 0; merged.conns = 0; }
  items.set(it.id, merged);
  if (prev && prev.status !== 'completed' && it.status === 'completed') toast(`Finished: ${it.name}`);
  renderRow(merged);
  if (!prev || prev.status !== it.status) renderList(); else renderCounts();
  renderStatusBar();
  renderMini();
});
api.listen('removed', ids => {
  for (const id of [].concat(ids)) {
    items.delete(id);
    rows.get(id)?.remove();
    rows.delete(id);
    selected.delete(id);
  }
  renderList();
  renderStatusBar();
  renderMini();
});

// ---------- Boot ----------
(async () => {
  const st = await api.invoke('get_state');
  settings = st.settings;
  for (const it of st.items) items.set(it.id, { ...it, speed: 0, conns: 0 });
  applyTheme();
  renderTypes();
  renderList();
  renderStatusBar();
  showNextPending();
  const [ext, info] = await Promise.all([api.invoke('extension_info'), api.invoke('app_info')]);
  if (info.storage.notice) toast(info.storage.notice, 9000);
  if (!ext.ready) toast(`The browser extension can't connect: another program is using port ${ext.port}.`, 6000);
  if (ext.prompt) showPairPrompt(ext.prompt);
})();

// ---------- Simulated backend for previewing the UI in a browser ----------
function mockBackend() {
  const handlers = {};
  const emit = (ev, p) => (handlers[ev] || []).forEach(f => f(p));
  let next = 1;
  const st = { settings: { connections: 8, maxActive: 3, dir: 'C:\\Users\\you\\Downloads', speedLimitKbps: 0, theme: 'system', askBeforeDownload: true, closeToTray: true, trayHintShown: false }, items: [] };
  const now = Date.now();
  const seed = [
    ['https://example.com/ubuntu-24.04.3-desktop-amd64.iso', 6.1e9, 0.42, 'downloading'],
    ['https://example.com/Big_Buck_Bunny_4K.mp4', 8.9e8, 0.77, 'downloading'],
    ['https://example.com/node-v24.18.0-x64.msi', 3.2e7, 0.3, 'paused'],
    ['https://example.com/project-assets.zip', 2.4e8, 0, 'queued'],
    ['https://example.com/annual-report-2026.pdf', 4.8e6, 1, 'completed'],
    ['https://example.com/podcast-episode-112.mp3', 7.3e7, 1, 'completed'],
    ['https://example.com/dataset.tar.gz', 1.2e9, 0.12, 'failed'],
  ];
  for (const [url, size, f, status] of seed) {
    const id = next++;
    st.items.push({ id, url, name: url.split('/').pop(), dir: st.settings.dir, size, resumable: true, status, done: Math.round(size * f),
      error: status === 'failed' ? 'Server replied HTTP 403 to a range request' : null, added: now - id * 60000, finished: status === 'completed' ? now - id * 50000 : null });
  }
  const find = id => st.items.find(i => i.id === id);
  // Open the page with ?pair to preview the "Allow this browser?" window.
  if (location.search.includes('pair')) setTimeout(() => emit('pair-request', { ticket: 1, browser: 'Chromium', code: '9544', expiresInMs: 120000 }), 600);
  setTimeout(() => {
    const it = { id: next++, url: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe', name: 'vlc-3.0.21-win64.exe', dir: st.settings.dir,
      size: null, resumable: false, probed: false, status: 'pending', done: 0, error: null, added: Date.now(), finished: null };
    st.items.push(it);
    emit('item', { ...it });
    setTimeout(() => { Object.assign(it, { size: 4.07e7, resumable: true, probed: true }); emit('item', { ...it }); }, 900);
  }, 1500);
  setInterval(() => {
    const act = st.items.filter(i => i.status === 'downloading');
    emit('progress', act.map(i => {
      const speed = 2e6 + Math.random() * 6e6;
      i.done = Math.min(i.size, i.done + speed * 0.4);
      if (i.done >= i.size) { i.status = 'completed'; i.finished = Date.now(); setTimeout(() => emit('item', { ...i })); }
      return { id: i.id, done: i.done, speed, conns: 8 };
    }));
  }, 400);
  const cmds = {
    get_state: () => structuredClone(st),
    add_download: ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw "That doesn't look like a valid link";
      const it = { id: next++, url, name: url.split('/').pop() || 'download', dir: st.settings.dir, size: 5e8, resumable: true, status: 'downloading', done: 0, error: null, added: Date.now(), finished: null };
      st.items.push(it);
      return { ...it };
    },
    pause: ({ id }) => { const i = find(id); i.status = 'paused'; emit('item', { ...i }); },
    resume: ({ id }) => { const i = find(id); i.status = 'downloading'; i.error = null; emit('item', { ...i }); },
    remove: ({ id }) => cmds.remove_many({ ids: [id] }),
    remove_many: ({ ids }) => {
      const gone = st.items.filter(i => ids.includes(i.id)).map(i => i.id);
      st.items = st.items.filter(i => !ids.includes(i.id));
      if (gone.length) emit('removed', gone);
    },
    clear_completed: () => cmds.remove_many({ ids: st.items.filter(i => i.status === 'completed').map(i => i.id) }),
    set_settings: ({ settings }) => { st.settings = settings; },
    extension_info: () => ({ key: '3f9a-07c2-b1d4-8e60-5a2f-c913-7d08-e4b6', ready: true, port: 17385, prompt: null }),
    app_info: () => ({ version: '0.0.0-preview', storage: { mode: 'portable', dataDir: 'D:\\Apps\\fastdl\\data', notice: null } }),
    open_data_folder: () => toast('Would open the data folder'),
    answer_pairing: () => {},
    autostart_info: () => ({ available: false, enabled: false }),
    set_autostart: () => {},
    hide_to_tray: () => toast('Would hide to the tray'),
    quit_app: () => toast('Would quit'),
    new_extension_key: () => '91c0-4be7-2d38-f6a1-0c95-e27b-58d4-a3f1',
    confirm_download: ({ id, name, start }) => { const i = find(id); i.name = name; i.status = start ? 'downloading' : 'paused'; emit('item', { ...i }); },
    open_file: () => toast('Would open the file'),
    show_in_folder: () => toast('Would open the folder'),
    pick_folder: () => null,
  };
  return {
    invoke: async (cmd, args) => cmds[cmd](args || {}),
    listen: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
  };
}
