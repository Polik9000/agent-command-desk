'use strict';
/* Agent Command Desk – frontend (vanilla JS). Token jen v paměti, výstup Claude přes marked + DOMPurify. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const APPROVE_PROMPT = 'Plán schvaluji, proveď ho.';

const S = {
  token: null,
  appName: 'Agent Command Desk',
  accounts: [],
  projects: [],
  account: null,
  project: null,
  mode: 'auto',
  sessionId: null,
  run: null,          // { runId, controller, mode, account, prompt, sawPlan, resultText, resultError }
  lastPrompt: null,
  totalCost: 0,
  queue: new MessageQueue(),
  queueEdit: null,       // id položky fronty, která se právě upravuje
  queueWaitingEdit: false,
  queueNotice: null,
  models: [{ id: '', label: 'Výchozí účtu' }],
  efforts: [''],
  model: '',             // pro další zprávy (pamatuje se pro každý účet)
  effort: '',
  pending: [],           // přílohy připravené k odeslání
  attachNotice: null,
};

const DEFAULT_ATTACH_TEXT = 'Podívej se na přílohy.';
const ATTACH_RX = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|json|log)$/i;
const ATTACH_MAX = 10;
const ATTACH_MARK = '\n\nPřílohy od uživatele (soubory jen ke čtení, přečti je nástrojem Read):\n';

/* ---------- Token ---------- */
(function takeToken() {
  const m = /[#&]t=([A-Za-z0-9_\-]+)/.exec(location.hash);
  if (m) {
    S.token = m[1];
    history.replaceState(null, '', location.pathname); // token pryč z URL
  }
})();

/* ---------- API ---------- */
async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { 'X-ACD-Token': S.token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal, cache: 'no-store' });
  return res;
}
async function apiJson(path, opts) {
  const res = await api(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* prázdné tělo */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

/* ---------- Markdown ---------- */
function setupMarkdown() {
  if (window.DOMPurify) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    });
  }
  if (window.marked) marked.setOptions({ gfm: true, breaks: false });
  if (window.hljs) hljs.configure({ ignoreUnescapedHTML: true });
}
function renderMd(target, text, highlight) {
  const html = window.marked ? marked.parse(text || '') : null;
  if (html != null && window.DOMPurify) {
    target.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'], FORBID_ATTR: ['style'] });
  } else {
    target.textContent = text || '';
  }
  if (highlight && window.hljs) target.querySelectorAll('pre code').forEach((c) => { try { hljs.highlightElement(c); } catch { } });
}

/* ---------- Pomocné ---------- */
const chat = () => $('#chat');
function scrollDown(force) {
  const c = chat();
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 160;
  if (force || nearBottom) c.scrollTop = c.scrollHeight;
}
function append(node, force) {
  $('#empty').hidden = true;
  chat().appendChild(node);
  scrollDown(force);
  return node;
}
function clearChat() {
  chat().querySelectorAll(':scope > :not(#empty)').forEach((n) => n.remove());
  $('#empty').hidden = false;
}
function setStatus(text, busy) {
  const s = $('#status');
  s.textContent = '';
  if (busy) s.appendChild(el('span', 'spin'));
  s.appendChild(document.createTextNode(text || ''));
}
function fmtTime(epochSec) {
  if (!epochSec) return null;
  const d = new Date(epochSec * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })} ${time}`;
}
function fmtRelative(iso) {
  const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'teď';
  if (diff < 3600) return `před ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `před ${Math.floor(diff / 3600)} h`;
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
}
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} kB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
const accountById = (id) => S.accounts.find((a) => a.id === id);
const otherAccount = (id) => S.accounts.find((a) => a.id !== id && a.ok);

/* ---------- Stav, účty, projekty ---------- */
async function loadState() {
  const st = await apiJson('/api/state');
  if (st.app && st.app.name) { S.appName = st.app.name; $('#brand-name').textContent = st.app.name; }
  if (Array.isArray(st.models)) S.models = st.models;
  if (Array.isArray(st.efforts)) S.efforts = st.efforts;
  S.accounts = st.accounts;
  S.projects = st.projects;
  if (!S.account) S.account = st.defaultAccount;
  if (!S.project) S.project = st.defaultProject;
  renderAccounts();
  renderProjects();
  applyAccent();
  return st;
}

function renderAccounts() {
  const fs = $('#accounts');
  fs.querySelectorAll('.seg-item').forEach((n) => n.remove());
  for (const a of S.accounts) {
    const label = el('label', 'seg-item');
    label.style.setProperty('--item-accent', a.accent);
    const input = el('input');
    input.type = 'radio'; input.name = 'account'; input.value = a.id;
    input.checked = a.id === S.account;
    const pending = !a.ok && a.error === 'Ověřuji…';
    input.disabled = (!a.ok && !pending) || !!S.run;
    if (!a.ok && !pending) label.dataset.unavailable = 'true';
    const span = el('span');
    span.appendChild(el('i', 'swatch'));
    span.appendChild(document.createTextNode(a.label));
    label.title = a.ok ? a.email : (a.error || '');
    input.addEventListener('change', () => switchAccount(a.id));
    label.append(input, span);
    fs.appendChild(label);
  }
}

function renderProjects() {
  const sel = $('#project');
  const cur = S.project;
  sel.textContent = '';
  for (const p of S.projects) {
    const o = el('option', null, p.exists ? p.label : `${p.label} (chybí)`);
    o.value = p.id; o.disabled = !p.exists; o.selected = p.id === cur;
    sel.appendChild(o);
  }
  sel.disabled = !!S.run;
}

function applyAccent() {
  const a = accountById(S.account);
  if (a) document.documentElement.style.setProperty('--accent', a.accent);
  document.title = (S.attention ? '● ' : '') + (a ? `${S.appName} – ${a.label}` : S.appName);
}

/* ---------- Model a effort ---------- */
const RUNOPTS_KEY = (acc) => `acd.runopts.${acc}`;
const PRESETS = [
  { label: 'Rychlé', model: 'sonnet', effort: 'low' },
  { label: 'Běžná práce', model: '', effort: '' },
  { label: 'Důkladné', model: 'opus', effort: 'high' },
];
const modelLabel = (id) => (S.models.find((m) => m.id === id) || { label: id || 'Výchozí účtu' }).label;

function loadRunOpts() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(RUNOPTS_KEY(S.account)) || '{}'); } catch { o = {}; }
  S.model = S.models.some((m) => m.id === o.model) ? o.model : '';
  S.effort = S.efforts.includes(o.effort) ? o.effort : '';
  renderRunOpts();
}

function setRunOpts(model, effort) {
  S.model = S.models.some((m) => m.id === model) ? model : '';
  S.effort = S.efforts.includes(effort) ? effort : '';
  localStorage.setItem(RUNOPTS_KEY(S.account), JSON.stringify({ model: S.model, effort: S.effort }));
  renderRunOpts();
}

function renderRunOpts() {
  const sum = $('#runopts-summary');
  if (!sum) return;
  const custom = S.model || S.effort;
  sum.textContent = custom ? `${modelLabel(S.model)} · ${S.effort || 'výchozí'}` : 'Model: výchozí';
  sum.classList.toggle('is-custom', !!custom);
  const ms = $('#model'), es = $('#effort'), box = $('#runopts-presets');
  // Volby a předvolby se staví jen jednou: přestavění by zrušilo fokus a klik by vypadal jako klik mimo panel.
  if (!box.childElementCount) {
    for (const m of S.models) { const o = el('option', null, m.label); o.value = m.id; ms.appendChild(o); }
    for (const e of S.efforts) { const o = el('option', null, e || 'Výchozí'); o.value = e; es.appendChild(o); }
    for (const p of PRESETS.filter((x) => !x.model || S.models.some((m) => m.id === x.model))) {
      const b = button(p.label, 'btn-ghost btn-small', () => setRunOpts(p.model, p.effort));
      b.title = `${modelLabel(p.model)} · effort ${p.effort || 'výchozí'}`;
      b.dataset.model = p.model; b.dataset.effort = p.effort;
      box.appendChild(b);
    }
  }
  ms.value = S.model; es.value = S.effort;
  for (const b of box.children)
    b.setAttribute('aria-pressed', b.dataset.model === S.model && b.dataset.effort === S.effort ? 'true' : 'false');
}

