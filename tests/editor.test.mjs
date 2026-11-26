// Pokračování seznamů v poli pro psaní (wwwroot/editor.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(path.join(root, 'src', 'server', 'wwwroot', 'editor.js'), 'utf8'), sandbox);
const { continueList } = sandbox.window.ListEditor;

/** Simulace Enteru: vrátí [nový text, nová pozice kurzoru], nebo null. */
function enter(text, caret = text.length) {
  const r = continueList(text, caret);
  if (!r) return null;
  return [text.slice(0, r.from) + r.insert + text.slice(r.to), r.caret];
}

test('číslovaný seznam pokračuje dalším číslem', () => {
  assert.deepEqual([...enter('1. jablka')], ['1. jablka\n2. ', 13]);
  assert.deepEqual([...enter('úvod\n9) hrušky')], ['úvod\n9) hrušky\n10) ', 19]);
  assert.equal(enter('Nákup:\n  3. mléko')[0], 'Nákup:\n  3. mléko\n  4. ');
});

test('odrážky a zaškrtávací položky pokračují stejnou značkou', () => {
  assert.equal(enter('- chleba')[0], '- chleba\n- ');
  assert.equal(enter('* máslo')[0], '* máslo\n* ');
  assert.equal(enter('- [x] hotovo')[0], '- [x] hotovo\n- [ ] ');
});

test('Enter na prázdné položce seznam ukončí', () => {
  assert.deepEqual([...enter('1. jablka\n2. ')], ['1. jablka\n', 10]);
  assert.deepEqual([...enter('- a\n- ')], ['- a\n', 4]);
});

test('obyčejný text a kurzor uvnitř značky → obyčejný Enter', () => {
  assert.equal(enter('Ahoj, jak se máš'), null);
  assert.equal(enter('2026. rok'), null); // letopočet není číslovaný seznam
  assert.equal(continueList('1. jablka', 1), null);
  assert.equal(enter(''), null);
});

test('Enter uprostřed položky rozdělí text do nové položky', () => {
  const t = '1. jablka hrušky';
  assert.equal(enter(t, 9)[0], '1. jablka\n2.  hrušky');
});
