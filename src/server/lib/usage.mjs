// @ts-check
// Statistiky v čase – jen čísla, žádné texty zpráv. Soubor <stateDir>/usage.jsonl, jeden řádek na záznam:
//   běh:   {kind:'run', t, account, project, model, effort, input, output, cacheRead, cacheWrite, cost, ms, turns, error,
//           byModel?, workers?}  input… = hlavní konverzace (result.usage); byModel = hlavní + pracovníci po modelech
//   limit: {kind:'limit', t, account, window, utilization, resetsAt}  (nejvýš jednou za 10 min na okno, nebo při změně ≥ 2 body)
// Starší záznamy než KEEP_DAYS se mažou při startu a při překročení velikosti.
import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const KEEP_DAYS = 180;
export const MAX_DAYS = 180;
const MAX_BYTES = 20 * 1024 * 1024;
const LIMIT_EVERY_MS = 10 * 60_000;
const DAY = 86_400_000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const short = (v) => (typeof v === 'string' ? v.slice(0, 100) : '');

/** Jen když tah použil víc modelů (pracovníci): {byModel: {model: {input, output, cacheRead, cacheWrite, cost}}}. */
function byModel(list) {
  if (!Array.isArray(list) || list.length < 2) return {};
  /** @type {Record<string, any>} */
  const o = {};
  for (const m of list.slice(0, 20))
    o[short(m.model)] = { input: num(m.input), output: num(m.output), cacheRead: num(m.cacheRead), cacheWrite: num(m.cacheWrite), cost: num(m.costUsd) };
  return { byModel: o };
}

export class UsageLog {
  /** @param {string} stateDir @param {{now?: () => number, log?: (m:string) => void}} [o] */
  constructor(stateDir, { now = () => Date.now(), log = () => {} } = {}) {
    this.file = path.join(stateDir, 'usage.jsonl');
    this.now = now;
    this.log = log;
    /** @type {Map<string, {t:number, u:number}>} */
    this.lastLimit = new Map();
  }

  #append(o) {
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) this.prune();
      appendFileSync(this.file, `${JSON.stringify(o)}\n`, 'utf8');
    } catch (e) { this.log(`Statistiky nejde zapsat: ${/** @type {Error} */ (e).message}`); }
  }

  /**
   * Posluchač událostí jednoho běhu (model se vezme z init, jinak požadovaný).
   * @param {string} account @param {string} project @param {{model?:string, effort?:string}} requested
   */
  observer(account, project, requested = {}) {
    let model = requested.model || '';
    return (/** @type {any} */ e) => {
      if (!e || typeof e !== 'object') return;
      if (e.type === 'init' && typeof e.model === 'string') model = e.model;
      else if (e.type === 'result') this.addRun({ account, project, model, effort: requested.effort || '', ...e });
      else if (e.type === 'rate_limit') this.addLimit(account, e.windows);
    };
  }

  /** @param {any} r výsledek běhu (událost result z parseru + účet, projekt, model) */
  addRun(r) {
    const u = r.usage || {};
    this.#append({ kind: 'run', t: this.now(), account: short(r.account), project: short(r.project), model: short(r.model),
      effort: short(r.effort), input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite),
      cost: num(r.costUsd), ms: num(r.durationMs), turns: num(r.numTurns), error: r.isError === true ? 1 : 0,
      ...byModel(r.modelUsage), ...(num(r.subagents?.spawned) ? { workers: num(r.subagents.spawned) } : {}) });
  }

  /** @param {string} account @param {any} windows [{type, utilization, resetsAt}] */
  addLimit(account, windows) {
    if (!Array.isArray(windows)) return;
    const t = this.now();
    for (const w of windows.slice(0, 10)) {
      if (typeof w?.utilization !== 'number' || typeof w.type !== 'string') continue;
      const key = `${account}|${w.type}`;
      const last = this.lastLimit.get(key);
      if (last && t - last.t < LIMIT_EVERY_MS && Math.abs(w.utilization - last.u) < 0.02) continue;
      this.lastLimit.set(key, { t, u: w.utilization });
      this.#append({ kind: 'limit', t, account: short(account), window: short(w.type), utilization: Math.min(1.5, num(w.utilization)),
        resetsAt: num(w.resetsAt) || undefined });
    }
  }

  /** Záznamy za posledních `days` dní. */
  read(days = 30) {
    const d = Math.max(1, Math.min(MAX_DAYS, Math.floor(Number(days)) || 30));
    const from = this.now() - d * DAY;
    /** @type {any[]} */ const runs = [];
    /** @type {any[]} */ const limits = [];
    for (const o of this.#lines()) {
      if (o.t < from) continue;
      if (o.kind === 'run') runs.push(o);
      else if (o.kind === 'limit') limits.push(o);
    }
    return { days: d, from, runs: runs.slice(-50_000), limits: limits.slice(-20_000) };
  }

  #lines() {
    let text = '';
    try { text = readFileSync(this.file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o && typeof o.t === 'number') out.push(o); } catch { /* poškozený řádek */ }
    }
    return out;
  }

  /** Smaže záznamy starší než KEEP_DAYS (atomicky přes dočasný soubor). */
  prune() {
    if (!existsSync(this.file)) return;
    const from = this.now() - KEEP_DAYS * DAY;
    const keep = this.#lines().filter((o) => o.t >= from);
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, keep.map((o) => JSON.stringify(o)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
      renameSync(tmp, this.file);
    } catch (e) { this.log(`Statistiky nejde pročistit: ${/** @type {Error} */ (e).message}`); }
  }
}
