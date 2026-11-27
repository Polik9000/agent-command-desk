// @ts-check
// Konfigurace: local/config.json (vlastní, mimo Git), nebo soubor z ACD_CONFIG (testy).
// Vzor: config.example.json. Cesty mohou obsahovat %PROMENNE%, $PROMENNE a ~; programy lze zadat podle platformy.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  expand, forPlatform, checkClaudeExe, defaultStateDir, defaultClaudeExe, defaultGitExe, defaultBrowserExe,
} from './platform.mjs';

export { expand, norm, samePath, isUnder } from './platform.mjs';

/** @typedef {{id:string,label:string,configDir:string,expectedEmail:string,accent:string,configDirFull:string}} Account */
/** @typedef {{id:string,label:string,path:string,pathFull:string}} Project */
/**
 * @typedef {{app:{id:string,name:string}, port:number, openBrowser:boolean, startFullscreen?:boolean, interactivePermissions?:boolean, sessionProcessMinutes?:number,
 *   claudeExeFull:string, gitExeFull:string, browserExeFull:string, stateDirFull:string,
 *   disallowedTools:string[], appendSystemPrompt:string, defaultAccount:string, accounts:Account[],
 *   defaultProject:string, projects:Project[]}} Config
 */

const APP_ID_RX = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MODEL_ID_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // nikdy nezačíná „-“ → nejde podstrčit přepínač
/** Úsilí (effort) podle `claude --help`; '' = výchozí. */
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_MODELS = [
  { id: '', label: 'Výchozí účtu' },
  { id: 'haiku', label: 'Haiku' },   // od nejrychlejšího po nejschopnější
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'fable', label: 'Fable' },
];

/** Cesta ke konfiguraci: ACD_CONFIG, jinak <repo>/local/config.json. */
export function configPath(repoRoot) {
  return process.env.ACD_CONFIG ? path.resolve(process.env.ACD_CONFIG) : path.join(repoRoot, 'local', 'config.json');
}

/**
 * Načte a ověří konfiguraci. ACD_PORT a ACD_OPEN_BROWSER slouží pro testy.
 * @param {string} file
 * @param {{checkExe?: boolean}} [opts]
 * @returns {Config}
 */
export function loadConfig(file, { checkExe = true } = {}) {
  if (!existsSync(file))
    throw new Error(`Chybí konfigurace ${file}. Zkopírujte config.example.json do local/config.json a upravte účty a projekty.`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${path.basename(file)}: neplatný JSON (${e.message})`); }
  return parseConfig(raw, path.basename(file), { checkExe });
}

/**
 * Ověří a doplní konfiguraci z už načteného JSON (vstup se nemění). Používá i zápis z Nastavení, aby se do souboru
 * nikdy nedostalo nic, co by loadConfig odmítl.
 * @param {any} raw @param {string} name @param {{checkExe?: boolean}} [opts]
 * @returns {Config}
 */
export function parseConfig(raw, name, { checkExe = true } = {}) {
  const fail = (msg) => { throw new Error(`${name}: ${msg}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('očekávám objekt');
  /** @type {any} */
  const cfg = structuredClone(raw);

  if (process.env.ACD_PORT) cfg.port = Number(process.env.ACD_PORT);
  if (process.env.ACD_OPEN_BROWSER) cfg.openBrowser = process.env.ACD_OPEN_BROWSER === '1';
  cfg.port ??= 0;
  cfg.openBrowser ??= true;

  cfg.app ??= {};
  cfg.app.id ??= 'agent-command-desk';
  cfg.app.name ??= 'Agent Command Desk';
  if (!APP_ID_RX.test(cfg.app.id)) fail('app.id smí obsahovat jen malá písmena, číslice a pomlčky');
  if (typeof cfg.app.name !== 'string' || !cfg.app.name.trim()) fail('app.name je prázdné');

  if (!Array.isArray(cfg.accounts) || !cfg.accounts.length) fail('accounts je prázdné');
  if (!Array.isArray(cfg.projects) || !cfg.projects.length) fail('projects je prázdné');
  if (new Set(cfg.accounts.map((a) => a.id)).size !== cfg.accounts.length) fail('duplicitní id účtu');
  if (new Set(cfg.projects.map((p) => p.id)).size !== cfg.projects.length) fail('duplicitní id projektu');
  cfg.defaultAccount ??= cfg.accounts[0].id;
  if (!cfg.accounts.some((a) => a.id === cfg.defaultAccount)) fail('defaultAccount není v accounts');
  for (const a of cfg.accounts) {
    if (!a.id || !a.label) fail('účet musí mít id a label');
    if (!a.expectedEmail) fail(`účet ${a.id} nemá expectedEmail`);
    if (!a.configDir) fail(`účet ${a.id} nemá configDir`);
    a.accent ??= '#7aa2ff';
    a.configDirFull = expand(forPlatform(a.configDir) ?? '');
    if (!a.configDirFull) fail(`účet ${a.id}: configDir pro tuto platformu chybí`);
  }
  for (const p of cfg.projects) {
    if (!p.id || !p.label) fail('projekt musí mít id a label');
    p.pathFull = expand(forPlatform(p.path) ?? '');
    if (!p.pathFull) fail(`projekt ${p.id}: path pro tuto platformu chybí`);
  }

  const opt = (v) => { const s = forPlatform(v); return s ? expand(s) : ''; };
  cfg.claudeExeFull = opt(cfg.claudeExe) || defaultClaudeExe();
  cfg.gitExeFull = opt(cfg.gitExe) || defaultGitExe();
  cfg.browserExeFull = opt(cfg.browserExe) || defaultBrowserExe();
  cfg.stateDirFull = opt(cfg.stateDir) || defaultStateDir(cfg.app.id);

  if (checkExe) { const err = checkClaudeExe(cfg.claudeExeFull); if (err) fail(err); }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) fail('neplatný port');
  // Povolené modely pro výběr v UI (id = alias nebo plný název pro `claude --model`; '' = výchozí model účtu).
  cfg.models ??= DEFAULT_MODELS;
  if (!Array.isArray(cfg.models)) fail('models musí být pole');
  for (const m of cfg.models) {
    if (!m || typeof m.label !== 'string' || typeof m.id !== 'string' || (m.id !== '' && !MODEL_ID_RX.test(m.id)))
      fail('models: každá položka potřebuje id (písmena, číslice, . - _) a label');
  }
  if (!cfg.models.some((m) => m.id === '')) cfg.models = [{ id: '', label: 'Výchozí účtu' }, ...cfg.models];
  cfg.interactivePermissions ??= false;
  if (typeof cfg.interactivePermissions !== 'boolean') fail('interactivePermissions musí být true nebo false');
  // Jak dlouho smí proces claude po odpovědi čekat na další zprávu sezení (0 = vždy nový proces).
  cfg.sessionProcessMinutes ??= 10;
  if (!Number.isInteger(cfg.sessionProcessMinutes) || cfg.sessionProcessMinutes < 0 || cfg.sessionProcessMinutes > 120)
    fail('sessionProcessMinutes musí být celé číslo 0–120');
  cfg.disallowedTools ??= [];
  cfg.appendSystemPrompt = String(cfg.appendSystemPrompt ?? '').replaceAll('{appName}', cfg.app.name);
  return cfg;
}

export const findAccount = (cfg, id) => cfg.accounts.find((a) => a.id === id) ?? null;
export const findProject = (cfg, id) => cfg.projects.find((p) => p.id === id) ?? null;
