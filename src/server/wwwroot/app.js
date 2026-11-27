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
  modes: ['auto', 'plan'],
  sessionId: null,
  run: null,          // { runId, controller, mode, account, prompt, sawPlan, resultText, resultError }
  lastPrompt: null,
  totalCost: 0,
  stats: { last: null, session: null },  // statistiky běhů v tomto okně (poslední běh, otevřené sezení)
  limits: {},                            // poslední stav limitu podle účtu
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
  mcp: {},               // stav MCP serverů z posledního init podle účtu a projektu (jen v paměti)
  mcpWarned: {},
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
  tools.clear(); // karty nástrojů odstraněné z chatu
  $('#empty').hidden = false;
}
/** Důležité hlášení pro čtečku obrazovky (přeruší čtení). Stav běhu hlásí #status zdvořile. */
function announce(text) {
  const r = $('#announce');
  r.textContent = '';
  setTimeout(() => { r.textContent = text; }, 50); // stejný text znovu = znovu přečíst
}
/** Píše uživatel právě do pole? (pak mu nebrat fokus) */
const isTyping = () => { const a = document.activeElement; return !!a && (a.matches('textarea, input, select, [contenteditable="true"]') || !!a.closest('dialog[open]')); };
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
  S.interactivePermissions = st.interactivePermissions === true;
  S.modes = Array.isArray(st.modes) ? st.modes : ['auto', 'plan'];
  $('#mode-ask').hidden = !S.modes.includes('default');
  if (!S.modes.includes(S.mode)) setMode('auto');
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

