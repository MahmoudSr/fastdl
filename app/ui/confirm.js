'use strict';
// The small "New download" window: asks about downloads sent from the browser, one at a time,
// oldest first, then asks fastdl to close it. The main window stays wherever it is.

const api = connect(mockBackend);
const pending = new Map(); // id -> item waiting for an answer
let current = null;        // id shown now
let nameEdited = false;
let busy = false;          // an answer is on its way to the engine

function fill(it) {
  if (!nameEdited) $('#nd-name').value = it.name;
  if (!$('#nd-dir').value) $('#nd-dir').value = it.dir;
  $('#nd-icon').setAttribute('href', '#' + typeIcon($('#nd-name').value));
  let host = '';
  try { host = new URL(it.url).host; } catch { /* shown without a host */ }
  $('#nd-from').textContent = host ? `From ${host}` : '';
  $('#nd-from').title = it.url;
  const info = $('#nd-info');
  info.classList.toggle('warn', Boolean(it.error) || (it.probed && !it.resumable));
  if (it.error) info.textContent = `Couldn't check the file (${it.error}). You can still try to download it.`;
  else if (!it.probed) info.textContent = 'Getting file info…';
  else info.textContent = `${it.size != null ? fmtBytes(it.size) : 'Unknown size'} · ` +
    (it.resumable ? 'Can pause and resume' : "Can't pause or resume (the server doesn't allow it)");
}

function renderMore() {
  const more = pending.size - (current != null ? 1 : 0);
  $('#nd-more').hidden = more <= 0;
  $('#nd-more').textContent = `+${more} more`;
  $('#nd-more').title = `${more} more download${more > 1 ? 's' : ''} waiting after this one`;
}

/** Show the oldest download still waiting, or ask to close the window when there's none. */
async function showNext() {
  const next = [...pending.values()].sort((a, b) => a.id - b.id)[0];
  if (!next) {
    current = null;
    // fastdl refuses if a download arrived meanwhile; its "item" event then brings it here.
    if (await api.invoke('close_confirm')) return;
    renderMore();
    return;
  }
  current = next.id;
  nameEdited = false;
  $('#nd-dir').value = '';
  $('#nd-error').hidden = true;
  fill(next);
  renderMore();
  $('#nd-start').focus();
}

async function answer(choice) {
  if (busy || current == null) return;
  busy = true;
  const id = current;
  try {
    if (choice === 'cancel') {
      await api.invoke('remove', { id, deleteFile: false });
    } else {
      await api.invoke('confirm_download', { id, name: $('#nd-name').value.trim(), dir: $('#nd-dir').value, start: choice === 'start' });
      // Also starts every other download waiting here: you asked not to be asked.
      if ($('#nd-dont-ask').checked) { await api.invoke('stop_asking'); pending.clear(); }
    }
    pending.delete(id);
    await showNext();
  } catch (err) {
    $('#nd-error').textContent = String(err);
    $('#nd-error').hidden = false;
  } finally {
    busy = false;
  }
}

document.querySelectorAll('[data-answer]').forEach(b => b.addEventListener('click', () => answer(b.dataset.answer)));
$('#nd-name').addEventListener('input', () => {
  nameEdited = true;
  $('#nd-icon').setAttribute('href', '#' + typeIcon($('#nd-name').value));
});
$('#nd-browse').addEventListener('click', async () => {
  const dir = await api.invoke('pick_folder');
  if (dir) $('#nd-dir').value = dir;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); answer('cancel'); }
  // Enter in the name box means Download (on a focused button, Enter clicks that button).
  else if (e.key === 'Enter' && e.target.id === 'nd-name') { e.preventDefault(); answer('start'); }
});

// The window's X (or Alt+F4): Cancel, like Esc.
api.listen('confirm-cancel', () => answer('cancel'));

api.listen('item', it => {
  if (it.status === 'pending') {
    const isNew = !pending.has(it.id);
    pending.set(it.id, { ...pending.get(it.id), ...it });
    if (it.id === current) fill(pending.get(it.id));
    else if (current == null && !busy) showNext();
    else if (isNew) renderMore();
    return;
  }
  // Answered some other way (e.g. "Don't ask again" started it).
  if (!pending.delete(it.id)) return;
  if (it.id === current && !busy) showNext(); else renderMore();
});
api.listen('removed', ids => {
  let shownGone = false;
  for (const id of [].concat(ids)) { pending.delete(id); if (id === current) shownGone = true; }
  if (shownGone && !busy) showNext(); else renderMore();
});
api.listen('settings', s => applyTheme(s.theme));

(async () => {
  const st = await api.invoke('get_state');
  applyTheme(st.settings.theme);
  for (const it of st.items) if (it.status === 'pending') pending.set(it.id, it);
  showNext();
})();

// ---------- Simulated backend: open confirm.html in a browser to preview this window ----------
function mockBackend() {
  const handlers = {};
  const emit = (ev, p) => (handlers[ev] || []).forEach(f => f(p));
  const dir = 'C:\\Users\\you\\Downloads';
  const mk = (id, url) => ({ id, url, name: url.split('/').pop(), dir, size: null, resumable: false, probed: false, status: 'pending', done: 0, error: null, added: Date.now(), finished: null });
  const items = [mk(1, 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe'), mk(2, 'https://example.com/annual-report-2026.pdf')];
  setTimeout(() => { Object.assign(items[0], { size: 4.07e7, resumable: true, probed: true }); emit('item', { ...items[0] }); }, 900);
  setTimeout(() => { Object.assign(items[1], { size: 4.8e6, resumable: false, probed: true }); emit('item', { ...items[1] }); }, 1400);
  const done = id => { const i = items.findIndex(x => x.id === id); if (i >= 0) items.splice(i, 1); };
  const cmds = {
    get_state: () => ({ settings: { theme: 'system' }, items: items.map(i => ({ ...i })) }),
    confirm_download: ({ id }) => done(id),
    remove: ({ id }) => done(id),
    stop_asking: () => {},
    pick_folder: () => null,
    close_confirm: () => { document.body.innerHTML = '<p style="padding:24px">(The window would close now.)</p>'; return true; },
  };
  return {
    invoke: async (cmd, args) => cmds[cmd](args || {}),
    listen: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
  };
}
