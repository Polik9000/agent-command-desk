// @ts-check
// Agent Command Desk – lokální server nad Claude Code. Jen vestavěné moduly Node, jen 127.0.0.1.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configPath, findAccount, findProject } from './lib/config.mjs';
import { createSecret, setSecurityHeaders, checkRequest } from './lib/guard.mjs';
import { AccountGuard, ClaudeRunner, MODES } from './lib/claude.mjs';
import { ev } from './lib/parser.mjs';
import { listSessions, history, transcriptPath } from './lib/sessions.mjs';
import { gitStatus } from './lib/git.mjs';
import { AttachmentStore, attachmentsPrompt, MAX_PER_RUN as MAX_ATTACHMENTS } from './lib/attachments.mjs';
import { openWindow, createHeartbeat } from './lib/window.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WWWROOT = path.join(HERE, 'wwwroot');
/** Vlastní soubory uživatele (mimo Git) leží vedle configu: local/config.json, theme.css, favicon.svg. */
const CONFIG_FILE = configPath(REPO);
const LOCAL = path.dirname(CONFIG_FILE);
const MAX_BODY = 1024 * 1024;
const MAX_PROMPT = 100_000;

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

let cfg;
try { cfg = loadConfig(CONFIG_FILE); } catch (e) {
  console.error(e.message);
  process.exit(2);
}

// `node server.mjs --info [klíč]` → údaje pro spouštěcí skripty (JSON, nebo jedna hodnota) a konec.
const infoAt = process.argv.indexOf('--info');
if (infoAt >= 0) {
  const info = { id: cfg.app.id, name: cfg.app.name, stateDir: cfg.stateDirFull };
  const key = process.argv[infoAt + 1];
  console.log(key ? String(info[key] ?? '') : JSON.stringify(info));
  process.exit(0);
}

const stateDir = cfg.stateDirFull;
mkdirSync(stateDir, { recursive: true });

/* ---------- Jedna instance na uživatele (pid soubor) ---------- */
const pidFile = path.join(stateDir, 'server.pid');
function acquireSingleInstance() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidFile, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
      const other = Number(readFileSync(pidFile, 'utf8').trim());
      let alive = false;
      try { if (other) { process.kill(other, 0); alive = true; } } catch { /* neběží */ }
      if (alive) return false;
      try { unlinkSync(pidFile); } catch { /* souběh */ }
    }
  }
  return false;
}
if (!acquireSingleInstance()) {
  console.error(`${cfg.app.name} už běží.`);
  process.exit(3);
}

const secret = createSecret();
const heartbeat = createHeartbeat();
const accounts = new AccountGuard(cfg, log);
const runner = new ClaudeRunner(cfg, log);
const attachments = new AttachmentStore(stateDir, log);
attachments.cleanup();

/* ---------- Pomocné ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const problem = (res, status, error) => sendJson(res, status, { error });

function readJson(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(ct)) { reject(Object.assign(new Error('Očekávám application/json.'), { status: 415 })); return; }
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Požadavek je příliš velký.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Neplatný JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const publicAccount = (s) => ({ id: s.id, label: s.label, accent: s.accent, ok: s.ok, email: s.email, error: s.error });

/** Účet + projekt z query; účet musí být ověřený. */
async function resolveAccountProject(res, accountId, projectId) {
  const account = findAccount(cfg, accountId);
  const project = findProject(cfg, projectId);
  if (!account || !project) { problem(res, 400, 'Neznámý účet nebo projekt.'); return null; }
  const status = await accounts.getVerified(account);
  if (!status.ok || !status.projectsDirectory) { problem(res, 409, `Účet ${account.label} není ověřen: ${status.error}`); return null; }
  return { account, project, status };
}