function setupRunOpts() {
  $('#model').addEventListener('change', (e) => setRunOpts(e.target.value, S.effort));
  $('#effort').addEventListener('change', (e) => setRunOpts(S.model, e.target.value));
  const d = $('#runopts');
  document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target)) d.open = false; });
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { d.open = false; $('#runopts-summary').focus(); } });
}

/* ---------- Oznámení (volitelná, jen když okno není aktivní) ---------- */
const NOTIFY_KEY = 'acd.notify';
const notifyEnabled = () => localStorage.getItem(NOTIFY_KEY) === '1' && 'Notification' in window && Notification.permission === 'granted';

const NOTIFY_KINDS_KEY = 'acd.notify.kinds';
const NOTIFY_KINDS = ['ok', 'plan', 'problem'];
/** Kdy upozornit (výchozí: vždy). */
function notifyKinds() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(NOTIFY_KINDS_KEY) || '{}') || {}; } catch { o = {}; }
  return Object.fromEntries(NOTIFY_KINDS.map((k) => [k, o[k] !== false]));
}

function renderNotifyToggle() {
  const supported = 'Notification' in window;
  const denied = supported && Notification.permission === 'denied';
  const on = notifyEnabled();
  for (const b of document.querySelectorAll('.notify-toggle')) {
    b.textContent = on ? 'Oznámení: zapnuto' : 'Oznámení: vypnuto';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = !supported ? 'Prohlížeč oznámení nepodporuje.'
      : denied ? 'Oznámení jsou v prohlížeči zakázaná (ikona zámku vedle adresy → Oznámení).'
        : 'Upozornit, když Claude doběhne nebo čeká (jen když okno není aktivní).';
    b.disabled = !supported;
  }
  const kinds = notifyKinds();
  const fs = $('#set-notify-kinds');
  if (fs) {
    fs.disabled = !on;
    for (const c of fs.querySelectorAll('input')) c.checked = kinds[c.value];
  }
}

async function toggleNotify() {
  if (!('Notification' in window)) return;
  if (notifyEnabled()) { localStorage.setItem(NOTIFY_KEY, '0'); renderNotifyToggle(); return; }
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; } }
  localStorage.setItem(NOTIFY_KEY, perm === 'granted' ? '1' : '0');
  renderNotifyToggle();
}

