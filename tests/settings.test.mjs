// Nastavení: zápis projektů do konfigurace (jen projekty, validace cest, atomický zápis se zálohou).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseConfig } from '../src/server/lib/config.mjs';
import { changeProjects, slugId, checkLabel, settingsView } from '../src/server/lib/settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.test-state', 'settings');
const file = path.join(dir, 'config.json');
const acct = path.join(dir, 'acct');
const state = path.join(dir, 'state');
const projA = path.join(dir, 'proj-a');
const projB = path.join(dir, 'proj b – čeština');

const raw = () => ({
  app: { id: 'acd-settings', name: 'ACD' },
  claudeExe: process.execPath,
  stateDir: state,
  accounts: [{ id: 'a', label: 'A', configDir: acct, expectedEmail: 'a@example.com' }],
  defaultProject: 'pa',
  projects: [{ id: 'pa', label: 'A', path: projA }],
});
let cfg;
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const d of [acct, state, projA, projB, path.join(acct, 'inner'), path.join(projA, 'sub')]) mkdirSync(d, { recursive: true });
  writeFileSync(file, JSON.stringify(raw(), null, 2).replace(/\n/g, '\r\n'));
  cfg = loadConfig(file);
});
const add = (label, p) => changeProjects(file, cfg, { op: 'add', label, path: p });
const err = (status, rx) => (e) => e.status === status && rx.test(e.message);

test('parseConfig: stejná validace jako loadConfig, vstup nezmění', () => {
  const r = raw();
  const c = parseConfig(r, 'x.json');
  assert.equal(c.projects[0].pathFull, projA);
  assert.equal(r.projects[0].pathFull, undefined);
  assert.throws(() => parseConfig({ ...r, projects: [] }, 'x.json'), /projects je prázdné/);
  assert.throws(() => parseConfig([], 'x.json'), /očekávám objekt/);
});

test('slugId a checkLabel', () => {
  assert.equal(slugId('Čtu web – nový', new Set()), 'ctu-web-novy');
  assert.equal(slugId('web', new Set(['web', 'web-2'])), 'web-3');
  assert.equal(slugId('***', new Set()), 'projekt');
  assert.equal(checkLabel('  a   b '), 'a b');
  assert.throws(() => checkLabel(''), err(400, /1–60/));
  assert.throws(() => checkLabel('x'.repeat(61)), err(400, /1–60/));
  assert.throws(() => checkLabel('a\u0007'), err(400, /1–60/));
});

test('přidání: zapíše jen projekty, se zálohou, zachová CRLF a ostatní pole; config v paměti se obnoví', () => {
  const before = readFileSync(file, 'utf8');
  const r = add('Projekt B', projB);
  assert.equal(r.id, 'projekt-b');
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), before);
  assert.equal(existsSync(`${file}.tmp`), false);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /\r\n/);
  const disk = JSON.parse(text);
  assert.deepEqual(disk.accounts, raw().accounts);
  assert.equal(disk.projects[1].path, projB);
  assert.equal(cfg.projects.length, 2);
  assert.equal(cfg.projects[1].pathFull, projB);
  assert.deepEqual(settingsView(cfg).projects.map((p) => p.id), ['pa', 'projekt-b']);
  assert.equal(loadConfig(file).projects.length, 2); // soubor jde znovu načíst
});

test('přidání: neplatné cesty → 400 a soubor beze změny', () => {
  const before = readFileSync(file, 'utf8');
  const cases = [
    ['', /Zadejte cestu/],
    ['relativni/cesta', /celou cestu/],
    [path.join(dir, 'neexistuje'), /neexistuje/],
    [file, /neexistuje/],                       // soubor, ne složka
    [path.parse(root).root, /Kořen disku/],
    [os.homedir(), /Domovskou/],
    [path.dirname(os.homedir()), /Domovskou/],
    [acct, /složce účtu/],
    [path.join(acct, 'inner'), /složce účtu/],
    [state, /složce účtu/],
    [dir, /složce účtu/],                        // obsahuje složku účtu i stavu
    [projA, /už je mezi projekty/],
  ];
  for (const [p, rx] of cases) assert.throws(() => add('X', p), err(400, rx), p);
  assert.throws(() => add('', projB), err(400, /1–60/));
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(`${file}.bak`), false);
  assert.equal(cfg.projects.length, 1);
});

