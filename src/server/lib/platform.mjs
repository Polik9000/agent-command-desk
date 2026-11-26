// @ts-check
// Rozdíly mezi Windows a macOS (případně Linuxem): cesty, výchozí programy, ukončení stromu procesů.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
/** Windows a macOS (APFS) mají cesty bez rozlišení velikosti písmen. */
const CASE_INSENSITIVE = IS_WIN || IS_MAC;

/**
 * Hodnota z configu: buď řetězec, nebo objekt podle platformy { "win32": "...", "darwin": "...", "linux": "..." }.
 * @param {unknown} v @returns {string|undefined}
 */
export function forPlatform(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const x = /** @type {Record<string, unknown>} */ (v)[process.platform];
    return typeof x === 'string' ? x : undefined;
  }
  return undefined;
}

/** Rozbalí %PROMENNE%, $PROMENNE, ${PROMENNE} a úvodní ~ a vrátí absolutní cestu ('' pro prázdný vstup). */
export function expand(p) {
  if (!p) return '';
  let e = p.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  e = e.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => process.env[a ?? b] ?? m);
  if (e === '~' || e.startsWith('~/') || e.startsWith('~\\')) e = path.join(os.homedir(), e.slice(1));
  return path.resolve(e);
}

export const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
const cmp = (p) => (CASE_INSENSITIVE ? norm(p).toLowerCase() : norm(p));
export const samePath = (a, b) => cmp(a) === cmp(b);
export const isUnder = (child, parent) => cmp(child).startsWith(cmp(parent) + path.sep);

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** Najde program v PATH (na Windows jen .exe). */
export function which(name) {
  const exts = IS_WIN ? ['.exe'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** Výchozí složka stavu aplikace (logy, profil prohlížeče, pid). */
export function defaultStateDir(appId) {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), appId);
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', appId);
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), appId);
}

export function defaultClaudeExe() {
  const local = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  return existsSync(local) ? local : which('claude') ?? local;
}

export function defaultGitExe() {
  if (IS_WIN) {
    const pf = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
    if (existsSync(pf)) return pf;
  }
  return which('git') ?? (IS_WIN ? 'git.exe' : '/usr/bin/git');
}

export function defaultBrowserExe() {
  const candidates = IS_WIN
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map((d) => path.join(/** @type {string} */ (d), 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : IS_MAC
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

/**
 * Ověří cestu ke claude: absolutní, existující soubor; na Windows jen .exe (žádné .cmd/.bat → nikdy přes shell).
 * @returns {string|null} chybová hláška, nebo null
 */
export function checkClaudeExe(p) {
  if (!p || !path.isAbsolute(p)) return 'claudeExe musí být absolutní cesta';
  if (IS_WIN && path.extname(p).toLowerCase() !== '.exe') return 'claudeExe musí být .exe (žádné .cmd/.bat)';
  if (!isFile(p)) return `claude nenalezen: ${p}`;
  return null;
}

/** Možnosti spawn pro claude: na POSIX vlastní skupina procesů, aby šel ukončit celý strom. */
export const childSpawnOptions = () => (IS_WIN ? { windowsHide: true } : { detached: true });

const TASKKILL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

/** Ukončí celý strom procesů (claude + jeho bash/node potomky). */
export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    try {
      spawn(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } catch { /* proces už neexistuje */ }
    return;
  }
  const signal = (sig) => { try { process.kill(-pid, sig); return true; } catch { return false; } };
  if (signal('SIGTERM')) setTimeout(() => signal('SIGKILL'), 3000).unref();
}
