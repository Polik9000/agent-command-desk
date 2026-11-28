// @ts-check
// Zápis z panelu Nastavení – pole `projects`, `defaultProject`, `accounts` a `defaultAccount` v konfiguraci.
// Účet přidaný z UI je stejný allowlist jako ruční: vlastní složka Claude Code a očekávaný e-mail, který se ověřuje
// (`claude auth status`) – jiný přihlášený účet se nepoužije (rozhodnutí uživatele 2026-11-27).
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
 * @param {{op:'add', label:unknown, path:unknown} | {op:'rename', id:string, label:unknown} | {op:'remove', id:string}
 *   | {op:'orchestrationDefault', mode:unknown}} change
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
  } else if (change.op === 'default') {
    if (idx(change.id) < 0) throw Object.assign(new Error('Neznámý projekt.'), { status: 404 });
    raw.defaultProject = change.id;
    id = change.id;
  } else if (change.op === 'addAccount') {
    if (!Array.isArray(raw.accounts)) throw Object.assign(new Error('Konfigurace na disku nemá pole accounts.'), { status: 409 });
    if (raw.accounts.length >= MAX_ACCOUNTS) throw bad(`Nejvýš ${MAX_ACCOUNTS} účtů.`);
    const label = checkLabel(change.label);
    const email = checkEmail(change.expectedEmail);
    const dir = checkAccountDir(cfg, change.configDir);
    if (cfg.accounts.some((a) => a.expectedEmail.toLowerCase() === email)) throw bad('Účet s tímto e-mailem už je v seznamu.');
    id = slugId(label, new Set(raw.accounts.map((a) => a?.id)));
    const accent = typeof change.accent === 'string' && /^#[0-9a-f]{6}$/i.test(change.accent) ? change.accent : undefined;
    raw.accounts.push({ id, label, configDir: dir, expectedEmail: email, ...(accent ? { accent } : {}) });
  } else if (change.op === 'removeAccount') {
    if (!Array.isArray(raw.accounts)) throw Object.assign(new Error('Konfigurace na disku nemá pole accounts.'), { status: 409 });
    const i = raw.accounts.findIndex((a) => a && a.id === change.id);
    if (i < 0) throw Object.assign(new Error('Neznámý účet.'), { status: 404 });
    if (raw.accounts.length <= 1) throw bad('Poslední účet nelze odebrat.');
    if (isBusy(change.id)) throw Object.assign(new Error('Na účtu právě běží Claude – nejdřív ho zastavte.'), { status: 409 });
    raw.accounts.splice(i, 1);
    if (raw.defaultAccount === change.id) raw.defaultAccount = raw.accounts[0].id;
    id = change.id;
  } else if (change.op === 'orchestrationDefault') {
    // Výchozí režim orchestrace pro nová sezení; zbytek bloku orchestration (pracovníci) zůstává, jak ho uživatel napsal.
    if (change.mode !== 'off' && change.mode !== 'auto') throw bad('Režim orchestrace musí být off nebo auto.');
    if (raw.orchestration != null && (typeof raw.orchestration !== 'object' || Array.isArray(raw.orchestration)))
      throw Object.assign(new Error('Blok orchestration v konfiguraci není objekt – opravte ho ručně.'), { status: 409 });
    raw.orchestration = { ...(raw.orchestration ?? {}), defaultMode: change.mode };
    id = change.mode;
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
  cfg.accounts = next.accounts;
  cfg.defaultAccount = next.defaultAccount;
  cfg.orchestration = next.orchestration;
  return { id };
}

export const MAX_ACCOUNTS = 20;
/** Očekávaný e-mail účtu (aplikace ho porovná s `claude auth status`). */
export function checkEmail(v) {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!e || e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('Zadejte e-mail, kterým je účet přihlášený v Claude Code.');
  return e;
}
/**
 * Složka účtu Claude Code (CLAUDE_CONFIG_DIR). Nemusí ještě existovat – vznikne při přihlášení.
 * Nesmí to být kořen disku, domovská složka, složka projektu, stavu aplikace ani jiného účtu.
 */
export function checkAccountDir(cfg, input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1000 || input.includes('\0')) throw bad('Zadejte složku účtu.');
  const typed = input.trim();
  if (!path.isAbsolute(typed) && !/^(~([\\/]|$)|%[^%]+%|\$)/.test(typed)) throw bad('Zadejte celou cestu (např. ~/.claude-prace nebo %USERPROFILE%\\.claude-prace).');
  const full = path.resolve(expand(typed));
  const home = os.homedir();
  if (path.parse(full).root === full) throw bad('Kořen disku nelze použít.');
  if (samePath(full, home) || isUnder(home, full)) throw bad('Domovská složka nejde použít – zvolte podsložku, např. ~/.claude-prace.');
  for (const g of [cfg.stateDirFull, ...cfg.accounts.map((a) => a.configDirFull)].filter(Boolean))
    if (samePath(full, g) || isUnder(full, g) || isUnder(g, full)) throw bad('Tuto složku už používá jiný účet nebo aplikace.');
  for (const p of cfg.projects)
    if (samePath(full, p.pathFull) || isUnder(full, p.pathFull)) throw bad('Složka účtu nesmí ležet v projektu.');
  return typed;
}

/** Přehled pro Nastavení: projekty včetně cesty (jen pro zobrazení; běhy dál posílají jen id). */
export const settingsView = (cfg) => ({
  projects: cfg.projects.map((p) => ({ id: p.id, label: p.label, path: p.pathFull })),
  defaultProject: cfg.defaultProject,
  accounts: cfg.accounts.map((a) => ({ id: a.id, label: a.label, configDir: a.configDirFull, expectedEmail: a.expectedEmail, accent: a.accent })),
  defaultAccount: cfg.defaultAccount,
});