test('přidání: podsložka existujícího projektu je povolená', () => {
  assert.equal(add('Sub', path.join(projA, 'sub')).id, 'sub');
});

test('přejmenování a odebrání; poslední projekt ani běžící projekt odebrat nejde', () => {
  add('B', projB);
  changeProjects(file, cfg, { op: 'rename', id: 'b', label: 'Béčko' });
  assert.equal(cfg.projects[1].label, 'Béčko');
  assert.equal(cfg.projects[1].id, 'b');
  assert.throws(() => changeProjects(file, cfg, { op: 'rename', id: 'nic', label: 'x' }), err(404, /Neznámý/));
  assert.throws(() => changeProjects(file, cfg, { op: 'remove', id: 'pa' }, { isBusy: (id) => id === 'pa' }), err(409, /běží/));
  changeProjects(file, cfg, { op: 'remove', id: 'pa' });
  assert.equal(cfg.defaultProject, 'b');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultProject, 'b');
  assert.throws(() => changeProjects(file, cfg, { op: 'remove', id: 'b' }), err(400, /Poslední/));
  assert.throws(() => changeProjects(file, cfg, /** @type {any} */ ({ op: 'accounts' })), err(400, /operace/));
});

test('poškozený soubor na disku → 409, nic se nepřepíše', () => {
  writeFileSync(file, '{ nejde');
  assert.throws(() => add('B', projB), err(409, /JSON/));
  assert.equal(readFileSync(file, 'utf8'), '{ nejde');
});

test('výchozí projekt', () => {
  add('B', projB);
  const id = cfg.projects[1].id;
  changeProjects(file, cfg, { op: 'default', id });
  assert.equal(cfg.defaultProject, id);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).defaultProject, id);
  assert.throws(() => changeProjects(file, cfg, { op: 'default', id: 'nic' }), err(404, /Neznámý/));
});

test('účty: přidat s ověřenou složkou a e-mailem, odebrat; ochrany', () => {
  const acc = (o) => changeProjects(file, cfg, { op: 'addAccount', label: 'Práce', configDir: path.join(dir, '.claude-prace'), expectedEmail: 'Prace@Example.com', accent: '#123abc', ...o });
  const r = acc({});
  assert.equal(r.id, 'prace');
  const saved = JSON.parse(readFileSync(file, 'utf8')).accounts;
  assert.deepEqual(saved[1], { id: 'prace', label: 'Práce', configDir: path.join(dir, '.claude-prace'), expectedEmail: 'prace@example.com', accent: '#123abc' });
  assert.equal(cfg.accounts.length, 2);
  assert.throws(() => acc({ configDir: path.join(dir, 'jina') }), err(400, /e-mailem/));
  assert.throws(() => acc({ expectedEmail: 'b@example.com', configDir: acct }), err(400, /jiný účet/));
  assert.throws(() => acc({ expectedEmail: 'b@example.com', configDir: path.join(projA, '.claude') }), err(400, /projekt/));
  assert.throws(() => acc({ expectedEmail: 'b@example.com', configDir: os.homedir() }), err(400, /Domovská/));
  assert.throws(() => acc({ expectedEmail: 'neni-email', configDir: path.join(dir, 'x') }), err(400, /e-mail/));
  assert.throws(() => acc({ expectedEmail: 'b@example.com', configDir: 'relativni' }), err(400, /celou cestu/));
  assert.throws(() => changeProjects(file, cfg, { op: 'removeAccount', id: 'prace' }, { isBusy: () => true }), err(409, /běží/));
  changeProjects(file, cfg, { op: 'removeAccount', id: 'prace' });
  assert.equal(cfg.accounts.length, 1);
  assert.throws(() => changeProjects(file, cfg, { op: 'removeAccount', id: 'a' }), err(400, /Poslední/));
});
