// AccountGuard: účet se povolí jen při shodě e-mailu a složek (falešný `claude auth status`, žádný skutečný claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountGuard } from '../src/server/lib/claude.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configDir = path.join(root, '.test-state', 'accounts', '.claude-work');
mkdirSync(configDir, { recursive: true });

const account = { id: 'work', label: 'Work', accent: '#fff', expectedEmail: 'Me@Example.com', configDirFull: configDir };
const cfg = { claudeExeFull: process.execPath, accounts: [account] };
const ok = { loggedIn: true, email: 'me@example.com', configDirectory: configDir, projectsDirectory: path.join(configDir, 'projects') };

const guard = (status, timedOut = false) =>
  new AccountGuard(/** @type {any} */ (cfg), () => {}, async () => ({ stdout: JSON.stringify(status), timedOut }));

test('shoda e-mailu (bez ohledu na velikost písmen) a složek → povoleno', async () => {
  const s = await guard(ok).check(account);
  assert.equal(s.ok, true);
  assert.equal(s.projectsDirectory, path.join(configDir, 'projects'));
});

test('jiný e-mail (např. osobní účet) → zamítnuto', async () => {
  const s = await guard({ ...ok, email: 'osobni@example.com' }).check(account);
  assert.equal(s.ok, false);
  assert.match(s.error, /jiný účet/);
});

test('nepřihlášen → zamítnuto', async () => {
  const s = await guard({ ...ok, loggedIn: false }).check(account);
  assert.equal(s.ok, false);
  assert.match(s.error, /není přihlášen/);
});

test('jiná konfigurační složka → zamítnuto', async () => {
  const s = await guard({ ...ok, configDirectory: path.join(root, '.test-state', 'jina') }).check(account);
  assert.equal(s.ok, false);
  assert.match(s.error, /konfigurační složku/);
});

test('složka sezení mimo účet → zamítnuto', async () => {
  const s = await guard({ ...ok, projectsDirectory: path.join(root, '.test-state', 'jinde') }).check(account);
  assert.equal(s.ok, false);
  assert.match(s.error, /mimo složku účtu/);
});

test('nesmyslný výstup / vypršení → zamítnuto', async () => {
  const bad = new AccountGuard(/** @type {any} */ (cfg), () => {}, async () => ({ stdout: 'není json', timedOut: false }));
  assert.equal((await bad.check(account)).ok, false);
  const slow = new AccountGuard(/** @type {any} */ (cfg), () => {}, async () => ({ stdout: '', timedOut: true }));
  assert.match((await slow.check(account)).error, /vypršela/);
});

test('neexistující složka účtu → zamítnuto bez spuštění claude', async () => {
  let called = false;
  const g = new AccountGuard(/** @type {any} */ (cfg), () => {}, async () => { called = true; return { stdout: '{}', timedOut: false }; });
  const s = await g.check({ ...account, configDirFull: path.join(root, '.test-state', 'neexistuje') });
  assert.equal(s.ok, false);
  assert.equal(called, false);
});
