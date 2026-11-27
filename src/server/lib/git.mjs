// @ts-check
// Git jen pro čtení: větev, počet změn, seznam změněných souborů a diff po souborech.
// Git se spouští přes pole argumentů (bez shellu); žádná zapisující operace (žádné add/commit/checkout/stash…).
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

/** Strop pro diff jednoho souboru (pak se zkrátí). */
export const MAX_DIFF = 1024 * 1024;
/** Strop pro nesledovaný soubor zobrazený jako přidaný. */
export const MAX_UNTRACKED = 256 * 1024;
export const AREAS = ['staged', 'worktree', 'untracked'];

/**
 * fsmonitor by mohl spustit program z konfigurace repa; quotepath=off → názvy s diakritikou beze změny.
 * @returns {Promise<string|null>} stdout, nebo null (chyba / nejde o repo)
 */
function git(cfg, repo, args, { maxBuffer = 4 * 1024 * 1024 } = {}) {
  const exe = cfg.gitExeFull;
  if (!exe || !existsSync(repo)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(exe, ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', repo, ...args], {
      cwd: repo, windowsHide: true, timeout: 15_000, maxBuffer, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, // status nesmí zamykat index běžícímu Claude
    }, (err, stdout) => {
      // Příliš velký výstup: vrátíme, co přišlo (zkrátí se níž).
      if (err && /** @type {any} */ (err).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(String(stdout ?? ''));
      resolve(err ? null : stdout);
    });
  });
}

export async function gitStatus(cfg, repo) {
  const [branch, status] = await Promise.all([
    git(cfg, repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cfg, repo, ['status', '--porcelain']),
  ]);
  return {
    branch: branch?.trim() || null,
    changed: status ? status.split('\n').filter(Boolean).length : 0,
  };
}

/**
 * @typedef {{path:string, orig?:string, x:string, y:string, kind:'changed'|'renamed'|'conflict'|'untracked'}} GitFile
 * @typedef {{branch:string|null, upstream:string|null, ahead:number, behind:number, files:GitFile[]}} GitFiles
 */

/**
 * Rozebere `git status --porcelain=v2 -z --branch`.
 * @param {string} out @returns {GitFiles}
 */
export function parsePorcelainV2(out) {
  /** @type {GitFiles} */
  const r = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.head') r.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') r.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { r.ahead = Number(m[1]); r.behind = Number(m[2]); }
      }
      continue;
    }
    const type = line[0];
    if (type === '?') { r.files.push({ path: line.slice(2), x: '?', y: '?', kind: 'untracked' }); continue; }
    // Pevný počet polí před cestou (cesta může obsahovat mezery).
    const fieldsBeforePath = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : -1;
    if (fieldsBeforePath < 0) continue;
    let idx = -1;
    for (let k = 0, pos = 0; k < fieldsBeforePath; k++) { pos = line.indexOf(' ', pos) + 1; idx = pos; if (pos === 0) break; }
    if (idx <= 0) continue;
    const xy = line.slice(2, 4);
    const file = { path: line.slice(idx), x: xy[0], y: xy[1], kind: /** @type {GitFile['kind']} */ (type === '2' ? 'renamed' : type === 'u' ? 'conflict' : 'changed') };
    if (type === '2') file.orig = parts[++i] ?? '';
    r.files.push(file);
  }
  return r;
}

/** @returns {Promise<GitFiles|null>} null = není to git repo */
export async function gitFiles(cfg, repo) {
  const out = await git(cfg, repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  return out === null ? null : parsePorcelainV2(out);
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** Nesledovaný soubor jako „vše přidáno“ (bez spuštění gitu; symbolický odkaz se nesleduje). */
function untrackedDiff(repo, rel) {
  const full = path.resolve(repo, rel);
  if (!full.startsWith(path.resolve(repo) + path.sep)) throw bad('Neplatná cesta.');
  let st;
  try { st = lstatSync(full); } catch { return { diff: '', note: 'Soubor už neexistuje.' }; }
  if (st.isSymbolicLink()) { let t = ''; try { t = readlinkSync(full); } catch { } return { diff: '', note: `Symbolický odkaz → ${t}` }; }
  if (!st.isFile()) return { diff: '', note: 'Není to soubor.' };
  if (st.size > MAX_UNTRACKED) return { diff: '', note: `Nový soubor (${Math.round(st.size / 1024)} kB) – příliš velký pro náhled.` };
  const buf = readFileSync(full);
  if (buf.includes(0)) return { diff: '', note: 'Nový binární soubor.' };
  const text = buf.toString('utf8').replace(/\r\n/g, '\n');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (text === '') return { diff: '', note: 'Nový prázdný soubor.' };
  return { diff: `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n` };
}

/**
 * Diff jednoho souboru. Cesta musí být v aktuálním výpisu `git status` (nic jiného se nečte).
 * @param {string} rel cesta relativně ke kořeni repa (jak ji vrátil gitFiles) @param {string} area staged | worktree | untracked
 * @returns {Promise<{path:string, area:string, diff:string, truncated:boolean, note?:string}>}
 */
export async function gitDiff(cfg, repo, rel, area) {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\0')) throw bad('Neplatná cesta.');
  if (!AREAS.includes(area)) throw bad('Neplatná oblast (staged, worktree nebo untracked).');
  const st = await gitFiles(cfg, repo);
  if (!st) throw Object.assign(new Error('Projekt není git repozitář.'), { status: 409 });
  const f = st.files.find((x) => x.path === rel);
  if (!f) throw Object.assign(new Error('Soubor není mezi změnami (obnovte seznam).'), { status: 404 });

  let diff, note;
  if (area === 'untracked') {
    if (f.kind !== 'untracked') throw bad('Soubor není nesledovaný.');
    ({ diff, note } = untrackedDiff(repo, rel));
  } else {
    if (f.kind === 'untracked') throw bad('Nesledovaný soubor má jen oblast untracked.');
    if (area === 'staged' && f.x === '.') throw bad('Soubor nemá připravené změny.');
    if (area === 'worktree' && f.y === '.') throw bad('Soubor nemá nepřipravené změny.');
    const paths = f.orig && area === 'staged' ? [f.orig, f.path] : [f.path];
    const args = ['diff', ...(area === 'staged' ? ['--cached', '-M'] : []), '--no-color', '--no-ext-diff', '--no-textconv', '--', ...paths];
    diff = await git(cfg, repo, args, { maxBuffer: MAX_DIFF + 1 });
    if (diff === null) throw Object.assign(new Error('git diff selhal.'), { status: 500 });
    if (!diff) note = 'Beze změn obsahu (např. jen oprávnění nebo konce řádků).';
  }
  const truncated = diff.length > MAX_DIFF;
  return { path: f.path, area, diff: truncated ? diff.slice(0, MAX_DIFF) : diff, truncated, ...(note ? { note } : {}) };
}
