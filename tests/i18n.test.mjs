// Překlad rozhraní: každý text v kódu (_t('…')) má anglický překlad se stejnými {n}; hlášky serveru se překládají podle vzoru.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'wwwroot');
const read = (f) => readFileSync(path.join(W, f), 'utf8');
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');

function load(lang) {
  const store = { 'acd.lang': lang };
  const win = { localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } } };
  win.window = win;
  const doc = { documentElement: {}, addEventListener() {} };
  vm.runInNewContext(`${read('i18n.en.js')}\n${read('i18n.js')}`, { window: win, document: doc, localStorage: win.localStorage });
  return win;
}

const en = load('cs').ACD_EN;

test('každý _t(\'…\') v app.js, review.js a queue.js má překlad se stejnými {n}', () => {
  const missing = [];
  for (const f of ['app.js', 'review.js', 'queue.js']) {
    for (const m of read(f).matchAll(/_t\('((?:[^'\\]|\\.)*)'/g)) {
      const key = m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      if (!(key in en)) missing.push(`${f}: ${key}`);
      else assert.equal(placeholders(en[key]), placeholders(key), `proměnné: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('překlady neobsahují zbytky češtiny a mají stejné proměnné', () => {
  const CZ = /[ěščřžůďťňĚŠČŘŽŮĎŤŇ]/; // á í é ú ý by mohly být v anglických názvech; tyto znaky ne
  for (const [k, v] of Object.entries(en)) {
    assert.equal(placeholders(v), placeholders(k), k);
    assert.equal(CZ.test(v), false, `čeština v překladu: ${v}`);
  }
});

test('čeština: _t vrací klíč a dosadí proměnné; angličtina: překlad, chybějící klíč česky', () => {
  const cs = load('cs');
  assert.equal(cs._t('Účet {0} narazil na limit.', 'Práce'), 'Účet Práce narazil na limit.');
  assert.equal(cs._tr('Neznámý model.'), 'Neznámý model.');
  const e = load('en');
  assert.equal(e._t('Účet {0} narazil na limit.', 'Work'), 'Account Work hit its limit.');
  assert.equal(e._t('Něco, co ve slovníku není'), 'Něco, co ve slovníku není');
  assert.equal(e.LOC, 'en-GB');
});

test('_tr: hlášky serveru – přesná shoda i vzor, zachycené části se překládají znovu', () => {
  const e = load('en');
  assert.equal(e._tr('Neznámý model.'), 'Unknown model.');
  assert.equal(e._tr('Účet Práce není ověřen: Složka účtu neexistuje.'), 'Account Práce is not verified: The account folder does not exist.');
  assert.equal(e._tr('Fronta je plná (max. 50).'), 'The queue is full (max. 50).');
  assert.equal(e._tr('Nikdy neviděná hláška'), 'Nikdy neviděná hláška');
  assert.equal(e._tr(''), '');
});