/** Upozorní, jen když se uživatel zrovna nedívá. kind: ok | plan | problem (volby v Nastavení). */
function notify(title, body, kind) {
  if (document.hasFocus() && !document.hidden) return;
  S.attention = true;
  applyAccent();
  if (!notifyEnabled() || (kind && !notifyKinds()[kind])) return;
  try {
    const n = new Notification(title, { body: (body || '').slice(0, 180), icon: 'favicon.svg', tag: 'acd-run' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* oznámení nejde zobrazit */ }
}

async function loadGit() {
  const g = $('#git');
  try {
    const info = await apiJson(`/api/projects/${encodeURIComponent(S.project)}/git`);
    g.textContent = '';
    if (!info.branch) return;
    g.appendChild(document.createTextNode(`větev ${info.branch}`));
    if (info.changed) g.appendChild(el('span', 'changed', ` • ${info.changed} ${plural(info.changed, 'změna', 'změny', 'změn')}`));
  } catch { g.textContent = ''; }
}

async function loadSessions() {
  const ul = $('#sessions');
  let list = [];
  try {
    list = await apiJson(`/api/sessions?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`);
  } catch (e) {
    ul.textContent = '';
    ul.appendChild(el('li', 's-empty', e.message));
    return;
  }
  ul.textContent = '';
  if (!list.length) { ul.appendChild(el('li', 's-empty', 'Zatím žádná sezení.')); return; }
  for (const s of list) {
    const li = el('li');
    const b = el('button');
    b.type = 'button';
    b.dataset.id = s.id;
    if (s.id === S.sessionId) b.setAttribute('aria-current', 'true');
    b.append(el('span', 's-title', s.title), el('span', 's-meta', fmtRelative(s.updated) + (s.busy ? ' • běží' : '')));
    b.addEventListener('click', () => openSession(s.id));
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function markCurrentSession() {
  document.querySelectorAll('#sessions button').forEach((b) => {
    if (b.dataset.id === S.sessionId) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  $('#foot-session').textContent = S.sessionId ? `sezení ${S.sessionId.slice(0, 8)}` : 'Nové sezení';
}

/** Přepnutí účtu/projektu/sezení: fronta patří k aktuálnímu sezení → po potvrzení se zahodí. */
function leaveContext() {
  if (!S.queue.length) return true;
  const n = S.queue.length;
  const what = plural(n, 'čeká 1 zpráva', `čekají ${n} zprávy`, `čeká ${n} zpráv`);
  if (!confirm(`Ve frontě ${what} pro toto sezení. Při přepnutí se fronta zahodí. Pokračovat?`)) return false;
  S.queue.clear();
  S.queueEdit = null;
  S.queueWaitingEdit = false;
  renderQueue();
  return true;
}

function newSession() {
  if (S.run || !leaveContext()) return;
  S.sessionId = null;
  P.sessionPrompts = [];
  clearChat();
  hideBanner();
  markCurrentSession();
  $('#prompt').focus();
}

async function openSession(id) {
  if (S.run || !leaveContext()) return;
  S.sessionId = id;
  markCurrentSession();
  clearChat();
  hideBanner();
  setStatus('Načítám sezení…', true);
  try {
    const items = await apiJson(`/api/sessions/${encodeURIComponent(id)}?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`);
    P.sessionPrompts = items.filter((it) => it.role === 'user').map((it) => it.text).slice(-30);
    let tools = null;
    for (const it of items) {
      if (it.role === 'tool') {
        if (!tools) { tools = append(el('div', 'msg msg--note')); tools.dataset.names = ''; }
        tools.dataset.names += (tools.dataset.names ? ', ' : '') + it.name;
        tools.textContent = `Nástroje: ${tools.dataset.names}`;
        continue;
      }
      tools = null;
      if (it.role === 'user') append(userBubble(it.text));
      else {
        const m = append(el('div', 'msg msg--claude md'));
        renderMd(m, it.text, true);
      }
    }
    append(el('div', 'msg msg--note', 'Pokračujte další zprávou.'), true);
    setStatus('');
  } catch (e) {
    setStatus('');
    showError('Sezení nelze načíst', e.message);
  }
}

/** @returns {Promise<boolean>} zda se účet opravdu přepnul */
async function switchAccount(id) {
  if (S.run || id === S.account) return false;
  if (!leaveContext()) { renderAccounts(); return false; }
  discardPending();
  S.account = id;
  loadRunOpts();
  applyAccent();
  renderAccounts();
  newSession();
  await loadSessions();
  return true;
}

async function switchProject(id) {
  if (S.run || id === S.project) return;
  if (!leaveContext()) { $('#project').value = S.project; return; }
  discardPending();
  S.project = id;
  newSession();
  await Promise.all([loadSessions(), loadGit()]);
}

/* ---------- Paleta příkazů (Ctrl+K) ---------- */
// Příkazy a skilly z posledního init daného účtu a projektu (localStorage – jen názvy, ne obsah zpráv).
// Nedávné zprávy jen v paměti okna (odeslané v tomto okně + zprávy otevřeného sezení); na disk se neukládají.
const CMDS_KEY = (acc, proj) => `acd.cmds.${acc}.${proj}`;
const P = { items: [], sel: 0, recent: [], sessionPrompts: [] };

function rememberCommands(ev) {
  const list = [...new Set([...(ev.slashCommands || []), ...(ev.skills || [])])];
  if (!list.length) return;
  try { localStorage.setItem(CMDS_KEY(S.account, S.project), JSON.stringify(list.slice(0, 300))); } catch { }
}
function knownCommands() {
  try { const a = JSON.parse(localStorage.getItem(CMDS_KEY(S.account, S.project)) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}
function rememberPrompt(text) {
  const t = String(text || '').trim();
  if (!t) return;
  P.recent = [t, ...P.recent.filter((x) => x !== t)].slice(0, 20);
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); // bez diakritiky a velikosti písmen

function paletteActions() {
  return [
    { label: 'Nové sezení', run: () => newSession() },
    { label: 'Režim Auto', run: () => setMode('auto') },
    { label: 'Režim Plán', run: () => setMode('plan') },
    ...PRESETS.filter((x) => !x.model || S.models.some((m) => m.id === x.model))
      .map((p) => ({ label: `Model: ${p.label}`, meta: `${modelLabel(p.model)} · ${p.effort || 'výchozí'}`, run: () => setRunOpts(p.model, p.effort) })),
    { label: 'Přiložit soubory', run: () => $('#file-input').click() },
    { label: 'Změny v gitu', run: () => openGit() },
    { label: 'Nastavení', run: () => openSettings() },
    { label: document.fullscreenElement ? 'Ukončit celou obrazovku' : 'Celá obrazovka', run: () => toggleFullscreen() },
  ];
}

function insertIntoPrompt(text, { replaceEmpty = true } = {}) {
  const ta = $('#prompt');
  if (replaceEmpty && !ta.value.trim()) { ta.value = text; ta.setSelectionRange(text.length, text.length); }
  else {
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
    ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
    ta.setSelectionRange(a + text.length, a + text.length);
  }
  ta.focus();
}

function buildPalette(q) {
  const f = fold(q.trim());
  const match = (label) => !f || fold(label).includes(f);
  const score = (label) => (f && fold(label).startsWith(f) ? 0 : 1);
  const groups = [];
  const cmds = knownCommands().map((c) => ({ kind: 'cmd', label: `/${c}`, run: () => insertIntoPrompt(`/${c} `) }))
    .filter((x) => match(x.label) || match(x.label.slice(1)));
  const acts = paletteActions().map((a) => ({ kind: 'act', ...a })).filter((x) => match(x.label));
  const seen = new Set();
  const recent = [...P.recent, ...P.sessionPrompts.slice().reverse()].filter((t) => !seen.has(t) && seen.add(t)).slice(0, 30)
    .map((t) => ({ kind: 'msg', label: t.replace(/\s+/g, ' '), meta: t.length > 90 ? `${t.length} znaků` : '', run: () => insertIntoPrompt(t) }))
    .filter((x) => match(x.label));
  const sort = (a) => a.sort((x, y) => score(x.label) - score(y.label));
  // Lomítko na začátku = hledám příkaz.
  if (q.trim().startsWith('/')) groups.push(['Příkazy a skilly', sort(cmds)]);
  else groups.push(['Akce', sort(acts)], ['Příkazy a skilly', sort(cmds)], ['Nedávné zprávy', recent]);
  return groups.filter(([, items]) => items.length);
}

function renderPalette() {
  const ul = $('#palette-list');
  ul.textContent = '';
  const groups = buildPalette($('#palette-input').value);
  P.items = [];
  for (const [title, items] of groups) {
    const g = el('li', 'palette-group', title);
    g.setAttribute('role', 'presentation');
    ul.appendChild(g);
    for (const it of items) {
      const li = el('li', 'palette-item');
      li.id = `pal-${P.items.length}`;
      li.setAttribute('role', 'option');
      li.dataset.kind = it.kind;
      li.appendChild(el('span', 'palette-label', it.label));
      if (it.meta) li.appendChild(el('span', 'palette-meta', it.meta));
      const idx = P.items.length;
      li.addEventListener('mousemove', () => { if (P.sel !== idx) { P.sel = idx; markPalette(); } });
      li.addEventListener('click', () => { P.sel = idx; runPalette(); });
      ul.appendChild(li);
      P.items.push({ ...it, node: li });
    }
  }
  if (!P.items.length) {
    const e = el('li', 'palette-empty', knownCommands().length || $('#palette-input').value ? 'Nic nenalezeno.' : 'Nic nenalezeno. Příkazy se objeví po prvním běhu v tomto projektu.');
    e.setAttribute('role', 'presentation');
    ul.appendChild(e);
  }
  P.sel = Math.min(P.sel, Math.max(0, P.items.length - 1));
  markPalette();
}

function markPalette() {
  P.items.forEach((it, i) => it.node.setAttribute('aria-selected', i === P.sel ? 'true' : 'false'));
  const cur = P.items[P.sel];
  const input = $('#palette-input');
  if (cur) { input.setAttribute('aria-activedescendant', cur.node.id); cur.node.scrollIntoView({ block: 'nearest' }); }
  else input.removeAttribute('aria-activedescendant');
}

function runPalette() {
  const it = P.items[P.sel];
  if (!it) return;
  $('#palette').close();
  it.run();
}

function openPalette() {
  const d = $('#palette');
  if (d.open) { d.close(); return; }
  for (const x of document.querySelectorAll('dialog[open]')) x.close();
  $('#palette-input').value = '';
  P.sel = 0;
  renderPalette();
  d.showModal();
  $('#palette-input').focus();
}

function setupPalette() {
  $('#palette-open').addEventListener('click', openPalette);
  $('#palette-input').addEventListener('input', () => { P.sel = 0; renderPalette(); });
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); P.sel = Math.min(P.sel + 1, P.items.length - 1); markPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); P.sel = Math.max(P.sel - 1, 0); markPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
  });
  $('#palette').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
}

/* ---------- Git přehled (jen pro čtení) ---------- */
const GIT_CODES = { M: 'změněno', A: 'přidáno', D: 'smazáno', R: 'přejmenováno', C: 'zkopírováno', T: 'změna typu', U: 'konflikt', '?': 'nový' };
const G = { files: null, sel: null, seq: 0 };

async function openGit() {
  const d = $('#gitdlg');
  if (!d.open) d.showModal();
  await loadGitFiles();
}

async function loadGitFiles() {
  const nav = $('#git-files');
  nav.textContent = '';
  $('#git-sub').textContent = 'Načítám…';
  let r;
  try { r = await apiJson(`/api/projects/${encodeURIComponent(S.project)}/git/files`); }
  catch (e) { $('#git-sub').textContent = e.message; return; }
  if (!r.repo) { $('#git-sub').textContent = 'Projekt není git repozitář.'; showDiff(null); return; }
  const ab = r.upstream ? ` • ${r.upstream}` + (r.ahead ? ` • ${r.ahead} napřed` : '') + (r.behind ? ` • ${r.behind} pozadu` : '') : '';
  $('#git-sub').textContent = `větev ${r.branch || '(odpojená HEAD)'}${ab} • ${r.files.length} ${plural(r.files.length, 'soubor', 'soubory', 'souborů')}`;
  const groups = [
    ['Konflikty', r.files.filter((f) => f.kind === 'conflict').map((f) => [f, 'worktree', 'U'])],
    ['Připravené ke commitu', r.files.filter((f) => f.kind !== 'conflict' && f.kind !== 'untracked' && f.x !== '.').map((f) => [f, 'staged', f.x])],
    ['Změněné', r.files.filter((f) => f.kind !== 'conflict' && f.kind !== 'untracked' && f.y !== '.').map((f) => [f, 'worktree', f.y])],
    ['Nové (nesledované)', r.files.filter((f) => f.kind === 'untracked').map((f) => [f, 'untracked', '?'])],
  ];
  const all = [];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    const g = el('div', 'git-group');
    g.appendChild(el('h3', 'eyebrow', `${title} (${items.length})`));
    for (const [f, area, code] of items) {
      const b = el('button', 'git-file');
      b.type = 'button';
      const c = el('span', 'git-code', code); c.dataset.k = code; c.title = GIT_CODES[code] || code;
      b.appendChild(c);
      const p = el('span', 'git-path', f.path);
      if (f.orig && area === 'staged') p.appendChild(el('small', null, `dříve ${f.orig}`));
      b.appendChild(p);
      b.setAttribute('aria-label', `${f.path} – ${GIT_CODES[code] || code}`);
      b.addEventListener('click', () => selectGitFile(b, f.path, area));
      b.dataset.key = `${area}\n${f.path}`;
      g.appendChild(b);
      all.push(b);
    }
    nav.appendChild(g);
  }
  if (!all.length) { showDiff(null, 'Žádné změny – pracovní strom je čistý.'); return; }
  const keep = G.sel && all.find((b) => b.dataset.key === G.sel);
  const first = keep || all[0];
  const [area, path] = first.dataset.key.split('\n');
  selectGitFile(first, path, area);
}

async function selectGitFile(btn, path, area) {
  for (const b of $('#git-files').querySelectorAll('.git-file')) b.setAttribute('aria-current', b === btn ? 'true' : 'false');
  G.sel = `${area}\n${path}`;
  const seq = ++G.seq;
  showDiff(null, 'Načítám…');
  try {
    const r = await apiJson(`/api/projects/${encodeURIComponent(S.project)}/git/diff?path=${encodeURIComponent(path)}&area=${area}`);
    if (seq === G.seq) showDiff(r);
  } catch (e) { if (seq === G.seq) showDiff(null, e.message); }
}

/** Unified diff → řádky s barvami (stejné třídy jako u karet nástrojů). */
function showDiff(r, message) {
  const box = $('#git-diff');
  box.textContent = '';
  if (!r) { if (message) box.appendChild(el('p', 'git-note', message)); return; }
  if (r.note) box.appendChild(el('p', 'git-note', r.note));
  if (r.diff) {
    const d = el('div', 'diff');
    const lines = r.diff.replace(/\n$/, '').split('\n');
    for (const line of lines) {
      const k = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line) ? 'file'
        : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
      d.appendChild(el('div', k, line));
    }
    box.appendChild(d);
  }
  if (r.truncated) box.appendChild(el('p', 'git-note', 'Diff je příliš dlouhý – zobrazen jen začátek.'));
}

function setupGit() {
  $('#git').addEventListener('click', openGit);
  $('#git-refresh').addEventListener('click', loadGitFiles);
  $('#git-close').addEventListener('click', () => $('#gitdlg').close());
  $('#gitdlg').addEventListener('close', () => { if (!S.run) loadGit(); });
}

/* ---------- Nastavení ---------- */
function setMsg(text, kind) {
  const m = $('#set-projects-msg');
  m.textContent = text || '';
  if (kind) m.dataset.kind = kind; else delete m.dataset.kind;
}

async function openSettings() {
  const d = $('#settings');
  setMsg('');
  renderSettingsAccounts();
  renderFullscreenButton();
  renderNotifyToggle();
  if (!d.open) d.showModal();
  try { renderSettingsProjects(await apiJson('/api/settings')); } catch (e) { setMsg(e.message, 'err'); }
}

function renderSettingsAccounts() {
  const ul = $('#set-accounts');
  ul.textContent = '';
  for (const a of S.accounts) {
    const li = el('li', 'set-item');
    const sw = el('i', 'swatch'); sw.style.background = a.accent; li.appendChild(sw);
    const main = el('div', 'set-item-main');
    main.appendChild(el('span', 'set-item-label', a.label));
    main.appendChild(el('span', 'set-item-path', a.ok ? a.email : (a.error || '')));
    li.appendChild(main);
    li.appendChild(el('span', a.ok ? 'set-badge' : 'set-badge set-badge--bad', a.ok ? 'ověřen' : 'nedostupný'));
    ul.appendChild(li);
  }
}

function renderSettingsProjects(view) {
  const ul = $('#set-projects');
  ul.textContent = '';
  for (const p of view.projects) {
    const li = el('li', 'set-item');
    const main = el('div', 'set-item-main');
    main.appendChild(el('span', 'set-item-label', p.label));
    main.appendChild(el('span', 'set-item-path', p.path));
    li.appendChild(main);
    if (p.id === S.project) li.appendChild(el('span', 'set-badge', 'otevřený'));
    if (p.id === view.defaultProject) li.appendChild(el('span', 'set-badge', 'výchozí'));
    li.appendChild(button('Přejmenovat', 'btn-ghost btn-small', () => startRename(li, p)));
    const rm = button('Odebrat', 'btn-danger btn-small', () => removeProject(p));
    rm.disabled = view.projects.length <= 1 || (!!S.run && p.id === S.project);
    if (rm.disabled) rm.title = view.projects.length <= 1 ? 'Poslední projekt nelze odebrat.' : 'V projektu právě běží Claude.';
    li.appendChild(rm);
    ul.appendChild(li);
  }
}

function startRename(li, p) {
  const main = li.querySelector('.set-item-main');
  const label = main.querySelector('.set-item-label');
  const input = el('input');
  input.type = 'text'; input.value = p.label; input.maxLength = 60;
  input.setAttribute('aria-label', `Nový název projektu ${p.label}`);
  main.replaceChild(input, label);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (!save || !v || v === p.label) { main.replaceChild(label, input); return; }
    await changeProject('PATCH', p.id, { label: v }, `Projekt přejmenován na „${v}“.`);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function removeProject(p) {
  const current = p.id === S.project;
  if (!confirm(`Odebrat projekt „${p.label}“ ze seznamu?\n\nSložka ani sezení se nesmažou, jen zmizí z aplikace.`)) return;
  if (current && !leaveContext()) return;
  await changeProject('DELETE', p.id, undefined, `Projekt „${p.label}“ odebrán.`);
}

/** Zápis projektů → obnovit seznam v Nastavení i v hlavičce; zmizí-li otevřený projekt, přepnout. */
async function changeProject(method, id, body, okText) {
  const url = id ? `/api/settings/projects/${encodeURIComponent(id)}` : '/api/settings/projects';
  try {
    const view = await apiJson(url, { method, body });
    await loadState();
    if (!S.projects.some((x) => x.id === S.project)) {
      const next = S.projects.find((x) => x.exists) || S.projects[0];
      S.project = '';
      await switchProject(next.id);
    }
    renderSettingsProjects(view);
    setMsg(okText);
    return view;
  } catch (e) {
    setMsg(e.message, 'err');
    try { renderSettingsProjects(await apiJson('/api/settings')); } catch { }
    return null;
  }
}

async function addProjectSubmit(e) {
  e.preventDefault();
  const label = $('#set-add-label').value.trim();
  const path = $('#set-add-path').value.trim();
  if (!label || !path) return;
  const view = await changeProject('POST', '', { label, path }, `Projekt „${label}“ přidán – najdete ho v přepínači projektů.`);
  if (view) { $('#set-add-label').value = ''; $('#set-add-path').value = ''; }
}

function renderFullscreenButton() {
  const b = $('#set-fullscreen');
  const on = !!document.fullscreenElement;
  b.textContent = on ? 'Ukončit celou obrazovku' : 'Celá obrazovka';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.disabled = !document.fullscreenEnabled;
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* prohlížeč odmítl */ }
}

function setupSettings() {
  $('#settings-open').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => $('#settings').close());
  $('#settings').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }); // klik na pozadí
  $('#set-add').addEventListener('submit', addProjectSubmit);
  $('#set-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', renderFullscreenButton);
  $('#set-notify').addEventListener('click', toggleNotify);
  $('#set-notify-kinds').addEventListener('change', () => {
    const o = {};
    for (const c of $('#set-notify-kinds').querySelectorAll('input')) o[c.value] = c.checked;
    localStorage.setItem(NOTIFY_KINDS_KEY, JSON.stringify(o));
  });
}

