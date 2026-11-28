// @ts-check
// Orchestrace (issue #1): hlavní model sezení řídí nativní subagenty Claude Code („pracovníky“), které aplikace
// předá přes `claude -p --agents <soubor>`. Režim Vypnuto = beze změny; Auto = definice pracovníků + krátké pokyny.
// Pracovníci nikdy nedostanou permissionMode – dědí režim a pravidla rodiče, takže nemohou mít víc oprávnění.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ORCH_MODES = ['off', 'auto'];
/** Nejnižší verze Claude Code, která v režimu -p přijme `--agents` jako cestu k souboru. */
export const MIN_AGENTS_FILE_VERSION = '2.1.281';
export const WORKER_NAME_RX = /^acd-[a-z0-9][a-z0-9-]{0,39}$/;
/** Čtecí role: jen tyto nástroje; zápis, příkazy i další agenti výslovně zakázané. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent'];
const MAX_WORKERS = 12;
const MAX_TEXT = 4000;

/** Vestavění pracovníci (výchozí – žádná povinná posloupnost; orchestrátor volí sám, nebo nikoho). */
export const WORKER_PRESETS = {
  'acd-explore': {
    model: 'haiku', readOnly: true,
    description: 'Fast, read-only project exploration and code research: find files, symbols, usages and conventions, '
      + 'and summarise what exists. Use for broad searches that would otherwise flood the main context. Cannot edit.',
    prompt: 'You are a fast, read-only code explorer working for an orchestrating agent. Use Glob, Grep and Read to '
      + 'answer exactly the question you were given. Report concrete findings with file paths and line numbers, keep '
      + 'the report short, and say clearly what you did not find or could not check. Never guess.',
  },
  'acd-plan': {
    model: 'haiku', readOnly: true,
    description: 'Read-only research and options gathering for planning: collect constraints, affected files and '
      + 'possible approaches with trade-offs before a change is designed. Cannot edit.',
    prompt: 'You gather facts for a plan that another agent will decide on. Read the relevant code and docs, list the '
      + 'files and functions involved, constraints, risks and 2-3 options with trade-offs. Cite file paths. Do not '
      + 'decide for the orchestrator and do not propose edits you have not checked against the code.',
  },
  'acd-implementer': {
    model: 'sonnet', readOnly: false,
    description: 'Scoped implementation and multi-step coding work with a clear boundary (named files or module). '
      + 'Uses the normal project tools under the session permissions. Do not run two implementers on the same files.',
    prompt: 'You implement one clearly scoped change for an orchestrating agent. Stay inside the files and scope you '
      + 'were given; if the task needs changes elsewhere, stop and report instead of expanding the scope. Follow the '
      + 'conventions of the surrounding code, run the relevant tests if you can, and report exactly what you changed, '
      + 'what you verified and what remains unverified.',
  },
  'acd-reviewer': {
    model: 'sonnet', readOnly: true,
    description: 'Independent review of changes: reads the diff and the surrounding code and reports actionable '
      + 'findings (bugs, regressions, missing tests) without editing anything.',
    prompt: 'You review changes for an orchestrating agent without editing anything. Read the changed code and enough '
      + 'context to judge it. Report only actionable findings, most severe first, each with file path, line, the '
      + 'concrete failure scenario and a suggested fix. Say explicitly when you found nothing important.',
  },
};

/** Pokyny pro orchestrátora (připojí se za appendSystemPrompt jen v režimu Auto). */
export function guidance(workers) {
  const list = workers.map((w) => `- ${w.name}${w.model && w.model !== 'inherit' ? ` (${w.model})` : ''}${w.readOnly ? ', read-only' : ''}`).join('\n');
  return [
    'Orchestration is enabled for this session. You are the orchestrator: you may delegate to these subagents with the Agent tool:',
    list,
    'Decide per task whether delegating is worth it. Do small or simple tasks yourself, without subagents. Delegate when work is'
    + ' large, independent or would flood your context (broad searches, separate investigations, a review with fresh eyes).',
    'Prefer the least costly capable worker for bounded work; keep difficult reasoning, task decomposition, integration and the'
    + ' final verification yourself. Run workers in parallel only for independent work; never let two workers edit the same'
    + ' files, and delegate implementation only with clear file ownership.',
    'Give each worker a self-contained brief (goal, files, constraints, what to report). Treat worker results as claims: check'
    + ' important findings and changes yourself, reconcile conflicts, and run or inspect tests before you report completion.',
    'Subagents use the same usage limits as you. Do not claim that delegation saved tokens or improved quality.',
  ].join('\n');
}

/**
 * Ověří volitelný blok `orchestration` z konfigurace. Měkce: neplatné položky se vynechají s varováním,
 * aplikace i běžný chat fungují dál.
 * @param {any} raw @param {Array<{id:string}>} models allowlist modelů (cfg.models)
 * @returns {{defaultMode:'off'|'auto', workers: Array<{name:string, model:string, readOnly:boolean, description:string, prompt:string}>, warnings:string[]}}
 */
