// Průzkumník souborů jen pro čtení: seznam (git / složky), čtení jen ze seznamu, uvnitř projektu, bez tajných souborů.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listFiles, readProjectFile, clearFilesCache, SECRET_RX, MAX_READ } from '../src/server/lib/files.mjs';
import { defaultGitExe } from '../src/server/lib/platform.mjs';

// Mimo repozitář aplikace (jinak by seznam bral git nadřazeného repa).
const base = path.join(os.tmpdir(), `acd-files-test-${process.pid}`);
const plain = { id: 'plain', pathFull: path.join(base, 'plain') };
const repo = { id: 'repo', pathFull: path.join(base, 'repo') };
const cfg = { gitExeFull: defaultGitExe() };
const w = (p, c) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, c); };
let symlinkOk = false;

before(() => {
  rmSync(base, { recursive: true, force: true });
  clearFilesCache();
  const P = plain.pathFull;
  w(path.join(P, 'a.txt'), 'ahoj\n');
  w(path.join(P, 'src', 'b.js'), 'const b = 1;\n');
  w(path.join(P, 'node_modules', 'x', 'i.js'), 'x');
  w(path.join(P, '.git', 'config'), 'x');
  w(path.join(P, '.env'), 'TOKEN=tajne');
  w(path.join(P, '.env.example'), 'TOKEN=');
  w(path.join(P, 'img.bin'), Buffer.from([1, 0, 2]));
  w(path.join(P, 'big.txt'), 'x'.repeat(MAX_READ + 1));
  w(path.join(base, 'outside.txt'), 'mimo projekt');
  try { symlinkSync(path.join(base, 'outside.txt'), path.join(P, 'link.txt')); symlinkOk = true; } catch { /* Windows bez oprávnění */ }

  const R = repo.pathFull;
  w(path.join(R, '.gitignore'), 'ignored.log\n');
  w(path.join(R, 'tracked.md'), '# Ahoj\n');
  w(path.join(R, 'ignored.log'), 'log');
  w(path.join(R, 'nový soubor.txt'), 'nový');
  execFileSync(cfg.gitExeFull, ['-C', R, 'init', '-q']);
  execFileSync(cfg.gitExeFull, ['-C', R, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', 'tracked.md', '.gitignore']);
});

after(() => rmSync(base, { recursive: true, force: true }));

test('seznam bez gitu: bez node_modules, .git a symbolických odkazů', async () => {
  const f = await listFiles(cfg, plain, true);
  assert.equal(f.source, 'folders');
  assert.ok(f.set.has('a.txt') && f.set.has('src/b.js'));
  assert.equal(f.list.some((p) => p.startsWith('node_modules/') || p.startsWith('.git/')), false);
  assert.equal(f.set.has('link.txt'), false);
});

test('seznam v gitu: sledované i nové, ignorované ne; názvy s diakritikou a mezerou', async () => {
  const f = await listFiles(cfg, repo, true);
  assert.equal(f.source, 'git');
  assert.ok(f.set.has('tracked.md') && f.set.has('nový soubor.txt') && f.set.has('.gitignore'));
  assert.equal(f.set.has('ignored.log'), false);
  await assert.rejects(readProjectFile(cfg, repo, 'ignored.log'), (e) => e.status === 404);
  assert.equal((await readProjectFile(cfg, repo, 'nový soubor.txt')).content, 'nový');
});

test('čtení: jen ze seznamu, bez traversal, tajné/binární/velké jen s poznámkou', async () => {
  await listFiles(cfg, plain, true);
  assert.equal((await readProjectFile(cfg, plain, 'src/b.js')).content, 'const b = 1;\n');
  for (const bad of ['../outside.txt', 'src/../a.txt', '/etc/passwd', 'C:\\Windows\\win.ini', '', 'a\0b', 'src//b.js'])
    await assert.rejects(readProjectFile(cfg, plain, bad), (e) => e.status === 400 || e.status === 404, bad);
  await assert.rejects(readProjectFile(cfg, plain, 'node_modules/x/i.js'), (e) => e.status === 404);
  const env = await readProjectFile(cfg, plain, '.env');
  assert.equal(env.content, undefined);
  assert.match(env.note, /tajné/);
  assert.equal((await readProjectFile(cfg, plain, '.env.example')).content, 'TOKEN=');
  assert.match((await readProjectFile(cfg, plain, 'img.bin')).note, /Binární/);
  assert.match((await readProjectFile(cfg, plain, 'big.txt')).note, /příliš velký/);
});

test('SECRET_RX: klíče a přihlašovací soubory', () => {
  for (const p of ['.env', 'app/.env.local', 'id_rsa', 'certs/server.key', 'a.pem', '.npmrc', '.credentials.json', 'config/secrets.yml', '.git-credentials'])
    assert.ok(SECRET_RX.test(p), p);
  for (const p of ['.env.example', 'README.md', 'src/keyboard.js', 'environment.ts', 'docs/secret-santa.md'])
    assert.equal(SECRET_RX.test(p), false, p);
});

test('odkaz mimo projekt se nepřečte (je-li možné odkaz vytvořit)', { skip: !symlinkOk && 'symbolický odkaz nejde vytvořit' }, async () => {
  // Odkaz není v seznamu (procházení odkazy přeskakuje) → 404 ještě před kontrolou cesty.
  await assert.rejects(readProjectFile(cfg, plain, 'link.txt'), (e) => e.status === 404 || e.status === 403);
});
