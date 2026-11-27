// @ts-check
// Zápis z panelu Nastavení – výhradně pole `projects` (a `defaultProject`) v konfiguraci.
// Účty se z UI nikdy nemění: allowlist účtů s expectedEmail zůstává jen v ručně upravovaném souboru.
// Postup: přečíst surový JSON z disku → upravit projekty → ověřit stejnou validací jako při startu (parseConfig) →
// zapsat atomicky (dočasný soubor + rename) se zálohou <config>.bak → v paměti nahradit cfg.projects.
import { readFileSync, writeFileSync, renameSync, copyFileSync, statSync, realpathSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from './config.mjs';
import { expand, samePath, isUnder } from './platform.mjs';

export const MAX_PROJECTS = 50;
const MAX_LABEL = 60;
const ID_MAX = 40;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** Název projektu: 1–60 znaků bez řídicích znaků. */
export function checkLabel(label) {
  if (typeof label !== 'string') throw bad('Chybí název projektu.');
  const t = label.replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) throw bad(`Název musí mít 1–${MAX_LABEL} znaků.`);
  return t;
}

/** id z názvu: bez diakritiky, malá písmena, číslice a pomlčky; unikátní (přípona -2, -3…). */
export function slugId(label, taken) {
  let base = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ID_MAX).replace(/-+$/, '');
  if (!base) base = 'projekt';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, ID_MAX - String(i).length - 1)}-${i}`;
  return id;
}

/**
 * Ověří složku nového projektu. Vrací skutečnou absolutní cestu (bez zástupců a odkazů).
 * @param {import('./config.mjs').Config} cfg @param {unknown} input
 */
export function checkProjectPath(cfg, input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1000 || input.includes('\0')) throw bad('Zadejte cestu ke složce.');
  const typed = input.trim();
  // Relativní cesta by se rozbalila vůči složce serveru – vyžadujeme celou cestu (nebo ~, %VAR%, $VAR).
  if (!path.isAbsolute(typed) && !/^(~([\\/]|$)|%[^%]+%|\$)/.test(typed)) throw bad('Zadejte celou cestu ke složce (např. C:\\Users\\…\\projekt nebo ~/code/projekt).');
  let real;
  try {
    real = realpathSync.native(expand(typed));
    if (!statSync(real).isDirectory()) throw new Error();
  } catch { throw bad('Složka neexistuje.'); }

  const home = os.homedir();
  if (path.parse(real).root === real || samePath(real, path.parse(real).root)) throw bad('Kořen disku nelze přidat jako projekt.');
  if (samePath(real, home) || isUnder(home, real)) throw bad('Domovskou složku (ani složku nad ní) nelze přidat jako projekt.');
  const guarded = [cfg.stateDirFull, ...cfg.accounts.map((a) => a.configDirFull)].filter(Boolean);
  for (const g of guarded) {
    if (samePath(real, g) || isUnder(real, g) || isUnder(g, real))
      throw bad('Složka nesmí obsahovat ani ležet ve složce účtu Claude Code nebo ve složce stavu aplikace.');
  }
  if (cfg.projects.some((p) => samePath(p.pathFull, real))) throw bad('Tato složka už je mezi projekty.');
  return real;
}

/**
 * Provede změnu projektů a uloží ji. `isBusy(id)` = v projektu právě běží Claude (takový projekt nejde odebrat).
 * @param {string} file @param {import('./config.mjs').Config} cfg
 * @param {{op:'add', label:unknown, path:unknown} | {op:'rename', id:string, label:unknown} | {op:'remove', id:string}} change
 * @param {{isBusy?: (projectId: string) => boolean}} [opts]
 * @returns {{id: string}}
 */
export function changeProjects(file, cfg, change, { isBusy = () => false } = {}) {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  /** @type {any} */
  let raw;
  try { raw = JSON.parse(text); } catch { throw Object.assign(new Error('Konfigurace na disku není platný JSON – opravte ji ručně.'), { status: 409 }); }
  if (!Array.isArray(raw.projects)) throw Object.assign(new Error('Konfigurace na disku nemá pole projects.'), { status: 409 });
  const idx = (id) => raw.projects.findIndex((p) => p && p.id === id);
  let id;

  if (change.op === 'add') {
    if (raw.projects.length >= MAX_PROJECTS) throw bad(`Nejvýš ${MAX_PROJECTS} projektů.`);
    const label = checkLabel(change.label);
    const real = checkProjectPath(cfg, change.path);
    id = slugId(label, new Set(raw.projects.map((p) => p?.id)));
    raw.projects.push({ id, label, path: real });
  } else if (change.op === 'rename') {
    const i = idx(change.id);
    if (i < 0) throw Object.assign(new Error('Neznámý projekt.'), { status: 404 });
    raw.projects[i] = { ...raw.projects[i], label: checkLabel(change.label) };
    id = change.id;
  } else if (change.op === 'remove') {
    const i = idx(change.id);
    if (i < 0) throw Object.assign(new Error('Neznámý projekt.'), { status: 404 });
    if (raw.projects.length <= 1) throw bad('Poslední projekt nelze odebrat.');
    if (isBusy(change.id)) throw Object.assign(new Error('V projektu právě běží Claude – nejdřív ho zastavte.'), { status: 409 });
    raw.projects.splice(i, 1);
    if (raw.defaultProject === change.id) raw.defaultProject = raw.projects[0].id;
    id = change.id;
  } else {
    throw bad('Neznámá operace.');
  }

  // Stejná validace jako při startu; spustitelný soubor claude se tu neřeší (nemění se).
  const next = parseConfig(raw, path.basename(file), { checkExe: false });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2).replace(/\n/g, eol) + eol, { encoding: 'utf8', flag: 'w' });
  try {
    copyFileSync(file, `${file}.bak`);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nevznikl */ }
    throw e;
  }
  cfg.projects = next.projects;
  cfg.defaultProject = next.defaultProject;
  return { id };
}

/** Přehled pro Nastavení: projekty včetně cesty (jen pro zobrazení; běhy dál posílají jen id). */
export const settingsView = (cfg) => ({
  projects: cfg.projects.map((p) => ({ id: p.id, label: p.label, path: p.pathFull })),
  defaultProject: cfg.defaultProject,
});