/* ---------- Statické soubory ---------- */
/** Jediné soubory, které lze přepsat z local/ (nic jiného z local/ se nikdy neservíruje). */
const LOCAL_OVERRIDES = { '/theme.local.css': 'theme.css', '/favicon.svg': 'favicon.svg' };

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
  if (rel === '/') rel = '/index.html';
  if (Object.hasOwn(LOCAL_OVERRIDES, rel)) {
    const local = path.join(LOCAL, LOCAL_OVERRIDES[rel]);
    if (existsSync(local)) return sendFile(req, res, local, MIME[path.extname(local)]);
    if (rel === '/theme.local.css') { // vlastní téma je volitelné → prázdné CSS místo 404
      res.writeHead(200, { 'Content-Type': MIME['.css'], 'Content-Length': 0 });
      res.end();
      return;
    }
  }
  const file = path.resolve(WWWROOT, '.' + rel);
  const type = MIME[path.extname(file).toLowerCase()];
  if (!file.startsWith(WWWROOT + path.sep) || !type) { res.writeHead(404); res.end(); return; }
  return sendFile(req, res, file, type);
}

async function sendFile(req, res, file, type) {
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error();
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404); res.end();
  }
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  let m;

  if (req.method === 'GET' && p === '/api/ping') return sendJson(res, 200, { ok: true });

  if (req.method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, {
      app: { name: cfg.app.name },
      accounts: accounts.all().map(publicAccount),
      projects: cfg.projects.map((x) => ({ id: x.id, label: x.label, exists: existsSync(x.pathFull) })),
      defaultAccount: cfg.defaultAccount,
      defaultProject: findProject(cfg, cfg.defaultProject)?.id ?? cfg.projects[0].id,
      modes: MODES,
    });
  }

  if (req.method === 'GET' && p === '/api/accounts') return sendJson(res, 200, accounts.all().map(publicAccount));

  if (req.method === 'POST' && p === '/api/accounts/refresh') {
    await accounts.refreshAll();
    return sendJson(res, 200, accounts.all().map(publicAccount));
  }

  if (req.method === 'GET' && (m = /^\/api\/projects\/([^/]+)\/git$/.exec(p))) {
    const project = findProject(cfg, decodeURIComponent(m[1]));
    return project ? sendJson(res, 200, await gitStatus(cfg, project.pathFull)) : problem(res, 404, 'Neznámý projekt.');
  }

  if (req.method === 'GET' && p === '/api/sessions') {
    const r = await resolveAccountProject(res, q.get('account'), q.get('project'));
    if (!r) return;
    const list = listSessions(r.status.projectsDirectory, r.project.pathFull)
      .map((s) => ({ ...s, busy: runner.isSessionBusy(s.id) }));
    return sendJson(res, 200, list);
  }

  if (req.method === 'GET' && (m = /^\/api\/sessions\/([^/]+)$/.exec(p))) {
    const r = await resolveAccountProject(res, q.get('account'), q.get('project'));
    if (!r) return;
    const file = transcriptPath(r.status.projectsDirectory, r.project.pathFull, decodeURIComponent(m[1]));
    return file ? sendJson(res, 200, history(file)) : problem(res, 404, 'Sezení neexistuje.');
  }

  if (req.method === 'POST' && p === '/api/attachments') {
    const account = findAccount(cfg, q.get('account'));
    const project = findProject(cfg, q.get('project'));
    if (!account || !project) { req.resume(); return problem(res, 400, 'Neznámý účet nebo projekt.'); }
    try { return sendJson(res, 200, await attachments.save(req, account.id, project.id, q.get('name'))); }
    catch (e) { return problem(res, e.status ?? 500, e.status ? e.message : 'Uložení přílohy selhalo.'); }
  }

  if (req.method === 'DELETE' && (m = /^\/api\/attachments\/([0-9a-f]{32})$/.exec(p))) {
    const account = findAccount(cfg, q.get('account'));
    const project = findProject(cfg, q.get('project'));
    if (!account || !project) return problem(res, 400, 'Neznámý účet nebo projekt.');
    return sendJson(res, 200, { removed: attachments.remove(account.id, project.id, m[1]) });
  }

  if (req.method === 'POST' && p === '/api/runs') return startRun(req, res);

  if (req.method === 'POST' && (m = /^\/api\/runs\/([0-9a-f]+)\/stop$/.exec(p))) {
    const run = runner.find(m[1]);
    if (!run) return problem(res, 404, 'Běh neexistuje.');
    run.stop();
    return sendJson(res, 200, { stopped: true });
  }

  return problem(res, 404, 'Neznámá adresa.');
}

