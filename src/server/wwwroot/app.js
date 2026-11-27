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
  if (force) STICK.on = true;
  if (!STICK.on) { $('#to-bottom').hidden = false; return; } // uživatel je výš → nechat ho tam
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 1) return;
  c.scrollTo({ top: c.scrollHeight, behavior: 'instant' });
  $('#to-bottom').hidden = true;
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
  if (typeof AG !== 'undefined') AG.clear();
  $('#empty').hidden = false;
}
/** Při přepnutí sezení: úlohy na pozadí, kopie, kontext. */
function resetSessionUi() {
  BG.tasks.clear();
  renderBackground();
  S.forkNext = false;
  renderForkNote();
  CTX.data = null;
  $('#foot-context').hidden = true;
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
  $('#chrome-row').hidden = !S.interactivePermissions;
  $('#chrome-toggle').checked = chromeOn();
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
  liveModel();
}
/** Za běhu: model se přepne hned (jako /model); effort platí od další zprávy. */
async function liveModel() {
  const run = S.run;
  if (!run || !run.runId || run.side || S.model === run.model) return;
  if (!S.model) { setStatus('Výchozí model platí od další zprávy.'); return; }
  try {
    await apiJson(`/api/runs/${run.runId}/model`, { method: 'POST', body: { model: S.model } });
    run.model = S.model;
    announce(`Model přepnut na ${modelLabel(S.model)} – platí od dalšího kroku.`);
  } catch (e) { setStatus(`Model platí od další zprávy (${e.message}).`); }
}
/** Za běhu: režim se přepne hned (jako Shift+Tab v terminálu). */
async function liveMode(m) {
  const run = S.run;
  if (!run || !run.runId || run.side || run.mode === m) return;
  try {
    await apiJson(`/api/runs/${run.runId}/mode`, { method: 'POST', body: { mode: m } });
    run.mode = m;
    announce(`Režim přepnut na ${MODE_LABELS[m] || m}.`);
  } catch (e) { showError('Režim nejde přepnout za běhu', e.message); }
}
function setChrome(on) {
  store(CHROME_KEY, on ? '1' : '0');
  $('#chrome-toggle').checked = on;
  renderRunOpts();
  announce(on ? 'Claude in Chrome zapnuto – od další zprávy, každá akce v prohlížeči se schvaluje.' : 'Claude in Chrome vypnuto.');
}

function renderRunOpts() {
  const sum = $('#runopts-summary');
  if (!sum) return;
  const custom = S.model || S.effort;
  sum.textContent = (custom ? `${modelLabel(S.model)} · ${S.effort || 'výchozí'}` : 'Model: výchozí') + (chromeOn() ? ' · Chrome' : '');
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
    b.appendChild(el('span', 's-meta', fmtRelative(s.updated) + (s.busy ? ' • běží' : '') + (titles[s.id] ? ' • přejmenováno' : '')
      + (hasDraft(s.id) ? ' • koncept' : '')));
    b.addEventListener('click', () => openSession(s.id));
    li.appendChild(b);
    const r = el('button', 's-rename', '✎');
    r.type = 'button';
    r.title = 'Přejmenovat (název uvidíte i v Claude Code v terminálu)';
    r.setAttribute('aria-label', `Přejmenovat sezení ${title}`);
    r.addEventListener('click', () => renameSession(li, s, title));
    li.appendChild(r);
    const f = el('button', 's-rename s-fork', '⑂');
    f.type = 'button';
    f.title = 'Pokračovat v kopii (původní sezení zůstane beze změny)';
    f.setAttribute('aria-label', `Pokračovat v kopii sezení ${title}`);
    f.addEventListener('click', () => forkSession(s.id));
    li.appendChild(f);
    ul.appendChild(li);
  }
  loadElsewhere();
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
    const v = input.value.replace(/\s+/g, ' ').trim();
    if (!save || v === current) { loadSessions(); return; }
    if (!v) { setCustomTitle(s.id, ''); loadSessions(); return; } // prázdný = zpět na název z Claude Code
    apiJson(`/api/sessions/${encodeURIComponent(s.id)}/title?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`,
      { method: 'POST', body: { title: v } })
      .then(() => { setCustomTitle(s.id, ''); announce('Sezení přejmenováno.'); })
      .catch((e) => { setCustomTitle(s.id, v); setStatus(`Název uložen jen v aplikaci: ${e.message}`); })
      .finally(loadSessions);
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
  if (!DR.skip) saveDraft();
  DR.skip = false;
  cancelContinue();
  S.sessionId = null;
  restoreDraft();
  resetSessionUi();
  resetProgress();
  P.sessionPrompts = [];
  clearChat();
  hideBanner();
  markCurrentSession();
  $('#prompt').focus();
}

async function openSession(id) {
  if (S.run || !leaveContext()) return;
  saveDraft();
  cancelContinue();
  S.sessionId = id;
  restoreDraft();
  resetSessionUi();
  $('#foot-context').hidden = false;
  $('#foot-context').textContent = 'Kontext';
  resetProgress();
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
      if (it.role === 'user') attachUuid(append(userBubble(it.text)), it.uuid);
      else {
        const m = claudeBubble();
        append(m.node);
        setClaudeText(m, it.text, true);
      }
    }
    append(el('div', 'msg msg--note', 'Pokračujte další zprávou.'), true);
    restoreProgress(id);
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
  saveDraft();
  DR.skip = true;
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
  CMDLOAD.p = null;
  if (S.run || id === S.project) return;
  if (!leaveContext()) { $('#project').value = S.project; return; }
  saveDraft();
  DR.skip = true;
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
  b.hidden = false;
  if (!l) { b.textContent = 'Statistiky'; return; }
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
  if (!$('#stats-hist').hidden) loadHistory();
}

