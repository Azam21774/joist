'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { accounts: [], recipients: [], settings: {}, run: { state: 'idle' } };
let filter = 'all', search = '';
const MAX_ROWS = 400;

const RUN_LABEL = {
  idle: 'Idle', running: 'Running', pausing: 'Pausing…', paused: 'Paused',
  waiting: 'Waiting for active account', stopping: 'Stopping…', stopped: 'Stopped', done: 'Completed'
};
const ACC_LABEL = { idle: 'Closed', connecting: 'Connecting', active: 'Active', busy: 'Sending', inactive: 'Inactive' };

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 2800);
}

// ------------------------------------------------------------ render
const _cache = new WeakMap();
function setHtml(el, html) {
  if (_cache.get(el) === html) return; // nothing changed -> don't touch the DOM
  const top = el.scrollTop;
  el.innerHTML = html;
  el.scrollTop = top;
  _cache.set(el, html);
}
let _raf = 0;
function scheduleRender() {
  if (_raf) return;
  _raf = requestAnimationFrame(() => { _raf = 0; render(); });
}

function render() {
  const st = S.run.state;
  const rec = S.recipients;
  const sent = rec.filter(r => r.status === 'sent').length;
  const pend = rec.length - sent;
  const activeN = S.accounts.filter(a => a.status === 'active' || a.status === 'busy').length;
  const pct = rec.length ? Math.round((sent / rec.length) * 100) : 0;

  $('#pill').className = 'pill ' + st;
  $('#pill span').textContent = RUN_LABEL[st] || st;
  $('#sTotal').textContent = rec.length;
  $('#sSent').textContent = sent;
  $('#sPend').textContent = pend;
  $('#sAcc').textContent = `${activeN}/${S.accounts.length}`;
  $('#sPct').textContent = pct + '%';
  $('#bar').style.width = pct + '%';

  const live = ['running', 'waiting', 'pausing', 'paused'].includes(st);
  $('#bStart').disabled = !(['idle', 'done'].includes(st) && pend > 0 && S.accounts.length > 0);
  $('#bResume').disabled = !(['paused', 'pausing'].includes(st) || (st === 'stopped' && pend > 0));
  $('#bPause').disabled = !['running', 'waiting'].includes(st);
  $('#bStop').disabled = !live;
  $('#bRestart').disabled = !rec.length || st === 'stopping';
  $('#recClearAll').disabled = $('#recClearSent').disabled = false;

  renderAccounts();
  renderRecipients();
}

function renderAccounts() {
  const st = S.run.state;
  const box = $('#accList');
  if (!S.accounts.length) {
    setHtml(box, '<div class="empty">No accounts yet.<br>Click “+ Add” and enter email:password.</div>');
    return;
  }
  setHtml(box, S.accounts.map(a => {
    const canOpen = !['connecting', 'busy'].includes(a.status);
    const live = ['running', 'waiting', 'pausing', 'paused'].includes(st);
    const openLbl = a.status === 'active' ? 'Focus' : live ? 'Open / Login' : '▶ Start';
    return `<div class="acc ${a.status}">
      <div class="meta">
        <div class="em" title="${esc(a.email)}">${esc(a.email)}</div>
        <div class="nt">${esc(a.note || (a.status === 'idle' ? 'Chrome is closed' : ''))}</div>
      </div>
      <span class="badge ${a.status}">${ACC_LABEL[a.status] || a.status}</span>
      <div class="acts">
        <button class="btn sm go" data-act="open" data-id="${a.id}" ${canOpen ? '' : 'disabled'}>${openLbl}</button>
        <button class="btn sm" data-act="close" data-id="${a.id}" ${['active', 'busy'].includes(a.status) ? '' : 'disabled'}>Close</button>
        <button class="btn sm danger" data-act="remove" data-id="${a.id}">Remove</button>
      </div>
    </div>`;
  }).join(''));
}

function renderRecipients() {
  const q = search.trim().toLowerCase();
  const rows = S.recipients.filter(r =>
    (filter === 'all' || (filter === 'sent' ? r.status === 'sent' : r.status !== 'sent')) &&
    (!q || r.email.toLowerCase().includes(q)));
  const box = $('#recList');
  if (!rows.length) {
    setHtml(box, `<div class="empty">${S.recipients.length ? 'Nothing matches this filter.' : 'No recipients yet.<br>Use “+ Add” or Import.'}</div>`);
    return;
  }
  setHtml(box, rows.slice(0, MAX_ROWS).map(r => `
    <div class="rec"><span class="e" title="${esc(r.email)}">${esc(r.email)}</span>
      <span class="st ${r.status}">${r.status}</span>
      <button class="x" data-rm="${esc(r.id)}" ${r.status === 'sending' ? 'disabled' : ''} title="Remove">✕</button>
    </div>`).join('') +
    (rows.length > MAX_ROWS ? `<div class="more">+ ${rows.length - MAX_ROWS} more (use search or filter)</div>` : ''));
}

