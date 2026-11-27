// @ts-check
// Průzkumník souborů projektu – jen pro čtení.
// Seznam: v git repu `git ls-files` (sledované + nové, bez ignorovaných podle .gitignore), jinak procházení složek
// bez build/cache adresářů a bez symbolických odkazů. Soubor jde přečíst jen tehdy, když je v aktuálním seznamu,
// leží i po rozřešení odkazů uvnitř projektu, je textový a malý. Soubory s možnými tajnými údaji se nezobrazují.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isUnder } from './config.mjs';
import { gitLsFiles } from './git.mjs';

export const MAX_FILES = 20_000;
export const MAX_READ = 512 * 1024;
const MAX_DEPTH = 12;
const CACHE_MS = 15_000;
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'bin', 'obj', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', 'target', '.idea', '.vs', '.gradle', '.terraform']);
/** Klíče, certifikáty, .env a přihlašovací soubory – v aplikaci se neukazují (vzory .env.example ano). */
export const SECRET_RX = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.credentials\.json|\.claude\.json|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;

const err = (status, msg) => Object.assign(new Error(msg), { status });
/** @type {Map<string, {at:number, list:string[], set:Set<string>, truncated:boolean, source:string}>} */
const cache = new Map();

/** Procházení složek mimo git (do šířky, bez odkazů a build/cache složek). */
async function walk(root) {
  const out = [];
  const queue = [{ dir: root, rel: '', depth: 0 }];
  while (queue.length && out.length <= MAX_FILES) {
    const { dir, rel, depth } = /** @type {any} */ (queue.shift());
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) queue.push({ dir: path.join(dir, e.name), rel: r, depth: depth + 1 }); }
      else if (e.isFile()) out.push(r);
    }
  }
  return out;
}

/**
 * Seznam souborů projektu (relativní cesty s „/“), z cache nejvýš 15 s starý, pokud `fresh` není true.
 * @param {any} cfg @param {{id:string, pathFull:string}} project
 */
export async function listFiles(cfg, project, fresh = false) {
  const c = cache.get(project.id);
  if (c && !fresh && Date.now() - c.at < CACHE_MS) return c;
  let git = await gitLsFiles(cfg, project.pathFull);
  if (git && !git.length) git = null; // složka ignorovaná nadřazeným repem → projít složky
  const raw = git ?? await walk(project.pathFull);
  const list = [...new Set(raw.map((p) => p.replaceAll('\\', '/')).filter((p) => p && !p.endsWith('/')))].sort((a, b) => a.localeCompare(b));
  const v = { at: Date.now(), list: list.slice(0, MAX_FILES), set: new Set(list.slice(0, MAX_FILES)), truncated: list.length > MAX_FILES,
    source: git ? 'git' : 'folders' };
  cache.set(project.id, v);
  return v;
}

/**
 * Obsah jednoho souboru ze seznamu.
 * @returns {Promise<{path:string, size:number, content?:string, note?:string}>}
 */
export async function readProjectFile(cfg, project, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\0') || path.isAbsolute(rel)
    || rel.split(/[\\/]/).some((s) => s === '..' || s === '')) throw err(400, 'Neplatná cesta.');
  if (!(await listFiles(cfg, project)).set.has(rel)) throw err(404, 'Soubor není v seznamu projektu (obnovte seznam).');
  if (SECRET_RX.test(rel)) return { path: rel, size: 0, note: 'Soubor může obsahovat tajné údaje (klíče, hesla) – aplikace ho nezobrazuje.' };
  const root = await fsp.realpath(project.pathFull);
  let real;
  try { real = await fsp.realpath(path.join(project.pathFull, rel)); } catch { return { path: rel, size: 0, note: 'Soubor už neexistuje.' }; }
  if (!isUnder(real, root)) throw err(403, 'Soubor leží mimo projekt.');
  const st = await fsp.stat(real);
  if (!st.isFile()) return { path: rel, size: 0, note: 'Není to soubor.' };
  if (st.size > MAX_READ) return { path: rel, size: st.size, note: `Soubor má ${Math.round(st.size / 1024)} kB – pro náhled je příliš velký.` };
  const buf = await fsp.readFile(real);
  if (buf.includes(0)) return { path: rel, size: st.size, note: 'Binární soubor – náhled není k dispozici.' };
  return { path: rel, size: st.size, content: buf.toString('utf8') };
}

/** Po odebrání/přidání projektu nebo pro testy. */
export const clearFilesCache = () => cache.clear();