function setupStats() {
  renderFootStats(); // tlačítko je vidět hned po spuštění, ne až po první zprávě
  $('#foot-cost').addEventListener('click', openStats);
  $('#stats-close').addEventListener('click', () => $('#statsdlg').close());
  $('#statsdlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
}

/* ---------- Statistiky v čase: grafy z /api/stats/history (jen čísla) ---------- */
// Barvy sérií: ověřená kategoriální paleta (5 slotů, pořadí pevné, nikdy cyklicky), zbytek = „Ostatní“ (šedá).
const H = { data: null, days: 30, seq: 0 };
const SERIES_MAX = 5;
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = (key) => { const [, m, d] = key.split('-'); return `${Number(d)}. ${Number(m)}.`; };
const METRICS = {
  cost: { label: 'Odhad ceny API', get: (r) => r.cost || 0, fmt: (v) => `$${v.toLocaleString('cs-CZ', { minimumFractionDigits: v < 10 ? 2 : 0, maximumFractionDigits: v < 10 ? 2 : 0 })}` },
  tokens: { label: 'Tokeny', get: (r) => (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0), fmt: (v) => fmtTok(v) },
  runs: { label: 'Běhy', get: () => 1, fmt: (v) => fmtNum(v) },
  minutes: { label: 'Čas práce', get: (r) => (r.ms || 0) / 60_000, fmt: (v) => (v < 60 ? `${Math.round(v)} min` : `${(v / 60).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} h`) },
};
function groupLabel(kind, id) {
  if (kind === 'project') { const p = S.projects.find((x) => x.id === id); return p ? p.label : id || '?'; }
  if (kind === 'account') { const a = accountById(id); return a ? a.label : id || '?'; }
  return (id || 'výchozí').replace(/^claude-/, '');
}
/** Nice horní mez osy (1, 2, 2.5, 5 × 10^k). */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

async function loadHistory() {
  const body = $('#hist-body');
  const seq = ++H.seq;
  body.textContent = '';
  body.appendChild(el('p', 'stats-empty', 'Načítám…'));
  try { H.data = await apiJson(`/api/stats/history?days=${H.days}`); }
  catch (e) { if (seq === H.seq) { body.textContent = ''; body.appendChild(el('p', 'stats-empty', e.message)); } return; }
  if (seq === H.seq) renderHistory();
}

function renderHistory() {
  const body = $('#hist-body');
  body.textContent = '';
  const data = H.data;
  if (!data) return;
  const metric = METRICS[$('#hist-metric').value] || METRICS.cost;
  const kind = $('#hist-group').value;
  const runs = data.runs;
  // Dny od začátku období po dnešek.
  const days = [];
  for (let t = Date.now() - (data.days - 1) * 86_400_000; days.length < data.days; t += 86_400_000) days.push(dayKey(t));

  // Souhrn.
  const tiles = el('div', 'tiles');
  const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
  for (const [label, value] of [['Běhy', fmtNum(runs.length)], ['Tokeny', fmtTok(sum(METRICS.tokens.get))],
    ['Odhad ceny API', METRICS.cost.fmt(sum(METRICS.cost.get))], ['Čas práce', METRICS.minutes.fmt(sum(METRICS.minutes.get))],
    ['Chyby', fmtNum(runs.filter((r) => r.error).length)]]) {
    const t = el('div', 'tile');
    t.append(el('span', 'tile-label', label), el('span', 'tile-value', value));
    tiles.appendChild(t);
  }
  body.appendChild(tiles);
  if (!runs.length) {
    body.appendChild(el('p', 'stats-empty', `Za posledních ${data.days} dní zatím žádný běh. Historie se začala ukládat s touto verzí aplikace.`));
  } else {
    // Série: nejvýš 5 největších skupin podle ukazatele, zbytek „Ostatní“. Barva patří skupině (pořadí podle velikosti v období).
    const totals = new Map();
    for (const r of runs) totals.set(r[kind], (totals.get(r[kind]) || 0) + metric.get(r));
    const order = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const top = order.slice(0, order.length > SERIES_MAX ? SERIES_MAX - 1 : SERIES_MAX);
    const series = top.map((id, i) => ({ id, label: groupLabel(kind, id), color: `var(--s${i + 1})` }));
    if (order.length > top.length) series.push({ id: '\u0000other', label: 'Ostatní', color: 'var(--s-other)' });
    const idx = new Map(series.map((s, i) => [s.id, i]));
    const values = days.map(() => series.map(() => 0));
    const dayIdx = new Map(days.map((d, i) => [d, i]));
    for (const r of runs) {
      const di = dayIdx.get(dayKey(r.t));
      if (di == null) continue;
      const si = idx.has(r[kind]) ? idx.get(r[kind]) : idx.get('\u0000other');
      values[di][si] += metric.get(r);
    }
    body.appendChild(el('h3', 'eyebrow chart-title', `${metric.label} po dnech – podle ${$('#hist-group').selectedOptions[0].textContent}`));
    body.appendChild(columnChart(days, series, values, metric.fmt));

    // Tabulka (přístupná podoba grafu) – skupiny za celé období.
    const t = el('table', 'stats-table');
    t.appendChild(el('caption', null, `Za ${data.days} dní podle ${$('#hist-group').selectedOptions[0].textContent}`));
    const hr = el('tr');
    for (const h of [{ project: 'Projekt', model: 'Model', account: 'Účet' }[kind], 'Běhy', 'Tokeny', 'Odhad ceny API', 'Čas práce', 'Chyby']) { const th = el('th', null, h); th.scope = 'col'; hr.appendChild(th); }
    const thead = el('thead'); thead.appendChild(hr); t.appendChild(thead);
    const tb = el('tbody');
    for (const id of order) {
      const rs = runs.filter((r) => r[kind] === id);
      const tr = el('tr');
      const th = el('th', null, groupLabel(kind, id)); th.scope = 'row'; tr.appendChild(th);
      const s = (f) => rs.reduce((a, r) => a + f(r), 0);
      for (const v of [fmtNum(rs.length), fmtTok(s(METRICS.tokens.get)), METRICS.cost.fmt(s(METRICS.cost.get)), METRICS.minutes.fmt(s(METRICS.minutes.get)),
        fmtNum(rs.filter((r) => r.error).length)]) tr.appendChild(el('td', null, v));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(t);
  }

  // Limit účtu v čase (aktuální účet).
  const acc = accountById(S.account);
  const lims = data.limits.filter((l) => l.account === S.account);
  body.appendChild(el('h3', 'eyebrow chart-title', `Využití limitu – účet ${acc ? acc.label : S.account}`));
  if (!lims.length) body.appendChild(el('p', 'stats-empty', 'Zatím bez údajů – Claude Code je posílá během běhů.'));
  else {
    const names = { five_hour: '5 hodin', seven_day: '7 dní', seven_day_opus: '7 dní (Opus)', seven_day_sonnet: '7 dní (Sonnet)' };
    const wins = [...new Set(lims.map((l) => l.window))].slice(0, 3);
    const series = wins.map((w, i) => ({ label: names[w] || w, color: `var(--s${i + 1})`,
      points: lims.filter((l) => l.window === w).map((l) => ({ t: l.t, v: Math.min(100, l.utilization * 100) })) }));
    body.appendChild(lineChart(series, data.from, Date.now()));
  }
}

/** Legenda (pro ≥ 2 série) – barva jen u značky, text v barvě textu. */
function legend(series) {
  const ul = el('ul', 'legend');
  ul.setAttribute('aria-label', 'Legenda');
  for (const s of series) {
    const li = el('li');
    const sw = el('span', 'legend-swatch'); sw.style.background = s.color; sw.setAttribute('aria-hidden', 'true');
    li.append(sw, document.createTextNode(s.label));
    ul.appendChild(li);
  }
  return ul;
}

function chartTip(wrap) {
  const tip = el('div', 'chart-tip');
  tip.setAttribute('aria-hidden', 'true'); // přístupná je tabulka
  tip.hidden = true;
  wrap.appendChild(tip);
  return (rows, x, y) => {
    if (!rows) { tip.hidden = true; return; }
    tip.textContent = '';
    for (const [sw, text, strong] of rows) {
      const line = el('div', strong ? 'chart-tip-head' : null);
      if (sw) { const k = el('span', 'legend-swatch'); k.style.background = sw; line.appendChild(k); }
      line.appendChild(document.createTextNode(text));
      tip.appendChild(line);
    }
    tip.hidden = false;
    const w = wrap.clientWidth;
    tip.style.left = `${Math.min(Math.max(0, x + 12), w - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
  };
}

/** Skládaný sloupcový graf po dnech: sloupce ≤ 24 px, 2px mezera mezi díly, zaoblený horní konec. */
function columnChart(days, series, values, fmt) {
  const wrap = el('div', 'chart');
  if (series.length >= 2) wrap.appendChild(legend(series));
  const W = 720, Hh = 220, L = 56, R = 8, T = 10, B = 26;
  const totals = values.map((v) => v.reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(...totals));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${Hh}`, class: 'chart-svg', role: 'img',
    'aria-label': `Sloupcový graf, ${days.length} dní, nejvíc ${fmt(Math.max(...totals))} za den. Hodnoty jsou v tabulce pod grafem.` });
  const y = (v) => T + (Hh - T - B) * (1 - v / max);
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'chart-grid' }));
    const tx = svgEl('text', { x: L - 6, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }); tx.textContent = fmt(v); svg.appendChild(tx);
  }
  const band = (W - L - R) / days.length;
  const bw = Math.max(2, Math.min(24, band * 0.7));
  const every = Math.ceil(days.length / 8);
  const tip = chartTip(wrap);
  days.forEach((d, i) => {
    const cx = L + band * i + band / 2;
    if ((days.length - 1 - i) % every === 0) { // od dneška pozpátku – popisky se nepřekrývají
      const tx = svgEl('text', { x: cx, y: Hh - 8, class: 'chart-axis', 'text-anchor': 'middle' }); tx.textContent = dayLabel(d); svg.appendChild(tx);
    }
    let base = y(0);
    const segs = series.map((s, si) => [s, values[i][si]]).filter(([, v]) => v > 0);
    segs.forEach(([s, v], k) => {
      const h = base - y(v);
      const top = k === segs.length - 1;
      const hh = Math.max(1, h - (top ? 0 : 2)); // 2px mezera k dalšímu dílu
      const x0 = cx - bw / 2, y0 = base - h + (top ? 0 : 2);
      const r = top ? Math.min(4, hh, bw / 2) : 0;
      const path = `M${x0},${base} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + bw - r} Q${x0 + bw},${y0} ${x0 + bw},${y0 + r} V${base} Z`;
      const p = svgEl('path', { d: path, class: 'chart-bar' }); p.style.fill = s.color;
      svg.appendChild(p);
      base -= h;
    });
    // Zásah pro najetí myší je celý pruh dne, ne jen sloupec.
    const hit = svgEl('rect', { x: L + band * i, y: T, width: band, height: Hh - T - B, class: 'chart-hit' });
    hit.addEventListener('mouseenter', () => {
      const rect = svg.getBoundingClientRect(), scale = rect.width / W;
      tip([[null, `${dayLabel(d)} – celkem ${fmt(totals[i])}`, true],
        ...series.map((s, si) => [s.color, `${s.label}: ${fmt(values[i][si])}`]).filter((_, si) => values[i][si] > 0)],
      cx * scale, y(totals[i]) * scale + (series.length >= 2 ? wrap.querySelector('.legend').offsetHeight : 0));
    });
    hit.addEventListener('mouseleave', () => tip(null));
    svg.appendChild(hit);
  });
  svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'chart-base' }));
  wrap.appendChild(svg);
  return wrap;
}

/** Čárový graf 0–100 % v čase: čáry 2 px, koncové body s prstencem, popisek na konci, nitkový kříž. */
function lineChart(series, from, to) {
  const wrap = el('div', 'chart');
  if (series.length >= 2) wrap.appendChild(legend(series));
  const W = 720, Hh = 200, L = 44, R = 70, T = 10, B = 26;
  const x = (t) => L + (W - L - R) * Math.min(1, Math.max(0, (t - from) / Math.max(1, to - from)));
  const y = (v) => T + (Hh - T - B) * (1 - v / 100);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${Hh}`, class: 'chart-svg', role: 'img',
    'aria-label': `Využití limitu v čase: ${series.map((s) => `${s.label} naposledy ${Math.round(s.points.at(-1).v)} %`).join(', ')}.` });
  for (const v of [0, 25, 50, 75, 100]) {
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'chart-base' : 'chart-grid' }));
    const tx = svgEl('text', { x: L - 6, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' }); tx.textContent = `${v} %`; svg.appendChild(tx);
  }
  const spanDays = (to - from) / 86_400_000;
  const ticks = Math.min(7, Math.max(2, Math.round(spanDays)));
  for (let i = 0; i <= ticks; i++) {
    const t = from + ((to - from) / ticks) * i;
    const tx = svgEl('text', { x: x(t), y: Hh - 8, class: 'chart-axis', 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' });
    tx.textContent = dayLabel(dayKey(t));
    svg.appendChild(tx);
  }
  for (const s of series) {
    const pts = s.points;
    const line = svgEl('polyline', { points: pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '), class: 'chart-line' });
    line.style.stroke = s.color;
    svg.appendChild(line);
    const last = pts[pts.length - 1];
    const dot = svgEl('circle', { cx: x(last.t), cy: y(last.v), r: 4, class: 'chart-dot' }); dot.style.fill = s.color;
    svg.appendChild(dot);
  }
  // Popisky na konci čar jen když se nepřekrývají (jinak stačí legenda a nitkový kříž).
  const ends = series.map((s) => ({ s, last: s.points[s.points.length - 1] })).sort((a, b) => y(a.last.v) - y(b.last.v));
  if (series.length <= 4 && ends.every((e, i) => i === 0 || y(e.last.v) - y(ends[i - 1].last.v) >= 14)) {
    for (const { s, last } of ends) {
      const lab = svgEl('text', { x: x(last.t) + 8, y: y(last.v) + 4, class: 'chart-label' });
      lab.textContent = `${s.label} ${Math.round(last.v)} %`;
      svg.appendChild(lab);
    }
  }
  const cross = svgEl('line', { y1: T, y2: Hh - B, class: 'chart-cross', visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: L, y: T, width: W - L - R, height: Hh - T - B, class: 'chart-hit' });
  const tip = chartTip(wrap);
  hit.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect(), scale = rect.width / W;
    const t = from + ((e.clientX - rect.left) / scale - L) / (W - L - R) * (to - from);
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t)); cross.setAttribute('visibility', 'visible');
    const rows = [[null, new Date(t).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }), true]];
    for (const s of series) {
      const before = s.points.filter((p) => p.t <= t).at(-1);
      if (before) rows.push([s.color, `${s.label}: ${Math.round(before.v)} %`]);
    }
    tip(rows, x(t) * scale, (series.length >= 2 ? wrap.querySelector('.legend').offsetHeight : 0) + 20);
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip(null); });
  svg.appendChild(hit);
  wrap.appendChild(svg);
  return wrap;
}

function downloadCsv() {
  const runs = (H.data && H.data.runs) || [];
  const head = ['datum', 'cas', 'ucet', 'projekt', 'model', 'effort', 'vstup', 'vystup', 'cache_cteni', 'cache_zapis', 'odhad_ceny_usd', 'doba_s', 'tahy', 'chyba'];
  const q = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.join(',')];
  for (const r of runs) {
    const d = new Date(r.t);
    lines.push([dayKey(r.t), d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }), groupLabel('account', r.account),
      groupLabel('project', r.project), r.model, r.effort, r.input, r.output, r.cacheRead, r.cacheWrite, (r.cost || 0).toFixed(4),
      ((r.ms || 0) / 1000).toFixed(1), r.turns, r.error ? 1 : 0].map(q).join(','));
  }
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  const a = el('a');
  a.href = url;
  a.download = `statistiky-${dayKey(Date.now())}-${H.days}dni.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  announce(`Staženo ${runs.length} ${plural(runs.length, 'záznam', 'záznamy', 'záznamů')}.`);
}

function selectStatsTab(hist) {
  $('#stats-tab-now').setAttribute('aria-selected', String(!hist));
  $('#stats-tab-hist').setAttribute('aria-selected', String(hist));
  $('#stats-tab-now').tabIndex = hist ? -1 : 0;
  $('#stats-tab-hist').tabIndex = hist ? 0 : -1;
  $('#stats-body').hidden = hist;
  $('#stats-hist').hidden = !hist;
  $('#statsdlg').classList.toggle('stats--wide', hist);
  if (hist) loadHistory();
}

