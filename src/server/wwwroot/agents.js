// Orchestrace a karty agentů – logika bez DOM (testy: tests/agents.test.mjs).
// Model pracovníka se nehádá: jen z volání nástroje Agent (`model`), nebo z definice pracovníka, kterou aplikace předala.
(function (root) {
  'use strict';
  const ORCH_MODES = ['off', 'auto'];
  const ORCH_KEY = 'acd.orch';
  const ORCH_MAX = 200;

  /**
   * Model karty agenta. @param {any} input vstup nástroje Agent @param {Record<string,string>|null} workers jméno → model
   * (jen pracovníci aktivní orchestrace tohoto běhu) @param {string} sessionModel model sezení (pro „inherit“)
   * @returns {string|null} id/alias modelu, nebo null = neznámý
   */
  function workerModel(input, workers, sessionModel) {
    if (!input || typeof input !== 'object') return null;
    if (typeof input.model === 'string' && input.model) return input.model === 'inherit' ? (sessionModel || null) : input.model;
    const sub = typeof input.subagent_type === 'string' ? input.subagent_type : '';
    const w = workers && sub && Object.prototype.hasOwnProperty.call(workers, sub) ? workers[sub] : null;
    if (!w) return null;
    return w === 'inherit' ? (sessionModel || null) : w;
  }

  /** Pracovníci z události `orchestration` → mapa jméno → model (jen při aktivní orchestraci). */
  function workerMap(ev) {
    const m = {};
    if (!ev || ev.active !== true || !Array.isArray(ev.workers)) return m;
    for (const w of ev.workers) if (w && typeof w.name === 'string' && typeof w.model === 'string') m[w.name] = w.model;
    return m;
  }

  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  /**
   * Tokeny tahu po modelech (hlavní + pracovníci) z `result.modelUsage`. Nic se nesčítá s `usage` ani s tokeny z karet,
   * takže nic není dvakrát. @returns {null | {rows: any[], total: number, cost: number}}
   */
  function turnUsage(modelUsage) {
    if (!Array.isArray(modelUsage) || !modelUsage.length) return null;
    const rows = modelUsage.map((m) => {
      const tokens = n(m.input) + n(m.output) + n(m.cacheRead) + n(m.cacheWrite);
      return { model: String(m.model || '?'), input: n(m.input), output: n(m.output), cacheRead: n(m.cacheRead), cacheWrite: n(m.cacheWrite),
        tokens, cost: typeof m.costUsd === 'number' ? m.costUsd : null };
    });
    return { rows, total: rows.reduce((a, r) => a + r.tokens, 0), cost: rows.reduce((a, r) => a + (r.cost || 0), 0) };
  }

  /**
   * Tokeny tahu včetně pracovníků: z modelUsage; bez něj jen hlavní konverzace – a když tah měl pracovníky,
   * je údaj neúplný (partial). @returns {{tokens:number, partial:boolean}}
   */
  function allTokens(ev) {
    const t = turnUsage(ev && ev.modelUsage);
    if (t) return { tokens: t.total, partial: false };
    const u = (ev && ev.usage) || {};
    const main = n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
    return { tokens: main, partial: !!(ev && ev.subagents && ev.subagents.spawned > 0) };
  }

  /* ---------- Režim orchestrace podle sezení (localStorage, nejvýš ORCH_MAX sezení) ---------- */
  function readMap(storage) {
    try { const o = JSON.parse(storage.getItem(ORCH_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
  }
  /** Režim sezení; nové nebo neznámé sezení = výchozí režim. */
  function sessionOrch(storage, sessionId, fallback) {
    const v = sessionId ? readMap(storage)[sessionId] : undefined;
    return ORCH_MODES.includes(v) ? v : (ORCH_MODES.includes(fallback) ? fallback : 'off');
  }
  function saveSessionOrch(storage, sessionId, mode) {
    if (!sessionId || !ORCH_MODES.includes(mode)) return;
    const m = readMap(storage);
    delete m[sessionId];
    m[sessionId] = mode; // poslední na konec → nejstarší se maže první
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - ORCH_MAX))) delete m[k];
    try { storage.setItem(ORCH_KEY, JSON.stringify(m)); } catch { /* plné úložiště */ }
  }

  root.Agents = { ORCH_MODES, ORCH_MAX, workerModel, workerMap, turnUsage, allTokens, sessionOrch, saveSessionOrch };
})(typeof window !== 'undefined' ? window : globalThis);
