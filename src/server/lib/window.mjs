// @ts-check
// Okno Chrome --app s vlastním profilem; když se okno zavře, aplikace skončí.
// Windows: proces Chrome skončí se zavřením okna. Když Chrome předá okno už běžící instanci (proces hned skončí),
// nebo na macOS (aplikace po zavření okna běží dál), rozhoduje heartbeat z UI.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { IS_WIN } from './platform.mjs';

const HANDOFF_MS = 5_000;
const IDLE_LIMIT_MS = 3 * 60_000;

export function createHeartbeat() {
  let last = Date.now();
  return { touch() { last = Date.now(); }, get sinceMs() { return Date.now() - last; } };
}

/**
 * @param {{cfg: import('./config.mjs').Config, url: string, heartbeat: ReturnType<typeof createHeartbeat>,
 *   hasActiveRuns: () => boolean, shutdown: (reason: string) => void, log: (m: string) => void}} o
 * @returns {{close: () => void}}
 */
export function openWindow({ cfg, url, heartbeat, hasActiveRuns, shutdown, log }) {
  const exe = cfg.browserExeFull;
  if (!existsSync(exe)) {
    log(`Prohlížeč nenalezen: ${exe} (nastavte browserExe v local/config.json).`);
    shutdown('bez prohlížeče');
    return { close() {} };
  }
  const profile = path.join(cfg.stateDirFull, 'chrome');
  mkdirSync(profile, { recursive: true });

  const started = Date.now();
  const p = spawn(exe, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,900'], { stdio: 'ignore', windowsHide: false });
  let exited = false;
  p.on('error', (e) => { log(`Prohlížeč se nespustil: ${e.message}`); shutdown('chyba prohlížeče'); });
  log(`Okno otevřeno (PID prohlížeče ${p.pid}).`);

  let watching = false;
  const watchHeartbeat = () => {
    if (watching) return;
    watching = true;
    const timer = setInterval(() => {
      if (heartbeat.sinceMs > IDLE_LIMIT_MS && !hasActiveRuns()) { clearInterval(timer); shutdown('okno neodpovídá'); }
    }, 30_000);
    timer.unref();
  };
  if (!IS_WIN) watchHeartbeat();

  p.on('exit', () => {
    exited = true;
    if (Date.now() - started > HANDOFF_MS) { shutdown('okno zavřeno'); return; }
    log('Prohlížeč předal okno existující instanci; o ukončení rozhodne heartbeat.');
    watchHeartbeat();
  });

  return { close() { if (!exited) { try { p.kill(); } catch { /* už neběží */ } } } };
}