function addLog(l) {
  const box = $('#logBox');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const d = document.createElement('div');
  d.className = 'ln ' + l.level;
  d.innerHTML = `<span class="t">${new Date(l.t).toLocaleTimeString()}</span><span>${esc(l.msg)}</span>`;
  box.appendChild(d);
  while (box.children.length > 400) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------ settings form
const num = v => (v === '' || v == null ? null : Math.max(0, Number(v)));
function fillForm(s) {
  $('#fSubject').value = s.subject || '';
  $('#fMessage').value = s.message || '';
  $('#fEstimate').value = s.estimateName || '';
  $('#fBatch').value = s.batchSize ?? 10;
  $('#fBatchDelay').value = s.batchDelayMs ?? '';
  $('#fType').value = s.typingDelayMs ?? '';
  $('#fRType').value = s.recipientTypingDelayMs ?? '';
  $('#fChrome').value = s.chromePath || '';
}
let saveT;
function saveForm() {
  clearTimeout(saveT);
  saveT = setTimeout(() => api.saveSettings({
    subject: $('#fSubject').value,
    message: $('#fMessage').value,
    estimateName: $('#fEstimate').value.trim(),
    batchSize: Math.max(1, num($('#fBatch').value) || 10),
    batchDelayMs: num($('#fBatchDelay').value),
    typingDelayMs: num($('#fType').value),
    recipientTypingDelayMs: num($('#fRType').value),
    chromePath: $('#fChrome').value.trim()
  }), 250);
}
['#fSubject', '#fMessage', '#fEstimate', '#fBatch', '#fBatchDelay', '#fType', '#fRType', '#fChrome']
  .forEach(s => $(s).addEventListener('input', saveForm));

// ------------------------------------------------------------ dialogs
function bulkDialog({ title, hint, placeholder }) {
  return new Promise(resolve => {
    const dlg = $('#dlg');
    $('#dlgTitle').textContent = title;
    $('#dlgHint').textContent = hint;
    $('#dlgText').value = '';
    $('#dlgText').placeholder = placeholder;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? $('#dlgText').value : null), { once: true });
    dlg.showModal();
    $('#dlgText').focus();
  });
}
const report = (r, what) => r && toast(`${r.added} ${what} added` + (r.dup ? `, ${r.dup} duplicate` : '') + (r.bad ? `, ${r.bad} invalid` : ''), !r.added && (r.bad || r.dup));

// ------------------------------------------------------------ events
$('#accAdd').onclick = async () => {
  const t = await bulkDialog({ title: 'Add accounts', hint: 'One per line: email:password', placeholder: 'user1@mail.com:password1\nuser2@mail.com:password2' });
  if (t) report(await api.accounts.add(t), 'account');
};
$('#accRemoveAll').onclick = () => {
  if (!S.accounts.length) return toast('No accounts to remove.', true);
  const live = ['running', 'waiting', 'pausing', 'paused'].includes(S.run.state);
  if (confirm(`Remove all ${S.accounts.length} accounts? Their Chrome windows will be closed.` + (live ? '\n\nA run is in progress — it will wait until you add an active account.' : ''))) api.accounts.removeAll();
};
$('#accImport').onclick = async () => report(await api.accounts.import(), 'account');
$('#recAdd').onclick = async () => {
  const t = await bulkDialog({ title: 'Add recipients', hint: 'One per line, or comma-separated', placeholder: 'a@mail.com\nb@mail.com, c@mail.com' });
  if (t) report(await api.recipients.add(t), 'recipient');
};
$('#recImport').onclick = async () => report(await api.recipients.import(), 'recipient');
$('#recClearAll').onclick = () => S.recipients.length && confirm('Remove all recipients?') && api.recipients.clear('all');
$('#recClearSent').onclick = () => api.recipients.clear('sent');

$('#accList').onclick = async e => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const { act, id } = b.dataset;
  if (act === 'open') api.accounts.open(id);
  else if (act === 'close') api.accounts.close(id);
  else if (act === 'remove') {
    const a = S.accounts.find(x => x.id === id);
    if (confirm(`${a ? a.email : 'Account'} Remove this account? Its Chrome window will be closed too.`)) api.accounts.remove(id);
  }
};
$('#recList').onclick = e => {
  const b = e.target.closest('button[data-rm]');
  if (b && !b.disabled) api.recipients.remove([b.dataset.rm]);
};
$('#recFilter').onclick = e => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('#recFilter button').forEach(x => x.classList.toggle('on', x === b));
  renderRecipients();
};
$('#recSearch').oninput = e => { search = e.target.value; renderRecipients(); };
$('#tabs').onclick = e => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#tab-compose').classList.toggle('hide', b.dataset.t !== 'compose');
  $('#tab-settings').classList.toggle('hide', b.dataset.t !== 'settings');
};
$('#logClear').onclick = () => ($('#logBox').innerHTML = '');

const run = (fn, ok) => async () => {
  const r = await fn();
  if (r && r.ok === false && r.error) toast(r.error, true);
};
$('#bStart').onclick = run(() => api.run.start());
$('#bPause').onclick = run(() => api.run.pause());
$('#bResume').onclick = run(() => api.run.resume());
$('#bStop').onclick = run(() => api.run.stop());
$('#bRestart').onclick = run(async () => {
  if (!confirm('Restart will reset all recipients to “pending” and start again from the beginning. Continue?')) return;
  return api.run.restart();
});

// ------------------------------------------------------------ boot
(async () => {
  const { state, logs } = await api.init();
  S = state;
  fillForm(S.settings);
  logs.forEach(addLog);
  render();
  api.onState(s => { S = s; scheduleRender(); });
  api.onLog(addLog);
})();
