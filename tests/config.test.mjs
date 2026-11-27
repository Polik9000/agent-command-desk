// Konfigurace a platformní vrstva (bez skutečného claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/server/lib/config.mjs';
import { expand, forPlatform, isUnder, samePath, checkClaudeExe, IS_WIN } from '../src/server/lib/platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.test-state', 'config');
mkdirSync(tmp, { recursive: true });

function writeCfg(name, obj) {
  const f = path.join(tmp, name);
  writeFileSync(f, JSON.stringify(obj));
  return f;
}
const base = () => ({
  claudeExe: process.execPath,
  accounts: [{ id: 'a', label: 'A', configDir: '~/.claude-a', expectedEmail: 'a@example.com' }],
  projects: [{ id: 'p', label: 'P', path: '~/code/p' }],
});

test('expand: ~, %VAR%, $VAR', () => {
  process.env.ACD_TEST_DIR = path.join(os.tmpdir(), 'acd');
  assert.equal(expand('~/x'), path.join(os.homedir(), 'x'));
  assert.equal(expand('%ACD_TEST_DIR%/y'), path.join(os.tmpdir(), 'acd', 'y'));
  assert.equal(expand('$ACD_TEST_DIR/y'), path.join(os.tmpdir(), 'acd', 'y'));
  assert.equal(expand('${ACD_TEST_DIR}/y'), path.join(os.tmpdir(), 'acd', 'y'));
  assert.equal(expand(''), '');
});

test('forPlatform: řetězec nebo objekt podle platformy', () => {
  assert.equal(forPlatform('x'), 'x');
  assert.equal(forPlatform({ [process.platform]: 'moje' }), 'moje');
  assert.equal(forPlatform({ nejaka: 'jina' }), undefined);
  assert.equal(forPlatform(42), undefined);
});

test('isUnder / samePath', () => {
  const parent = path.join(os.tmpdir(), 'ucet');
  assert.ok(isUnder(path.join(parent, 'projects'), parent));
  assert.ok(!isUnder(parent + '-jiny', parent));
  assert.ok(!isUnder(parent, parent));
  assert.ok(samePath(parent + path.sep, parent));
});

test('checkClaudeExe: relativní cesta a neexistující soubor odmítnuty', () => {
  assert.match(checkClaudeExe('claude'), /absolutní/);
  assert.match(checkClaudeExe(path.join(os.tmpdir(), 'neexistuje', IS_WIN ? 'claude.exe' : 'claude')), /nenalezen/);
  assert.equal(checkClaudeExe(process.execPath), null);
  if (IS_WIN) assert.match(checkClaudeExe('C:\\x\\claude.cmd'), /\.exe/);
});

test('config.example.json je platný (kromě cesty ke claude)', () => {
  const cfg = loadConfig(path.join(root, 'config.example.json'), { checkExe: false });
  assert.equal(cfg.app.id, 'agent-command-desk');
  assert.equal(cfg.accounts[0].configDirFull, path.join(os.homedir(), '.claude-work'));
  assert.ok(path.isAbsolute(cfg.projects[0].pathFull));
  assert.ok(cfg.appendSystemPrompt.includes('Agent Command Desk'));
  assert.ok(!cfg.appendSystemPrompt.includes('{appName}'));
});

test('chybějící konfigurace → srozumitelná chyba', () => {
  assert.throws(() => loadConfig(path.join(tmp, 'neni.json')), /config\.example\.json/);
});

test('výchozí hodnoty: app, defaultAccount, stateDir podle app.id', () => {
  const cfg = loadConfig(writeCfg('min.json', base()));
  assert.equal(cfg.app.name, 'Agent Command Desk');
  assert.equal(cfg.defaultAccount, 'a');
  assert.ok(cfg.stateDirFull.endsWith('agent-command-desk'));
  assert.equal(cfg.accounts[0].accent, '#7aa2ff');
});

test('neplatné hodnoty odmítnuty', () => {
  assert.throws(() => loadConfig(writeCfg('id.json', { ...base(), app: { id: '../zlé', name: 'x' } })), /app\.id/);
  assert.throws(() => loadConfig(writeCfg('mail.json', { ...base(), accounts: [{ id: 'a', label: 'A', configDir: '~/x' }] })), /expectedEmail/);
  assert.throws(() => loadConfig(writeCfg('dup.json', { ...base(), projects: [base().projects[0], base().projects[0]] })), /duplicitní/);
  assert.throws(() => loadConfig(writeCfg('def.json', { ...base(), defaultAccount: 'osobni' })), /defaultAccount/);
  assert.throws(() => loadConfig(writeCfg('exe.json', { ...base(), claudeExe: 'claude' })), /claude/);
});

test('models: výchozí seznam, vlastní seznam vždy s „Výchozí účtu“, neplatné id odmítnuto', () => {
  const def = loadConfig(writeCfg('m1.json', base()));
  assert.deepEqual(def.models.map((m) => m.id), ['', 'opus', 'sonnet', 'fable']);
  const own = loadConfig(writeCfg('m2.json', { ...base(), models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] }));
  assert.deepEqual(own.models.map((m) => m.id), ['', 'claude-opus-5-5']);
  assert.throws(() => loadConfig(writeCfg('m3.json', { ...base(), models: [{ id: '--dangerously-skip-permissions', label: 'x' }] })), /models/);
  assert.throws(() => loadConfig(writeCfg('m4.json', { ...base(), models: [{ id: 'a b', label: 'x' }] })), /models/);
});

test('interactivePermissions: výchozí false, jen boolean', () => {
  assert.equal(loadConfig(writeCfg('ip1.json', base())).interactivePermissions, false);
  assert.equal(loadConfig(writeCfg('ip2.json', { ...base(), interactivePermissions: true })).interactivePermissions, true);
  assert.throws(() => loadConfig(writeCfg('ip3.json', { ...base(), interactivePermissions: 'ano' })), /interactivePermissions/);
});