/* ---------- Banner ---------- */
function hideBanner() { const b = $('#banner'); b.hidden = true; b.textContent = ''; b.className = 'banner'; }
function showBanner(kind, html, actions) {
  const b = $('#banner');
  b.className = 'banner' + (kind === 'warn' ? ' warn' : '');
  b.textContent = '';
  const t = el('div', 'banner-text');
  t.append(...html);
  b.appendChild(t);
  for (const a of actions || []) b.appendChild(a);
  b.hidden = false;
}
function button(text, cls, onClick) {
  const b = el('button', 'btn ' + cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function showLimit(accountId, resetsAt, detail) {
  const acc = accountById(accountId);
  const other = otherAccount(accountId);
  const when = fmtTime(resetsAt);
  const strong = el('strong', null, `Účet ${acc ? acc.label : accountId} narazil na limit.`);
  const parts = [strong, document.createTextNode(when ? ` Obnoví se v ${when}.` : ' Čas obnovení není známý.')];
  if (detail) parts.push(el('div', null, detail));
  const actions = [];
  if (other) {
    actions.push(button(`Přepnout na ${other.label} a poslat znovu`, 'btn-accent', async () => {
      const prompt = S.lastPrompt;
      if (await switchAccount(other.id) && prompt) { $('#prompt').value = prompt; send(); }
    }));
    actions.push(button(`Jen přepnout`, 'btn-ghost', () => switchAccount(other.id)));
  }
  showBanner('err', parts, actions);
}

function showError(title, detail) {
  const box = el('div', 'msg msg--error');
  box.appendChild(el('div', 'eyebrow', title));
  if (detail) box.appendChild(el('pre', null, detail));
  append(box, true);
}

/* ---------- Nástroje ---------- */
function toolSummary(name, input, cwd) {
  if (!input || typeof input !== 'object') return '';
  const rel = (p) => {
    if (typeof p !== 'string') return '';
    if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase())) return p.slice(cwd.length).replace(/^[\\/]/, '') || '.';
    return p;
  };
  switch (name) {
    case 'Bash': case 'PowerShell': return (input.command || '').split('\n')[0];
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return rel(input.file_path);
    case 'NotebookEdit': return rel(input.notebook_path);
    case 'Glob': return input.pattern + (input.path ? `  v ${rel(input.path)}` : '');
    case 'Grep': return `${input.pattern}${input.path ? '  v ' + rel(input.path) : ''}`;
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'Task': case 'Agent': return input.description || '';
    case 'Skill': return input.skill || '';
    case 'TodoWrite': return Array.isArray(input.todos) ? `${input.todos.length} úkolů` : '';
    default: {
      const v = Object.values(input).find((x) => typeof x === 'string');
      return v ? v.split('\n')[0] : '';
    }
  }
}

