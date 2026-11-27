// Git přehled jen pro čtení: parser porcelain v2 a diff po souborech na dočasném repu.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePorcelainV2, gitFiles, gitDiff, MAX_UNTRACKED } from '../src/server/lib/git.mjs';
import { defaultGitExe } from '../src/server/lib/platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.join(root, '.test-state', 'git-repo');
const cfg = { gitExeFull: defaultGitExe() };
const g = (...args) => execFileSync(cfg.gitExeFull, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  '-c', 'core.autocrlf=false', '-c', 'core.quotepath=off', '-C', repo, ...args], { encoding: 'utf8' });

test('parsePorcelainV2: větev, ahead/behind, změny, přejmenování, konflikt, nesledované, mezery v názvu', () => {
  const out = [
    '# branch.oid 0123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a b.js',
    '1 A. N... 000000 100644 100644 000 ccc nový soubor.md',
    '2 R. N... 100644 100644 100644 ddd ddd R100 new name.txt', 'old name.txt',
    'u UU N... 100644 100644 100644 100644 e1 e2 e3 konflikt.txt',
    '? složka/nesledovaný soubor.txt', '',
  ].join('\0');
  const r = parsePorcelainV2(out);
  assert.equal(r.branch, 'main');
  assert.equal(r.upstream, 'origin/main');
  assert.equal(r.ahead, 2); assert.equal(r.behind, 1);
  assert.deepEqual(r.files, [
    { path: 'src/a b.js', x: '.', y: 'M', kind: 'changed' },
    { path: 'nový soubor.md', x: 'A', y: '.', kind: 'changed' },
    { path: 'new name.txt', x: 'R', y: '.', kind: 'renamed', orig: 'old name.txt' },
    { path: 'konflikt.txt', x: 'U', y: 'U', kind: 'conflict' },
    { path: 'složka/nesledovaný soubor.txt', x: '?', y: '?', kind: 'untracked' },
  ]);
  assert.equal(parsePorcelainV2('# branch.head (detached)\0').branch, null);
});

before(() => {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false'); // stejné chování na CI (Windows runner má autocrlf=true)
  writeFileSync(path.join(repo, 'a.txt'), 'jedna\ndva\ntři\n');
  writeFileSync(path.join(repo, 'staré jméno.txt'), 'obsah k přejmenování\n');
  writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, 'a.txt'), 'jedna\nDVA\ntři\nčtyři\n');      // nepřipravená změna
  writeFileSync(path.join(repo, 'b.txt'), 'b2\n'); g('add', 'b.txt');         // připravená změna
  writeFileSync(path.join(repo, 'b.txt'), 'b3\n');                            // … a další nepřipravená
  renameSync(path.join(repo, 'staré jméno.txt'), path.join(repo, 'nové jméno.txt')); g('add', '-A', '--', 'staré jméno.txt', 'nové jméno.txt');
  mkdirSync(path.join(repo, 'dir'));
  writeFileSync(path.join(repo, 'dir', 'nový s mezerou.md'), '# Ahoj\nřádek\n');
  writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 0, 2]));
  writeFileSync(path.join(repo, 'velký.txt'), 'x'.repeat(MAX_UNTRACKED + 1));
});

test('gitFiles na skutečném repu', async () => {
  const r = await gitFiles(cfg, repo);
  assert.equal(r.branch, 'main');
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(by['a.txt'].y, 'M');
  assert.equal(by['b.txt'].x, 'M'); assert.equal(by['b.txt'].y, 'M');
  assert.equal(by['nové jméno.txt'].kind, 'renamed');
  assert.equal(by['nové jméno.txt'].orig, 'staré jméno.txt');
  assert.equal(by['dir/nový s mezerou.md'].kind, 'untracked');
  assert.equal(await gitFiles(cfg, path.join(root, '.test-state', 'neexistuje')), null);
});

test('gitDiff = git diff (worktree i staged), nesledovaný soubor jako přidaný', async () => {
  const w = await gitDiff(cfg, repo, 'a.txt', 'worktree');
  assert.equal(w.diff, g('diff', '--no-color', '--', 'a.txt'));
  assert.match(w.diff, /^\+DVA$/m);
  const s = await gitDiff(cfg, repo, 'b.txt', 'staged');
  assert.equal(s.diff, g('diff', '--cached', '-M', '--no-color', '--', 'b.txt'));
  assert.match(s.diff, /^\+b2$/m);
  const ren = await gitDiff(cfg, repo, 'nové jméno.txt', 'staged');
  assert.match(ren.diff, /rename from staré jméno.txt/);
  const u = await gitDiff(cfg, repo, 'dir/nový s mezerou.md', 'untracked');
  assert.match(u.diff, /^@@ -0,0 \+1,2 @@$/m);
  assert.match(u.diff, /^\+řádek$/m);
  assert.match((await gitDiff(cfg, repo, 'bin.dat', 'untracked')).note, /binární/);
  assert.match((await gitDiff(cfg, repo, 'velký.txt', 'untracked')).note, /příliš velký/);
});

test('gitDiff: jen soubory ze status, jen platná oblast', async () => {
  const st = (p, a) => gitDiff(cfg, repo, p, a).then(() => 0, (e) => e.status);
  assert.equal(await st('../../package.json', 'worktree'), 404);
  assert.equal(await st('.git/config', 'untracked'), 404);
  assert.equal(await st('a.txt', 'staged'), 400);        // nemá připravené změny
  assert.equal(await st('a.txt', 'untracked'), 400);
  assert.equal(await st('a.txt', 'evil'), 400);
  assert.equal(await st('', 'worktree'), 400);
  assert.equal(await st('a\0b', 'worktree'), 400);
  assert.equal(await st('dir/nový s mezerou.md', 'worktree'), 400);
});

test('gitDiff: nesledovaný symbolický odkaz se nečte', { skip: process.platform === 'win32' ? 'symlink na Windows vyžaduje oprávnění' : false }, async () => {
  symlinkSync(path.join(root, 'package.json'), path.join(repo, 'odkaz'));
  const r = await gitDiff(cfg, repo, 'odkaz', 'untracked');
  assert.equal(r.diff, '');
  assert.match(r.note, /Symbolický odkaz/);
});
