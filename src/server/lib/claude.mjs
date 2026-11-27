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
import { alwaysUpdates, ruleLabel, inputPreview, controlResponse, controlError, PERMISSION_TIMEOUT_MS } from './permissions.mjs';

export { killTree };
export const MODES = ['auto', 'plan'];
/** Režim „Ručně“: Claude Code se ptá na každý zápis a příkaz. Jen s interactivePermissions – jinak by se vše zamítlo. */
export const ASK_MODE = 'default';
/** Povolené režimy podle configu (nikdy bypassPermissions, acceptEdits ani dontAsk). */
export const allowedModes = (cfg) => (cfg.interactivePermissions === true ? [...MODES, ASK_MODE] : [...MODES]);
const MAX_PLAN_BYTES = 512 * 1024;
const ACCOUNT_MAX_AGE_MS = 10 * 60 * 1000;

/** Jeden řádek vstupu --input-format stream-json se zprávou uživatele. */
export const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

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
  }

  get idleMs() { return this.idleMsOverride ?? (this.cfg.sessionProcessMinutes ?? 10) * 60_000; }
  get hasActiveRuns() { return this.runs.size > 0; }
  isSessionBusy(id) { return this.busySessions.has(id); }
  find(id) { return this.runs.get(id); }
  /** Běží v projektu nějaký claude? (takový projekt nejde odebrat v Nastavení) */
  isProjectBusy(projectId) { for (const r of this.runs.values()) if (r.projectId === projectId) return true; return false; }
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
   * @param {{addDirs?: string[], model?: string, effort?: string}} [opts] addDirs = další složky (přílohy);
   *   model/effort už ověřené proti allowlistu (server.mjs)
   */
  async start(account, project, mode, prompt, resume, { addDirs = [], model = '', effort = '' } = {}) {
    if (!allowedModes(this.cfg).includes(mode)) throw new Error('Neplatný režim.');
    if (resume && this.busySessions.has(resume)) throw new Error('Toto sezení už běží.');
    if (resume) this.busySessions.add(resume); // hned, ať nikdo jiný sezení nepřevezme během čekání níže
    const sig = JSON.stringify([account.id, project.id, mode, model, effort, addDirs]);
    let proc = resume ? this.idle.get(resume) : undefined;
    try {
      if (proc && (proc.sig !== sig || proc.exited)) { await this.#retire(proc); proc = undefined; }
      if (proc) this.#unpark(proc);
      else proc = this.#spawn(account, project, mode, resume, { addDirs, model, effort }, sig);
    } catch (e) {
      if (resume) this.busySessions.delete(resume);
      throw e;
    }
    const warm = proc.turns > 0;
    const run = this.#newRun(proc, account, project, resume, warm);
    this.log(`Běh ${run.id} spuštěn: účet ${account.id}, projekt ${project.id}, režim ${mode}, resume ${!!resume}`
      + `, model ${model || 'výchozí'}, effort ${effort || 'výchozí'}${warm ? `, proces ${proc.id} převzat` : ''}`);
    proc.turns++;
    try { proc.child.stdin.write(userLine(prompt), 'utf8'); } catch { /* proces skončil – ohlásí 'close' */ }
    return run;
  }

  #spawn(account, project, mode, resume, { addDirs, model, effort }, sig) {
    // Vstup jako stream-json: stdin zůstává otevřený, takže lze poslat další zprávu do běžícího tahu
    // (Claude ji převezme na nejbližším předělu; --replay-user-messages to potvrdí) i další tah do stejného procesu.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', '--permission-mode', mode];
    // Výchozí: na co by se Claude Code zeptal, to se samo zamítne. Volitelně se ptá uživatele v okně (docs/security.md).
    if (this.cfg.interactivePermissions === true) args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'stdio');
    else args.push('--permission-prompts', 'none');
    if (resume) args.push('--resume', resume);
    if (this.cfg.appendSystemPrompt) args.push('--append-system-prompt', this.cfg.appendSystemPrompt);
    if (this.cfg.disallowedTools.length) args.push('--disallowedTools', ...this.cfg.disallowedTools);
    for (const d of addDirs) args.push('--add-dir', d);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    const child = this.spawnFn(claudeExePath(this.cfg), args, {
      cwd: project.pathFull, env: claudeEnv(account), shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...childSpawnOptions(),
    });
    let closedResolve;
    const proc = {
      id: randomUUID().slice(0, 8), child, sig, mode, accountId: account.id, projectId: project.id,
      sessionId: resume ?? null, run: /** @type {any} */ (null), turns: 0, exited: false, stdinOpen: true,
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
    return proc;
  }

  #newRun(proc, account, project, resume, warm) {
    const runner = this;
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
      stop() {
        if (run.ended) return;
        run.stopped = true;
        run.acceptingInput = false;
        proc.endInput();
        killTree(proc.child.pid);
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
      answerPermission(requestId, decision) {
        const p = run.permissions.get(requestId);
        if (!p || run.ended) return false;
        run.permissions.delete(requestId);
        clearTimeout(p.timer);
        try { proc.child.stdin.write(controlResponse(requestId, decision, p.input, p.suggestions), 'utf8'); } catch { /* proces skončil */ }
        const always = decision === 'always' ? alwaysUpdates(p.suggestions).flatMap((u) => u.rules.map(ruleLabel)) : [];
        run.emit('event', ev('permission_resolved', { requestId, decision: decision === 'always' && !always.length ? 'once' : decision, rules: always }));
        return true;
      },
    });
    proc.run = run;
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
    const reusable = this.idleMs > 0 && !!result && !result.isError && !run.stopped && !proc.exited && proc.stdinOpen
      && !!proc.sessionId && proc.lastMode === proc.mode && ![...proc.turnTools].some((t) => MODE_TOOLS.has(t));
    if (!reusable) { proc.endInput(); return; }
    this.#emitPlans(proc, run);
    run.emit('event', ev('exit', { code: 0, stopped: false, sessionId: run.sessionId, kept: true }));
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