function setupHistory() {
  $('#stats-tab-now').addEventListener('click', () => selectStatsTab(false));
  $('#stats-tab-hist').addEventListener('click', () => selectStatsTab(true));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const hist = $('#stats-tab-now').getAttribute('aria-selected') === 'true';
    selectStatsTab(hist);
    (hist ? $('#stats-tab-hist') : $('#stats-tab-now')).focus();
  });
  $('#hist-range').addEventListener('change', (e) => { H.days = Number(e.target.value) || 30; loadHistory(); });
  $('#hist-metric').addEventListener('change', renderHistory);
  $('#hist-group').addEventListener('change', renderHistory);
  $('#hist-csv').addEventListener('click', downloadCsv);
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

const MODE_LABELS = { auto: 'Auto', plan: 'Plán', acceptEdits: 'Úpravy', default: 'Ručně' };
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
    { label: 'Režim Úpravy', meta: 'úpravy souborů bez ptaní, příkazy se ptají', run: () => setMode('acceptEdits') },
    { label: 'Otázka bokem', meta: 'nezapíše se do sezení', run: () => openSide() },
    ...(S.sessionId && !S.run ? [{ label: 'Pokračovat v kopii sezení', meta: 'původní zůstane beze změny', run: () => forkSession(S.sessionId) },
      { label: 'Kontext sezení', meta: 'co zabírá místo', run: () => { renderContext(); $('#contextdlg').showModal(); loadContext(); } },
      { label: 'Zhustit konverzaci', meta: '/compact – uvolní kontext', run: () => startRun('/compact', S.mode) },
      { label: 'Exportovat konverzaci', meta: 'Markdown', run: () => exportSession() }] : []),
    ...(S.interactivePermissions ? [{ label: chromeOn() ? 'Vypnout Claude in Chrome' : 'Zapnout Claude in Chrome', meta: 'ovládání prohlížeče, každá akce se schvaluje',
      run: () => setChrome(!chromeOn()) }] : []),
    ...(PR.tasks.length || BG.tasks.size ? [{ label: PR.hidden ? 'Ukázat průběh' : 'Skrýt průběh', run: () => { PR.hidden = !PR.hidden; renderProgress(); } }] : []),
    { label: 'Hledat v konverzaci', meta: 'Ctrl+F', run: () => openFind() },
    { label: 'Soubory projektu', meta: 'hledání a náhled', run: () => openFiles() },
    { label: 'Nastavení', run: () => openSettings() },
    { label: 'Statistiky a limit účtu', run: () => openStats() },
    { label: 'Statistiky v čase', meta: 'grafy, CSV', run: () => { openStats(); selectStatsTab(true); } },
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
  autoGrow();
  clearTimeout(DR.timer);
  DR.timer = setTimeout(saveDraft, 400);
}

function buildPalette(q) {
  const f = fold(q.trim());
  const match = (label) => !f || fold(label).includes(f);
  const score = (label) => (f && fold(label).startsWith(f) ? 0 : 1);
  const groups = [];
  const ci = commandInfo();
  const cmds = commandEntries().map((c) => {
    const [desc, hint] = ci.info[c.name] || ['', ''];
    return { kind: 'cmd', label: `/${c.name}${hint ? ` ${hint}` : ''}`, meta: desc ? desc.slice(0, 70) : c.kind === 'skill' ? 'skill' : '', run: () => insertIntoPrompt(`/${c.name} `) };
  }).filter((x) => match(x.label) || match(x.label.slice(1)) || match(x.meta));
  const agents = ci.agents.map((a) => ({ kind: 'cmd', label: `Agent ${a.name}`, meta: (a.description || '').slice(0, 70),
    run: () => insertIntoPrompt(`Použij agenta ${a.name}: `) })).filter((x) => match(x.label) || match(x.meta));
  const acts = paletteActions().map((a) => ({ kind: 'act', ...a })).filter((x) => match(x.label));
  const seen = new Set();
  const recent = [...P.recent, ...P.sessionPrompts.slice().reverse()].filter((t) => !seen.has(t) && seen.add(t)).slice(0, 30)
    .map((t) => ({ kind: 'msg', label: t.replace(/\s+/g, ' '), meta: t.length > 90 ? `${t.length} znaků` : '', run: () => insertIntoPrompt(t) }))
    .filter((x) => match(x.label));
  const sort = (a) => a.sort((x, y) => score(x.label) - score(y.label));
  // Lomítko na začátku = hledám příkaz.
  if (q.trim().startsWith('/')) groups.push(['Příkazy a skilly', sort(cmds)]);
  else groups.push(['Akce', sort(acts)], ['Příkazy a skilly', sort(cmds)], ['Agenti', sort(agents)], ['Nedávné zprávy', recent]);
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
  if (filesTree()) {
    nav.textContent = '';
    if (!hits.length) nav.appendChild(el('p', 'git-note', terms.length ? 'Nic nenalezeno.' : 'Žádné soubory.'));
    else renderTree(nav, hits, terms.length > 0);
    $('#files-status').textContent = terms.length ? `${hits.length} ${plural(hits.length, 'soubor', 'soubory', 'souborů')}` : '';
    return;
  }
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
  for (const i of document.querySelectorAll('input[name="files-view"]')) {
    i.checked = (i.value === 'tree') === filesTree();
    i.addEventListener('change', () => setFilesView(i.value === 'tree'));
  }
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
  $('#set-autocontinue').checked = autoOn();
  $('#set-drafts').checked = draftsOn();
  if (!d.open) d.showModal();
  try { const v = await apiJson('/api/settings'); renderSettingsProjects(v); renderSettingsAccountsFull(v); } catch (e) { setMsg(e.message, 'err'); }
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
    else {
      const d = button('Nastavit jako výchozí', 'btn-ghost btn-small', () => setDefaultProject(p));
      d.title = 'Tento projekt se otevře při spuštění aplikace';
      li.appendChild(d);
    }
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
  $('#set-add-account').addEventListener('submit', addAccountSubmit);
  $('#set-fullscreen').addEventListener('click', toggleFullscreen);
  $('#set-theme').addEventListener('change', (e) => { if (window.acdTheme) window.acdTheme.set(e.target.value); });
  document.addEventListener('fullscreenchange', renderFullscreenButton);
  $('#set-notify').addEventListener('click', toggleNotify);
  $('#set-autocontinue').addEventListener('change', (e) => { store(AUTO_KEY, e.target.checked ? '1' : '0'); if (!e.target.checked) cancelContinue(); });
  $('#set-drafts').addEventListener('change', (e) => {
    store(DRAFTS_ON_KEY, e.target.checked ? '1' : '0');
    if (!e.target.checked) { try { localStorage.removeItem(DRAFTS_KEY); } catch { } loadSessions(); }
  });
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
  if (AC.timer && AC.ctx && AC.ctx.account === accountId) {
    const left = el('span', null, fmtLeft(AC.at - Date.now()));
    left.id = 'ac-left';
    const line = el('div', null, `Automaticky pokračuji v ${fmtTime(AC.at / 1000)} (za `);
    line.append(left, document.createTextNode(') – pokud okno zůstane otevřené. Fronta zůstane pozastavená.'));
    parts.push(line);
    actions.push(button('Nepokračovat automaticky', 'btn-ghost', () => { cancelContinue(); showLimit(accountId, resetsAt, detail); announce('Automatické pokračování zrušeno.'); }));
  } else if (!autoOn()) parts.push(el('div', null, 'Automatické pokračování po obnovení je vypnuté (Nastavení → Zprávy a práce).'));
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
function setClaudeText(m, text, highlight, partial) {
  const clean = Review.progressMarks(text, partial).clean; // značky průběhu se nezobrazují
  RAW.set(m.node, clean);
  renderMd(m.body, clean, highlight);
  m.node.hidden = !clean.trim(); // odpověď jen se značkou = žádná bublina
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
  for (const im of ev.images || []) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(im.mediaType)) continue;
    const img = el('img', 'tool-img');
    img.src = `data:${im.mediaType};base64,${im.data}`;
    img.alt = `Obrázek z nástroje ${t.name || ''}`.trim();
    img.loading = 'lazy';
    t.body.appendChild(img);
    t.d.open = true;
  }
  if (state === 'error' && !ev.denied) t.d.open = true;
}

