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

export { killTree };
export const MODES = ['auto', 'plan'];
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

export class ClaudeRunner {
  /** @param {import('./config.mjs').Config} cfg @param {(m:string)=>void} log */
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    /** @type {Map<string, any>} */
    this.runs = new Map();
    /** @type {Set<string>} */
    this.busySessions = new Set();
  }

  get hasActiveRuns() { return this.runs.size > 0; }
  isSessionBusy(id) { return this.busySessions.has(id); }
  find(id) { return this.runs.get(id); }
  stopAll() { for (const r of this.runs.values()) r.stop(); }

  /**
   * Spustí claude; události emituje jako 'event', na konci 'end'.
   * @param {import('./config.mjs').Account} account @param {import('./config.mjs').Project} project
   * @param {string} mode @param {string} prompt @param {string|null} resume
   * @param {{addDirs?: string[], model?: string, effort?: string}} [opts] addDirs = další složky jen pro tento běh
   *   (přílohy); model/effort už ověřené proti allowlistu (server.mjs)
   */
  start(account, project, mode, prompt, resume, { addDirs = [], model = '', effort = '' } = {}) {
    if (!MODES.includes(mode)) throw new Error('Neplatný režim.');
    if (resume && this.busySessions.has(resume)) throw new Error('Toto sezení už běží.');

    // Vstup jako stream-json: stdin zůstane otevřený, dokud tah neskončí, takže lze poslat další zprávu
    // do běžícího tahu (Claude ji převezme na nejbližším předělu; --replay-user-messages to potvrdí).
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', '--permission-mode', mode, '--permission-prompts', 'none'];
    if (resume) args.push('--resume', resume);
    if (this.cfg.appendSystemPrompt) args.push('--append-system-prompt', this.cfg.appendSystemPrompt);
    if (this.cfg.disallowedTools.length) args.push('--disallowedTools', ...this.cfg.disallowedTools);
    for (const d of addDirs) args.push('--add-dir', d);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    const child = spawn(claudeExePath(this.cfg), args, {
      cwd: project.pathFull, env: claudeEnv(account), shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...childSpawnOptions(),
    });

    const run = Object.assign(new EventEmitter(), {
      id: randomUUID().replaceAll('-', ''),
      accountId: account.id,
      projectId: project.id,
      sessionId: resume ?? null,
      stopped: false,
      ended: false,
      acceptingInput: true, // dokud je stdin otevřený
      injected: 0,          // zprávy poslané do běžícího tahu
      replayed: 0,          // potvrzení převzetí od claude (včetně úvodního promptu)
      stop() {
        if (run.ended) return;
        run.stopped = true;
        run.closeInput();
        killTree(child.pid);
      },
      /** Pošle zprávu do běžícího tahu. @returns {boolean} false, pokud už běh vstup nepřijímá */
      inject(text) {
        if (!run.acceptingInput || run.ended || run.stopped) return false;
        run.injected++;
        child.stdin.write(userLine(text), 'utf8');
        return true;
      },
      closeInput() {
        if (!run.acceptingInput) return;
        run.acceptingInput = false;
        clearTimeout(run.closeTimer);
        try { child.stdin.end(); } catch { /* už zavřeno */ }
      },
      closeTimer: /** @type {any} */ (null),
    });
    if (resume) this.busySessions.add(resume);
    this.runs.set(run.id, run);
    this.log(`Běh ${run.id} spuštěn: účet ${account.id}, projekt ${project.id}, režim ${mode}, resume ${!!resume}`
      + `, model ${model || 'výchozí'}, effort ${effort || 'výchozí'}`);
    this.#pump(run, child, account, prompt);
    return run;
  }

  #pump(run, child, account, prompt) {
    const parser = new StreamParser(path.join(account.configDirFull, 'plans'));
    let stderr = '';
    let spawnError = null;
    child.on('error', (e) => { spawnError = e; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdin.on('error', () => { /* proces skončil dřív, než přečetl stdin */ });
    child.stdin.write(userLine(prompt), 'utf8');

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      for (const e of parser.parse(line)) {
        if (e.type === 'init' && parser.sessionId && !run.sessionId) {
          run.sessionId = parser.sessionId;
          this.busySessions.add(parser.sessionId);
        }
        if (e.type === 'user_replay') {
          run.replayed++;
          clearTimeout(run.closeTimer);
        }
        if (e.type === 'result') {
          // Tah skončil. Čeká-li ještě vložená zpráva (ještě nepřevzatá), claude ji vezme jako další tah;
          // jinak vstup zavřít, aby proces skončil. Pojistka: bez převzetí do 60 s zavřít i tak.
          clearTimeout(run.closeTimer);
          if (run.injected <= run.replayed - 1) run.closeInput();
          else run.closeTimer = setTimeout(() => run.closeInput(), 60_000);
        }
        run.emit('event', e);
      }
    });

    const rlClosed = new Promise((r) => rl.once('close', r));
    const exited = new Promise((r) => child.once('close', (code) => r(code)));
    Promise.all([rlClosed, exited]).then(([, code]) => {
      if (spawnError) run.emit('event', ev('error', { message: `Běh selhal: ${spawnError.message}` }));
      for (const file of parser.planFiles) {
        try {
          if (statSync(file).size <= MAX_PLAN_BYTES) run.emit('event', ev('plan', { path: file, content: readFileSync(file, 'utf8') }));
        } catch { /* soubor plánu zmizel */ }
      }
      const exitCode = typeof code === 'number' ? code : -1;
      const err = stderr.trim() && exitCode !== 0 && !run.stopped ? stderr.trim() : undefined;
      run.emit('event', ev('exit', { code: exitCode, stopped: run.stopped, sessionId: run.sessionId, stderr: err }));
      this.log(`Běh ${run.id} skončil kódem ${exitCode}${run.stopped ? ' (zastaven)' : ''}`);
    }).finally(() => {
      clearTimeout(run.closeTimer);
      run.acceptingInput = false;
      run.ended = true;
      this.runs.delete(run.id);
      if (run.sessionId) this.busySessions.delete(run.sessionId);
      run.emit('end');
    });
  }
}