/** POST /api/runs → text/event-stream s normalizovanými událostmi. */
async function startRun(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return problem(res, e.status ?? 400, e.message); }
  if (!body || typeof body !== 'object') return problem(res, 400, 'Prázdný požadavek.');

  const account = findAccount(cfg, body.account);
  const project = findProject(cfg, body.project);
  if (!account) return problem(res, 400, 'Neznámý účet.');
  if (!project) return problem(res, 400, 'Neznámý projekt.');
  if (!MODES.includes(body.mode)) return problem(res, 400, 'Režim musí být auto nebo plan.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_PROMPT)
    return problem(res, 400, 'Prázdná nebo příliš dlouhá zpráva.');
  if (!existsSync(project.pathFull)) return problem(res, 400, 'Složka projektu neexistuje.');

  // Přílohy: jen id nahraná pro tento účet a projekt; cesty doplní server, Claude dostane jen jejich složku.
  const ids = body.attachments ?? [];
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) return problem(res, 400, `Nejvýš ${MAX_ATTACHMENTS} příloh.`);
  const files = [];
  for (const id of ids) {
    const f = attachments.resolve(account.id, project.id, id);
    if (!f) return problem(res, 400, 'Příloha neexistuje (nahrajte ji znovu).');
    files.push(f);
  }
  const prompt = body.prompt + attachmentsPrompt(files);
  const attachDir = attachments.dirFor(account.id, project.id);
  const addDirs = existsSync(attachDir) ? [attachDir] : []; // i v dalších zprávách sezení si může přílohu znovu přečíst

  const status = await accounts.getVerified(account);
  if (!status.ok || !status.projectsDirectory) return problem(res, 409, `Účet ${account.label} není ověřen: ${status.error}`);

  let resume = null;
  if (body.resume != null && body.resume !== '') {
    // Jen sezení existující v adresáři zvoleného účtu a projektu → nikdy cross-account.
    if (!transcriptPath(status.projectsDirectory, project.pathFull, body.resume))
      return problem(res, 404, 'Sezení v tomto účtu a projektu neexistuje.');
    if (runner.isSessionBusy(body.resume)) return problem(res, 409, 'Toto sezení právě běží.');
    resume = body.resume;
  }

  let run;
  try { run = runner.start(account, project, body.mode, prompt, resume, { addDirs }); }
  catch (e) { return problem(res, 409, e.message); }

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
  const send = (e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
  send(ev('run', { runId: run.id, account: account.id, project: project.id, mode: body.mode }));
  run.on('event', send);
  run.once('end', () => res.end());
  // Okno zavřeno / spojení přerušeno → běh nenecháme viset.
  res.on('close', () => { if (!run.ended) run.stop(); });
}

/* ---------- Server ---------- */
const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  const denied = checkRequest(req, secret);
  if (denied) {
    log(`Zamítnuto ${denied.status} (${denied.reason}) ${req.method} ${String(req.url).split('?')[0]}`);
    res.writeHead(denied.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(denied.status === 401 ? '401 Unauthorized' : '403 Forbidden');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      heartbeat.touch();
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    log(`Chyba ${req.method} ${url.pathname}: ${e?.message}`);
    if (!res.headersSent) problem(res, 500, 'Interní chyba.');
    else res.end();
  }
});

/** @type {{close: () => void} | null} */
let win = null;
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Končím (${reason}).`);
  runner.stopAll(); // žádný proces claude nezůstane běžet
  win?.close();
  try { unlinkSync(pidFile); } catch { /* už smazán */ }
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => { try { unlinkSync(pidFile); } catch { } });

server.listen(cfg.port, '127.0.0.1', () => {
  const addr = server.address();
  secret.port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${secret.port}/`;
  log(`${cfg.app.id} naslouchá na ${base}`);

  // Účty: hned a pak každých 10 minut.
  const refresh = () => accounts.refreshAll().catch((e) => log(`Kontrola účtů selhala: ${e.message}`));
  refresh();
  setInterval(refresh, 10 * 60_000).unref();

  if (cfg.openBrowser) {
    win = openWindow({ cfg, url: `${base}#t=${secret.token}`, heartbeat, hasActiveRuns: () => runner.hasActiveRuns, shutdown, log });
  } else if (process.stdout.isTTY) {
    console.log(`Otevřete: ${base}#t=${secret.token}`); // jen na interaktivní konzoli, nikdy do logu
  }
});