/* ---------- Plán ---------- */
function showPlanCard(markdown, title, raw) {
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
  const review = button('Připomínkovat', 'btn-ghost', () => planComments(box, markdown || raw));
  review.title = 'Napsat připomínky k jednotlivým řádkům plánu';
  actions.append(approve, review, el('span', 'hint', 'Schválení spustí plán v režimu Auto ve stejném sezení.'));
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
  if (ev.toolName === 'AskUserQuestion' && Array.isArray(ev.questions) && ev.questions.length) { showQuestionCard(ev, run); return; }
  const box = el('div', 'perm');
  box.dataset.requestId = ev.requestId;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', `Claude žádá o svolení: ${ev.displayName || ev.toolName}`);
  box.appendChild(el('div', 'eyebrow', 'Claude žádá o svolení'));
  box.appendChild(el('h3', 'perm-title', ev.displayName || ev.toolName));
  if (ev.description) box.appendChild(el('p', 'perm-desc', ev.description));
  const pv = ev.preview || {};
  const detail = pv.command || pv.path || pv.url || pv.json;
  if (ev.edit && Array.isArray(ev.edit.edits)) box.appendChild(diffView(ev.edit.edits, toolSummary('Edit', { file_path: ev.edit.file }, run.cwd)));
  else if (detail) box.appendChild(el('pre', null, detail));
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
  liveMode(m);
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
  setTimeout(() => { saveDraft(); autoGrow(); }, 0); // odeslaný text už není koncept
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

async function startRun(prompt, mode, files = [], opts = { model: S.model, effort: S.effort }, { auto = false } = {}) {
  if (S.run) return;
  if (!auto) cancelContinue();
  hideBanner();
  S.lastPrompt = prompt;
  const bubble = append(userBubble(prompt, files), true);

  const controller = new AbortController();
  const run = { runId: null, controller, mode, account: S.account, prompt, sawPlan: false, resultText: null,
    resultError: false, hadError: false, cwd: null, limitShown: false, outcome: null, sessionId: S.sessionId,
    replays: 0, injectedBubbles: [], model: opts.model || '', effort: opts.effort || '', auto, bubble,
    fork: !!(S.forkNext && S.sessionId), chrome: chromeOn() };
  if (S.forkNext) { S.forkNext = false; renderForkNote(); }
  S.run = run;
  PR.stopped = null;
  setRunning(true);
  renderProgress();
  setStatus('Spouštím Claude…', true);

  const state = { msgBlocks: new Map(), finalized: new Set() };
  try {
    const res = await api('/api/runs', {
      method: 'POST',
      signal: controller.signal,
      body: { account: S.account, project: S.project, mode, prompt, resume: S.sessionId, attachments: files.map((f) => f.id), model: run.model, effort: run.effort, ...runFlags(run) },
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
  if (outcome === 'limit') scheduleContinue(run);
  else if (outcome === 'ok' && run.sessionId) delete AC.attempts[run.sessionId];
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
const SL = { items: [], sel: 0, mode: 'cmd', at: null };
const AT = { files: null, project: null, at: 0, loading: false };
/** Seznam souborů pro @ (stejný jako v okně Soubory; obnoví se nejvýš jednou za minutu). */
async function ensureAtFiles() {
  if (AT.loading) return false;
  AT.loading = true;
  try { const r = await apiJson(`/api/projects/${encodeURIComponent(S.project)}/files`); AT.files = r.files; }
  catch { AT.files = []; }
  finally { AT.project = S.project; AT.at = Date.now(); AT.loading = false; }
  return true;
}
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
  const ta = $('#prompt');
  let items, mode = 'cmd', at = null;
  if (q !== null) {
    if (!commandEntries().length) { ensureCommands().then((ok) => { if (ok && slashQuery() !== null) updateSlash(); }); }
    const f = fold(q);
    items = commandEntries().filter((c) => fold(c.name).includes(f))
      .sort((x, y) => (fold(x.name).startsWith(f) ? 0 : 1) - (fold(y.name).startsWith(f) ? 0 : 1)).slice(0, 50)
      .map((c) => { const [d, h] = commandInfo().info[c.name] || ['', '']; return { ...c, label: `/${c.name}${h ? ` ${h}` : ''}`, meta: d ? d.slice(0, 60) : c.kind === 'skill' ? 'skill' : '' }; });
  } else {
    at = ta.selectionStart === ta.selectionEnd ? Review.atQuery(ta.value, ta.selectionStart) : null;
    if (!at) { closeSlash(); return; }
    if (AT.project !== S.project || !AT.files) { ensureAtFiles().then((ok) => { if (ok) updateSlash(); }); return; }
    if (Date.now() - AT.at > 60_000) ensureAtFiles();
    mode = 'file';
    items = Review.rankFiles(AT.files, at.query, 12).map((p) => {
      const slash = p.lastIndexOf('/');
      return { name: p, kind: 'file', label: p.slice(slash + 1), meta: slash > 0 ? p.slice(0, slash) : '' };
    });
  }
  if (!items.length) { closeSlash(); return; }
  const ul = $('#slash-list');
  const wasOpen = slashOpen() && SL.mode === mode;
  SL.mode = mode;
  SL.at = at;
  ul.setAttribute('aria-label', mode === 'file' ? 'Soubory projektu' : 'Příkazy a skilly');
  ul.textContent = '';
  SL.items = items.map((c, i) => {
    const li = el('li', 'palette-item');
    li.id = `slash-${i}`;
    li.setAttribute('role', 'option');
    li.dataset.kind = mode === 'file' ? 'file' : 'cmd';
    li.appendChild(el('span', 'palette-label', c.label));
    if (c.meta) li.appendChild(el('span', 'palette-meta', c.meta));
    if (mode === 'file') li.setAttribute('aria-label', c.name);
    li.addEventListener('mousedown', (e) => e.preventDefault()); // fokus zůstane v poli
    li.addEventListener('click', () => { SL.sel = i; acceptSlash(); });
    ul.appendChild(li);
    return { ...c, node: li };
  });
  SL.sel = 0;
  ul.hidden = false;
  markSlash();
  if (!wasOpen) $('#slash-status').textContent = mode === 'file'
    ? `${items.length} ${plural(items.length, 'soubor', 'soubory', 'souborů')} – šipky vyberou, Enter nebo Tab vloží, Esc zavře.`
    : `${items.length} ${plural(items.length, 'příkaz', 'příkazy', 'příkazů')} – šipky vyberou, Enter nebo Tab vloží, Esc zavře.`;
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
  if (SL.mode === 'file' && SL.at) {
    // @cesta: nahradit rozepsané @… (i zbytek slova za kurzorem); Claude Code soubor načte sám.
    const from = SL.at.start;
    const end = ta.selectionStart + /^[^\s@"]*/.exec(ta.value.slice(ta.selectionStart))[0].length;
    const after = ta.value.slice(end);
    const text = `@${it.name}` + (after.startsWith(' ') ? '' : ' ');
    ta.setSelectionRange(from, end);
    if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, from, end, 'end');
    const caret = from + text.length + (after.startsWith(' ') ? 1 : 0);
    ta.setSelectionRange(caret, caret);
    closeSlash();
    return;
  }
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
      tool('↩', 'back', `Vrátit zprávu ${idx + 1} do pole pro psaní`, () => {
        const ta = $('#prompt');
        ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${it.prompt}` : it.prompt;
        for (const f of it.attachments) if (!S.pending.some((x) => x.id === f.id)) S.pending.push({ ...f, status: 'ok' });
        S.queueFocus = null;
        q.remove(it.id);
        renderQueue();
        renderAttachments();
        ta.focus();
        saveDraft();
        announce('Zpráva vrácena do pole pro psaní.');
      }),
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
  requestAnimationFrame(() => { b.pending = false; setClaudeText(b, b.raw, false, true); scrollDown(); });
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
    case 'commands':
      rememberCommandInfo(ev);
      break;
    case 'task':
      taskEvent(ev, run);
      break;
    case 'bg_tasks': {
      // Aktuální seznam úloh na pozadí: co v něm není a „běží“, už skončilo.
      const live = new Set((ev.tasks || []).map((t) => t.taskId));
      for (const [id, t] of BG.tasks) if (t.status === 'running' && !live.has(id)) { t.status = 'completed'; t.end = Date.now(); }
      renderBackground();
      renderProgress();
      break;
    }
    case 'title':
      setTimeout(loadSessions, 300);
      break;
    case 'text': {
      if (ev.parent) { agentEvent(ev); break; }
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
      if (ev.parent && agentEvent(ev)) break;
      if (TASK_TOOLS.has(ev.name)) break;
      if (!ev.parent && AGENT_TOOLS.has(ev.name)) { agentCard(ev.id); setStatus('Claude spouští agenta…', true); break; }
      const t = toolCard(ev.id, ev.name, ev.parent);
      t.nm.textContent = ev.name;
      setStatus(`Nástroj ${ev.name}…`, true);
      break;
    }
    case 'tool_use': {
      if (ev.parent && agentEvent(ev)) break;
      if (!ev.parent && TASK_TOOLS.has(ev.name)) { progressToolUse(ev.name, ev.id, ev.input); break; }
      if (!ev.parent && AGENT_TOOLS.has(ev.name)) {
        const a = agentCard(ev.id, ev.input);
        const desc = (ev.input && ev.input.description) || '';
        a.t.nm.textContent = desc ? `Agent · ${desc}` : 'Agent';
        a.t.sm.textContent = '';
        break;
      }
      const t = toolCard(ev.id, ev.name, ev.parent);
      fillToolInput(t, ev.name, ev.input, run.cwd);
      break;
    }
    case 'tool_result': {
      if (ev.parent && agentEvent(ev)) break;
      if (progressToolResult(ev.id, ev.content, ev.isError)) break;
      const t = tools.get(ev.id);
      if (t) { fillToolResult(t, ev); tools.delete(ev.id); } // výsledek přijde jen jednou
      setStatus('Claude pracuje…', true);
      break;
    }
    case 'rate_limit':
      S.limits[run.account] = { ...ev, at: Date.now() };
      if (ev.status === 'rejected') { run.limitShown = true; run.limitResetsAt = ev.resetsAt; showLimit(run.account, ev.resetsAt); }
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
      if (run.replays === 1) attachUuid(run.bubble, ev.uuid);
      if (run.replays > 1) {
        const st = run.injectedBubbles.shift();
        if (st) { st.textContent = 'Claude si zprávu přečetl'; attachUuid(st.closest('.msg'), ev.uuid); }
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
      run.resultError = !!ev.isError && !ev.interrupted;
      if (ev.sessionId) { S.sessionId = ev.sessionId; S.queue.bindSession(run, ev.sessionId); markCurrentSession(); }
      if (typeof ev.costUsd === 'number') S.totalCost += ev.costUsd;
      addRunStats(ev, run);
      if ($('#overviewdlg').open) loadOverview();
      const looksLikeLimit = ev.isError && (ev.apiErrorStatus === 429 || /limit|rate.?limit|usage/i.test(ev.result || ''));
      if (looksLikeLimit && !run.limitShown) { run.limitShown = true; showLimit(run.account, null, ev.result); }
      else if (ev.isError && !run.limitShown && !ev.interrupted) showError(`Claude skončil s chybou (${ev.subtype || 'error'})`, ev.result || '');
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
      if (PR.tasks.length && !PR.tasks.every((t) => t.status === 'completed'))
        PR.stopped = ev.stopped ? 'Zastaveno.' : run.limitShown ? 'Přerušeno limitem účtu.' : 'Claude skončil před koncem seznamu – pokračujte další zprávou.';
      renderProgress();
      // Plan bez souboru plánu → plán je text odpovědi.
      if (run.mode === 'plan' && !run.sawPlan && !ev.stopped && !run.resultError && run.resultText) showPlanCard(null, 'Plán je výše – schválit?', run.resultText);
      if (ev.kept) setTimeout(loadContext, 300);
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

/* ---------- Úložiště prohlížeče (vše v try/catch – může být zakázané) ---------- */
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* nevadí */ } };

/* ---------- Průběh práce: seznam úkolů Claude Code (TaskCreate/TaskUpdate, jako Ctrl+T v terminálu) ---------- */
// Claude si u větších úkolů sám vede seznam kroků; aplikace z něj ukazuje vpravo kroky, procenta a odhad času.
const PR = { tasks: [], pending: new Map(), hidden: false, timer: null, stopped: null, said: '' };
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']); // v chatu jako karty nástrojů nic neříkají

function resetProgress() {
  PR.tasks = [];
  PR.pending.clear();
  PR.hidden = false;
  PR.stopped = null;
  renderProgress();
}
/** tool_use TaskCreate / TaskUpdate (hlavní Claude, ne agenti). */
function progressToolUse(name, id, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'TaskCreate') {
    // Nový seznam, když je předchozí celý hotový.
    if (PR.tasks.length && PR.tasks.every((t) => t.status === 'completed')) { PR.tasks = []; PR.hidden = false; }
    PR.pending.set(id, String(i.subject || i.description || 'Krok').slice(0, 200));
  } else if (name === 'TaskUpdate') {
    const t = PR.tasks.find((x) => x.id === String(i.taskId));
    if (!t) return;
    const now = Date.now();
    if (i.status === 'deleted') PR.tasks = PR.tasks.filter((x) => x !== t);
    else if (i.status === 'in_progress') { t.status = 'in_progress'; t.start ??= now; }
    else if (i.status === 'completed') { t.status = 'completed'; t.start ??= now; t.end = now; }
    else if (i.status === 'pending') t.status = 'pending';
    if (typeof i.subject === 'string' && i.subject) t.text = i.subject.slice(0, 200);
    PR.stopped = null;
    renderProgress();
  }
}
/** tool_result TaskCreate: „Task #3 created successfully: …“ → id úkolu. */
function progressToolResult(id, content, isError) {
  if (!PR.pending.has(id)) return false;
  const text = PR.pending.get(id);
  PR.pending.delete(id);
  const m = /#(\d+)/.exec(String(content || ''));
  if (m && !isError && !PR.tasks.some((t) => t.id === m[1])) { PR.tasks.push({ id: m[1], text, status: 'pending' }); PR.stopped = null; renderProgress(); }
  return true;
}
const fmtDur = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

function renderProgress() {
  const panel = $('#progress'), foot = $('#foot-progress');
  const info = Review.taskProgress(PR.tasks, Date.now());
  const has = info.total > 0;
  $('#progress-main').hidden = !has;
  const bgCount = BG.tasks.size;
  panel.hidden = (!has && !bgCount) || PR.hidden;
  $('.layout').classList.toggle('has-progress', !panel.hidden);
  foot.hidden = !has && !bgCount;
  const running = !!S.run && !info.done && !PR.stopped;
  const tick = (running && has) || bgCount > 0;
  if (tick && !PR.timer) PR.timer = setInterval(() => { renderProgress(); renderBackground(); }, 5000);
  if (!tick && PR.timer) { clearInterval(PR.timer); PR.timer = null; }
  const label = !has ? '' : info.done ? 'hotovo' : info.current >= 0 ? `krok ${info.current + 1} z ${info.total}` : `${info.completed} z ${info.total}`;
  foot.textContent = has ? `Průběh: ${label} · ${info.percent} %${bgCount ? ` · na pozadí ${bgCount}` : ''}` : `Na pozadí: ${bgCount}`;
  foot.setAttribute('aria-expanded', String(!panel.hidden));
  foot.title = panel.hidden ? 'Ukázat průběh' : 'Skrýt průběh';
  if (!has) return;
  $('#progress-pct').textContent = `${info.percent} %`;
  const first = PR.tasks.find((t) => t.start)?.start;
  const last = Math.max(0, ...PR.tasks.map((t) => t.end || 0));
  $('#progress-eta').textContent = info.done ? `hotovo${first && last ? ` za ${fmtDur(last - first)}` : ''}`
    : !running ? '' : info.etaMs != null ? `zbývá ${Review.fmtEta(info.etaMs)}` : 'odhad po prvním kroku';
  const bar = $('#progress-bar');
  bar.setAttribute('aria-valuenow', String(info.percent));
  bar.setAttribute('aria-valuetext', `${label}, ${info.percent} %`);
  bar.firstElementChild.style.width = `${info.percent}%`;
  const ol = $('#progress-steps');
  ol.textContent = '';
  PR.tasks.forEach((t, i) => {
    const n = i + 1;
    const state = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'current' : 'todo';
    const li = el('li');
    li.dataset.state = state;
    if (state === 'current') li.setAttribute('aria-current', 'step');
    const num = el('span', 'progress-num', state === 'done' ? '✓' : String(n));
    num.setAttribute('aria-hidden', 'true');
    li.append(num, el('span', 'sr-only', state === 'done' ? `${n}, hotovo: ` : state === 'current' ? `${n}, právě teď: ` : `${n}: `),
      el('span', 'progress-text', t.text));
    if (t.start && t.end) li.appendChild(el('span', 'progress-time', fmtDur(t.end - t.start)));
    else if (t.start && state === 'current' && running) li.appendChild(el('span', 'progress-time', fmtDur(Date.now() - t.start)));
    ol.appendChild(li);
  });
  $('#progress-note').textContent = info.done ? '' : PR.stopped || '';
  const cur = info.current >= 0 ? PR.tasks[info.current] : null;
  const say = info.done ? 'Průběh: hotovo.' : cur ? `Krok ${info.current + 1} z ${info.total}: ${cur.text}` : '';
  if (say && say !== PR.said) { PR.said = say; $('#progress-status').textContent = say; }
}

/** Seznam úkolů otevřeného sezení z přepisu (bez časů) – rozpracovaný se ukáže, hotový zůstane skrytý. */
async function restoreProgress(id) {
  try {
    const o = await apiJson(`/api/sessions/${encodeURIComponent(id)}/overview?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`);
    if (S.sessionId !== id || S.run || !Array.isArray(o.todos) || !o.todos.length) return;
    PR.tasks = o.todos.map((t, i) => ({ id: `h${i}`, text: t.content, status: t.status }));
    const done = PR.tasks.every((t) => t.status === 'completed');
    PR.hidden = done;
    PR.stopped = done ? null : 'Rozpracovaný seznam z dřívějška.';
    renderProgress();
  } catch { /* přehled nejde načíst – nevadí */ }
}

function setupProgress() {
  $('#progress-hide').addEventListener('click', () => { PR.hidden = true; renderProgress(); $('#foot-progress').focus(); });
  $('#foot-progress').addEventListener('click', () => { PR.hidden = !PR.hidden; renderProgress(); });
}

/* ---------- Rozepsané zprávy (koncepty) po sezeních – jen localStorage tohoto prohlížeče ---------- */
const DRAFTS_KEY = 'acd.drafts';
const DRAFTS_ON_KEY = 'acd.drafts.on';
const DRAFT_MAX = 30, DRAFT_DAYS = 30, DRAFT_CHARS = 20_000;
const draftsOn = () => load(DRAFTS_ON_KEY) !== '0';
const draftKey = () => `${S.account}|${S.project}|${S.sessionId || 'nové'}`;
const DR = { timer: null, skip: false };
function readDrafts() {
  try { const o = JSON.parse(load(DRAFTS_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
function writeDrafts(o) {
  const now = Date.now();
  const keep = Object.entries(o).filter(([, d]) => d && typeof d.text === 'string' && typeof d.at === 'number' && now - d.at < DRAFT_DAYS * 86_400_000)
    .sort((a, b) => b[1].at - a[1].at).slice(0, DRAFT_MAX);
  store(DRAFTS_KEY, JSON.stringify(Object.fromEntries(keep)));
}
function saveDraft() {
  clearTimeout(DR.timer);
  if (!draftsOn() || !S.account || !S.project) return;
  const o = readDrafts();
  const k = draftKey();
  const t = $('#prompt').value;
  const had = !!o[k];
  if (t.trim()) o[k] = { text: t.slice(0, DRAFT_CHARS), at: Date.now() };
  else if (had) delete o[k];
  else return;
  writeDrafts(o);
  if (had !== !!t.trim() && S.sessionId) markDraftInList(S.sessionId, !!t.trim());
}
function restoreDraft() {
  const d = draftsOn() ? readDrafts()[draftKey()] : null;
  $('#prompt').value = d ? d.text : '';
  autoGrow();
  if (d) setStatus('Obnovena rozepsaná zpráva.');
}
const hasDraft = (id) => draftsOn() && !!readDrafts()[`${S.account}|${S.project}|${id}`];
function markDraftInList(id, on) {
  const meta = document.querySelector(`#sessions button[data-id="${CSS.escape(id)}"] .s-meta`);
  if (!meta) return;
  meta.textContent = meta.textContent.replace(/ • koncept$/, '') + (on ? ' • koncept' : '');
}

/* ---------- Po obnovení limitu automaticky pokračovat (jako Claude Code; vypnout jde v Nastavení) ---------- */
const AUTO_KEY = 'acd.autocontinue';
const autoOn = () => load(AUTO_KEY) !== '0';
const CONTINUE_PROMPT = 'Pokračuj tam, kde jsi skončil – předtím tě zastavil limit účtu.';
const AC_MAX_TRIES = 3;
const AC = { timer: null, at: 0, ctx: null, attempts: {} };
function fmtLeft(ms) {
  if (ms <= 60_000) return 'chvíli';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function scheduleContinue(run) {
  cancelContinue();
  const sid = run.sessionId || S.sessionId;
  const lim = S.limits[run.account];
  const resetsAt = run.limitResetsAt || (lim && lim.resetsAt);
  if (!autoOn() || !resetsAt || !sid) return;
  const tries = AC.attempts[sid] || 0;
  if (tries >= AC_MAX_TRIES) { showBanner('err', [el('strong', null, 'Automatické pokračování vzdávám'),
    document.createTextNode(` – limit trvá i po ${tries} pokusech. Pokračujte ručně.`)], []); return; }
  AC.attempts[sid] = tries + 1;
  AC.ctx = { account: run.account, project: S.project, sessionId: sid, mode: run.mode, model: run.model, effort: run.effort };
  // Minuta rezervy po obnovení; čas v minulosti → za 5 minut.
  AC.at = Math.max(resetsAt * 1000 + 60_000, Date.now() + (resetsAt * 1000 < Date.now() ? 300_000 : 0));
  AC.timer = setInterval(tickContinue, 15_000);
  showLimit(run.account, resetsAt);
}
function cancelContinue() {
  if (!AC.timer) return;
  clearInterval(AC.timer);
  AC.timer = null;
  AC.ctx = null;
}
function tickContinue() {
  const left = $('#ac-left');
  if (left) left.textContent = fmtLeft(AC.at - Date.now());
  if (Date.now() < AC.at || S.run) return; // běží-li něco jiného, počkat
  const c = AC.ctx;
  cancelContinue();
  if (!c || c.account !== S.account || c.project !== S.project || c.sessionId !== S.sessionId) return;
  notify('Pokračuji po obnovení limitu', CONTINUE_PROMPT, 'ok');
  announce('Limit účtu se obnovil – pokračuji.');
  startRun(CONTINUE_PROMPT, c.mode, [], { model: c.model, effort: c.effort }, { auto: true });
}

/* ---------- Volby běhu: kopie sezení, otázka bokem, Claude in Chrome ---------- */
const CHROME_KEY = 'acd.chrome';
const chromeOn = () => S.interactivePermissions && load(CHROME_KEY) === '1';
/** Příznaky pro POST /api/runs podle běhu. */
function runFlags(run) {
  const f = {};
  if (run.fork) f.fork = true;
  if (run.side) f.side = true;
  if (run.chrome) f.chrome = true;
  return f;
}
function renderForkNote() {
  const n = $('#fork-note');
  n.hidden = !S.forkNext;
  if (S.forkNext) $('#fork-note-text').textContent = 'Další zpráva pokračuje v kopii tohoto sezení – původní zůstane beze změny.';
}
function forkSession(id) {
  if (S.run) return;
  const go = () => { S.forkNext = true; renderForkNote(); $('#prompt').focus(); announce('Další zpráva vytvoří kopii sezení.'); };
  if (id && id !== S.sessionId) openSession(id).then(go); else if (S.sessionId) go();
}

/* ---------- Agenti (subagenti) a práce na pozadí ---------- */
// Karta agenta: popis úkolu, typ, stav, nástroje a tokeny; po rozbalení živý záznam, co agent dělá (jen sledovat).
const AG = new Map(); // tool_use id nástroje Agent/Task → {card, log, meta, info}
const BG = { tasks: new Map() }; // taskId → {description, type, start, status, toolUseId}
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function agentCard(id, input) {
  let a = AG.get(id);
  if (a) {
    if (input && input.prompt && !a.t.body.querySelector('.agent-prompt')) {
      if (input.subagent_type) { a.info.type = input.subagent_type; renderAgentMeta(a); }
      const p = el('details', 'agent-prompt');
      p.appendChild(el('summary', null, 'Zadání agenta'));
      p.appendChild(el('pre', null, String(input.prompt).slice(0, 4000)));
      a.t.body.insertBefore(p, a.log);
    }
    return a;
  }
  const t = toolCard(id, 'Agent');
  t.d.classList.add('agent');
  const meta = el('span', 'agent-meta');
  t.d.querySelector('summary').insertBefore(meta, t.badge);
  const log = el('ol', 'agent-log');
  log.setAttribute('aria-label', 'Co agent dělá');
  t.body.textContent = '';
  if (input && input.prompt) {
    const p = el('details', 'agent-prompt');
    p.appendChild(el('summary', null, 'Zadání agenta'));
    p.appendChild(el('pre', null, String(input.prompt).slice(0, 4000)));
    t.body.appendChild(p);
  }
  t.body.appendChild(log);
  a = { t, log, meta, info: { tools: 0, tokens: 0, ms: 0, type: (input && input.subagent_type) || '', start: Date.now() }, lines: new Map() };
  AG.set(id, a);
  renderAgentMeta(a);
  return a;
}
function renderAgentMeta(a) {
  const i = a.info;
  const parts = [i.type, i.tools ? `${i.tools} ${plural(i.tools, 'nástroj', 'nástroje', 'nástrojů')}` : '',
    i.tokens ? `${fmtTok(i.tokens)} tokenů` : '', i.ms ? fmtDur(i.ms) : '', i.background ? 'na pozadí' : ''].filter(Boolean);
  a.meta.textContent = parts.join(' · ');
}
/** Událost z agenta (parent = id nástroje Agent). @returns {boolean} true = zpracováno v kartě agenta */
function agentEvent(ev) {
  const a = AG.get(ev.parent);
  if (!a) return false;
  if (ev.type === 'tool_start' || ev.type === 'tool_use') {
    let li = a.lines.get(ev.id);
    if (!li) {
      li = el('li', 'agent-step');
      li.dataset.state = 'running';
      a.log.appendChild(li);
      a.lines.set(ev.id, li);
      a.info.tools++;
      renderAgentMeta(a);
    }
    if (ev.type === 'tool_use') {
      li.textContent = '';
      li.append(el('span', 'agent-tool', ev.name), document.createTextNode(` ${toolSummary(ev.name, ev.input, S.run && S.run.cwd)}`));
    } else if (!li.textContent) li.appendChild(el('span', 'agent-tool', ev.name));
    a.t.sm.textContent = `${ev.name} ${ev.type === 'tool_use' ? toolSummary(ev.name, ev.input, S.run && S.run.cwd) : ''}`.trim();
  } else if (ev.type === 'tool_result') {
    const li = a.lines.get(ev.id);
    if (li) li.dataset.state = ev.denied ? 'denied' : ev.isError ? 'error' : 'ok';
  } else if (ev.type === 'text' && ev.text) {
    const li = el('li', 'agent-text');
    renderMd(li, ev.text.length > 3000 ? `${ev.text.slice(0, 3000)}…` : ev.text, false);
    a.log.appendChild(li);
  }
  return true;
}
/** Události úloh (agent nebo příkaz na pozadí): začal / průběh / změna stavu / hotovo. */
function taskEvent(ev, run) {
  const a = ev.toolUseId ? AG.get(ev.toolUseId) : null;
  if (a) {
    if (ev.subagentType) a.info.type = ev.subagentType;
    if (ev.tokens) a.info.tokens = ev.tokens;
    if (ev.ms) a.info.ms = ev.ms;
    if (ev.background) a.info.background = true;
    if (ev.lastTool && ev.phase === 'progress' && !a.lines.size) a.t.sm.textContent = ev.description || ev.lastTool;
    if (ev.phase === 'notification' || (ev.phase === 'updated' && ev.status && ev.status !== 'running')) {
      a.t.d.dataset.state = ev.status === 'completed' ? 'ok' : 'error';
      a.t.badge.textContent = ev.status === 'completed' ? 'hotovo' : ev.status === 'stopped' || ev.status === 'killed' ? 'zastaveno' : 'chyba';
    }
    renderAgentMeta(a);
  }
  // Panel „Na pozadí“: jen to, co Claude pustil na pozadí (příkazy i agenti).
  if (ev.phase === 'started' && ev.background) {
    BG.tasks.set(ev.taskId, { description: ev.description || ev.taskId, type: ev.taskType, start: Date.now(), status: 'running', runId: run.runId });
    if (a) { a.t.badge.textContent = 'na pozadí'; }
  } else if (BG.tasks.has(ev.taskId) && (ev.phase === 'notification' || (ev.phase === 'updated' && ev.status && ev.status !== 'running'))) {
    const t = BG.tasks.get(ev.taskId);
    t.status = ev.status || 'completed';
    t.end = Date.now();
    if (ev.summary) t.summary = ev.summary;
    setTimeout(() => { BG.tasks.delete(ev.taskId); renderBackground(); renderProgress(); }, 60_000); // hotové chvíli zůstanou
  }
  renderBackground();
  renderProgress();
}
function renderBackground() {
  const sec = $('#bg-section'), ul = $('#bg-list');
  sec.hidden = !BG.tasks.size;
  ul.textContent = '';
  for (const [id, t] of BG.tasks) {
    const li = el('li', 'bg-item');
    li.dataset.state = t.status;
    const main = el('span', 'bg-main');
    main.append(el('span', 'bg-desc', t.description),
      el('span', 'bg-meta', `${t.type === 'local_agent' ? 'agent' : 'příkaz'} · ${t.status === 'running' ? `běží ${fmtDur(Date.now() - t.start)}`
        : t.status === 'completed' ? 'hotovo' : 'zastaveno'}`));
    li.appendChild(main);
    if (t.status === 'running' && S.run && S.run.runId === t.runId) {
      const stopBtn = button('Zastavit', 'btn-ghost btn-small', async () => {
        stopBtn.disabled = true;
        try { await apiJson(`/api/runs/${t.runId}/task-stop`, { method: 'POST', body: { taskId: id } }); announce(`Zastavuji: ${t.description}`); }
        catch (e) { stopBtn.disabled = false; showError('Úlohu nejde zastavit', e.message); }
      });
      stopBtn.setAttribute('aria-label', `Zastavit ${t.description}`);
      li.appendChild(stopBtn);
    }
    ul.appendChild(li);
  }
}

/* ---------- Příkazy s popisy a agenti (z initialize) ---------- */
const CMDINFO_KEY = (acc, proj) => `acd.cmdinfo.${acc}.${proj}`;
function rememberCommandInfo(ev) {
  const info = {};
  for (const c of ev.commands || []) info[c.name] = [c.description || '', c.argumentHint || ''];
  store(CMDINFO_KEY(S.account, S.project), JSON.stringify({ info, agents: (ev.agents || []).slice(0, 100) }));
}
function commandInfo() {
  try { const v = JSON.parse(load(CMDINFO_KEY(S.account, S.project)) || '{}'); return { info: v.info || {}, agents: Array.isArray(v.agents) ? v.agents : [] }; }
  catch { return { info: {}, agents: [] }; }
}

/* ---------- Otázka od Clauda (AskUserQuestion) ---------- */
function showQuestionCard(ev, run) {
  const box = el('div', 'perm question');
  box.dataset.requestId = ev.requestId;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Claude se ptá');
  box.appendChild(el('div', 'eyebrow', 'Claude se ptá'));
  const groups = [];
  ev.questions.forEach((q, qi) => {
    const fs = el('fieldset', 'question-set');
    fs.appendChild(el('legend', 'perm-title', q.question));
    const name = `q-${ev.requestId}-${qi}`;
    const inputs = [];
    for (const o of q.options) {
      const lab = el('label', 'question-opt');
      const inp = el('input');
      inp.type = q.multiSelect ? 'checkbox' : 'radio';
      inp.name = name;
      inp.value = o.label;
      lab.append(inp, el('span', 'question-label', o.label));
      if (o.description) lab.appendChild(el('span', 'question-desc', o.description));
      fs.appendChild(lab);
      inputs.push(inp);
    }
    const other = el('input', 'question-other');
    other.type = 'text';
    other.maxLength = 2000;
    other.placeholder = 'Jiná odpověď (napište vlastní)';
    other.setAttribute('aria-label', `Jiná odpověď na: ${q.question}`);
    fs.appendChild(other);
    box.appendChild(fs);
    groups.push({ q, inputs, other });
  });
  const msg = el('p', 'perm-result');
  const actions = el('div', 'perm-actions');
  const send = async (decision) => {
    let answers;
    if (decision === 'answer') {
      answers = {};
      for (const g of groups) {
        const picked = g.inputs.filter((i) => i.checked).map((i) => i.value);
        const own = g.other.value.trim();
        const val = own || picked.join(', ');
        if (!val) { msg.textContent = 'Vyberte odpověď u každé otázky, nebo napište vlastní.'; (g.inputs[0] || g.other).focus(); return; }
        answers[g.q.question] = val;
      }
    }
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    try {
      await apiJson(`/api/runs/${encodeURIComponent(run.runId)}/permission`, { method: 'POST', body: { requestId: ev.requestId, decision, answers } });
      box.dataset.state = 'resolved';
      msg.textContent = decision === 'answer' ? `Odpověď: ${Object.values(answers).join(' / ')}` : 'Bez odpovědi – Claude pokračuje sám.';
      $('#prompt').focus({ preventScroll: true });
    } catch (e) { for (const b of actions.querySelectorAll('button')) b.disabled = false; msg.textContent = e.message; }
  };
  const ok = button('Odpovědět', 'btn-accent btn-small', () => send('answer'));
  actions.append(ok, button('Neodpovídat', 'btn-ghost btn-small', () => send('deny')));
  box.append(actions, msg);
  append(box, true);
  run.pendingPermissions = (run.pendingPermissions || 0) + 1;
  setStatus('Claude čeká na vaši odpověď…', true);
  if (!isTyping()) (groups[0].inputs[0] || groups[0].other).focus({ preventScroll: true });
  announce(`Claude se ptá: ${ev.questions.map((q) => q.question).join(' ')}`);
  notify('Claude se ptá', ev.questions[0].question, 'plan');
}

/* ---------- Návrat souborů k dřívější zprávě (jako Esc Esc / /rewind) ---------- */
function attachUuid(bubble, uuid) {
  if (!bubble || !uuid || bubble.dataset.uuid) return;
  bubble.dataset.uuid = uuid;
  const b = el('button', 'msg-rewind', '↶');
  b.type = 'button';
  b.title = 'Vrátit soubory projektu do stavu před touto zprávou';
  b.setAttribute('aria-label', 'Vrátit soubory do stavu před touto zprávou');
  b.addEventListener('click', () => rewindTo(uuid, b));
  bubble.appendChild(b);
}
async function rewindTo(uuid, btn) {
  if (S.run) { showBanner('warn', [document.createTextNode('Soubory jde vrátit, až Claude doběhne.')], []); return; }
  if (!S.sessionId) return;
  const url = `/api/sessions/${encodeURIComponent(S.sessionId)}/rewind?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`;
  btn.disabled = true;
  setStatus('Zjišťuji, co se změní…', true);
  let r;
  try { r = await apiJson(url, { method: 'POST', body: { messageId: uuid, dryRun: true } }); }
  catch (e) { setStatus(''); btn.disabled = false; showError('Návrat nejde zjistit', e.message); return; }
  setStatus('');
  btn.disabled = false;
  if (!r.canRewind || !r.files.length) {
    showBanner('warn', [document.createTextNode(r.error && !/checkpoint/i.test(r.error) ? r.error
      : 'K této zprávě není co vracet – od ní se nezměnil žádný soubor (nebo změny udělal příkaz v terminálu, ty se nevracejí).')], []);
    return;
  }
  const list = r.files.slice(0, 20).join('\n') + (r.files.length > 20 ? `\n… a dalších ${r.files.length - 20}` : '');
  if (!confirm(`Vrátit ${r.files.length} ${plural(r.files.length, 'soubor', 'soubory', 'souborů')} do stavu před touto zprávou?\n\n${list}\n\n`
    + 'Změny od té doby (i vaše vlastní v těchto souborech) se ztratí. Konverzace zůstane, jak je.')) return;
  try {
    const d = await apiJson(url, { method: 'POST', body: { messageId: uuid, dryRun: false } });
    append(el('div', 'msg msg--note', `Soubory vráceny do stavu před vybranou zprávou (${d.files.length || r.files.length} ${plural(r.files.length, 'soubor', 'soubory', 'souborů')}).`), true);
    announce('Soubory vráceny.');
    loadGit();
  } catch (e) { showError('Návrat se nepovedl', e.message); }
}

/* ---------- Kontext (jako /context) a zhuštění (/compact) ---------- */
const CTX = { data: null, seq: 0 };
async function loadContext() {
  const b = $('#foot-context');
  if (!S.sessionId) { b.hidden = true; return; }
  const seq = ++CTX.seq;
  const id = S.sessionId;
  try {
    const c = await apiJson(`/api/sessions/${encodeURIComponent(id)}/context?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`);
    if (seq !== CTX.seq || id !== S.sessionId) return;
    CTX.data = c;
    b.hidden = false;
    const pct = Math.round(c.percentage);
    b.textContent = `Kontext ${pct} %`;
    b.dataset.level = c.autoCompactThreshold && c.totalTokens >= c.autoCompactThreshold * 0.85 ? 'warn' : pct >= 70 ? 'warn' : 'ok';
    if ($('#contextdlg').open) renderContext();
  } catch { if (seq === CTX.seq) b.hidden = true; }
}
function renderContext() {
  const c = CTX.data, body = $('#context-body');
  body.textContent = '';
  if (!c) { body.appendChild(el('p', 'stats-empty', 'Zatím bez údajů.')); return; }
  body.appendChild(el('p', 'context-sum', `${fmtTok(c.totalTokens)} z ${fmtTok(c.maxTokens)} tokenů (${Math.round(c.percentage)} %)`
    + (c.model ? ` · ${c.model.replace(/^claude-/, '')}` : '')));
  const bar = el('span', 'meter-bar');
  bar.setAttribute('role', 'meter'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(c.percentage))); bar.setAttribute('aria-label', 'Zaplnění kontextu');
  const fill = el('i'); fill.style.width = `${Math.min(100, c.percentage)}%`; bar.appendChild(fill);
  body.appendChild(bar);
  if (c.autoCompact && c.autoCompactThreshold)
    body.appendChild(el('p', 'stats-empty', `Claude Code konverzaci automaticky zhustí kolem ${fmtTok(c.autoCompactThreshold)} tokenů.`));
  const t = el('table', 'stats-table');
  t.appendChild(el('caption', null, 'Co zabírá místo'));
  const tb = el('tbody');
  for (const x of c.categories.filter((x) => x.tokens > 0)) {
    const tr = el('tr');
    const th = el('th', null, x.name + (x.deferred ? ' (načte se až při použití)' : '')); th.scope = 'row';
    tr.append(th, el('td', null, fmtNum(x.tokens)));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  body.appendChild(t);
}
function setupContext() {
  $('#foot-context').addEventListener('click', () => { renderContext(); $('#contextdlg').showModal(); loadContext(); });
  $('#context-close').addEventListener('click', () => $('#contextdlg').close());
  $('#contextdlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('#context-compact').addEventListener('click', () => {
    $('#contextdlg').close();
    if (S.run) { showBanner('warn', [document.createTextNode('Zhustit jde, až Claude doběhne.')], []); return; }
    startRun('/compact', S.mode);
  });
}

/* ---------- Otázka bokem (jako /btw): kopie sezení jen pro čtení, neukládá se ---------- */
const SQ = { controller: null };
function openSide() {
  if (!S.sessionId) { showBanner('warn', [document.createTextNode('Otázka bokem potřebuje rozpracované sezení – nejdřív pošlete zprávu.')], []); return; }
  const d = $('#sidedlg');
  if (!d.open) d.showModal();
  $('#side-input').focus();
}
async function askSide(e) {
  e.preventDefault();
  const q = $('#side-input').value.trim();
  if (!q || SQ.controller) return;
  const out = $('#side-answer');
  out.textContent = '';
  const ans = el('div', 'md');
  out.appendChild(ans);
  $('#side-status').textContent = 'Claude odpovídá…';
  $('#side-send').disabled = true;
  SQ.controller = new AbortController();
  let raw = '';
  try {
    const res = await api('/api/runs', { method: 'POST', signal: SQ.controller.signal,
      body: { account: S.account, project: S.project, mode: 'plan', prompt: q, resume: S.sessionId, model: S.model, effort: S.effort, side: true } });
    if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).error || m; } catch { } throw new Error(m); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
        if (ev.type === 'text_delta' && !ev.parent) { raw += ev.text || ''; renderMd(ans, raw, false); }
        else if (ev.type === 'text' && !ev.parent) { raw = raw && !raw.endsWith(ev.text) ? raw : ev.text; renderMd(ans, raw, true); }
        else if (ev.type === 'result' && ev.isError) throw new Error(ev.result || 'Chyba');
      }
    }
    $('#side-status').textContent = 'Hotovo. Do sezení se nic nezapsalo.';
  } catch (err) {
    $('#side-status').textContent = err.name === 'AbortError' ? 'Zrušeno.' : `Chyba: ${err.message}`;
  } finally { SQ.controller = null; $('#side-send').disabled = false; }
}
function setupSide() {
  $('#side-form').addEventListener('submit', askSide);
  $('#side-close').addEventListener('click', () => $('#sidedlg').close());
  $('#sidedlg').addEventListener('close', () => { if (SQ.controller) SQ.controller.abort(); });
  $('#side-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askSide(e); });
}

/* ---------- Export konverzace (Markdown) ---------- */
async function exportSession() {
  if (!S.sessionId) { showBanner('warn', [document.createTextNode('Není co exportovat – sezení je prázdné.')], []); return; }
  let items;
  try { items = await apiJson(`/api/sessions/${encodeURIComponent(S.sessionId)}?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`); }
  catch (e) { showError('Export se nepovedl', e.message); return; }
  const titleEl = document.querySelector(`#sessions button[data-id="${CSS.escape(S.sessionId)}"] .s-title`);
  const title = titleEl ? titleEl.textContent : 'Sezení';
  const proj = S.projects.find((p) => p.id === S.project);
  const lines = [`# ${title}`, '', `Projekt: ${proj ? proj.label : S.project} · sezení ${S.sessionId} · export ${new Date().toLocaleString('cs-CZ')}`, ''];
  let tools = [];
  const flush = () => { if (tools.length) { lines.push(`> Nástroje: ${tools.join(', ')}`, ''); tools = []; } };
  for (const it of items) {
    if (it.role === 'tool') { tools.push(it.name); continue; }
    flush();
    const text = it.role === 'assistant' ? Review.progressMarks(it.text).clean : it.text;
    lines.push(it.role === 'user' ? '## Vy' : '## Claude', '', text.trim(), '');
  }
  flush();
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
  const a = el('a');
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60).trim() || 'sezeni'}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  announce('Konverzace exportována.');
}

/* ---------- Sezení otevřená jinde (terminál, pozadí) ---------- */
const ELSE = { ids: new Set(), at: 0 };
async function loadElsewhere() {
  try {
    const list = await apiJson(`/api/sessions/active?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`);
    ELSE.ids = new Set(list.map((s) => s.sessionId));
    ELSE.kind = Object.fromEntries(list.map((s) => [s.sessionId, s.kind === 'background' ? 'běží na pozadí' : 'otevřené v terminálu']));
    for (const b of document.querySelectorAll('#sessions button[data-id]')) {
      const meta = b.querySelector('.s-meta');
      if (!meta) continue;
      meta.textContent = meta.textContent.replace(/ • (otevřené v terminálu|běží na pozadí)/, '')
        + (ELSE.ids.has(b.dataset.id) ? ` • ${ELSE.kind[b.dataset.id]}` : '');
    }
  } catch { /* bez údajů */ }
}

/* ---------- Připomínky k plánu ---------- */
function planComments(box, markdown) {
  if (box.querySelector('.plan-review')) { box.querySelector('.plan-review').remove(); return; }
  const wrap = el('div', 'plan-review');
  wrap.appendChild(el('p', 'hint', 'Klikněte na řádek plánu (nebo Enter) a napište připomínku. „Poslat připomínky“ je pošle Claudovi – plán upraví a nic nezmění.'));
  const lines = String(markdown || '').split('\n').map((l, i) => ({ text: l, n: i + 1 })).filter((l) => l.text.trim());
  const notes = new Map();
  const d = el('div', 'diff diff--review');
  for (const l of lines) {
    const row = el('div', 'ctx diff-line', l.text);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Řádek plánu ${l.n}: ${l.text.trim()}`);
    const open = () => {
      d.querySelectorAll('.diff-form').forEach((f) => f.remove());
      const form = el('div', 'diff-form');
      const ta = el('textarea');
      ta.rows = 2;
      ta.value = notes.get(l.n) || '';
      ta.setAttribute('aria-label', `Připomínka k řádku ${l.n}`);
      const save = () => {
        const v = ta.value.trim();
        if (v) notes.set(l.n, v); else notes.delete(l.n);
        row.classList.toggle('has-comment', !!v);
        row.title = v;
        form.remove();
        count.textContent = `${notes.size} ${plural(notes.size, 'připomínka', 'připomínky', 'připomínek')}`;
        sendBtn.disabled = !notes.size;
        row.focus();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); form.remove(); row.focus(); }
      });
      const acts = el('div', 'diff-form-actions');
      acts.append(button('Uložit', 'btn-accent btn-small', save), button('Zrušit', 'btn-ghost btn-small', () => { form.remove(); row.focus(); }));
      form.append(ta, acts);
      row.after(form);
      ta.focus();
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    d.appendChild(row);
  }
  wrap.appendChild(d);
  const bar = el('div', 'plan-actions');
  const count = el('span', 'hint', '0 připomínek');
  const sendBtn = button('Poslat připomínky', 'btn-accent btn-small', () => {
    if (S.run || !notes.size) return;
    const items = [...notes.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, note], i) => `${i + 1}. K řádku „${lines.find((l) => l.n === n).text.trim().slice(0, 160)}“:\n   ${note.replace(/\n/g, '\n   ')}`);
    wrap.remove();
    setMode('plan');
    startRun(`Připomínky k plánu – uprav ho podle nich a znovu ho předlož ke schválení:\n\n${items.join('\n')}`, 'plan');
  });
  sendBtn.disabled = true;
  bar.append(sendBtn, count);
  wrap.appendChild(bar);
  box.appendChild(wrap);
  d.querySelector('.diff-line')?.focus();
}

/* ---------- Pole pro psaní roste s textem, kurzor zůstává vidět ---------- */
function autoGrow() {
  const ta = $('#prompt');
  if (!ta) return;
  const max = Math.round(window.innerHeight * 0.4);
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 4, max)}px`;
  ta.style.overflowY = ta.scrollHeight + 4 > max ? 'auto' : 'hidden';
  // Kurzor na konci (typicky po Enteru) → posunout dolů, ať je nový řádek vidět.
  if (ta.selectionEnd >= ta.value.length - 1) ta.scrollTop = ta.scrollHeight;
}

/* ---------- Chat se drží dole, jen když jste dole ---------- */
const STICK = { on: true };
function setupStick() {
  const c = chat();
  c.addEventListener('scroll', () => {
    STICK.on = c.scrollHeight - c.scrollTop - c.clientHeight < 48;
    $('#to-bottom').hidden = STICK.on;
  }, { passive: true });
  $('#to-bottom').addEventListener('click', () => { scrollDown(true); $('#prompt').focus({ preventScroll: true }); });
}

/* ---------- Otázka bokem: rozepsaný text se přesune do otázky (a zpět, když ji neodešlete) ---------- */
const SIDE = { moved: '' };
function openSideWithDraft() {
  const ta = $('#prompt'), side = $('#side-input');
  if (ta.value.trim() && !side.value.trim()) {
    SIDE.moved = ta.value;
    side.value = ta.value;
    ta.value = '';
    autoGrow();
    saveDraft();
  }
  openSide();
  if (SIDE.moved) $('#side-status').textContent = 'Rozepsanou zprávu jsem přesunul sem. Když otázku neodešlete, vrátí se po zavření zpět.';
}
function sideClosed() {
  const ta = $('#prompt'), side = $('#side-input');
  if (SIDE.moved && side.value.trim() && !ta.value.trim()) { ta.value = side.value; side.value = ''; autoGrow(); saveDraft(); }
  SIDE.moved = '';
}
function sideToMessage() {
  const ta = $('#prompt'), side = $('#side-input');
  const t = side.value.trim();
  if (!t) return;
  ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${t}` : t;
  side.value = '';
  SIDE.moved = '';
  $('#sidedlg').close();
  autoGrow();
  saveDraft();
  ta.focus();
}

/* ---------- Nabídka / : příkazy a skilly ze serveru, když je okno ještě nezná ---------- */
const CMDLOAD = { key: '', p: null };
function ensureCommands() {
  const key = `${S.account}|${S.project}`;
  if (CMDLOAD.key === key && CMDLOAD.p) return CMDLOAD.p;
  CMDLOAD.key = key;
  CMDLOAD.p = apiJson(`/api/commands?account=${encodeURIComponent(S.account)}&project=${encodeURIComponent(S.project)}`)
    .then((r) => {
      if (`${S.account}|${S.project}` !== key) return false;
      rememberCommandInfo(r);
      if (!commandEntries().length && r.commands.length)
        store(CMDS_KEY(S.account, S.project), JSON.stringify({ commands: r.commands.map((c) => c.name), skills: [] }));
      return true;
    })
    .catch(() => { CMDLOAD.p = null; return false; });
  return CMDLOAD.p;
}

/* ---------- Soubory projektu jako strom složek ---------- */
const FILES_VIEW_KEY = 'acd.files.view';
const filesTree = () => load(FILES_VIEW_KEY) === 'tree';
F.open = new Set();
function buildTree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!n.dirs.has(parts[i])) n.dirs.set(parts[i], { dirs: new Map(), files: [], path: parts.slice(0, i + 1).join('/') });
      n = n.dirs.get(parts[i]);
    }
    n.files.push(p);
  }
  return root;
}
function renderTree(nav, paths, expandAll) {
  const tree = buildTree(paths);
  let shown = 0;
  const walk = (node, depth, parent) => {
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, d] of dirs) {
      if (shown > FILES_SHOWN * 2) return;
      const open = expandAll || F.open.has(d.path);
      const b = el('button', 'git-file files-dir');
      b.type = 'button';
      b.style.paddingLeft = `${0.5 + depth * 1.1}em`;
      b.setAttribute('aria-expanded', String(open));
      b.setAttribute('aria-label', `Složka ${d.path}`);
      b.append(el('span', 'files-caret', open ? '▾' : '▸'), el('span', 'git-path', `${name}/`));
      b.addEventListener('click', () => { if (F.open.has(d.path)) F.open.delete(d.path); else F.open.add(d.path); renderFiles(); focusFileButton(`Složka ${d.path}`); });
      parent.appendChild(b);
      shown++;
      if (open) walk(d, depth + 1, parent);
    }
    for (const p of node.files.sort((a, b) => a.localeCompare(b))) {
      if (shown > FILES_SHOWN * 2) return;
      const b = el('button', 'git-file');
      b.type = 'button';
      b.style.paddingLeft = `${0.5 + depth * 1.1 + 1}em`;
      b.appendChild(el('span', 'git-path', p.slice(p.lastIndexOf('/') + 1)));
      b.setAttribute('aria-label', p);
      if (p === F.sel) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => showFile(b, p));
      parent.appendChild(b);
      shown++;
    }
  };
  walk(tree, 0, nav);
  if (shown > FILES_SHOWN * 2) nav.appendChild(el('p', 'git-note', 'Seznam je zkrácený – zpřesněte hledání.'));
}
function focusFileButton(label) {
  const b = [...$('#files-list').querySelectorAll('.git-file')].find((x) => x.getAttribute('aria-label') === label);
  if (b) b.focus();
}
function setFilesView(tree) {
  store(FILES_VIEW_KEY, tree ? 'tree' : 'list');
  for (const i of document.querySelectorAll('input[name="files-view"]')) i.checked = (i.value === 'tree') === tree;
  renderFiles();
}

/* ---------- Nastavení: účty a výchozí projekt ---------- */
async function setDefaultProject(p) {
  try {
    const view = await apiJson(`/api/settings/default-project/${encodeURIComponent(p.id)}`, { method: 'PUT' });
    renderSettingsProjects(view);
    setMsg(`Výchozí projekt: „${p.label}“ – otevře se při příštím spuštění.`);
  } catch (e) { setMsg(e.message, 'err'); }
}
function loginCommand(dir) {
  return navigator.userAgent.includes('Windows') ? `$env:CLAUDE_CONFIG_DIR = "${dir}"; claude` : `CLAUDE_CONFIG_DIR="${dir}" claude`;
}
function renderSettingsAccountsFull(view) {
  const ul = $('#set-accounts');
  ul.textContent = '';
  for (const a of view.accounts) {
    const st = accountById(a.id) || {};
    const li = el('li', 'set-item set-item--wrap');
    const sw = el('i', 'swatch'); sw.style.background = a.accent; li.appendChild(sw);
    const main = el('div', 'set-item-main');
    main.appendChild(el('span', 'set-item-label', a.label + (a.id === view.defaultAccount ? ' (výchozí)' : '')));
    main.appendChild(el('span', 'set-item-path', `${a.expectedEmail} · ${a.configDir}`));
    if (!st.ok && st.error) main.appendChild(el('span', 'set-item-path set-item-err', st.error));
    li.appendChild(main);
    li.appendChild(el('span', st.ok ? 'set-badge' : 'set-badge set-badge--bad', st.ok ? 'ověřen' : st.error === 'Ověřuji…' ? 'ověřuji' : 'nepřihlášen'));
    if (!st.ok) {
      const cmd = loginCommand(a.configDir);
      const copy = button('Příkaz pro přihlášení', 'btn-ghost btn-small', () => copyText(cmd, copy, 'Příkaz je ve schránce – vložte ho do terminálu a napište /login.'));
      copy.title = cmd;
      li.appendChild(copy);
    }
    const rm = button('Odebrat', 'btn-danger btn-small', async () => {
      if (!confirm(`Odebrat účet „${a.label}“ z aplikace?\n\nPřihlášení ani sezení se nesmažou, účet jen zmizí ze seznamu.`)) return;
      await changeAccount('DELETE', a.id, undefined, `Účet „${a.label}“ odebrán.`);
    });
    rm.disabled = view.accounts.length <= 1 || (!!S.run && S.run.account === a.id);
    li.appendChild(rm);
    ul.appendChild(li);
  }
}
async function changeAccount(method, id, body, okText) {
  const m = $('#set-accounts-msg');
  try {
    const view = await apiJson(id ? `/api/settings/accounts/${encodeURIComponent(id)}` : '/api/settings/accounts', { method, body });
    m.dataset.kind = ''; m.textContent = okText;
    await loadState();
    if (!S.accounts.some((a) => a.id === S.account)) await switchAccount(S.accounts[0].id);
    renderSettingsAccountsFull(view);
    // Ověření běží na pozadí – chvíli obnovovat stav.
    for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 2500)); await loadState(); if ($('#settings').open) renderSettingsAccountsFull(await apiJson('/api/settings')); }
    return view;
  } catch (e) { m.dataset.kind = 'err'; m.textContent = e.message; return null; }
}
async function addAccountSubmit(e) {
  e.preventDefault();
  const label = $('#acc-label').value.trim(), email = $('#acc-email').value.trim(), dir = $('#acc-dir').value.trim();
  if (!label || !email || !dir) return;
  const view = await changeAccount('POST', '', { label, expectedEmail: email, configDir: dir, accent: $('#acc-color').value },
    `Účet „${label}“ přidán. Pokud v té složce ještě nejste přihlášený, zkopírujte příkaz pro přihlášení a v terminálu napište /login.`);
  if (view) { $('#acc-label').value = ''; $('#acc-email').value = ''; $('#acc-dir').value = ''; }
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
  $('#prompt').addEventListener('input', autoGrow);
  $('#prompt').addEventListener('keyup', (e) => { if (e.key === 'Enter') autoGrow(); });
  window.addEventListener('resize', autoGrow);
  $('#prompt').addEventListener('input', () => { clearTimeout(DR.timer); DR.timer = setTimeout(saveDraft, 400); });
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
  setupProgress();
  setupContext();
  setupSide();
  $('#side-open').addEventListener('click', openSideWithDraft);
  $('#side-to-message').addEventListener('click', sideToMessage);
  $('#sidedlg').addEventListener('close', sideClosed);
  setupStick();
  autoGrow();
  $('#fork-cancel').addEventListener('click', () => { S.forkNext = false; renderForkNote(); $('#prompt').focus(); });
  $('#chrome-toggle').addEventListener('change', (e) => setChrome(e.target.checked));
  $('#overview-export').addEventListener('click', exportSession);
  setupHistory();
  setupSessionSearch();
  $('#new-session').addEventListener('click', newSession);
  $('#project').addEventListener('change', (e) => switchProject(e.target.value));
  document.querySelectorAll('input[name="mode"]').forEach((i) => i.addEventListener('change', () => { S.mode = i.value; liveMode(i.value); }));
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
  setInterval(() => { if (!S.run && !document.hidden) loadElsewhere(); }, 30000);
  $('#prompt').focus();
}

document.addEventListener('DOMContentLoaded', main);
