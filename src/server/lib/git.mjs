// @ts-check
// Aktuální větev a počet změněných souborů (jen čtení, git přes pole argumentů).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(cfg, repo, args) {
  const exe = cfg.gitExeFull;
  if (!exe || !existsSync(repo)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(exe, ['-C', repo, ...args], {
      cwd: repo, windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, // status nesmí zamykat index běžícímu Claude
    }, (err, stdout) => resolve(err ? null : stdout));
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
