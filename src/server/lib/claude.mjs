// @ts-check
// Spouštění claude (bez shellu, argumenty jako pole, prompt přes stdin), ověření účtů, běhy.
import { spawn, execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isUnder, samePath, norm } from './config.mjs';
import { checkClaudeExe, childSpawnOptions, killTree } from './platform.mjs';
import { StreamParser, ev } from './parser.mjs';
import {
  ORCH_MODES, MIN_AGENTS_FILE_VERSION, buildAgents, guidance, composePrompt, userAgentNames, versionAtLeast, parseVersion,
  writeAgentsFile, removeAgentsFile, clearAgentsDir,
} from './orchestration.mjs';
import { alwaysUpdates, ruleLabel, inputPreview, editPreview, questionsPreview, controlResponse, controlError, PERMISSION_TIMEOUT_MS } from './permissions.mjs';

export { killTree };
/** Režimy: Auto, Plán, Úpravy (acceptEdits – úpravy souborů bez ptaní, příkazy se ptají; schváleno 2026-11-27). */
export const MODES = ['auto', 'plan', 'acceptEdits'];
/** Režim „Ručně“: Claude Code se ptá na každý zápis a příkaz. Jen s interactivePermissions – jinak by se vše zamítlo. */
export const ASK_MODE = 'default';
/** Povolené režimy podle configu (nikdy bypassPermissions ani dontAsk). */
export const allowedModes = (cfg) => (cfg.interactivePermissions === true ? [...MODES, ASK_MODE] : [...MODES]);
/** Claude in Chrome: každá akce prohlížeče se musí schválit (pravidlo „ask“ pro celý MCP server). */
export const CHROME_SETTINGS = JSON.stringify({ permissions: { ask: ['mcp__claude-in-chrome'] } });
const CONTROL_TIMEOUT_MS = 15_000;
const INTERRUPT_KILL_MS = 8_000;
const MAX_PLAN_BYTES = 512 * 1024;
const ACCOUNT_MAX_AGE_MS = 10 * 60 * 1000;

/** Jeden řádek vstupu --input-format stream-json se zprávou uživatele. */
export const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

/**
 * Prostředí procesu běhu: seznam úkolů Claude Code (TaskCreate/TaskUpdate → panel Průběh, ověřeno na 2.1.332)
 * a kontrolní body souborů (návrat souborů k dřívější zprávě).
 */