const tools = new Map();
function toolCard(id, name, parent) {
  let t = tools.get(id);
  if (t) return t;
  const d = el('details', 'tool' + (parent ? ' sub' : ''));
  d.dataset.state = 'running';
  const sum = el('summary');
  const nm = el('span', 'tool-name', name || 'nástroj');
  const sm = el('span', 'tool-sum');
  const badge = el('span', 'tool-badge', 'běží');
  sum.append(nm, sm, badge);
  const body = el('div', 'tool-body');
  d.append(sum, body);
  t = { d, nm, sm, badge, body, name };
  tools.set(id, t);
  append(d);
  return t;
}

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length * B.length > 250000) return [...A.map((l) => ['del', l]), ...B.map((l) => ['add', l])];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(['ctx', A[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(['del', A[i++]]);
    else out.push(['add', B[j++]]);
  }
  while (i < n) out.push(['del', A[i++]]);
  while (j < m) out.push(['add', B[j++]]);
  return out;
}
function diffView(edits, file) {
  const box = el('div', 'diff');
  if (file) box.appendChild(el('div', 'file', file));
  edits.forEach((e, idx) => {
    if (idx > 0) box.appendChild(el('div', 'ctx', '⋯'));
    for (const [k, line] of lineDiff(e.old || '', e.new || '')) {
      if (e.old === '' && k === 'del') continue;
      box.appendChild(el('div', k, (k === 'add' ? '+ ' : k === 'del' ? '- ' : '  ') + line));
    }
  });
  return box;
}

function fillToolInput(t, name, input, cwd) {
  t.name = name;
  t.nm.textContent = name;
  t.sm.textContent = toolSummary(name, input, cwd);
  t.body.textContent = '';
  if (name === 'Edit' && input) {
    t.body.appendChild(diffView([{ old: input.old_string, new: input.new_string }], toolSummary(name, input, cwd)));
  } else if (name === 'MultiEdit' && input && Array.isArray(input.edits)) {
    t.body.appendChild(diffView(input.edits.map((e) => ({ old: e.old_string, new: e.new_string })), toolSummary(name, input, cwd)));
  } else if (name === 'Write' && input) {
    t.body.appendChild(diffView([{ old: '', new: input.content || '' }], toolSummary(name, input, cwd)));
  } else if ((name === 'Bash' || name === 'PowerShell') && input) {
    t.body.appendChild(el('div', 'eyebrow', 'Příkaz'));
    t.body.appendChild(el('pre', null, input.command || ''));
  } else if (input && Object.keys(input).length) {
    t.body.appendChild(el('div', 'eyebrow', 'Vstup'));
    t.body.appendChild(el('pre', null, JSON.stringify(input, null, 2)));
  }
}

function fillToolResult(t, ev) {
  const state = ev.denied ? 'denied' : ev.isError ? 'error' : 'ok';
  t.d.dataset.state = state;
  t.badge.textContent = state === 'denied' ? 'zamítnuto' : state === 'error' ? 'chyba' : 'hotovo';
  if (ev.denied) {
    const why = [ev.decisionSource, ev.decisionReason].filter(Boolean).join(' / ');
    t.body.appendChild(el('div', 'tool-reason', `Zamítnuto${why ? ` (${why})` : ''}.`));
    t.d.open = true;
  }
  if (ev.content) {
    t.body.appendChild(el('div', 'eyebrow', 'Výsledek'));
    t.body.appendChild(el('pre', null, ev.content));
  }
  if (state === 'error' && !ev.denied) t.d.open = true;
}

/* ---------- Plán ---------- */
function showPlanCard(markdown, title) {
  const box = el('div', 'plan');
  box.appendChild(el('div', 'eyebrow', title || 'Plán'));
  if (markdown) {
    const body = el('div', 'md');
    renderMd(body, markdown, true);
    box.appendChild(body);
  }
  const actions = el('div', 'plan-actions');
  const approve = button('Schválit plán', 'btn-accent', () => approvePlan(approve));
  actions.append(approve, el('span', 'hint', 'Spustí se v režimu Auto ve stejném sezení. Úpravy plánu napište jako další zprávu.'));
  box.appendChild(actions);
  append(box, true);
}

function approvePlan(btn) {
  if (S.run || !S.sessionId) return;
  btn.disabled = true;
  setMode('auto');
  if (S.queue.paused === 'plan') S.queue.resume(); // schválením je důvod pauzy vyřešen; fronta pokračuje po provedení plánu
  startRun(APPROVE_PROMPT, 'auto');
}

function setMode(m) {
  S.mode = m;
  document.querySelectorAll('input[name="mode"]').forEach((i) => { i.checked = i.value === m; });
}

/* ---------- Běh ---------- */
function setRunning(on) {
  $('#send').textContent = on ? 'Poslat hned' : 'Odeslat';
  $('#send').title = on ? 'Claude si zprávu přečte ještě během práce (Ctrl+Enter)' : 'Odeslat (Ctrl+Enter)';
  $('#queue-send').hidden = !on;
  $('#stop').hidden = !on;
  $('#prompt').disabled = false;
  $('#prompt').placeholder = on ? 'Ctrl+Enter = poslat hned do běžící práce, Ctrl+Shift+Enter = do fronty'
    : 'Napište zprávu… (Ctrl+Enter odešle)';
  $('#new-session').disabled = on;
  renderAccounts();
  renderProjects();
  renderQueue();
}

/**
 * Odeslat. Když Claude pracuje: target 'now' = do běžícího tahu (Claude ji přečte na nejbližším předělu),
 * 'queue' = do fronty (odešle se po dokončení).
 */
function send(target = 'now') {
  const ta = $('#prompt');
  if (S.pending.some((a) => a.status === 'uploading')) { S.attachNotice = 'Počkejte, až se přílohy nahrají.'; renderAttachments(); return; }
  const files = S.pending.filter((a) => a.status === 'ok').map(({ id, name, type, size }) => ({ id, name, type, size }));
  const prompt = ta.value.trim() || (files.length ? DEFAULT_ATTACH_TEXT : '');
  if (!prompt) return;
  if (S.run) {
    if (target === 'queue' || !S.run.runId) { if (enqueue(prompt, files)) clearPending(); return; }
    ta.value = '';
    clearPending();
    rememberPrompt(prompt);
    injectNow(S.run, prompt, files);
    return;
  }
  ta.value = '';
  clearPending();
  rememberPrompt(prompt);
  startRun(prompt, S.mode, files);
}

/** Zpráva do běžícího tahu; když už běh končí (409), jde do fronty. */
async function injectNow(run, prompt, files) {
  let res;
  try {
    res = await api(`/api/runs/${run.runId}/message`, { method: 'POST', body: { prompt, attachments: files.map((f) => f.id) } });
  } catch (e) {
    showError('Zprávu se nepodařilo poslat', e.message);
    return;
  }
  if (res.status === 409 || res.status === 404) {
    if (S.run === run || S.run === null) {
      enqueue(prompt, files);
      S.queueNotice = 'Claude už práci dokončoval – zpráva je ve frontě a odešle se hned po něm.';
      renderQueue();
      if (!S.run) setTimeout(dispatchNext, 0);
    }
    return;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { }
    showError('Zprávu se nepodařilo poslat', msg);
    return;
  }
  const bubble = userBubble(prompt, files);
  bubble.classList.add('msg--injected');
  const state = el('span', 'msg-inject-state', 'Posláno do běžící práce – čeká, až si ji Claude přečte…');
  bubble.appendChild(state);
  append(bubble, true);
  run.injectedBubbles.push(state);
}

/** Bublina mé zprávy; text z historie může obsahovat blok s cestami k přílohám. */
function userBubble(text, files) {
  let body = text;
  let names = (files || []).map((f) => `${f.name} (${fmtSize(f.size)})`);
  const at = body.indexOf(ATTACH_MARK);
  if (at >= 0) {
    names = body.slice(at + ATTACH_MARK.length).split('\n').map((l) => l.replace(/^- /, '').split(/[\\/]/).pop()).filter(Boolean);
    body = body.slice(0, at);
  }
  const box = el('div', 'msg msg--me', body);
  if (names.length) {
    const list = el('div', 'msg-attachments');
    for (const n of names) list.appendChild(el('span', 'msg-attachment', `📎 ${n}`));
    box.appendChild(list);
  }
  return box;
}

async function startRun(prompt, mode, files = [], opts = { model: S.model, effort: S.effort }) {
  if (S.run) return;
  hideBanner();
  S.lastPrompt = prompt;
  append(userBubble(prompt, files), true);

  const controller = new AbortController();
  const run = { runId: null, controller, mode, account: S.account, prompt, sawPlan: false, resultText: null,
    resultError: false, hadError: false, cwd: null, limitShown: false, outcome: null, sessionId: S.sessionId,
    replays: 0, injectedBubbles: [], model: opts.model || '', effort: opts.effort || '' };
  S.run = run;
  setRunning(true);
  setStatus('Spouštím Claude…', true);

  const state = { msgBlocks: new Map(), finalized: new Set() };
  try {
    const res = await api('/api/runs', {
      method: 'POST',
      signal: controller.signal,
      body: { account: S.account, project: S.project, mode, prompt, resume: S.sessionId, attachments: files.map((f) => f.id), model: run.model, effort: run.effort },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          handleEvent(ev, run, state);
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') showError('Běh se nepodařilo spustit', e.message);
    run.outcome ??= e.name === 'AbortError' ? 'stopped' : 'error';
  } finally {
    S.run = null;
    setRunning(false);
    if (!$('#status').textContent.startsWith('Hotovo') && !$('#status').textContent.startsWith('Zastaveno')) setStatus('');
    loadSessions();
    loadGit();
    $('#prompt').focus();
    afterRun(run);
  }
}

/* ---------- Fronta zpráv ---------- */
function enqueue(prompt, files = []) {
  let ok = false;
  try {
    S.queue.add({ prompt, mode: S.mode, account: S.account, project: S.project, sessionId: S.sessionId, run: S.run, attachments: files,
      opts: { model: S.model, effort: S.effort } });
    $('#prompt').value = '';
    S.queueNotice = null;
    ok = true;
  } catch (e) {
    S.queueNotice = e.message;
  }
  renderQueue();
  return ok;
}

/** Konec běhu → výsledek pro frontu: ok | stopped | error | limit | plan. */
function afterRun(run) {
  const outcome = run.outcome ?? 'error';
  const go = S.queue.onRunEnd(outcome);
  renderQueue();
  if (go) { setTimeout(dispatchNext, 0); return; }
  const queued = S.queue.length ? ` Ve frontě čeká ${S.queue.length}.` : '';
  const texts = {
    ok: ['Claude doběhl', (run.resultText || 'Hotovo.') + queued],
    plan: ['Plán čeká na schválení', 'Podívejte se na plán a schvalte ho.' + queued],
    limit: ['Účet narazil na limit', 'Přepněte na jiný účet, nebo počkejte na obnovení.' + queued],
    error: ['Běh skončil chybou', (run.resultText || 'Podívejte se do okna.') + queued],
  };
  const kind = { ok: 'ok', plan: 'plan', limit: 'problem', error: 'problem' }[outcome];
  if (texts[outcome]) notify(...texts[outcome], kind);
}

function dispatchNext() {
  if (S.run) return;
  if (S.queueEdit !== null) { S.queueWaitingEdit = true; renderQueue(); return; }
  const item = S.queue.takeNext({ account: S.account, project: S.project, sessionId: S.sessionId });
  renderQueue();
  if (item) startRun(item.prompt, item.mode, item.attachments, { model: S.model, effort: S.effort, ...item.opts });
}

function finishQueueEdit() {
  S.queueEdit = null;
  if (S.queueWaitingEdit) { S.queueWaitingEdit = false; if (!S.run) setTimeout(dispatchNext, 0); }
  renderQueue();
}

/* ---------- Přílohy ---------- */
let attachSeq = 0;
const attachUrl = (extra = '') => `?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}${extra}`;

function deleteAttachment(id) {
  if (id) api(`/api/attachments/${id}${attachUrl()}`, { method: 'DELETE' }).catch(() => {});
}
function clearPending() { S.pending = []; S.attachNotice = null; renderAttachments(); }
function discardPending() { for (const a of S.pending) deleteAttachment(a.id); clearPending(); }

async function addFiles(fileList, fromClipboard) {
  for (const file of fileList) {
    if (S.pending.length >= ATTACH_MAX) { S.attachNotice = `Nejvýš ${ATTACH_MAX} příloh ke zprávě.`; break; }
    let name = file.name || 'soubor';
    if (fromClipboard && file.type.startsWith('image/')) {
      const t = new Date().toTimeString().slice(0, 8).replaceAll(':', '');
      name = `schránka-${t}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    }
    if (!ATTACH_RX.test(name)) { S.attachNotice = `${name}: nepodporovaný typ (obrázky, PDF, txt, md, csv, json, log).`; continue; }
    const item = { key: ++attachSeq, name, size: file.size, type: file.type, status: 'uploading', id: null, thumb: null };
    S.pending.push(item);
    if (file.type.startsWith('image/') && file.size < 5 * 1024 * 1024) {
      const r = new FileReader();
      r.onload = () => { item.thumb = String(r.result); renderAttachments(); };
      r.readAsDataURL(file);
    }
    renderAttachments();
    upload(item, file);
  }
  renderAttachments();
}

async function upload(item, file) {
  try {
    const res = await fetch(`/api/attachments${attachUrl(`&name=${encodeURIComponent(item.name)}`)}`, {
      method: 'POST', headers: { 'X-ACD-Token': S.token, 'Content-Type': 'application/octet-stream' }, body: file, cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch { /* prázdné tělo */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    if (!S.pending.includes(item)) { deleteAttachment(data.id); return; } // mezitím odebráno
    Object.assign(item, { id: data.id, name: data.name, type: data.type, size: data.size, status: 'ok' });
  } catch (e) {
    item.status = 'error';
    item.error = e.message;
  }
  renderAttachments();
}

function renderAttachments() {
  const box = $('#attach-list');
  box.textContent = '';
  if (!S.pending.length && !S.attachNotice) { box.hidden = true; return; }
  box.hidden = false;
  for (const a of S.pending) {
    const chip = el('div', 'attach-chip');
    chip.dataset.state = a.status;
    if (a.thumb) { const img = el('img', 'attach-thumb'); img.src = a.thumb; img.alt = ''; chip.appendChild(img); }
    else chip.appendChild(el('span', 'attach-ext', (a.name.split('.').pop() || '?').toUpperCase()));
    const info = el('span', 'attach-info');
    info.append(el('span', 'attach-name', a.name),
      el('span', 'attach-meta', a.status === 'uploading' ? 'nahrávám…' : a.status === 'error' ? a.error : `${a.type || '?'} • ${fmtSize(a.size)}`));
    chip.appendChild(info);
    chip.appendChild(iconButton('✕', `Odebrat přílohu ${a.name}`, () => {
      S.pending = S.pending.filter((x) => x !== a);
      deleteAttachment(a.id);
      S.attachNotice = null;
      renderAttachments();
    }));
    box.appendChild(chip);
  }
  if (S.attachNotice) box.appendChild(el('div', 'queue-notice', S.attachNotice));
}

function setupAttachments() {
  const input = $('#file-input');
  $('#attach').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  $('#prompt').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(files, true);
  });
  // Přetažení: vždy zachytit, jinak by Chrome soubor otevřel místo aplikace (a ztratil klíč).
  const hint = $('#drop-hint');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; hint.hidden = false; } });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; hint.hidden = true; } });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer && S.queueDrag == null) e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'none';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0; hint.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  });
}

/** Enter v seznamu doplní další číslo / odrážku; Shift+Enter = obyčejný nový řádek (výchozí chování). */
function listKeydown(e) {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
  const ta = e.target;
  if (ta.selectionStart !== ta.selectionEnd) return;
  const r = window.ListEditor.continueList(ta.value, ta.selectionStart);
  if (!r) return;
  e.preventDefault();
  ta.setSelectionRange(r.from, r.to);
  // execCommand zachová Ctrl+Z; kdyby nebyl k dispozici, setRangeText.
  const ok = r.insert ? document.execCommand('insertText', false, r.insert) : document.execCommand('delete');
  if (!ok) ta.setRangeText(r.insert, r.from, r.to, 'end');
  ta.setSelectionRange(r.caret, r.caret);
}

function iconButton(text, label, onClick, disabled) {
  const b = button(text, 'btn-ghost btn-icon', onClick);
  b.setAttribute('aria-label', label);
  b.title = label;
  b.disabled = !!disabled;
  return b;
}

function renderQueue() {
  const box = $('#queue');
  const q = S.queue;
  const prevScroll = box.querySelector('.queue-list')?.scrollTop ?? 0;
  box.textContent = '';
  if (!q.length && !S.queueNotice) { box.hidden = true; return; }
  box.hidden = false;

  const head = el('div', 'queue-head');
  head.appendChild(el('span', 'eyebrow', `Fronta (${q.length})`));
  let state = '';
  if (q.length) {
    state = q.paused ? `Pozastaveno – ${q.pauseText}` : S.queueWaitingEdit ? 'Čeká na dokončení úprav.'
      : S.run ? 'Odešle se postupně po dokončení běhu.' : 'Čeká.';
  }
  head.appendChild(el('span', 'queue-state' + (q.paused ? ' paused' : ''), state));
  if (q.length && q.paused && !S.run && q.paused !== 'context')
    head.appendChild(button('Pokračovat', 'btn-accent btn-small', () => { q.resume(); dispatchNext(); }));
  if (q.length && !q.paused && S.run)
    head.appendChild(button('Pozastavit', 'btn-ghost btn-small', () => { q.pause('manual'); renderQueue(); }));
  if (q.length)
    head.appendChild(button('Vyprázdnit', 'btn-ghost btn-small', () => {
      for (const it of q.items) for (const f of it.attachments) deleteAttachment(f.id);
      q.clear(); S.queueEdit = null; S.queueWaitingEdit = false; S.queueNotice = null; renderQueue();
    }));
  box.appendChild(head);
  if (S.queueNotice) box.appendChild(el('div', 'queue-notice', S.queueNotice));

  const ol = el('ol', 'queue-list');
  q.items.forEach((it, idx) => {
    const li = el('li', 'queue-item');
    li.appendChild(el('span', 'queue-mode', it.mode === 'plan' ? 'Plán' : 'Auto'));
    if (S.queueEdit === it.id) {
      const ta = el('textarea', 'queue-edit');
      ta.value = it.prompt;
      ta.rows = 3;
      ta.setAttribute('aria-label', `Upravit zprávu ${idx + 1}`);
      const save = () => {
        try { q.update(it.id, ta.value); S.queueNotice = null; } catch (e) { S.queueNotice = e.message; renderQueue(); return; }
        finishQueueEdit();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); finishQueueEdit(); }
        listKeydown(e);
      });
      const actions = el('span', 'queue-tools');
      actions.append(button('Uložit', 'btn-accent btn-small', save), button('Zrušit', 'btn-ghost btn-small', finishQueueEdit));
      li.append(ta, actions);
      ol.appendChild(li);
      setTimeout(() => ta.focus(), 0);
      return;
    }
    const handle = el('span', 'queue-handle', '⠿');
    handle.draggable = true;
    handle.title = 'Přetáhněte pro změnu pořadí (klávesnicí šipkami)';
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('dragstart', (e) => {
      S.queueDrag = it.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-acd-queue', String(it.id));
      e.dataTransfer.setDragImage(li, 12, 12);
      li.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => { S.queueDrag = null; renderQueue(); });
    li.addEventListener('dragover', (e) => {
      if (S.queueDrag == null) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (e) => {
      if (S.queueDrag == null) return;
      e.preventDefault();
      e.stopPropagation();
      const from = q.items.findIndex((x) => x.id === S.queueDrag);
      let to = idx + (li.classList.contains('drop-after') ? 1 : 0);
      if (from < to) to -= 1;
      S.queueFocus = { id: S.queueDrag, action: 'up' };
      q.moveTo(S.queueDrag, to);
      S.queueDrag = null;
      renderQueue();
    });
    li.prepend(handle);
    const txt = el('span', 'queue-text', it.prompt);
    if (it.attachments.length) txt.appendChild(el('span', 'queue-files', ` 📎 ${it.attachments.length}`));
    li.appendChild(txt);
    const tools = el('span', 'queue-tools');
    const tool = (text, action, label, onClick, disabled) => {
      const b = iconButton(text, label, () => { S.queueFocus = { id: it.id, action }; onClick(); }, disabled);
      b.dataset.q = `${it.id}:${action}`;
      return b;
    };
    tools.append(
      tool('↑', 'up', `Posunout zprávu ${idx + 1} výš`, () => { q.move(it.id, -1); renderQueue(); }, idx === 0),
      tool('↓', 'down', `Posunout zprávu ${idx + 1} níž`, () => { q.move(it.id, 1); renderQueue(); }, idx === q.length - 1),
      tool('✎', 'edit', `Upravit zprávu ${idx + 1}`, () => { S.queueEdit = it.id; renderQueue(); }),
      tool('✕', 'remove', `Odebrat zprávu ${idx + 1}`, () => {
        // Po smazání zůstat na sousední zprávě (další, jinak předchozí).
        const neighbour = q.items[idx + 1] ?? q.items[idx - 1];
        S.queueFocus = neighbour ? { id: neighbour.id, action: 'remove' } : null;
        q.remove(it.id);
        if (S.queueEdit === it.id) finishQueueEdit(); else renderQueue();
      }),
    );
    li.appendChild(tools);
    ol.appendChild(li);
  });
  box.appendChild(ol);

  // Překreslení nesmí skočit na začátek: zachovat posun seznamu a výběr na stejné zprávě.
  ol.scrollTop = prevScroll;
  const f = S.queueFocus;
  S.queueFocus = null;
  if (f) {
    const order = [f.action, f.action === 'up' ? 'down' : 'up', 'edit'];
    const btn = order.map((a) => ol.querySelector(`[data-q="${f.id}:${a}"]`)).find((b) => b && !b.disabled);
    if (btn) {
      btn.focus({ preventScroll: true });
      btn.closest('li')?.scrollIntoView({ block: 'nearest' });
    }
  }
}

function textBlock(state, messageId, index) {
  const key = `${messageId}:${index ?? 0}`;
  let b = state.msgBlocks.get(key);
  if (!b) {
    const node = append(el('div', 'msg msg--claude md'));
    b = { node, raw: '', messageId, pending: false };
    state.msgBlocks.set(key, b);
  }
  return b;
}
function scheduleRender(b) {
  if (b.pending) return;
  b.pending = true;
  requestAnimationFrame(() => { b.pending = false; renderMd(b.node, b.raw, false); scrollDown(); });
}

function handleEvent(ev, run, state) {
  switch (ev.type) {
    case 'run':
      run.runId = ev.runId;
      break;
    case 'init':
      S.sessionId = ev.sessionId;
      run.sessionId = ev.sessionId;
      S.queue.bindSession(run, ev.sessionId);
      run.cwd = ev.cwd;
      rememberCommands(ev);
      markCurrentSession();
      $('#foot-model').textContent = `${ev.model || ''} • ${ev.permissionMode || ''}`
        + (run.effort ? ` • effort ${run.effort} (požadováno)` : '') + ` • v${ev.version || ''}`;
      setStatus(run.mode === 'plan' ? 'Claude plánuje…' : 'Claude pracuje…', true);
      break;
    case 'text_delta': {
      if (ev.parent) break;
      const b = textBlock(state, ev.messageId, ev.index);
      b.raw += ev.text || '';
      scheduleRender(b);
      setStatus('Claude píše…', true);
      break;
    }
    case 'text': {
      if (ev.parent) break;
      // Najdi první nefinalizovaný blok této zprávy, jinak vytvoř nový.
      let target = null;
      for (const [key, b] of state.msgBlocks) {
        if (b.messageId === ev.messageId && !state.finalized.has(key)) { target = [key, b]; break; }
      }
      if (!target) {
        const key = `${ev.messageId}:final${state.msgBlocks.size}`;
        const b = { node: append(el('div', 'msg msg--claude md')), raw: '', messageId: ev.messageId };
        state.msgBlocks.set(key, b);
        target = [key, b];
      }
      const [key, b] = target;
      state.finalized.add(key);
      b.raw = ev.text || '';
      renderMd(b.node, b.raw, true);
      scrollDown();
      break;
    }
    case 'tool_start': {
      const t = toolCard(ev.id, ev.name, ev.parent);
      t.nm.textContent = ev.name;
      setStatus(`Nástroj ${ev.name}…`, true);
      break;
    }
    case 'tool_use': {
      const t = toolCard(ev.id, ev.name, ev.parent);
      fillToolInput(t, ev.name, ev.input, run.cwd);
      break;
    }
    case 'tool_result': {
      const t = tools.get(ev.id);
      if (t) fillToolResult(t, ev);
      setStatus('Claude pracuje…', true);
      break;
    }
    case 'rate_limit':
      if (ev.status === 'rejected') { run.limitShown = true; showLimit(run.account, ev.resetsAt); }
      else if (ev.status === 'allowed_warning') {
        const pct = ev.utilization != null ? ` (${Math.round(ev.utilization * 100)} %)` : '';
        const acc = accountById(run.account);
        showBanner('warn', [el('strong', null, `Účet ${acc ? acc.label : ''} se blíží limitu${pct}.`),
          document.createTextNode(ev.resetsAt ? ` Obnova v ${fmtTime(ev.resetsAt)}.` : '')], []);
      }
      break;
    case 'user_replay':
      // První potvrzení je úvodní prompt; další = zprávy poslané do běžícího tahu, v pořadí odeslání.
      run.replays++;
      if (run.replays > 1) {
        const st = run.injectedBubbles.shift();
        if (st) st.textContent = 'Claude si zprávu přečetl';
      }
      break;
    case 'retry':
      setStatus(`API hlásí chybu, zkouším znovu (pokus ${ev.attempt ?? '?'})…`, true);
      break;
    case 'plan':
      run.sawPlan = true;
      showPlanCard(ev.content, 'Plán ke schválení');
      break;
    case 'result': {
      run.resultText = ev.result;
      run.resultError = !!ev.isError;
      if (ev.sessionId) { S.sessionId = ev.sessionId; S.queue.bindSession(run, ev.sessionId); markCurrentSession(); }
      if (typeof ev.costUsd === 'number') {
        S.totalCost += ev.costUsd;
        $('#foot-cost').textContent = `poslední běh $${ev.costUsd.toFixed(3)} • ${ev.numTurns ?? '?'} ${plural(ev.numTurns, 'tah', 'tahy', 'tahů')} • ${(ev.durationMs / 1000).toFixed(1)} s`;
      }
      const looksLikeLimit = ev.isError && (ev.apiErrorStatus === 429 || /limit|rate.?limit|usage/i.test(ev.result || ''));
      if (looksLikeLimit && !run.limitShown) { run.limitShown = true; showLimit(run.account, null, ev.result); }
      else if (ev.isError && !run.limitShown) showError(`Claude skončil s chybou (${ev.subtype || 'error'})`, ev.result || '');
      if (ev.denials && ev.denials.length) {
        const names = [...new Set(ev.denials.map((d) => d.toolName))].join(', ');
        append(el('div', 'msg msg--note', `Zamítnuto ${ev.denials.length}× (${names}) – ${run.mode === 'plan' ? 'režim Plán nic nemění' : 'oprávnění'}.`));
      }
      break;
    }
    case 'exit':
      for (const st of run.injectedBubbles.splice(0)) st.textContent = 'Claude zprávu nestihl převzít – pošlete ji prosím znovu.';
      run.outcome = ev.stopped ? 'stopped' : run.limitShown ? 'limit'
        : (ev.code !== 0 || run.resultError || run.hadError) ? 'error' : run.mode === 'plan' ? 'plan' : 'ok';
      if (ev.stopped) { append(el('div', 'msg msg--note', 'Zastaveno.')); setStatus('Zastaveno.'); }
      else if (ev.code !== 0 && ev.stderr && !run.limitShown) showError(`claude skončil kódem ${ev.code}`, ev.stderr);
      else setStatus('Hotovo.');
      // Plan bez souboru plánu → plán je text odpovědi.
      if (run.mode === 'plan' && !run.sawPlan && !ev.stopped && !run.resultError && run.resultText) showPlanCard(null, 'Plán je výše – schválit?');
      break;
    case 'error':
      run.hadError = true;
      showError('Chyba běhu', ev.message);
      break;
  }
}

async function stop() {
  const run = S.run;
  if (!run) return;
  setStatus('Zastavuji…', true);
  if (run.runId) {
    try { await api(`/api/runs/${run.runId}/stop`, { method: 'POST' }); } catch { }
  } else run.controller.abort();
}

/* ---------- Start ---------- */
async function main() {
  setupMarkdown();
  if (!S.token) {
    showError('Chybí přístupový klíč', 'Okno otevřete spouštěčem aplikace (klíč platí jen pro jedno spuštění a obnovením stránky se ztratí).');
    $('#composer').hidden = true;
    return;
  }

  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(e.shiftKey ? 'queue' : 'now'); return; }
    listKeydown(e);
  });
  $('#notify-toggle').addEventListener('click', toggleNotify);
  renderNotifyToggle();
  window.addEventListener('focus', () => { if (S.attention) { S.attention = false; applyAccent(); } });
  $('#stop').addEventListener('click', stop);
  $('#queue-send').addEventListener('click', () => send('queue'));
  setupAttachments();
  setupRunOpts();
  setupSettings();
  setupGit();
  setupPalette();
  $('#new-session').addEventListener('click', newSession);
  $('#project').addEventListener('change', (e) => switchProject(e.target.value));
  document.querySelectorAll('input[name="mode"]').forEach((i) => i.addEventListener('change', () => { S.mode = i.value; }));
  window.addEventListener('beforeunload', (e) => { if (S.run || S.queue.length || S.pending.length) { e.preventDefault(); e.returnValue = ''; } });

  try {
    let st = await loadState();
    loadRunOpts();
    // Účty se ověřují na pozadí – chvíli počkej na výsledek.
    for (let i = 0; i < 20 && st.accounts.some((a) => !a.ok && a.error === 'Ověřuji…'); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      st = await loadState();
    }
    const cur = accountById(S.account);
    if (cur && !cur.ok) {
      const alt = otherAccount(S.account);
      showBanner('err', [el('strong', null, `Účet ${cur.label} není dostupný: `), document.createTextNode(cur.error || '')],
        alt ? [button(`Použít ${alt.label}`, 'btn-accent', () => switchAccount(alt.id))] : []);
    }
    await Promise.all([loadSessions(), loadGit()]);
  } catch (e) {
    showError('Aplikace nemůže načíst stav', e.message);
  }

  // Průběžně: stav účtů (a zároveň signál pro backend, že okno žije).
  setInterval(async () => {
    try { if (!S.run) { await loadState(); } else await api('/api/ping'); } catch { }
  }, 30000);
  setInterval(() => { if (!S.run) loadGit(); }, 60000);
  $('#prompt').focus();
}

document.addEventListener('DOMContentLoaded', main);
