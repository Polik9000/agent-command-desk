// Hledání v konverzaci, čísla řádků diffu a zpráva z komentářů (wwwroot/review.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(path.join(root, 'src', 'server', 'wwwroot', 'review.js'), 'utf8'), sandbox);
const { findAll, diffLines, commentsMessage, inlineCode } = sandbox.window.Review;
const plain = (v) => JSON.parse(JSON.stringify(v)); // pole z jiného kontextu vm

test('findAll: bez diakritiky a velikosti písmen, pozice v původním textu', () => {
  const t = 'Čtenářský PIKNIK a čtenáři';
  assert.deepEqual(plain(findAll(t, 'ctenar')), [[0, 6], [19, 25]]);
  assert.equal(t.slice(...findAll(t, 'piknik')[0]), 'PIKNIK');
  assert.deepEqual(plain(findAll(t, 'ČTENÁŘ')), [[0, 6], [19, 25]]);
  assert.deepEqual(plain(findAll(t, '  ')), []);
  assert.deepEqual(plain(findAll('', 'x')), []);
  assert.deepEqual(plain(findAll('aaaa', 'aa')), [[0, 2], [2, 4]]); // nepřekrývající se
});

test('findAll: rozložené znaky (NFD) a emoji', () => {
  const nfd = 'Café a cafe';
  assert.deepEqual(plain(findAll(nfd, 'café')), [[0, 5], [8, 12]]);
  const e = 'ok 👍 hotovo';
  const [[s, end]] = findAll(e, 'hotovo');
  assert.equal(e.slice(s, end), 'hotovo');
  assert.equal(e.slice(...findAll(e, '👍 h')[0]), '👍 h');
});

test('diffLines: čísla řádků podle hlavičky úseku', () => {
  const d = ['diff --git a/x.js b/x.js', 'index 1..2 100644', '--- a/x.js', '+++ b/x.js',
    '@@ -10,3 +10,4 @@ function f()', ' a', '-b', '+B', '+C', ' d', '\\ No newline at end of file', '@@ -40 +41 @@', '-z'].join('\n') + '\n';
  const r = plain(diffLines(d)).map((l) => [l.kind, l.line ?? null, l.side ?? null]);
  assert.deepEqual(r, [
    ['file', null, null], ['file', null, null], ['file', null, null], ['file', null, null],
    ['hunk', null, null], ['ctx', 10, 'new'], ['del', 11, 'old'], ['add', 11, 'new'], ['add', 12, 'new'], ['ctx', 13, 'new'],
    ['meta', null, null], ['hunk', null, null], ['del', 40, 'old'],
  ]);
});

test('diffLines: nový soubor od řádku 1, „--- “ uvnitř úseku je odebraný řádek', () => {
  const r = plain(diffLines('--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+# A\n+-- B\n'));
  assert.deepEqual(r.slice(3).map((l) => [l.kind, l.line]), [['add', 1], ['add', 2]]);
  const r2 = plain(diffLines('@@ -1,2 +1,1 @@\n--- odebraný komentář\n+++ přidaný\n'));
  assert.deepEqual(r2.map((l) => l.kind), ['hunk', 'del', 'add']);
});

test('commentsMessage: seřazené podle souboru a řádku, kód i poznámka', () => {
  const m = commentsMessage([
    { file: 'src/b.js', area: 'worktree', kind: 'del', line: 7, side: 'old', text: '-old()', note: 'Tohle vrať.' },
    { file: 'src/a.js', area: 'untracked', kind: 'add', line: 3, side: 'new', text: '+const x = `a`;', note: 'Přejmenuj\nna count.' },
  ]);
  assert.equal(m, [
    'Moje komentáře ke změnám v projektu (git diff). Projdi je a uprav kód podle nich:', '',
    '1. `src/a.js`, přidaný řádek 3, nový soubor: ``const x = `a`;``',
    '   Přejmenuj', '   na count.',
    '2. `src/b.js`, odebraný řádek 7 (číslováno podle původní verze), neuložené změny: `old()`',
    '   Tohle vrať.',
  ].join('\n'));
});

test('inlineCode: zpětné apostrofy v textu', () => {
  assert.equal(inlineCode('a'), '`a`');
  assert.equal(inlineCode('a``b'), '```a``b```');
  assert.equal(inlineCode('`x'), '`` `x ``');
});