export function normalizeOrchestration(raw, models) {
  const warnings = [];
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw != null && o !== raw) warnings.push('orchestration musí být objekt – ignorováno.');
  let defaultMode = o.defaultMode ?? 'off';
  if (!ORCH_MODES.includes(defaultMode)) { warnings.push(`orchestration.defaultMode „${String(defaultMode).slice(0, 20)}“ neznám – použito off.`); defaultMode = 'off'; }
  const allowed = new Set(models.map((m) => m.id).filter(Boolean));
  const okModel = (m) => m === 'inherit' || allowed.has(m);
  const text = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_TEXT) : '');
  const conf = o.workers && typeof o.workers === 'object' && !Array.isArray(o.workers) ? o.workers : {};
  if (o.workers != null && conf !== o.workers) warnings.push('orchestration.workers musí být objekt – ignorováno.');

  const workers = [];
  const names = [...new Set([...Object.keys(WORKER_PRESETS), ...Object.keys(conf)])];
  for (const name of names) {
    const preset = /** @type {any} */ (WORKER_PRESETS)[name];
    const c = conf[name];
    if (c != null && (typeof c !== 'object' || Array.isArray(c))) { warnings.push(`Pracovník ${name}: očekávám objekt – ${preset ? 'výchozí nastavení' : 'vynechán'}.`); if (!preset) continue; }
    const cc = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
    if (!preset && !WORKER_NAME_RX.test(name)) { warnings.push(`Pracovník „${name.slice(0, 40)}“: jméno musí začínat acd- (a-z, 0-9, -) – vynechán.`); continue; }
    if (cc.enabled === false) continue;
    let model = cc.model ?? preset?.model ?? 'inherit';
    if (typeof model !== 'string' || !okModel(model)) {
      const fallback = preset && okModel(preset.model) && model !== preset.model ? preset.model : 'inherit';
      warnings.push(`Pracovník ${name}: model „${String(model).slice(0, 40)}“ není v seznamu modelů – ${preset ? `použit ${fallback}` : 'vynechán'}.`);
      if (!preset) continue;
      model = fallback;
    }
    const description = text(cc.description) || preset?.description || '';
    const prompt = text(cc.prompt) || preset?.prompt || '';
    if (!description || !prompt) { warnings.push(`Pracovník ${name}: chybí description nebo prompt – vynechán.`); continue; }
    if (cc.readOnly != null && typeof cc.readOnly !== 'boolean') warnings.push(`Pracovník ${name}: readOnly musí být true/false.`);
    const readOnly = typeof cc.readOnly === 'boolean' ? cc.readOnly : preset ? preset.readOnly : true; // vlastní = jen čtení, pokud neřekne jinak
    workers.push({ name, model, readOnly, description, prompt });
    if (workers.length >= MAX_WORKERS) { if (names.length > MAX_WORKERS) warnings.push(`Nejvýš ${MAX_WORKERS} pracovníků.`); break; }
  }
  return { defaultMode, workers, warnings };
}

/** Jména agentů uživatele a projektu (`name:` ve frontmatteru *.md), aby je --agents nezastínil. */
export function userAgentNames(dirs) {
  const names = new Set();
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).slice(0, 500); } catch { continue; }
    for (const f of files) {
      names.add(f.slice(0, -3));
      try {
        const head = readFileSync(path.join(dir, f), 'utf8').slice(0, 4000);
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
        const m = fm && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
        if (m) names.add(m[1].trim());
      } catch { /* nečitelný soubor */ }
    }
  }
  return names;
}

/**
 * Definice pro `--agents` (objekt podle jména). Nikdy permissionMode; zakázané nástroje sezení platí i pro pracovníky.
 * @param {ReturnType<typeof normalizeOrchestration>['workers']} workers
 * @param {{disallowedTools?: string[], taken?: Set<string>}} [o]
 */
export function buildAgents(workers, { disallowedTools = [], taken = new Set() } = {}) {
  /** @type {Record<string, any>} */
  const defs = {};
  const active = [];
  const skipped = [];
  for (const w of workers) {
    if (taken.has(w.name)) { skipped.push({ name: w.name, reason: 'jméno už používá agent uživatele nebo projektu' }); continue; }
    /** @type {any} */
    const d = { description: w.description, prompt: w.prompt };
    if (w.model && w.model !== 'inherit') d.model = w.model;
    if (w.readOnly) {
      d.tools = [...READ_ONLY_TOOLS];
      d.disallowedTools = [...new Set([...WRITE_TOOLS, ...disallowedTools])];
    } else if (disallowedTools.length) d.disallowedTools = [...disallowedTools];
    defs[w.name] = d;
    active.push({ name: w.name, model: w.model, readOnly: w.readOnly });
  }
  return { defs, workers: active, skipped };
}

/** Složení --append-system-prompt: nastavení uživatele zůstává, pokyny orchestrace se připojí za něj. */
export const composePrompt = (append, extra) => [append, extra].filter((s) => typeof s === 'string' && s.trim()).join('\n\n');

/** Verze z `claude --version` („2.1.332 (Claude Code)“) → [2,1,332], jinak null. */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function versionAtLeast(v, min) {
  const a = Array.isArray(v) ? v : parseVersion(v);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/* ---------- Soubory definic: <stateDir>/agents/<procId>.json, žijí stejně dlouho jako proces ---------- */
export const agentsDir = (stateDir) => path.join(stateDir, 'agents');
export function writeAgentsFile(stateDir, id, defs) {
  const dir = agentsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id.replace(/[^\w-]/g, '')}.json`);
  writeFileSync(file, JSON.stringify(defs, null, 2), { encoding: 'utf8', mode: 0o600 });
  return file;
}
export function removeAgentsFile(file) { if (file) try { rmSync(file, { force: true }); } catch { /* už smazán */ } }
/** Zbytky po pádu aplikace (při startu) nebo všechny soubory (při ukončení). */
export function clearAgentsDir(stateDir) {
  const dir = agentsDir(stateDir);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) removeAgentsFile(path.join(dir, f));
}