/* Vlastní názvy sezení jen v této aplikaci (localStorage) – do transkriptů Claude Code se nezapisuje. */
const TITLES_KEY = () => `acd.titles.${S.account}.${S.project}`;
function customTitles() {
  try { const o = JSON.parse(localStorage.getItem(TITLES_KEY()) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function setCustomTitle(id, title) {
  const o = customTitles();
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (t) o[id] = t; else delete o[id];
  try { localStorage.setItem(TITLES_KEY(), JSON.stringify(o)); } catch { }
}

const SS = { q: '', timer: null, seq: 0 };

async function loadSessions() {
  const ul = $('#sessions');
  const q = SS.q;
  const seq = ++SS.seq;
  let list = [];
  try {
    const base = `account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`;
    list = await apiJson(q ? `/api/sessions/search?${base}&q=${encodeURIComponent(q)}` : `/api/sessions?${base}`);
  } catch (e) {
    if (seq !== SS.seq) return;
    ul.textContent = '';
    ul.appendChild(el('li', 's-empty', e.message));
    return;
  }
  if (seq !== SS.seq) return; // mezitím přišlo novější hledání
  ul.textContent = '';
  if (!list.length) { ul.appendChild(el('li', 's-empty', q ? 'Nic nenalezeno.' : 'Zatím žádná sezení.')); return; }
  const titles = customTitles();
  for (const s of list) {
    const li = el('li');
    const b = el('button');
    b.type = 'button';
    b.dataset.id = s.id;
    if (s.id === S.sessionId) b.setAttribute('aria-current', 'true');
    const title = titles[s.id] || s.title;
    b.appendChild(el('span', 's-title', title));
    if (s.snippet) b.appendChild(snippetNode(s.snippet, q, s.role));
    b.appendChild(el('span', 's-meta', fmtRelative(s.updated) + (s.busy ? ' • běží' : '') + (titles[s.id] ? ' • přejmenováno' : '')));
    b.addEventListener('click', () => openSession(s.id));
    li.appendChild(b);
    const r = el('button', 's-rename', '✎');
    r.type = 'button';
    r.title = 'Přejmenovat (jen v této aplikaci)';
    r.setAttribute('aria-label', `Přejmenovat sezení ${title}`);
    r.addEventListener('click', () => renameSession(li, s, title));
    li.appendChild(r);
    ul.appendChild(li);
  }
}

/** Úryvek s vyznačenou shodou (bez innerHTML). */
function snippetNode(text, q, role) {
  const span = el('span', 's-snippet');
  span.appendChild(document.createTextNode(role === 'assistant' ? 'Claude: ' : 'Vy: '));
  const f = fold(text), n = fold(q.replace(/\s+/g, ' ').trim());
  const i = n ? f.indexOf(n) : -1;
  if (i < 0) { span.appendChild(document.createTextNode(text)); return span; }
  span.appendChild(document.createTextNode(text.slice(0, i)));
  span.appendChild(el('mark', null, text.slice(i, i + n.length)));
  span.appendChild(document.createTextNode(text.slice(i + n.length)));
  return span;
}

function renameSession(li, s, current) {
  const input = el('input', 's-edit');
  input.type = 'text'; input.value = current; input.maxLength = 80;
  input.setAttribute('aria-label', 'Nový název sezení (prázdný = původní)');
  li.textContent = '';
  li.appendChild(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) setCustomTitle(s.id, input.value.trim() === s.title ? '' : input.value);
    loadSessions();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function setupSessionSearch() {
  const inp = $('#session-search');
  const go = () => {
    const v = inp.value.replace(/\s+/g, ' ').trim();
    const q = v.length >= 2 ? v : '';
    if (q === SS.q) return;
    SS.q = q;
    loadSessions();
  };
  inp.addEventListener('input', () => { clearTimeout(SS.timer); SS.timer = setTimeout(go, 300); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape' && inp.value) { e.preventDefault(); inp.value = ''; clearTimeout(SS.timer); go(); } });
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
        const m = claudeBubble();
        append(m.node);
        setClaudeText(m, it.text, true);
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
  GC.items = [];
  renderCommentBar();
  newSession();
  await Promise.all([loadSessions(), loadGit()]);
}

/* ---------- Statistiky (jen v paměti okna) ---------- */
const fmtNum = (n) => Number(n || 0).toLocaleString('cs-CZ');
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} M`
  : n >= 1000 ? `${(n / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} k` : fmtNum(n));
const tokTotal = (u) => (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0);
const emptyStats = () => ({ runs: 0, turns: 0, ms: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addRunStats(ev, run) {
  const u = ev.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const last = { runs: 1, turns: ev.numTurns || 0, ms: ev.durationMs || 0, cost: typeof ev.costUsd === 'number' ? ev.costUsd : 0, ...u,
    model: run.model, effort: run.effort };
  S.stats.last = last;
  const sid = ev.sessionId || run.sessionId || S.sessionId;
  if (!S.stats.session || S.stats.session.id !== sid) S.stats.session = { id: sid, ...emptyStats() };
  const s = S.stats.session;
  for (const k of ['runs', 'turns', 'ms', 'cost', 'input', 'output', 'cacheRead', 'cacheWrite']) s[k] += last[k];
  renderFootStats();
  if ($('#statsdlg').open) renderStats();
}

function renderFootStats() {
  const b = $('#foot-cost');
  const l = S.stats.last;
  if (!l) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = `poslední běh ${fmtTok(tokTotal(l))} tokenů • odhad API $${l.cost.toFixed(3)} • ${l.turns} ${plural(l.turns, 'tah', 'tahy', 'tahů')} • ${(l.ms / 1000).toFixed(1)} s`;
}

function renderStats() {
  const box = $('#stats-body');
  box.textContent = '';
  const cols = [['last', 'Poslední běh'], ['session', 'Sezení (toto okno)']].filter(([k]) => S.stats[k]);
  if (!cols.length) box.appendChild(el('p', 'stats-empty', 'Zatím žádný běh v tomto okně.'));
  else {
    const t = el('table', 'stats-table');
    t.appendChild(el('caption', null, 'Tokeny a odhad ceny'));
    const head = el('thead'); const hr = el('tr');
    hr.appendChild(el('th', null, '')); for (const [, label] of cols) { const th = el('th', null, label); th.scope = 'col'; hr.appendChild(th); }
    head.appendChild(hr); t.appendChild(head);
    const body = el('tbody');
    const rows = [
      ['Vstup', (s) => fmtNum(s.input)], ['Výstup', (s) => fmtNum(s.output)],
      ['Cache – čtení', (s) => fmtNum(s.cacheRead)], ['Cache – zápis', (s) => fmtNum(s.cacheWrite)],
      ['Tokeny celkem', (s) => fmtNum(tokTotal(s))], ['Běhy / tahy', (s) => `${s.runs} / ${s.turns}`],
      ['Doba', (s) => `${(s.ms / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} s`],
      ['Odhad ceny API', (s) => `$${s.cost.toFixed(3)}`],
    ];
    for (const [label, f] of rows) {
      const tr = el('tr'); const th = el('th', null, label); th.scope = 'row'; tr.appendChild(th);
      for (const [k] of cols) tr.appendChild(el('td', null, f(S.stats[k])));
      body.appendChild(tr);
    }
    t.appendChild(body);
    box.appendChild(t);
  }
  const acc = accountById(S.account);
  box.appendChild(el('h3', 'eyebrow', `Limit účtu ${acc ? acc.label : ''}`));
  const lim = S.limits[S.account];
  if (!lim || !(lim.windows || []).length) {
    box.appendChild(el('p', 'stats-empty', 'Zatím bez údajů – Claude Code je pošle během prvního běhu.'));
    return;
  }
  const names = { five_hour: '5 hodin', seven_day: '7 dní', seven_day_opus: '7 dní (Opus)', seven_day_sonnet: '7 dní (Sonnet)' };
  for (const w of lim.windows) {
    const pct = w.utilization != null ? Math.round(w.utilization * 100) : null;
    const m = el('div', 'meter');
    m.dataset.level = pct != null && pct >= 80 ? 'warn' : 'ok';
    m.appendChild(el('span', null, names[w.type] || w.type));
    const bar = el('span', 'meter-bar');
    bar.setAttribute('role', 'meter'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    if (pct != null) bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-label', `Využití limitu ${names[w.type] || w.type}`);
    const fill = el('i'); fill.style.width = `${Math.min(100, pct ?? 0)}%`; bar.appendChild(fill);
    m.appendChild(bar);
    m.appendChild(el('span', 'meter-text', `${pct != null ? `${pct} %` : '?'}${w.resetsAt ? ` • obnova ${fmtTime(w.resetsAt)}` : ''}`));
    box.appendChild(m);
  }
  box.appendChild(el('p', 'stats-empty', `Stav z ${new Date(lim.at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}.`));
}

function openStats() {
  renderStats();
  const d = $('#statsdlg');
  if (!d.open) d.showModal();
}

function setupStats() {
  $('#foot-cost').addEventListener('click', openStats);
  $('#stats-close').addEventListener('click', () => $('#statsdlg').close());
  $('#statsdlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
}

/* ---------- Paleta příkazů (Ctrl+K) ---------- */
// Příkazy a skilly z posledního init daného účtu a projektu (localStorage – jen názvy, ne obsah zpráv).
// Nedávné zprávy jen v paměti okna (odeslané v tomto okně + zprávy otevřeného sezení); na disk se neukládají.
const CMDS_KEY = (acc, proj) => `acd.cmds.${acc}.${proj}`;
const P = { items: [], sel: 0, recent: [], sessionPrompts: [] };

function rememberCommands(ev) {
  const skills = (ev.skills || []).slice(0, 300);
  const commands = (ev.slashCommands || []).filter((x) => !skills.includes(x)).slice(0, 300);
  if (!commands.length && !skills.length) return;
  try { localStorage.setItem(CMDS_KEY(S.account, S.project), JSON.stringify({ commands, skills })); } catch { }
}
/** Příkazy a skilly z posledního init účtu a projektu: [{name, kind: 'cmd'|'skill'}]. */
function commandEntries() {
  let v;
  try { v = JSON.parse(localStorage.getItem(CMDS_KEY(S.account, S.project)) || '[]'); } catch { return []; }
  const str = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  if (Array.isArray(v)) return str(v).map((name) => ({ name, kind: 'cmd' })); // starší formát
  return [...str(v && v.commands).map((name) => ({ name, kind: 'cmd' })), ...str(v && v.skills).map((name) => ({ name, kind: 'skill' }))];
}
const knownCommands = () => commandEntries().map((c) => c.name);
function rememberPrompt(text) {
  const t = String(text || '').trim();
  if (!t) return;
  P.recent = [t, ...P.recent.filter((x) => x !== t)].slice(0, 20);
}

const MODE_LABELS = { auto: 'Auto', plan: 'Plán', default: 'Ručně' };
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); // bez diakritiky a velikosti písmen

function paletteActions() {
  return [
    ...(document.querySelector('.perm:not([data-state="resolved"]) .perm-actions button:not(:disabled)')
      ? [{ label: 'Žádost o svolení', meta: 'přejít na kartu', run: () => {
        const b = document.querySelector('.perm:not([data-state="resolved"]) .perm-actions button:not(:disabled)');
        if (b) { b.scrollIntoView({ block: 'center' }); b.focus(); }
      } }] : []),
    { label: 'Nové sezení', run: () => newSession() },
    { label: 'Režim Auto', run: () => setMode('auto') },
    { label: 'Režim Plán', run: () => setMode('plan') },
    ...(S.modes.includes('default') ? [{ label: 'Režim Ručně', meta: 'ptá se na každý zápis a příkaz', run: () => setMode('default') }] : []),
    ...PRESETS.filter((x) => !x.model || S.models.some((m) => m.id === x.model))
      .map((p) => ({ label: `Model: ${p.label}`, meta: `${modelLabel(p.model)} · ${p.effort || 'výchozí'}`, run: () => setRunOpts(p.model, p.effort) })),
    { label: 'Přiložit soubory', run: () => $('#file-input').click() },
    { label: 'Změny v gitu', meta: 'komentáře k řádkům', run: () => openGit() },
    { label: 'Přehled sezení', meta: 'soubory, úkoly, agenti, MCP', run: () => openOverview() },
    { label: 'Hledat v konverzaci', meta: 'Ctrl+F', run: () => openFind() },
    { label: 'Soubory projektu', meta: 'hledání a náhled', run: () => openFiles() },
    { label: 'Nastavení', run: () => openSettings() },
    { label: 'Statistiky a limit účtu', run: () => openStats() },
    { label: document.fullscreenElement ? 'Ukončit celou obrazovku' : 'Celá obrazovka', run: () => toggleFullscreen() },
    ...[['dark', 'Tmavý'], ['light', 'Světlý'], ['system', 'Podle systému']].map(([v, l]) =>
      ({ label: `Motiv: ${l}`, run: () => window.acdTheme && window.acdTheme.set(v) })),
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
  const cmds = commandEntries().map((c) => ({ kind: 'cmd', label: `/${c.name}`, meta: c.kind === 'skill' ? 'skill' : '', run: () => insertIntoPrompt(`/${c.name} `) }))
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
  renderCommentBar();
  if (!all.length) { showDiff(null, 'Žádné změny – pracovní strom je čistý.'); return; }
  const keep = G.sel && all.find((b) => b.dataset.key === G.sel);
  const first = keep || all[0];
  const [area, path] = first.dataset.key.split('\n');
  selectGitFile(first, path, area);
}

async function selectGitFile(btn, path, area) {
  for (const b of $('#git-files').querySelectorAll('.git-file')) b.setAttribute('aria-current', b === btn ? 'true' : 'false');
  G.sel = `${area}\n${path}`;
  G.cur = { path, area };
  const seq = ++G.seq;
  showDiff(null, 'Načítám…');
  try {
    const r = await apiJson(`/api/projects/${encodeURIComponent(S.project)}/git/diff?path=${encodeURIComponent(path)}&area=${area}`);
    if (seq === G.seq) {
      showDiff(r);
      // Čtečce stačí shrnutí; celý diff si projde sama (živá oblast nad diffem by ho předčítala celý).
      const lines = (r.diff || '').split(/\n/);
      const add = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const del = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      $('#git-status').textContent = `${path}: ${add} ${plural(add, 'přidaný řádek', 'přidané řádky', 'přidaných řádků')}, `
        + `${del} ${plural(del, 'odebraný', 'odebrané', 'odebraných')}${r.note ? '. ' + r.note : ''}`;
    }
  } catch (e) { if (seq === G.seq) { showDiff(null, e.message); $('#git-status').textContent = e.message; } }
}

/** Unified diff → řádky s barvami (stejné třídy jako u karet nástrojů). */
function showDiff(r, message) {
  const box = $('#git-diff');
  box.textContent = '';
  if (!r) { if (message) box.appendChild(el('p', 'git-note', message)); return; }
  if (r.note) box.appendChild(el('p', 'git-note', r.note));
  if (r.diff) {
    const d = el('div', 'diff diff--review');
    const cur = G.cur || {};
    let first = true;
    for (const l of Review.diffLines(r.diff)) {
      const row = el('div', l.kind === 'meta' ? 'ctx' : l.kind, l.text);
      if (l.line != null) {
        row.classList.add('diff-line');
        row.setAttribute('role', 'button');
        row.tabIndex = first ? 0 : -1;
        first = false;
        row.dataset.line = String(l.line);
        row.dataset.side = l.side;
        row.setAttribute('aria-label', `${LINE_WORD[l.kind]} ${l.line}: ${l.text.slice(1).trim() || '(prázdný)'}`);
        LINE_INFO.set(row, { file: cur.path, area: cur.area, kind: l.kind, line: l.line, side: l.side, text: l.text });
      }
      d.appendChild(row);
    }
    box.appendChild(d);
    renderLineComments(d);
  }
  if (r.truncated) box.appendChild(el('p', 'git-note', 'Diff je příliš dlouhý – zobrazen jen začátek.'));
}

/* ---------- Komentáře k řádkům diffu → zpráva pro Clauda (jen v paměti okna) ---------- */
const GC = { items: [], seq: 0 };
const LINE_INFO = new WeakMap(); // řádek diffu → {file, area, kind, line, side, text}
const LINE_WORD = { add: 'přidaný řádek', del: 'odebraný řádek', ctx: 'řádek' };
const sameLine = (c, i) => c.file === i.file && c.area === i.area && c.line === i.line && c.side === i.side;

function diffRows() { return [...$('#git-diff').querySelectorAll('.diff-line')]; }

function renderLineComments(d = $('#git-diff .diff')) {
  if (!d) return;
  d.querySelectorAll('.diff-comment').forEach((n) => n.remove());
  for (const row of d.querySelectorAll('.diff-line')) {
    const info = LINE_INFO.get(row);
    const mine = GC.items.filter((c) => sameLine(c, info));
    row.classList.toggle('has-comment', mine.length > 0);
    let after = row;
    for (const c of mine) {
      const box = el('div', 'diff-comment');
      box.appendChild(el('p', null, c.note));
      const del = button('Smazat', 'btn-ghost btn-small', () => {
        GC.items = GC.items.filter((x) => x !== c);
        renderLineComments();
        renderCommentBar();
        announce('Komentář smazán.');
        row.focus();
      });
      del.setAttribute('aria-label', `Smazat komentář k řádku ${c.line}`);
      box.appendChild(del);
      after.after(box);
      after = box;
    }
  }
}

function renderCommentBar() {
  const n = GC.items.length;
  $('#git-comments').hidden = n === 0;
  $('#git-comments-count').textContent = `${n} ${plural(n, 'komentář', 'komentáře', 'komentářů')}`
    + (n ? ` v ${new Set(GC.items.map((c) => c.file)).size} ${plural(new Set(GC.items.map((c) => c.file)).size, 'souboru', 'souborech', 'souborech')}` : '');
  for (const b of $('#git-files').querySelectorAll('.git-file')) {
    const [area, path] = (b.dataset.key || '').split('\n');
    const k = GC.items.filter((c) => c.file === path && c.area === area).length;
    let badge = b.querySelector('.git-ccount');
    if (!k) { if (badge) badge.remove(); continue; }
    if (!badge) { badge = el('span', 'git-ccount'); badge.setAttribute('aria-hidden', 'true'); b.appendChild(badge); }
    badge.textContent = `💬 ${k}`;
  }
}

function openCommentForm(row) {
  const info = LINE_INFO.get(row);
  if (!info) return;
  closeCommentForm();
  const form = el('div', 'diff-form');
  const ta = el('textarea');
  ta.rows = 3;
  ta.maxLength = 2000;
  ta.setAttribute('aria-label', `Komentář k řádku ${info.line} souboru ${info.file}`);
  ta.placeholder = 'Co má Claude na tomto řádku změnit? (Ctrl+Enter přidá, Esc zruší)';
  const actions = el('div', 'diff-form-actions');
  const add = () => {
    const note = ta.value.trim();
    if (!note) { ta.focus(); return; }
    GC.items.push({ id: ++GC.seq, ...info, note });
    closeCommentForm();
    renderLineComments();
    renderCommentBar();
    announce(`Komentář přidán. Celkem ${GC.items.length}.`);
    row.focus();
  };
  actions.append(button('Přidat komentář', 'btn-accent btn-small', add),
    button('Zrušit', 'btn-ghost btn-small', () => { closeCommentForm(); row.focus(); }));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCommentForm(); row.focus(); }
  });
  form.append(ta, actions);
  let after = row;
  while (after.nextElementSibling && after.nextElementSibling.classList.contains('diff-comment')) after = after.nextElementSibling;
  after.after(form);
  ta.focus();
}
function closeCommentForm() { document.querySelectorAll('#git-diff .diff-form').forEach((f) => f.remove()); }

function sendComments() {
  if (!GC.items.length) return;
  const text = Review.commentsMessage(GC.items);
  $('#gitdlg').close();
  const ta = $('#prompt');
  if (ta.value.trim()) { ta.setSelectionRange(ta.value.length, ta.value.length); insertIntoPrompt(`\n\n${text}`, { replaceEmpty: false }); }
  else insertIntoPrompt(text);
  GC.items = [];
  renderCommentBar();
  announce('Komentáře jsou ve zprávě – zkontrolujte ji a odešlete.');
}

function setupGitComments() {
  const box = $('#git-diff');
  box.addEventListener('click', (e) => {
    const row = e.target.closest('.diff-line');
    if (row && !window.getSelection().toString()) openCommentForm(row); // označování textu myší komentář neotevře
  });
  box.addEventListener('focusin', (e) => {
    const row = e.target.closest('.diff-line');
    if (!row) return;
    for (const r of box.querySelectorAll('.diff-line[tabindex="0"]')) if (r !== row) r.tabIndex = -1;
    row.tabIndex = 0;
  });
  box.addEventListener('keydown', (e) => {
    const row = e.target.closest('.diff-line');
    if (!row || e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCommentForm(row); return; }
    const all = diffRows();
    const i = all.indexOf(row);
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1
      : e.key === 'PageDown' ? i + 20 : e.key === 'PageUp' ? i - 20 : null;
    if (to == null) return;
    e.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, to))];
    if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
  });
  $('#gitdlg').addEventListener('cancel', (e) => {
    if ($('#git-diff .diff-form')) { e.preventDefault(); closeCommentForm(); }
  });
  $('#git-comments-send').addEventListener('click', sendComments);
  $('#git-comments-clear').addEventListener('click', () => {
    const n = GC.items.length;
    if (!n || !confirm(`Zahodit ${n} ${plural(n, 'komentář', 'komentáře', 'komentářů')}?`)) return;
    GC.items = [];
    renderLineComments();
    renderCommentBar();
  });
}

function setupGit() {
  setupGitComments();
  $('#git').addEventListener('click', openGit);
  $('#git-refresh').addEventListener('click', loadGitFiles);
  $('#git-close').addEventListener('click', () => $('#gitdlg').close());
  $('#gitdlg').addEventListener('close', () => { if (!S.run) loadGit(); });
}

/* ---------- Soubory projektu (jen pro čtení) ---------- */
const F = { files: [], sel: null, seq: 0, timer: null, project: null };
const FILES_SHOWN = 300;
const HL_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  json: 'json', css: 'css', scss: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', md: 'markdown', py: 'python',
  cs: 'csharp', ps1: 'powershell', sh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql', astro: 'xml', vue: 'xml', php: 'php',
  java: 'java', go: 'go', rs: 'rust', rb: 'ruby', toml: 'ini', ini: 'ini', c: 'c', h: 'c', cpp: 'cpp', kt: 'kotlin', swift: 'swift' };

async function openFiles() {
  const d = $('#filesdlg');
  if (F.project !== S.project) { F.project = S.project; F.sel = null; $('#files-filter').value = ''; $('#files-view').textContent = ''; }
  if (!d.open) d.showModal();
  $('#files-filter').focus();
  await loadFiles(false);
}

async function loadFiles(fresh) {
  $('#files-sub').textContent = 'Načítám…';
  try {
    const r = await apiJson(`/api/projects/${encodeURIComponent(S.project)}/files${fresh ? '?fresh=1' : ''}`);
    F.files = r.files;
    $('#files-sub').textContent = `${r.files.length} ${plural(r.files.length, 'soubor', 'soubory', 'souborů')}`
      + (r.truncated ? ' (zkráceno)' : '') + (r.source === 'git' ? ' • podle gitu, bez ignorovaných' : ' • bez build a cache složek');
  } catch (e) { F.files = []; $('#files-sub').textContent = e.message; }
  renderFiles();
}

function renderFiles() {
  const nav = $('#files-list');
  const q = fold($('#files-filter').value.trim());
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = terms.length ? F.files.filter((p) => { const f = fold(p); return terms.every((t) => f.includes(t)); }) : F.files;
  // Shoda v názvu souboru před shodou jen ve složce.
  const name = (p) => fold(p.slice(p.lastIndexOf('/') + 1));
  const sorted = terms.length ? hits.slice().sort((x, y) => (name(x).includes(terms[0]) ? 0 : 1) - (name(y).includes(terms[0]) ? 0 : 1)) : hits;
  nav.textContent = '';
  for (const p of sorted.slice(0, FILES_SHOWN)) {
    const b = el('button', 'git-file');
    b.type = 'button';
    const slash = p.lastIndexOf('/');
    const sp = el('span', 'git-path', p.slice(slash + 1));
    if (slash > 0) sp.appendChild(el('small', null, p.slice(0, slash)));
    b.appendChild(sp);
    b.setAttribute('aria-label', p);
    if (p === F.sel) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => showFile(b, p));
    nav.appendChild(b);
  }
  if (!sorted.length) nav.appendChild(el('p', 'git-note', terms.length ? 'Nic nenalezeno.' : 'Žádné soubory.'));
  else if (sorted.length > FILES_SHOWN) nav.appendChild(el('p', 'git-note', `Zobrazeno ${FILES_SHOWN} z ${sorted.length} – zpřesněte hledání.`));
  $('#files-status').textContent = terms.length ? `${sorted.length} ${plural(sorted.length, 'soubor', 'soubory', 'souborů')}` : '';
}

async function showFile(btn, p) {
  for (const b of $('#files-list').querySelectorAll('.git-file')) b.setAttribute('aria-current', b === btn ? 'true' : 'false');
  F.sel = p;
  const seq = ++F.seq;
  const view = $('#files-view');
  view.textContent = '';
  view.appendChild(el('p', 'git-note', 'Načítám…'));
  let r;
  try { r = await apiJson(`/api/projects/${encodeURIComponent(S.project)}/file?path=${encodeURIComponent(p)}`); }
  catch (e) { if (seq === F.seq) { view.textContent = ''; view.appendChild(el('p', 'git-note', e.message)); $('#files-status').textContent = e.message; } return; }
  if (seq !== F.seq) return;
  view.textContent = '';
  const head = el('div', 'files-head');
  head.appendChild(el('h3', null, p));
  head.appendChild(button('Vložit cestu do zprávy', 'btn-ghost btn-small', () => {
    $('#filesdlg').close();
    insertIntoPrompt(p.includes(' ') ? `"${p}" ` : `${p} `, { replaceEmpty: false });
  }));
  if (r.content != null) head.appendChild(button('Kopírovat obsah', 'btn-ghost btn-small', async (e) => {
    try { await navigator.clipboard.writeText(r.content); e.target.textContent = 'Zkopírováno'; } catch { e.target.textContent = 'Kopírování selhalo'; }
  }));
  view.appendChild(head);
  if (r.note) { view.appendChild(el('p', 'git-note', r.note)); $('#files-status').textContent = `${p}: ${r.note}`; return; }
  const pre = el('pre', 'files-code');
  pre.tabIndex = 0; // posouvání klávesnicí
  pre.setAttribute('aria-label', `Obsah ${p}`);
  const code = el('code', null, r.content);
  const lang = HL_EXT[(p.split('.').pop() || '').toLowerCase()];
  if (lang && window.hljs && hljs.getLanguage(lang) && r.content.length <= 200_000) {
    try { code.innerHTML = hljs.highlight(r.content, { language: lang, ignoreIllegals: true }).value; code.classList.add('hljs'); } catch { code.textContent = r.content; }
  }
  pre.appendChild(code);
  view.appendChild(pre);
  const lines = r.content ? r.content.split('\n').length : 0;
  $('#files-status').textContent = `${p}: ${lines} ${plural(lines, 'řádek', 'řádky', 'řádků')}`;
}

function setupFiles() {
  $('#files-open').addEventListener('click', openFiles);
  $('#files-refresh').addEventListener('click', () => loadFiles(true));
  $('#files-close').addEventListener('click', () => $('#filesdlg').close());
  $('#filesdlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('#files-filter').addEventListener('input', () => { clearTimeout(F.timer); F.timer = setTimeout(renderFiles, 120); });
  $('#files-filter').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { const b = $('#files-list .git-file'); if (b) { e.preventDefault(); b.focus(); } }
    else if (e.key === 'Enter') { const b = $('#files-list .git-file'); if (b) { e.preventDefault(); b.click(); } }
  });
  // Šipky v seznamu souborů.
  $('#files-list').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...$('#files-list').querySelectorAll('.git-file')];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0) { $('#files-filter').focus(); return; }
    all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  });
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
  $('#set-perm').textContent = S.interactivePermissions
    ? 'Žádosti o svolení: zapnuto. Když se Claude Code zeptá, objeví se v chatu karta Povolit jednou / Povolit vždy / Zamítnout. V režimu Auto se ptá jen výjimečně – většinu rozhodne sám; na každý zápis a příkaz se ptá v režimu Ručně.'
    : 'Žádosti o svolení: vypnuto – na co by se Claude Code zeptal, to se samo zamítne. Zapnout jde volbou "interactivePermissions": true v local/config.json.';
  renderFullscreenButton();
  renderThemeChoice();
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

function renderThemeChoice() {
  const c = window.acdTheme ? window.acdTheme.get() : 'dark';
  for (const i of $('#set-theme').querySelectorAll('input')) i.checked = i.value === c;
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
  $('#set-theme').addEventListener('change', (e) => { if (window.acdTheme) window.acdTheme.set(e.target.value); });
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
  announce(t.textContent.slice(0, 300) + (actions && actions.length ? ' Možnosti jsou nad konverzací.' : ''));
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
  announce(`${title}${detail ? ': ' + detail.slice(0, 200) : ''}`);
}

/* ---------- Odpověď Claude: Markdown + tlačítko Kopírovat ---------- */
const RAW = new WeakMap(); // bublina → původní Markdown odpovědi
function claudeBubble() {
  const node = el('div', 'msg msg--claude');
  node.setAttribute('role', 'article');
  node.setAttribute('aria-label', 'Claude');
  const body = el('div', 'md');
  const bar = el('div', 'msg-bar');
  const copy = el('button', 'msg-copy', 'Kopírovat');
  copy.type = 'button';
  copy.title = 'Zkopírovat odpověď (jako Markdown)';
  copy.setAttribute('aria-label', 'Kopírovat odpověď');
  copy.addEventListener('click', () => copyText(RAW.get(node) ?? body.innerText, copy, 'Odpověď je ve schránce.'));
  bar.appendChild(copy);
  node.append(body, bar);
  return { node, body };
}
function setClaudeText(m, text, highlight) {
  RAW.set(m.node, text || '');
  renderMd(m.body, text, highlight);
}
async function copyText(text, btn, done) {
  btn.dataset.label ??= btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Zkopírováno'; announce(done || 'Zkopírováno.'); }
  catch { btn.textContent = 'Kopírování selhalo'; }
  clearTimeout(btn._reset);
  btn._reset = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1600);
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
  box.setAttribute('role', 'group'); // skupina, ne orientační bod – karet může být víc
  box.setAttribute('aria-label', title || 'Plán');
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
  announce(`${title || 'Plán'} – tlačítko Schválit plán je pod ním.`);
}

/* ---------- Žádost o svolení (jen s interactivePermissions v configu) ---------- */
const PERM_RESULT = {
  once: 'Povoleno jednou.', always: 'Povoleno vždy – pravidlo uloženo do .claude/settings.local.json projektu.',
  deny: 'Zamítnuto.', timeout: 'Bez odpovědi v časovém limitu – zamítnuto.',
};

function showPermissionCard(ev, run) {
  const box = el('div', 'perm');
  box.dataset.requestId = ev.requestId;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', `Claude žádá o svolení: ${ev.displayName || ev.toolName}`);
  box.appendChild(el('div', 'eyebrow', 'Claude žádá o svolení'));
  box.appendChild(el('h3', 'perm-title', ev.displayName || ev.toolName));
  if (ev.description) box.appendChild(el('p', 'perm-desc', ev.description));
  const pv = ev.preview || {};
  const detail = pv.command || pv.path || pv.url || pv.json;
  if (detail) box.appendChild(el('pre', null, detail));
  if (ev.blockedPath && ev.blockedPath !== pv.path) box.appendChild(el('p', 'perm-desc', `Cesta: ${ev.blockedPath}`));
  const actions = el('div', 'perm-actions');
  const answer = async (decision, btn) => {
    const hadFocus = box.contains(document.activeElement);
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    if (hadFocus) $('#prompt').focus({ preventScroll: true }); // zakázané tlačítko by fokus ztratilo
    try {
      await apiJson(`/api/runs/${encodeURIComponent(run.runId)}/permission`, { method: 'POST', body: { requestId: ev.requestId, decision } });
    } catch (e) {
      resolvePermissionCard(box, null, e.message);
    }
  };
  const once = button('Povolit jednou', 'btn-accent btn-small', () => answer('once'));
  actions.appendChild(once);
  if (ev.alwaysRules && ev.alwaysRules.length) {
    const always = button('Povolit vždy', 'btn-ghost btn-small', () => answer('always'));
    always.title = 'Uloží pravidlo do .claude/settings.local.json projektu (jako v Claude Code) – příště se už nezeptá.';
    actions.appendChild(always);
  }
  actions.appendChild(button('Zamítnout', 'btn-danger btn-small', () => answer('deny')));
  box.appendChild(actions);
  if (ev.alwaysRules && ev.alwaysRules.length) box.appendChild(el('p', 'perm-rule', `„Vždy“ uloží: ${ev.alwaysRules.join(', ')}`));
  const mins = Math.round((ev.timeoutMs || 600000) / 60000);
  box.appendChild(el('p', 'perm-rule perm-wait', `Claude čeká. Bez odpovědi do ${mins} min se akce zamítne.`));
  append(box, true);
  // Fokus jen když uživatel nepíše – jinak by mezerník nebo Enter akci omylem povolil.
  const typing = isTyping();
  if (!typing) once.focus({ preventScroll: true });
  announce(`Claude žádá o svolení: ${ev.displayName || ev.toolName}${detail ? ' – ' + String(detail).slice(0, 160) : ''}.`
    + (typing ? ' Karta je v konverzaci, najdete ji i v Příkazech (Ctrl+K).' : ''));
  run.pendingPermissions = (run.pendingPermissions || 0) + 1;
  setStatus('Claude čeká na vaše svolení…', true);
  notify('Claude žádá o svolení', `${ev.displayName || ev.toolName}: ${detail || ''}`, 'plan');
}

function resolvePermissionCard(box, decision, errorText) {
  if (!box) return;
  if (errorText) {
    for (const b of box.querySelectorAll('.perm-actions button')) b.disabled = false;
    let p = box.querySelector('.perm-result');
    if (!p) { p = el('p', 'perm-result'); box.appendChild(p); }
    p.dataset.decision = 'deny';
    p.textContent = errorText;
    return;
  }
  box.dataset.state = 'resolved';
  box.querySelector('.perm-result')?.remove();
  const p = el('p', 'perm-result', PERM_RESULT[decision] || decision);
  p.dataset.decision = decision;
  box.appendChild(p);
  if (decision === 'timeout') announce(PERM_RESULT.timeout);
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
  box.setAttribute('role', 'article');
  box.setAttribute('aria-label', 'Vaše zpráva');
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
/* ---------- Našeptávání příkazů při psaní „/“ na začátku zprávy ---------- */
const SL = { items: [], sel: 0 };
const slashOpen = () => !$('#slash-list').hidden;
/** Rozpracovaný příkaz: „/abc“ od začátku zprávy až po kurzor (Claude Code bere příkazy jen na začátku). */
function slashQuery() {
  const ta = $('#prompt');
  if (ta.selectionStart !== ta.selectionEnd) return null;
  const m = /^\/([\w:.-]*)$/.exec(ta.value.slice(0, ta.selectionStart));
  return m ? m[1] : null;
}
function closeSlash() {
  const ul = $('#slash-list');
  if (ul.hidden) return;
  ul.hidden = true;
  ul.textContent = '';
  SL.items = [];
  $('#prompt').removeAttribute('aria-activedescendant');
}
function updateSlash() {
  const q = slashQuery();
  if (q === null) { closeSlash(); return; }
  const f = fold(q);
  const items = commandEntries().filter((c) => fold(c.name).includes(f))
    .sort((x, y) => (fold(x.name).startsWith(f) ? 0 : 1) - (fold(y.name).startsWith(f) ? 0 : 1)).slice(0, 50);
  if (!items.length) { closeSlash(); return; }
  const ul = $('#slash-list');
  const wasOpen = slashOpen();
  ul.textContent = '';
  SL.items = items.map((c, i) => {
    const li = el('li', 'palette-item');
    li.id = `slash-${i}`;
    li.setAttribute('role', 'option');
    li.appendChild(el('span', 'palette-label', `/${c.name}`));
    if (c.kind === 'skill') li.appendChild(el('span', 'palette-meta', 'skill'));
    li.addEventListener('mousedown', (e) => e.preventDefault()); // fokus zůstane v poli
    li.addEventListener('click', () => { SL.sel = i; acceptSlash(); });
    ul.appendChild(li);
    return { ...c, node: li };
  });
  SL.sel = 0;
  ul.hidden = false;
  markSlash();
  if (!wasOpen) $('#slash-status').textContent = `${items.length} ${plural(items.length, 'příkaz', 'příkazy', 'příkazů')} – šipky vyberou, Enter nebo Tab vloží, Esc zavře.`;
}
function markSlash() {
  SL.items.forEach((it, i) => it.node.setAttribute('aria-selected', i === SL.sel ? 'true' : 'false'));
  const cur = SL.items[SL.sel];
  if (cur) { $('#prompt').setAttribute('aria-activedescendant', cur.node.id); cur.node.scrollIntoView({ block: 'nearest' }); }
}
function acceptSlash() {
  const it = SL.items[SL.sel];
  const ta = $('#prompt');
  if (!it) return;
  const end = ta.selectionStart + /^[\w:.-]*/.exec(ta.value.slice(ta.selectionStart))[0].length; // i zbytek slova za kurzorem
  const after = ta.value.slice(end);
  const text = `/${it.name}` + (after.startsWith(' ') ? '' : ' ');
  ta.setSelectionRange(0, end);
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, 0, end, 'end');
  const caret = text.length + (after.startsWith(' ') ? 1 : 0);
  ta.setSelectionRange(caret, caret);
  closeSlash();
}
/** @returns {boolean} true = klávesu zpracovalo našeptávání */
function slashKeydown(e) {
  if (!slashOpen() || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = SL.items.length;
    SL.sel = (SL.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    markSlash();
  } else if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) acceptSlash();
  else if (e.key === 'Escape') closeSlash();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

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
    li.appendChild(el('span', 'queue-mode', MODE_LABELS[it.mode] || it.mode));
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
    const m = claudeBubble();
    append(m.node);
    b = { node: m.node, body: m.body, raw: '', messageId, pending: false };
    state.msgBlocks.set(key, b);
  }
  return b;
}
function scheduleRender(b) {
  if (b.pending) return;
  b.pending = true;
  requestAnimationFrame(() => { b.pending = false; setClaudeText(b, b.raw, false); scrollDown(); });
}

function handleEvent(ev, run, state) {
  switch (ev.type) {
    case 'run':
      run.runId = ev.runId;
      run.warm = ev.warm === true; // navázáno na čekající proces claude (bez startu)
      break;
    case 'init':
      S.sessionId = ev.sessionId;
      run.sessionId = ev.sessionId;
      S.queue.bindSession(run, ev.sessionId);
      run.cwd = ev.cwd;
      rememberCommands(ev);
      rememberMcp(ev, run);
      markCurrentSession();
      $('#foot-model').textContent = `${ev.model || ''} • ${ev.permissionMode || ''}`
        + (run.effort ? ` • effort ${run.effort} (požadováno)` : '') + ` • v${ev.version || ''}`
        + (run.warm ? ' • navázáno na běžící proces' : '') + mcpFoot(ev.mcpServers);
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
        const m = claudeBubble();
        append(m.node);
        const b = { node: m.node, body: m.body, raw: '', messageId: ev.messageId };
        state.msgBlocks.set(key, b);
        target = [key, b];
      }
      const [key, b] = target;
      state.finalized.add(key);
      b.raw = ev.text || '';
      setClaudeText(b, b.raw, true);
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
      if (t) { fillToolResult(t, ev); tools.delete(ev.id); } // výsledek přijde jen jednou
      setStatus('Claude pracuje…', true);
      break;
    }
    case 'rate_limit':
      S.limits[run.account] = { ...ev, at: Date.now() };
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
      if (typeof ev.costUsd === 'number') S.totalCost += ev.costUsd;
      addRunStats(ev, run);
      if ($('#overviewdlg').open) loadOverview();
      const looksLikeLimit = ev.isError && (ev.apiErrorStatus === 429 || /limit|rate.?limit|usage/i.test(ev.result || ''));
      if (looksLikeLimit && !run.limitShown) { run.limitShown = true; showLimit(run.account, null, ev.result); }
      else if (ev.isError && !run.limitShown) showError(`Claude skončil s chybou (${ev.subtype || 'error'})`, ev.result || '');
      if (ev.denials && ev.denials.length) {
        const names = [...new Set(ev.denials.map((d) => d.toolName))].join(', ');
        append(el('div', 'msg msg--note', `Zamítnuto ${ev.denials.length}× (${names}) – ${run.mode === 'plan' ? 'režim Plán nic nemění' : 'oprávnění'}.`));
      }
      break;
    }
    case 'permission_request':
      showPermissionCard(ev, run);
      break;
    case 'permission_resolved': {
      const box = [...document.querySelectorAll('.perm')].find((b) => b.dataset.requestId === ev.requestId);
      resolvePermissionCard(box, ev.decision);
      run.pendingPermissions = Math.max(0, (run.pendingPermissions || 0) - 1);
      if (!run.pendingPermissions) setStatus(run.mode === 'plan' ? 'Claude plánuje…' : 'Claude pracuje…', true);
      break;
    }
    case 'exit':
      for (const b of document.querySelectorAll('.perm:not([data-state="resolved"])')) resolvePermissionCard(b, ev.stopped ? 'deny' : 'timeout');
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

/* ---------- Hledat v konverzaci (Ctrl+F) – bez diakritiky, zvýraznění přes CSS Highlight API ---------- */
const FD = { ranges: [], cur: -1, timer: null, obs: null, max: 2000 };
const canHighlight = () => !!(window.CSS && CSS.highlights && window.Highlight);

function openFind() {
  const bar = $('#find');
  bar.hidden = false;
  const i = $('#find-input');
  i.focus();
  i.select();
  if (!FD.obs) FD.obs = new MutationObserver(() => {
    if ($('#find').hidden || !$('#find-input').value.trim()) return;
    clearTimeout(FD.timer);
    FD.timer = setTimeout(() => runFind(true), 300); // nový obsah během psaní odpovědi
  });
  FD.obs.observe(chat(), { childList: true, subtree: true, characterData: true });
  if (i.value.trim()) runFind(false);
}
function closeFind() {
  $('#find').hidden = true;
  if (FD.obs) FD.obs.disconnect();
  clearTimeout(FD.timer);
  FD.ranges = [];
  FD.cur = -1;
  if (canHighlight()) { CSS.highlights.delete('acd-find'); CSS.highlights.delete('acd-find-cur'); }
  $('#find-count').textContent = '';
  $('#prompt').focus();
}
function runFind(keep) {
  const q = $('#find-input').value;
  const prev = FD.cur;
  FD.ranges = [];
  if (q.trim()) {
    const skip = '#empty, .msg-bar, .diff-form, button';
    const w = document.createTreeWalker(chat(), NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n = w.nextNode(); n && FD.ranges.length < FD.max; n = w.nextNode()) {
      for (const [a, b] of Review.findAll(n.data, q)) {
        const r = document.createRange();
        r.setStart(n, a);
        r.setEnd(n, b);
        FD.ranges.push(r);
      }
    }
  }
  const n = FD.ranges.length;
  FD.cur = !n ? -1 : keep ? Math.min(Math.max(prev, 0), n - 1) : 0;
  paintFind(!keep);
}
function paintFind(reveal) {
  const n = FD.ranges.length;
  const q = $('#find-input').value.trim();
  $('#find-count').textContent = !q ? '' : n ? `${FD.cur + 1} z ${n}${n >= FD.max ? '+' : ''}` : 'Nic nenalezeno';
  if (canHighlight()) {
    CSS.highlights.set('acd-find', new Highlight(...FD.ranges));
    if (FD.cur >= 0) CSS.highlights.set('acd-find-cur', new Highlight(FD.ranges[FD.cur]));
    else CSS.highlights.delete('acd-find-cur');
  }
  if (reveal && FD.cur >= 0) revealRange(FD.ranges[FD.cur]);
}
function revealRange(r) {
  const c = chat();
  // Výskyt ve sbalené kartě nástroje → kartu rozbalit.
  for (let p = r.startContainer.parentElement; p && p !== c; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) p.open = true;
  const rect = r.getBoundingClientRect(), cr = c.getBoundingClientRect();
  if (rect.top < cr.top + 40 || rect.bottom > cr.bottom - 40) c.scrollTop += rect.top - cr.top - c.clientHeight / 2;
  if (!canHighlight()) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
}
function stepFind(delta) {
  if (!FD.ranges.length) { runFind(false); return; }
  FD.cur = (FD.cur + delta + FD.ranges.length) % FD.ranges.length;
  paintFind(true);
}
function setupFind() {
  const i = $('#find-input');
  i.addEventListener('input', () => { clearTimeout(FD.timer); FD.timer = setTimeout(() => runFind(false), 150); });
  i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(FD.timer); stepFind(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#find-next').addEventListener('click', () => stepFind(1));
  $('#find-prev').addEventListener('click', () => stepFind(-1));
  $('#find-close').addEventListener('click', closeFind);
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return; // v dialozích hledá prohlížeč
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
    else if (e.key === 'F3' && !$('#find').hidden) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  });
}

/* ---------- MCP servery (stav z init; nastavení účtu se nečte) ---------- */
const MCP_LABELS = { connected: 'připojeno', failed: 'selhalo', 'needs-auth': 'vyžaduje přihlášení', pending: 'připojuje se',
  disabled: 'vypnuto', unknown: 'neznámý stav' };
const MCP_SOURCES = { claudeai: 'konektor claude.ai', plugin: 'plugin', user: 'váš (uživatel)', project: 'projekt (.mcp.json)',
  local: 'váš (lokální)', dynamic: 'dynamický', enterprise: 'organizace', managed: 'organizace' };
const MCP_ORDER = { failed: 0, pending: 1, connected: 2, unknown: 3, disabled: 4, 'needs-auth': 5 };
/** Upozornit v konverzaci jen na selhání – nepřihlášené konektory claude.ai jsou běžné. */
function rememberMcp(ev, run) {
  if (!Array.isArray(ev.mcpServers)) return;
  const key = `${run.account}|${S.project}`;
  S.mcp[key] = { servers: ev.mcpServers, at: Date.now() };
  const failed = ev.mcpServers.filter((s) => s.status === 'failed');
  const sig = failed.map((s) => s.name).join(',');
  if (sig && S.mcpWarned[key] !== sig)
    append(el('div', 'msg msg--note', `MCP ${plural(failed.length, 'server se nepřipojil', 'servery se nepřipojily', 'serverů se nepřipojilo')}: `
      + `${failed.map((s) => s.name).join(', ')}. Podrobnosti v Přehledu sezení.`));
  S.mcpWarned[key] = sig;
}
function mcpFoot(servers) {
  if (!Array.isArray(servers) || !servers.length) return '';
  const ok = servers.filter((s) => s.status === 'connected').length;
  const failed = servers.filter((s) => s.status === 'failed').length;
  return ` • MCP ${ok} připojeno${failed ? `, ${failed} selhalo` : ''}`;
}

/* ---------- Přehled sezení: soubory, úkoly, agenti, nástroje, MCP ---------- */
const OV = { seq: 0 };
const TODO_MARK = { completed: ['✓', 'hotovo'], in_progress: ['▶', 'probíhá'], pending: ['○', 'čeká'] };
const AGENT_STATUS = { done: ['dokončeno', 'ok'], background: ['běží na pozadí', 'run'], running: ['běží', 'run'], error: ['chyba', 'bad'] };

function ovSection(title) {
  const sec = el('section', 'ov-section');
  const h = el('h3', 'eyebrow', title);
  h.id = `ov-${Math.random().toString(36).slice(2, 8)}`;
  sec.setAttribute('aria-labelledby', h.id);
  sec.appendChild(h);
  return sec;
}
function ovBadge(text, kind) { const b = el('span', 'ov-badge', text); if (kind) b.dataset.k = kind; return b; }
const fmtWhen = (iso) => (iso ? fmtTime(Date.parse(iso) / 1000) : '');

async function openOverview() {
  const d = $('#overviewdlg');
  if (!d.open) d.showModal();
  await loadOverview();
}

async function openFileInViewer(p) {
  $('#overviewdlg').close();
  await openFiles();
  $('#files-filter').value = p;
  renderFiles();
  const b = [...$('#files-list').querySelectorAll('.git-file')].find((x) => x.getAttribute('aria-label') === p);
  if (b) { b.focus(); showFile(b, p); }
  else $('#files-status').textContent = 'Soubor v projektu už není, nebo ho git ignoruje.';
}

async function loadOverview() {
  const body = $('#overview-body'), sub = $('#overview-sub');
  const seq = ++OV.seq;
  let o = null, err = null;
  if (S.sessionId) {
    sub.textContent = 'Načítám…';
    try {
      o = await apiJson(`/api/sessions/${encodeURIComponent(S.sessionId)}/overview?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`);
    } catch (e) { err = e.message; }
    if (seq !== OV.seq) return;
  }
  body.textContent = '';
  if (!S.sessionId) sub.textContent = 'Nové sezení – přehled se ukáže po první zprávě.';
  else if (err) sub.textContent = /neexistuje/.test(err) ? 'Přepis sezení zatím není uložený – zkuste Obnovit za chvíli.' : err;
  else {
    const parts = [`${o.userMessages} ${plural(o.userMessages, 'zpráva', 'zprávy', 'zpráv')} od vás`,
      `${o.replies} ${plural(o.replies, 'odpověď', 'odpovědi', 'odpovědí')}`];
    if (o.started) parts.push(`od ${fmtWhen(o.started)}`);
    if (o.updated) parts.push(`naposledy ${fmtWhen(o.updated)}`);
    sub.textContent = parts.join(' • ');
  }

  if (o) {
    // Úkoly (poslední TodoWrite)
    const sec = ovSection('Úkoly');
    if (o.todos && o.todos.length) {
      const done = o.todos.filter((t) => t.status === 'completed').length;
      sec.querySelector('h3').textContent = `Úkoly – ${done} z ${o.todos.length} hotovo`;
      const ul = el('ul', 'ov-list ov-todos');
      for (const t of o.todos) {
        const li = el('li');
        li.dataset.status = t.status;
        const [mark, word] = TODO_MARK[t.status] || TODO_MARK.pending;
        const m = el('span', 'ov-mark', mark); m.setAttribute('aria-hidden', 'true');
        li.append(m, el('span', 'sr-only', `${word}: `), el('span', 'ov-main', t.content || '(bez textu)'));
        ul.appendChild(li);
      }
      sec.appendChild(ul);
      if (o.todosAt) sec.appendChild(el('p', 'ov-empty', `Seznam z ${fmtWhen(o.todosAt)}.`));
    } else sec.appendChild(el('p', 'ov-empty', 'Claude v tomto sezení nevedl seznam úkolů.'));
    body.appendChild(sec);

    // Upravené soubory
    const fsec = ovSection(`Upravené soubory (${o.files.length})`);
    if (o.files.length) {
      const ul = el('ul', 'ov-list');
      for (const f of o.files) {
        const li = el('li');
        if (f.outside) li.appendChild(el('span', 'ov-main ov-path', f.path));
        else {
          const b = el('button', 'ov-file', f.path);
          b.type = 'button';
          b.title = 'Otevřít v náhledu souborů';
          b.addEventListener('click', () => openFileInViewer(f.path));
          const wrap = el('span', 'ov-main'); wrap.appendChild(b); li.appendChild(wrap);
        }
        const meta = [];
        if (f.edits) meta.push(`${f.edits}× úprava`);
        if (f.writes) meta.push(`${f.writes}× zápis`);
        li.appendChild(el('span', 'ov-meta', meta.join(' · ')));
        if (f.agent) li.appendChild(ovBadge(f.main ? 'i agent' : 'agent'));
        if (f.outside) li.appendChild(ovBadge('mimo projekt'));
        if (f.failed) li.appendChild(ovBadge(`${f.failed}× chyba`, 'bad'));
        ul.appendChild(li);
      }
      fsec.appendChild(ul);
    } else fsec.appendChild(el('p', 'ov-empty', 'Žádný soubor upravený nástroji Edit nebo Write.'));
    body.appendChild(fsec);

    // Agenti
    const asec = ovSection(`Agenti (${o.agents.length})`);
    if (o.agents.length) {
      const ul = el('ul', 'ov-list');
      for (const a of o.agents) {
        const li = el('li');
        li.appendChild(el('span', 'ov-main', a.description));
        if (a.type) li.appendChild(el('span', 'ov-meta', a.type));
        const [word, kind] = AGENT_STATUS[a.status] || AGENT_STATUS.running;
        li.appendChild(ovBadge(word, kind));
        ul.appendChild(li);
      }
      asec.appendChild(ul);
    } else asec.appendChild(el('p', 'ov-empty', 'Claude v tomto sezení nespustil žádného agenta.'));
    body.appendChild(asec);

    // Nástroje
    if (o.tools.length) {
      const tsec = ovSection('Nástroje');
      tsec.appendChild(el('p', 'ov-tools', o.tools.map((t) => `${t.name} ${t.count}×`).join(' · ')));
      body.appendChild(tsec);
    }
  }

  // MCP servery: stav z posledního spuštění + použití v sezení
  const msec = ovSection('MCP servery');
  const st = S.mcp[`${S.account}|${S.project}`];
  const used = new Map((o ? o.mcp : []).map((m) => [m.name, m.count]));
  // Použité v sezení se jmenují podle nástroje (mcp__<server>__…) – u konektorů jiným tvarem než v init, proto zvlášť.
  const servers = st ? st.servers.slice().sort((a, b) => (MCP_ORDER[a.status] ?? 9) - (MCP_ORDER[b.status] ?? 9) || a.name.localeCompare(b.name)) : [];
  const mcpRow = (s) => {
    const li = el('li');
    li.appendChild(el('span', 'ov-main ov-path', s.name));
    if (s.source) li.appendChild(el('span', 'ov-meta', MCP_SOURCES[s.source] || s.source));
    li.appendChild(ovBadge(MCP_LABELS[s.status] || s.status, s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'bad' : s.status === 'pending' ? 'run' : ''));
    return li;
  };
  if (servers.length) {
    const main = servers.filter((s) => s.status !== 'needs-auth');
    const auth = servers.filter((s) => s.status === 'needs-auth');
    msec.querySelector('h3').textContent = `MCP servery – ${servers.filter((s) => s.status === 'connected').length} z ${servers.length} připojeno`;
    if (main.length) { const ul = el('ul', 'ov-list'); main.forEach((s) => ul.appendChild(mcpRow(s))); msec.appendChild(ul); }
    if (auth.length) {
      const det = el('details', 'ov-more');
      det.appendChild(el('summary', null, `Nepřihlášené (${auth.length}) – připojí se až po přihlášení v Claude Code (/mcp)`));
      const ul = el('ul', 'ov-list'); auth.forEach((s) => ul.appendChild(mcpRow(s))); det.appendChild(ul);
      msec.appendChild(det);
    }
    msec.appendChild(el('p', 'ov-empty', `Stav ze spuštění v ${new Date(st.at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}.`));
  } else msec.appendChild(el('p', 'ov-empty', st ? 'Účet v tomto projektu nemá žádný MCP server.'
    : 'Stav se ukáže po první zprávě v tomto projektu (Claude Code ho hlásí při spuštění).'));
  if (used.size) msec.appendChild(el('p', 'ov-tools', `Použito v sezení: ${[...used].map(([n, c]) => `${n} ${c}×`).join(' · ')}`));
  body.appendChild(msec);
}

function setupOverview() {
  $('#foot-overview').addEventListener('click', openOverview);
  $('#overview-refresh').addEventListener('click', loadOverview);
  $('#overview-close').addEventListener('click', () => $('#overviewdlg').close());
  $('#overviewdlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
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
    if (slashKeydown(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeSlash(); send(e.shiftKey ? 'queue' : 'now'); return; }
    listKeydown(e);
  });
  $('#prompt').addEventListener('input', updateSlash);
  $('#prompt').addEventListener('click', updateSlash);
  $('#prompt').addEventListener('blur', closeSlash);
  $('#notify-toggle').addEventListener('click', toggleNotify);
  renderNotifyToggle();
  window.addEventListener('focus', () => { if (S.attention) { S.attention = false; applyAccent(); } });
  $('#stop').addEventListener('click', stop);
  $('#queue-send').addEventListener('click', () => send('queue'));
  setupAttachments();
  setupRunOpts();
  setupSettings();
  setupGit();
  setupFiles();
  setupPalette();
  setupStats();
  setupFind();
  setupOverview();
  setupSessionSearch();
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