export function runEnv(account) {
  return { ...claudeEnv(account), CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' };
}

/** Prostředí potomka: bez CLAUDE*, ANTHROPIC_*; CLAUDE_CONFIG_DIR z allowlistu. */
export function claudeEnv(account) {
  /** @type {Record<string,string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const u = k.toUpperCase();
    if (u.startsWith('CLAUDE') || u.startsWith('ANTHROPIC_') || v === undefined) continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = account.configDirFull;
  return env;
}

export function claudeExePath(cfg) {
  const err = checkClaudeExe(cfg.claudeExeFull);
  if (err) throw new Error(err);
  return cfg.claudeExeFull;
}

/**
 * Výchozí spuštění `claude auth status --json` (vrací e-mail a složky, žádné tokeny).
 * @returns {Promise<{stdout: string, timedOut: boolean}>}
 */
function runAuthStatus(cfg, account) {
  return new Promise((resolve) => {
    execFile(claudeExePath(cfg), ['auth', 'status', '--json'],
      { cwd: account.configDirFull, env: claudeEnv(account), windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve({ stdout: String(stdout ?? ''), timedOut: !!err?.killed }));
  });
}

/* ---------------- Sezení běžící jinde ---------------- */
const activeCache = new Map();
/**
 * `claude agents --json` účtu: sezení běžící v terminálu nebo na pozadí (bez dotazu na model). Cache 15 s.
 * @returns {Promise<Array<{sessionId:string, cwd:string, kind:string, status:string, name:string}>>}
 */
export function activeSessions(cfg, account) {
  const c = activeCache.get(account.id);
  if (c && Date.now() - c.at < 15_000) return c.p;
  const p = new Promise((resolve) => {
    let exe;
    try { exe = claudeExePath(cfg); } catch { resolve([]); return; }
    execFile(exe, ['agents', '--json'], { cwd: account.configDirFull, env: claudeEnv(account), windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        let list = [];
        try { list = JSON.parse(String(stdout || '[]')); } catch { /* starší verze */ }
        const s = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
        resolve((Array.isArray(list) ? list : []).filter((x) => x && typeof x.sessionId === 'string').slice(0, 50)
          .map((x) => ({ sessionId: x.sessionId, cwd: s(x.cwd), kind: s(x.kind), status: s(x.status), name: s(x.name) })));
      });
  });
  activeCache.set(account.id, { at: Date.now(), p });
  return p;
}

/* ---------------- Ověření účtů ---------------- */

export class AccountGuard {
  /**
   * @param {import('./config.mjs').Config} cfg @param {(m:string)=>void} log
   * @param {(cfg:any, account:any) => Promise<{stdout:string, timedOut:boolean}>} [authStatus] jen pro testy
   */
  constructor(cfg, log, authStatus = runAuthStatus) {
    this.cfg = cfg;
    this.log = log;
    this.authStatus = authStatus;
    /** @type {Map<string, any>} */
    this.cache = new Map();
    /** @type {Promise<any>} */
    this.queue = Promise.resolve();
  }

  all() {
    return this.cfg.accounts.map((a) => this.cache.get(a.id) ??
      { id: a.id, label: a.label, accent: a.accent, ok: false, email: null, error: 'Ověřuji…', projectsDirectory: null, checkedAt: 0 });
  }

  async refreshAll() {
    for (const a of this.cfg.accounts) await this.check(a);
  }

  /** Ověřený stav (z cache, pokud je čerstvá). */
  async getVerified(a) {
    const s = this.cache.get(a.id);
    if (s && s.ok && Date.now() - s.checkedAt < ACCOUNT_MAX_AGE_MS) return s;
    return this.check(a);
  }

  /** Kontroly běží za sebou (žádné souběžné `auth status`). */
  /** Odebraný účet: zapomenout výsledek ověření. */
  forget(id) { this.cache.delete(id); }

  check(a) {
    const p = this.queue.then(() => this.#runCheck(a));
    this.queue = p.catch(() => {});
    return p.then((s) => {
      this.cache.set(a.id, s);
      if (!s.ok) this.log(`Účet ${a.id} neověřen: ${s.error}`);
      return s;
    });
  }

  async #runCheck(a) {
    const base = { id: a.id, label: a.label, accent: a.accent };
    const fail = (error, email = null) => ({ ...base, ok: false, email, error, projectsDirectory: null, checkedAt: Date.now() });
    if (!existsSync(a.configDirFull)) return fail('Složka účtu neexistuje.');
    const exeErr = checkClaudeExe(this.cfg.claudeExeFull);
    if (exeErr) return fail(exeErr);

    let out;
    try { out = await this.authStatus(this.cfg, a); } catch (e) { return fail(`Kontrola účtu selhala: ${e.message}`); }
    let r;
    try { r = JSON.parse(out.stdout); } catch { r = null; }
    if (!r || typeof r !== 'object')
      return fail(out.timedOut ? 'Kontrola účtu vypršela.' : 'Neočekávaný výstup `claude auth status`.');
    const email = typeof r.email === 'string' ? r.email : null;
    if (r.loggedIn !== true) return fail('Účet není přihlášen – spusťte claude s CLAUDE_CONFIG_DIR tohoto účtu a /login.');
    if (!email || email.toLowerCase() !== a.expectedEmail.toLowerCase())
      return fail(`Přihlášen jiný účet (${email ?? '?'}), očekáván ${a.expectedEmail}.`, email);
    if (typeof r.configDirectory !== 'string' || !samePath(r.configDirectory, a.configDirFull))
      return fail('Claude hlásí jinou konfigurační složku.', email);
    if (typeof r.projectsDirectory !== 'string' || !isUnder(r.projectsDirectory, a.configDirFull))
      return fail('Složka sezení je mimo složku účtu.', email);
    return { ...base, ok: true, email, error: null, projectsDirectory: norm(r.projectsDirectory), checkedAt: Date.now() };
  }
}

/* ---------------- Běhy ---------------- */
//
// Běh = jeden tah (zpráva → odpověď), pro UI jeden SSE proud. Proces claude může přežít víc běhů téhož sezení:
// po `result` zůstane stdin otevřený a proces čeká (nanejvýš `sessionProcessMinutes`, nejvýš MAX_IDLE procesů).
// Další zpráva do stejného sezení se stejným účtem, projektem, režimem, modelem, effortem a složkami ho převezme
// (bez startu procesu a --resume). Jiné nastavení → čekající proces se zavře a spustí se nový s --resume.
// Bezpečnost: proces se k dalšímu použití odloží jen tehdy, když poslední init hlásil očekávaný režim a v tahu
// nebyl nástroj, který režim mění (ExitPlanMode/EnterPlanMode); u převzatého procesu se režim kontroluje znovu.

/** Z odpovědi `initialize`: příkazy a skilly s popisem, agenti – jen texty pro nabídku, nic dalšího (účet ne). */
export function commandsInfo(r) {
  const s = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const NAME = /^[A-Za-z0-9][\w:.-]{0,99}$/;
  const commands = (Array.isArray(r?.commands) ? r.commands : []).filter((c) => c && NAME.test(c.name)).slice(0, 300)
    .map((c) => ({ name: c.name, description: s(c.description, 240), argumentHint: s(c.argumentHint, 80) }));
  const agents = (Array.isArray(r?.agents) ? r.agents : []).slice(0, 100)
    .map((a) => (typeof a === 'string' ? { name: a, description: '' } : { name: s(a?.name ?? a?.agentType, 80), description: s(a?.description ?? a?.whenToUse, 240) }))
    .filter((a) => NAME.test(a.name));
  return { commands, agents };
}

const MAX_IDLE = 3;
const MODE_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode']);
const RETIRE_WAIT_MS = 5000;

export class ClaudeRunner {
  /**
   * @param {import('./config.mjs').Config} cfg @param {(m:string)=>void} log
   * @param {{spawnFn?: typeof spawn, idleMs?: number}} [opts] jen pro testy (falešný claude, krátký limit)
   */
  constructor(cfg, log, { spawnFn = spawn, idleMs } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.spawnFn = spawnFn;
    this.idleMsOverride = idleMs;
    /** @type {Map<string, any>} běhy (tahy) */
    this.runs = new Map();
    /** @type {Set<string>} */
    this.busySessions = new Set();
    /** @type {Map<string, any>} čekající procesy podle id sezení (pořadí = od nejstaršího) */
    this.idle = new Map();
    /** @type {Map<string, {at:number, c:any}>} příkazy a agenti podle účtu a projektu (z initialize) */
    this.commandsCache = new Map();
    /** @type {Promise<number[]|null>|null} verze Claude Code (kvůli --agents) */
    this.versionP = null;
    /** @type {Set<string>} soubory definic pracovníků živých procesů */
    this.agentFiles = new Set();
    if (cfg.stateDirFull) try { clearAgentsDir(cfg.stateDirFull); } catch { /* složka stavu ještě není */ }
  }

  /** Smaže soubory definic pracovníků (při ukončení aplikace; synchronně). */
  cleanupFiles() { for (const f of this.agentFiles) removeAgentsFile(f); this.agentFiles.clear(); }

  /** `claude --version` jednou za běh aplikace (neúspěch se zkusí příště znovu). */
  cliVersion() {
    if (this.versionP) return this.versionP;
    const p = new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = this.spawnFn(claudeExePath(this.cfg), ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], ...childSpawnOptions() });
      } catch { resolve(null); return; }
      const t = setTimeout(() => { killTree(child.pid); resolve(null); }, 15_000);
      t.unref?.();
      child.on('error', () => { clearTimeout(t); resolve(null); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out = (out + d).slice(0, 500); });
      child.on('close', () => { clearTimeout(t); resolve(parseVersion(out)); });
    });
    this.versionP = p.then((v) => { if (!v) this.versionP = null; return v; });
    return this.versionP;
  }

  /**
   * Orchestrace pro nový proces: co se předá a proč případně ne. Vypnuto = null (beze změny argumentů i událostí).
   * @returns {Promise<null | {mode:string, active:boolean, defs?:any, workers:any[], skipped:any[], warnings:string[], reason?:string}>}
   */
  async orchestrationFor(account, project, requested, { copy = false } = {}) {
    if (requested !== 'auto') return null;
    const o = this.cfg.orchestration ?? { workers: [], warnings: [] };
    const base = { mode: 'auto', workers: [], skipped: [], warnings: [...(o.warnings ?? [])] };
    if (copy) return { ...base, active: false, reason: 'Kopie sezení a otázka bokem běží bez orchestrace.' };
    const v = await this.cliVersion();
    if (!v) return { ...base, active: false, reason: 'Verzi Claude Code nejde zjistit – orchestrace vypnuta.' };
    if (!versionAtLeast(v, MIN_AGENTS_FILE_VERSION))
      return { ...base, active: false, reason: `Orchestrace vyžaduje Claude Code ${MIN_AGENTS_FILE_VERSION} nebo novější (nainstalováno ${v.join('.')}).` };
    const taken = userAgentNames([path.join(project.pathFull, '.claude', 'agents'), path.join(account.configDirFull, 'agents')]);
    const b = buildAgents(o.workers ?? [], { disallowedTools: this.cfg.disallowedTools ?? [], taken });
    if (!b.workers.length) return { ...base, skipped: b.skipped, active: false, reason: 'Žádný pracovník není k dispozici (konfigurace orchestration.workers).' };
    return { ...base, active: true, defs: b.defs, workers: b.workers, skipped: b.skipped };
  }

  get idleMs() { return this.idleMsOverride ?? (this.cfg.sessionProcessMinutes ?? 10) * 60_000; }
  get hasActiveRuns() { return this.runs.size > 0; }
  isSessionBusy(id) { return this.busySessions.has(id); }
  /** Sezení, která drží procesy této aplikace (běžící i čekající) – v `claude agents` se nemají hlásit jako „jinde“. */
  ownSessionIds() { return [...this.busySessions, ...this.idle.keys()]; }
  find(id) { return this.runs.get(id); }
  /** Běží v projektu nějaký claude? (takový projekt nejde odebrat v Nastavení) */
  isProjectBusy(projectId) { for (const r of this.runs.values()) if (r.projectId === projectId) return true; return false; }
  isAccountBusy(accountId) { for (const r of this.runs.values()) if (r.accountId === accountId) return true; return false; }
  /** Zavře čekající procesy účtu (po odebrání účtu z Nastavení). */
  closeAccount(accountId) { for (const p of [...this.idle.values()]) if (p.accountId === accountId) this.#retire(p); }
  /** Příkazy, skilly a agenti pro nabídku `/` – z cache (10 min), jinak krátký proces bez dotazu na model. */
  async commandsFor(account, project) {
    const key = `${account.id}|${project.id}`;
    const c = this.commandsCache.get(key);
    if (c && Date.now() - c.at < 10 * 60_000) return c.c;
    const r = await this.#withTempProcess(account, project, null, (proc) => this.#control(proc, 'initialize'));
    const info = commandsInfo(r);
    this.commandsCache.set(key, { at: Date.now(), c: info });
    return info;
  }
  /** Zavře čekající procesy projektu (po odebrání projektu z Nastavení). */
  closeProject(projectId) { for (const p of [...this.idle.values()]) if (p.projectId === projectId) this.#retire(p); }
  stopAll() {
    for (const r of this.runs.values()) r.stop();
    for (const p of [...this.idle.values()]) { this.#unpark(p); killTree(p.child.pid); }
  }

  /**
   * Spustí tah; události emituje jako 'event', na konci 'end'.
   * @param {import('./config.mjs').Account} account @param {import('./config.mjs').Project} project
   * @param {string} mode @param {string} prompt @param {string|null} resume
   * @param {{addDirs?: string[], model?: string, effort?: string, fork?: boolean, side?: boolean, chrome?: boolean, orchestration?: string}} [opts]
   *   addDirs = další složky (přílohy); model/effort už ověřené proti allowlistu (server.mjs);
   *   fork = pokračovat v kopii sezení (--fork-session); side = otázka bokem (kopie bez uložení, jen čtení);
   *   chrome = Claude in Chrome (každá akce prohlížeče se schvaluje);
   *   orchestration = 'off' | 'auto' (pracovníci přes --agents; změna = nový proces, jako effort)
   */
  async start(account, project, mode, prompt, resume, { addDirs = [], model = '', effort = '', fork = false, side = false, chrome = false, orchestration = 'off' } = {}) {
    if (!allowedModes(this.cfg).includes(mode)) throw new Error('Neplatný režim.');
    if (!ORCH_MODES.includes(orchestration)) throw new Error('Neplatný režim orchestrace.');
    const copy = !!resume && (fork || side); // kopie původní sezení neblokuje ani nemění
    if (resume && !copy && this.busySessions.has(resume)) throw new Error('Toto sezení už běží.');
    if (resume && !copy) this.busySessions.add(resume); // hned, ať nikdo jiný sezení nepřevezme během čekání níže
    // Režim a model jde převzatému procesu změnit řídicím příkazem (jako Shift+Tab a /model); ostatní = nový proces.
    let sig = JSON.stringify([account.id, project.id, effort, addDirs, chrome === true]);
    let proc = resume && !copy ? this.idle.get(resume) : undefined;
    /** @type {any} */
    let orch = null;
    try {
      orch = await this.orchestrationFor(account, project, orchestration, { copy: copy || side });
      if (orch?.active) sig = JSON.stringify([account.id, project.id, effort, addDirs, chrome === true, 'auto']);
      if (proc && (proc.sig !== sig || proc.exited || (proc.model && !model))) { await this.#retire(proc); proc = undefined; }
      if (proc) {
        this.#unpark(proc);
        try {
          if (proc.mode !== mode) { await this.#control(proc, 'set_permission_mode', { mode }); proc.mode = mode; }
          if (proc.model !== model) { await this.#control(proc, 'set_model', { model }); proc.model = model; }
        } catch (e) {
          this.log(`Proces ${proc.id}: změna režimu/modelu selhala (${e.message}) – nový proces`);
          await this.#retire(proc);
          proc = undefined;
        }
      }
      if (!proc) proc = this.#spawn(account, project, mode, resume, { addDirs, model, effort, fork: copy, side, chrome: chrome === true, orch }, sig);
    } catch (e) {
      if (resume && !copy) this.busySessions.delete(resume);
      throw e;
    }
    const warm = proc.turns > 0;
    const run = this.#newRun(proc, account, project, copy ? null : resume, warm);
    if (orch) {
      // Pro UI: je orchestrace aktivní, kdo jsou pracovníci (a jaký model), proč případně ne. Definice ne.
      run.emit('event', ev('orchestration', { mode: 'auto', active: orch.active, workers: orch.workers, skipped: orch.skipped,
        reason: orch.reason, warnings: orch.warnings.length ? orch.warnings : undefined }));
    }
    this.log(`Běh ${run.id} spuštěn: účet ${account.id}, projekt ${project.id}, režim ${mode}, resume ${!!resume}`
      + `, model ${model || 'výchozí'}, effort ${effort || 'výchozí'}${warm ? `, proces ${proc.id} převzat` : ''}`);
    proc.turns++;
    try { proc.child.stdin.write(userLine(prompt), 'utf8'); } catch { /* proces skončil – ohlásí 'close' */ }
    return run;
  }

  #spawn(account, project, mode, resume, { addDirs, model, effort, fork, side, chrome, orch }, sig) {
    const id = randomUUID().slice(0, 8);
    // Vstup jako stream-json: stdin zůstává otevřený, takže lze poslat další zprávu do běžícího tahu
    // (Claude ji převezme na nejbližším předělu; --replay-user-messages to potvrdí) i další tah do stejného procesu.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', '--permission-mode', mode];
    // Výchozí: na co by se Claude Code zeptal, to se samo zamítne. Volitelně se ptá uživatele v okně (docs/security.md).
    if (this.cfg.interactivePermissions === true) args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'stdio');
    else args.push('--permission-prompts', 'none');
    if (resume) args.push('--resume', resume);
    if (resume && fork) args.push('--fork-session');
    if (side) args.push('--no-session-persistence');
    // Orchestrace: definice pracovníků v souboru aplikace (žije s procesem) a pokyny za appendSystemPrompt.
    let agentsFile = null;
    if (orch?.active) {
      agentsFile = writeAgentsFile(this.cfg.stateDirFull, id, orch.defs);
      this.agentFiles.add(agentsFile);
      args.push('--agents', agentsFile);
    }
    const append = orch?.active ? composePrompt(this.cfg.appendSystemPrompt, guidance(orch.workers)) : this.cfg.appendSystemPrompt;
    if (append) args.push('--append-system-prompt', append);
    args.push('--forward-subagent-text'); // co píší agenti → karta agenta
    if (chrome) args.push('--chrome', '--settings', CHROME_SETTINGS);
    if (this.cfg.disallowedTools.length) args.push('--disallowedTools', ...this.cfg.disallowedTools);
    for (const d of addDirs) args.push('--add-dir', d);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    const dropFile = () => { if (agentsFile) { removeAgentsFile(agentsFile); this.agentFiles.delete(agentsFile); } };
    let child;
    try {
      child = this.spawnFn(claudeExePath(this.cfg), args, {
        cwd: project.pathFull, env: runEnv(account), shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...childSpawnOptions(),
      });
    } catch (e) { dropFile(); throw e; }
    let closedResolve;
    const proc = {
      id, child, sig, orchestration: orch?.active ? 'auto' : 'off', agentsFile, mode, model, accountId: account.id, projectId: project.id, side: !!side,
      sessionId: fork || side ? null : resume ?? null, run: /** @type {any} */ (null), turns: 0, exited: false, stdinOpen: true,
      /** @type {Map<string, {resolve:Function, reject:Function, t:any}>} řídicí požadavky čekající na odpověď */
      pending: new Map(),
      lastMode: /** @type {string|undefined} */ (undefined), turnTools: new Set(), idleTimer: /** @type {any} */ (null),
      parser: new StreamParser(path.join(account.configDirFull, 'plans')), stderr: '', spawnError: /** @type {any} */ (null),
      closed: new Promise((r) => { closedResolve = r; }),
      endInput() {
        if (!proc.stdinOpen) return;
        proc.stdinOpen = false;
        try { child.stdin.end(); } catch { /* už zavřeno */ }
      },
    };
    this.#pump(proc, /** @type {any} */ (closedResolve));
    proc.closed.then(dropFile); // konec procesu (retire, chyba, kill, limit čekání) → soubor definic pryč
    // Seznam příkazů a skillů s popisy, agenti (jako nabídka / v terminálu) → událost pro paletu.
    // Odpověď se zpracuje hned při čtení řádku (onData), ne až v .then(): readline vydá celý blok stdout
    // synchronně, takže by jinak `result` téhož bloku tah ukončil dřív a commands by dostal až další tah (issue #2).
    this.#control(proc, 'initialize', {}, CONTROL_TIMEOUT_MS, (r) => {
      const c = commandsInfo(r);
      this.commandsCache.set(`${account.id}|${project.id}`, { at: Date.now(), c });
      if (proc.run && !proc.run.ended) proc.run.emit('event', ev('commands', c));
      else proc.commandsInfo = c;
    }).catch(() => { /* starší Claude Code – nevadí */ });
    return proc;
  }

  /**
   * Řídicí požadavek na proces (stdin stream-json) → odpověď Claude Code.
   * @param {(data:any) => void} [onData] zavolá se synchronně při zpracování odpovědi (v pořadí proudu)
   * @returns {Promise<any>}
   */
  #control(proc, subtype, payload = {}, timeoutMs = CONTROL_TIMEOUT_MS, onData) {
    return new Promise((resolve, reject) => {
      if (proc.exited || !proc.stdinOpen) { reject(new Error('Proces Claude Code už neběží.')); return; }
      const id = `acd-${randomUUID()}`;
      const t = setTimeout(() => { proc.pending.delete(id); reject(new Error('Claude Code neodpověděl.')); }, timeoutMs);
      t.unref?.();
      proc.pending.set(id, { resolve, reject, t, onData });
      try { proc.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...payload } }) + '\n', 'utf8'); }
      catch (e) { clearTimeout(t); proc.pending.delete(id); reject(e); }
    });
  }

  /** Změna režimu běžícího tahu (jako Shift+Tab). */
  async setRunMode(run, mode) {
    if (!allowedModes(this.cfg).includes(mode)) throw Object.assign(new Error('Neplatný režim.'), { status: 400 });
    const proc = run.proc;
    if (run.ended || !proc) throw Object.assign(new Error('Běh už skončil.'), { status: 409 });
    await this.#control(proc, 'set_permission_mode', { mode });
    proc.mode = mode;
    this.log(`Běh ${run.id}: režim → ${mode}`);
  }

  /** Změna modelu běžícího tahu (jako /model); platí od dalšího kroku. */
  async setRunModel(run, model) {
    const proc = run.proc;
    if (run.ended || !proc) throw Object.assign(new Error('Běh už skončil.'), { status: 409 });
    if (!model) throw Object.assign(new Error('Za běhu jde přepnout jen na konkrétní model.'), { status: 400 });
    await this.#control(proc, 'set_model', { model });
    proc.model = model;
    this.log(`Běh ${run.id}: model → ${model}`);
  }

  /** Zastaví úlohu na pozadí (příkaz nebo agenta) běžícího tahu. */
  async stopTask(run, taskId) {
    if (run.ended || !run.proc) throw Object.assign(new Error('Běh už skončil.'), { status: 409 });
    await this.#control(run.proc, 'stop_task', { task_id: taskId });
  }

  /**
   * Řídicí požadavek na sezení: použije běžící nebo čekající proces; jinak spustí krátký proces s --resume
   * (bez zprávy pro model, tedy bez tokenů) a po odpovědi ho zavře.
   * @param {{exclusive?: boolean}} [o] exclusive = sezení nesmí běžet (návrat souborů, přejmenování)
   */
  async sessionControl(account, project, sessionId, subtype, payload = {}, { exclusive = false } = {}) {
    const running = [...this.runs.values()].find((r) => r.sessionId === sessionId && !r.ended && r.proc && !r.proc.side);
    if (running) {
      if (exclusive) throw Object.assign(new Error('Sezení právě běží – počkejte, až Claude doběhne.'), { status: 409 });
      return this.#control(running.proc, subtype, payload);
    }
    const idle = this.idle.get(sessionId);
    if (idle && !exclusive) return this.#control(idle, subtype, payload);
    if (idle) await this.#retire(idle);
    return this.#withTempProcess(account, project, sessionId, (proc) => this.#control(proc, subtype, payload));
  }

  /** Přejmenuje sezení v Claude Code (/rename – lokální příkaz bez dotazu na model). */
  async renameSession(account, project, sessionId, title) {
    if (this.busySessions.has(sessionId)) throw Object.assign(new Error('Sezení právě běží – přejmenujte ho po doběhnutí.'), { status: 409 });
    const idle = this.idle.get(sessionId);
    if (idle) await this.#retire(idle);
    return this.#withTempProcess(account, project, sessionId, (proc) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Claude Code neodpověděl.')), CONTROL_TIMEOUT_MS);
      proc.onLocal = (e) => {
        if (e.type === 'title') { clearTimeout(t); resolve({ title: e.title }); }
        else if (e.type === 'result') { clearTimeout(t); resolve({ title }); }
      };
      try { proc.child.stdin.write(userLine(`/rename ${title}`), 'utf8'); } catch (e) { clearTimeout(t); reject(e); }
    }));
  }

  async #withTempProcess(account, project, sessionId, fn) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan',
      '--permission-prompts', 'none', ...(sessionId ? ['--resume', sessionId] : ['--no-session-persistence'])];
    const child = this.spawnFn(claudeExePath(this.cfg), args, {
      cwd: project.pathFull, env: runEnv(account), shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...childSpawnOptions(),
    });
    let closedResolve;
    const proc = { id: `tmp-${randomUUID().slice(0, 6)}`, child, exited: false, stdinOpen: true, pending: new Map(), run: null,
      parser: new StreamParser(path.join(account.configDirFull, 'plans')), stderr: '', turnTools: new Set(), mode: 'plan',
      onLocal: /** @type {any} */ (null), closed: new Promise((r) => { closedResolve = r; }),
      endInput() { if (!proc.stdinOpen) return; proc.stdinOpen = false; try { child.stdin.end(); } catch { } } };
    this.#pump(proc, /** @type {any} */ (closedResolve));
    try { return await fn(proc); }
    finally {
      proc.endInput();
      const t = setTimeout(() => killTree(child.pid), RETIRE_WAIT_MS);
      proc.closed.then(() => clearTimeout(t));
    }
  }

  #newRun(proc, account, project, resume, warm) {
    const runner = this;
    const emitNow = EventEmitter.prototype.emit;
    const run = Object.assign(new EventEmitter(), {
      id: randomUUID().replaceAll('-', ''),
      accountId: account.id,
      projectId: project.id,
      sessionId: resume ?? null,
      warm,                 // převzatý čekající proces
      blocked: false,       // zastaven pojistkou režimu
      stopped: false,
      ended: false,
      acceptingInput: true, // dokud tah nepřijme výsledek
      injected: 0,          // zprávy poslané do běžícího tahu
      replayed: 0,          // potvrzení převzetí od claude (včetně úvodního promptu)
      closeTimer: /** @type {any} */ (null),
      proc,
      interrupted: false,
      /** Tvrdé zastavení: konec procesu. */
      stop() {
        if (run.ended) return;
        run.stopped = true;
        run.acceptingInput = false;
        proc.endInput();
        killTree(proc.child.pid);
      },
      /**
       * Přerušení jako Esc v terminálu: Claude přestane, proces i sezení zůstanou připravené na další zprávu.
       * Když Claude Code do chvíle neodpoví výsledkem, proces se ukončí.
       */
      interrupt() {
        if (run.ended) return;
        if (run.interrupted || proc.exited || !proc.stdinOpen) { run.stop(); return; }
        run.interrupted = true;
        run.stopped = true;
        for (const id of [...run.permissions.keys()]) run.answerPermission(id, 'deny');
        runner.#control(proc, 'interrupt').catch(() => run.stop());
        const t = setTimeout(() => { if (!run.ended) { run.interrupted = false; run.stop(); } }, INTERRUPT_KILL_MS);
        t.unref?.();
      },
      /** Pošle zprávu do běžícího tahu. @returns {boolean} false, pokud už běh vstup nepřijímá */
      inject(text) {
        if (!run.acceptingInput || run.ended || run.stopped || !proc.stdinOpen) return false;
        run.injected++;
        try { proc.child.stdin.write(userLine(text), 'utf8'); } catch { return false; }
        return true;
      },
      /** Nevyřízené žádosti o svolení: requestId → {input, suggestions, timer} */
      permissions: new Map(),
      /**
       * Odpověď uživatele na žádost o svolení. @param {string} requestId @param {'once'|'always'|'deny'|'timeout'} decision
       * @returns {boolean} false = žádost neexistuje (už vyřízená, nebo cizí)
       */
      answerPermission(requestId, decision, answers) {
        const p = run.permissions.get(requestId);
        if (!p || run.ended) return false;
        run.permissions.delete(requestId);
        clearTimeout(p.timer);
        // Otázka od Clauda (AskUserQuestion): odpověď jde jako upravený vstup nástroje s mapou otázka → odpověď.
        const input = decision === 'answer' ? { ...p.input, answers } : p.input;
        const d = decision === 'answer' ? 'once' : decision;
        try { proc.child.stdin.write(controlResponse(requestId, d, input, p.suggestions), 'utf8'); } catch { /* proces skončil */ }
        const always = decision === 'always' ? alwaysUpdates(p.suggestions).flatMap((u) => u.rules.map(ruleLabel)) : [];
        run.emit('event', ev('permission_resolved', { requestId, decision: decision === 'always' && !always.length ? 'once' : decision, rules: always }));
        return true;
      },
      /** Vstup otázky (kvůli ověření odpovědi). */
      permissionInput(requestId) { return run.permissions.get(requestId)?.input; },
      /**
       * Události 'event' a 'end' se drží ve frontě, dokud se nepřihlásí posluchač (issue #2): běh vrací start()
       * a volající (server, SSE) se přihlásí až potom. release() je přehraje ve stejném pořadí a pustí dál.
       * @type {Array<[string, any[]]>|null}
       */
      held: [],
      release() {
        const q = run.held;
        if (!q) return;
        run.held = null;
        for (const [name, a] of q) emitNow.call(run, name, ...a);
      },
    });
    run.emit = function (name, ...a) {
      if (run.held && (name === 'event' || name === 'end')) { run.held.push([name, a]); return true; }
      return emitNow.call(run, name, ...a);
    };
    // Bez výslovného release(): pustit po prvním posluchači 'event', až se synchronně přihlásí i ostatní.
    run.on('newListener', (name) => { if (name === 'event' && run.held) queueMicrotask(() => run.release()); });
    proc.run = run;
    if (proc.commandsInfo) { const c = proc.commandsInfo; proc.commandsInfo = null; run.emit('event', ev('commands', c)); }
    proc.turnTools.clear();
    runner.runs.set(run.id, run);
    return run;
  }

  /** Žádost o svolení → UI (bez surových návrhů); bez odpovědi do limitu se zamítne. */
  #askPermission(run, e) {
    if (run.stopped || run.ended) return;
    const timer = setTimeout(() => run.answerPermission(e.requestId, 'timeout'), PERMISSION_TIMEOUT_MS);
    timer.unref?.();
    run.permissions.set(e.requestId, { input: e.input, suggestions: e.suggestions, timer });
    const always = alwaysUpdates(e.suggestions).flatMap((u) => u.rules.map(ruleLabel));
    this.log(`Běh ${run.id}: žádost o svolení (${e.toolName})`);
    run.emit('event', ev('permission_request', { requestId: e.requestId, toolName: e.toolName, displayName: e.displayName,
      description: e.description, blockedPath: e.blockedPath, toolUseId: e.toolUseId, preview: inputPreview(e.toolName, e.input),
      edit: editPreview(e.toolName, e.input), questions: e.toolName === 'AskUserQuestion' ? questionsPreview(e.input) : undefined,
      alwaysRules: always, timeoutMs: PERMISSION_TIMEOUT_MS }));
  }

  #pump(proc, closedResolve) {
    const { child, parser } = proc;
    child.on('error', (e) => { proc.spawnError = e; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { proc.stderr = (proc.stderr + d).slice(-4000); });
    child.stdin.on('error', () => { /* proces skončil dřív, než přečetl stdin */ });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      for (const e of parser.parse(line)) {
        const run = proc.run;
        if (e.type === 'control_response') {
          const w = proc.pending.get(e.requestId);
          if (w) {
            proc.pending.delete(e.requestId);
            clearTimeout(w.t);
            if (!e.ok) { w.reject(new Error(e.error || 'Chyba Claude Code.')); continue; }
            try { w.onData?.(e.data ?? {}); } catch (err) { this.log(`Proces ${proc.id}: ${err.message}`); }
            w.resolve(e.data ?? {});
          }
          continue;
        }
        if (e.type === 'status' && e.permissionMode) proc.lastMode = e.permissionMode; // po změně režimu za běhu
        if (proc.onLocal) { proc.onLocal(e); continue; } // krátký proces (přejmenování)
        if (e.type === 'control_other') { try { child.stdin.write(controlError(e.requestId), 'utf8'); } catch { } continue; }
        if (run?.blocked) continue; // tah zastavený pojistkou režimu: nic dalšího z něj nepředat
        if (!run || run.ended) {
          // Mimo tah (čekající proces) nemá claude co posílat; žádost o svolení bez okna = zamítnout.
          if (e.type === 'control_permission') try { child.stdin.write(controlResponse(e.requestId, 'deny', e.input, []), 'utf8'); } catch { }
          continue;
        }
        if (e.type === 'init') {
          proc.lastMode = e.permissionMode;
          if (parser.sessionId) proc.sessionId ??= parser.sessionId;
          if (parser.sessionId && !run.sessionId) {
            run.sessionId = parser.sessionId;
            this.busySessions.add(parser.sessionId);
          }
          if (run.warm && e.permissionMode !== proc.mode) {
            // Pojistka: převzatý proces musí běžet v režimu, který uživatel zvolil.
            this.log(`Běh ${run.id}: převzatý proces hlásí režim ${e.permissionMode}, očekáván ${proc.mode} – zastavuji`);
            run.emit('event', ev('error', { message: 'Claude Code běžel v jiném režimu, než je zvolený – běh zastaven. Pošlete zprávu znovu.' }));
            run.blocked = true;
            run.stop();
            continue;
          }
        }
        if (e.type === 'tool_use' && e.name) proc.turnTools.add(e.name);
        if (e.type === 'control_permission') { this.#askPermission(run, e); continue; }
        if (e.type === 'user_replay') {
          run.replayed++;
          clearTimeout(run.closeTimer);
        }
        if (e.type === 'result' && run.interrupted) e.interrupted = true; // přerušení není chyba
        if (e.type === 'result' && typeof e.costUsd === 'number') {
          // Claude Code hlásí total_cost_usd jako součet za celý proces – pro statistiky jen tento tah.
          e.totalCostUsd = e.costUsd;
          e.costUsd = Math.max(0, e.costUsd - (proc.costSoFar ?? 0));
          proc.costSoFar = e.totalCostUsd;
        }
        if (e.type === 'result') {
          // subagent_stats je také součet za proces (ověřeno na 2.1.332) – ven jen pracovníci tohoto tahu.
          const prev = proc.subagentsSoFar ?? { spawned: 0, completed: 0, failed: 0 };
          const cur = e.subagents ?? prev;
          proc.subagentsSoFar = { spawned: cur.spawned, completed: cur.completed, failed: cur.failed };
          const d = { spawned: Math.max(0, cur.spawned - prev.spawned), completed: Math.max(0, cur.completed - prev.completed),
            failed: Math.max(0, cur.failed - prev.failed) };
          e.subagents = d.spawned ? d : undefined;
        }
        run.emit('event', e);
        if (e.type === 'result') {
          // Tah skončil. Čeká-li ještě vložená zpráva (nepřevzatá), claude ji vezme jako další tah téhož běhu;
          // jinak tah uzavřít. Pojistka: bez převzetí do 60 s proces zavřít.
          clearTimeout(run.closeTimer);
          if (run.injected <= run.replayed - 1) this.#finishTurn(proc, run, e);
          else run.closeTimer = setTimeout(() => this.#finishTurn(proc, run, null), 60_000);
        }
      }
    });

    const rlClosed = new Promise((r) => rl.once('close', r));
    const exited = new Promise((r) => child.once('close', (code) => r(code)));
    Promise.all([rlClosed, exited]).then(([, code]) => {
      proc.exited = true;
      proc.stdinOpen = false;
      for (const w of proc.pending.values()) { clearTimeout(w.t); w.reject(new Error('Proces Claude Code skončil.')); }
      proc.pending.clear();
      if (this.idle.get(proc.sessionId) === proc) this.#unpark(proc);
      const run = proc.run;
      if (!run || run.ended) { this.log(`Proces ${proc.id} skončil kódem ${code}`); return; }
      if (proc.spawnError) run.emit('event', ev('error', { message: `Běh selhal: ${proc.spawnError.message}` }));
      this.#emitPlans(proc, run);
      const exitCode = typeof code === 'number' ? code : -1;
      const err = proc.stderr.trim() && exitCode !== 0 && !run.stopped ? proc.stderr.trim() : undefined;
      run.emit('event', ev('exit', { code: exitCode, stopped: run.stopped, sessionId: run.sessionId, stderr: err }));
      this.log(`Běh ${run.id} skončil kódem ${exitCode}${run.stopped ? ' (zastaven)' : ''}`);
      this.#endRun(run);
    }).finally(() => closedResolve());
  }

  /** Konec tahu: proces buď odložit k dalšímu použití, nebo zavřít vstup (pak ohlásí konec 'close'). */
  #finishTurn(proc, run, result) {
    if (run.ended) return;
    run.acceptingInput = false;
    // Přerušený tah (interrupt) skončí chybovým výsledkem, ale proces je v pořádku – smí se odložit.
    const okResult = !!result && (!result.isError || run.interrupted);
    const reusable = this.idleMs > 0 && okResult && (!run.stopped || run.interrupted) && !proc.exited && proc.stdinOpen && !proc.side
      && !!proc.sessionId && proc.lastMode === proc.mode && ![...proc.turnTools].some((t) => MODE_TOOLS.has(t));
    if (!reusable) { proc.endInput(); return; }
    this.#emitPlans(proc, run);
    run.emit('event', ev('exit', { code: 0, stopped: run.interrupted, sessionId: run.sessionId, kept: true }));
    this.log(`Běh ${run.id} hotov, proces ${proc.id} čeká na další zprávu`);
    this.#endRun(run);
    proc.run = null;
    this.#park(proc);
  }

  #emitPlans(proc, run) {
    for (const file of proc.parser.planFiles) {
      try {
        if (statSync(file).size <= MAX_PLAN_BYTES) run.emit('event', ev('plan', { path: file, content: readFileSync(file, 'utf8') }));
      } catch { /* soubor plánu zmizel */ }
    }
    proc.parser.planFiles.clear();
  }

  #endRun(run) {
    clearTimeout(run.closeTimer);
    for (const p of run.permissions.values()) clearTimeout(p.timer);
    run.permissions.clear();
    run.acceptingInput = false;
    run.ended = true;
    this.runs.delete(run.id);
    if (run.sessionId) this.busySessions.delete(run.sessionId);
    run.emit('end');
  }

  #park(proc) {
    const old = this.idle.get(proc.sessionId);
    if (old && old !== proc) this.#retire(old);
    this.idle.set(proc.sessionId, proc);
    proc.idleTimer = setTimeout(() => this.#retire(proc), this.idleMs);
    proc.idleTimer.unref?.();
    while (this.idle.size > MAX_IDLE) this.#retire(this.idle.values().next().value);
  }

  #unpark(proc) {
    clearTimeout(proc.idleTimer);
    if (this.idle.get(proc.sessionId) === proc) this.idle.delete(proc.sessionId);
  }

  /** Zavře čekající proces (konec vstupu; když neskončí včas, zabít). */
  async #retire(proc) {
    this.#unpark(proc);
    proc.endInput();
    const t = setTimeout(() => killTree(proc.child.pid), RETIRE_WAIT_MS);
    await proc.closed;
    clearTimeout(t);
  }
}
