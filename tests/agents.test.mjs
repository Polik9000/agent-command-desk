// Karty agentů a orchestrace v UI (wwwroot/agents.js): model pracovníka, součty bez dvojího počítání, režim podle sezení.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(path.join(root, 'src', 'server', 'wwwroot', 'agents.js'), 'utf8'), sandbox);
const A = sandbox.window.Agents;
const plain = (v) => JSON.parse(JSON.stringify(v));

test('workerModel: volání > definice pracovníka; inherit = model sezení; jinak nehádat', () => {
  const w = A.workerMap({ active: true, workers: [{ name: 'acd-explore', model: 'haiku' }, { name: 'acd-x', model: 'inherit' }] });
  assert.equal(A.workerModel({ subagent_type: 'acd-explore' }, w, 'opus'), 'haiku');
  assert.equal(A.workerModel({ subagent_type: 'acd-explore', model: 'sonnet' }, w, 'opus'), 'sonnet', 'model z volání má přednost');
  assert.equal(A.workerModel({ subagent_type: 'acd-x' }, w, 'opus'), 'opus');
  assert.equal(A.workerModel({ subagent_type: 'acd-x' }, w, ''), null, 'výchozí model sezení neznáme');
  assert.equal(A.workerModel({ subagent_type: 'Explore' }, w, 'opus'), null, 'vestavěný agent bez modelu = neznámý');
  assert.equal(A.workerModel({ subagent_type: 'constructor' }, w, 'opus'), null);
  assert.equal(A.workerModel(null, w, 'opus'), null);
  assert.deepEqual(plain(A.workerMap({ active: false, workers: [{ name: 'acd-explore', model: 'haiku' }] })), {}, 'neaktivní orchestrace = žádné pracovníky');
});

test('turnUsage/allTokens: součet jen z modelUsage, bez dvojího počítání; bez dat s pracovníky = neúplné', () => {
  const ev = { usage: { input: 4, output: 296, cacheRead: 59888, cacheWrite: 28048 }, subagents: { spawned: 1 },
    modelUsage: [{ model: 'claude-sonnet-5-5', input: 4, output: 296, cacheRead: 59888, cacheWrite: 28048, costUsd: 0.12 },
      { model: 'claude-haiku-5-5', input: 4, output: 322, cacheRead: 4306, cacheWrite: 9105, costUsd: 0.0013 }] };
  const t = A.turnUsage(ev.modelUsage);
  assert.equal(t.rows.length, 2);
  assert.equal(t.total, 4 + 296 + 59888 + 28048 + 4 + 322 + 4306 + 9105);
  assert.ok(Math.abs(t.cost - 0.1213) < 1e-9);
  assert.deepEqual(plain(A.allTokens(ev)), { tokens: t.total, partial: false });
  assert.deepEqual(plain(A.allTokens({ usage: ev.usage, subagents: { spawned: 2 } })), { tokens: 88236, partial: true });
  assert.deepEqual(plain(A.allTokens({ usage: ev.usage })), { tokens: 88236, partial: false }, 'bez pracovníků je hlavní konverzace vše');
  assert.equal(A.turnUsage(undefined), null);
});

test('režim orchestrace podle sezení: výchozí pro nové, uložený pro známé, nejvýš 200 sezení', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(A.sessionOrch(storage, null, 'auto'), 'auto');
  assert.equal(A.sessionOrch(storage, 's1', 'off'), 'off');
  A.saveSessionOrch(storage, 's1', 'auto');
  assert.equal(A.sessionOrch(storage, 's1', 'off'), 'auto');
  A.saveSessionOrch(storage, 's1', 'nesmysl');
  assert.equal(A.sessionOrch(storage, 's1', 'off'), 'auto');
  for (let i = 0; i < 205; i++) A.saveSessionOrch(storage, `x${i}`, 'off');
  const m = JSON.parse(mem.get('acd.orch'));
  assert.equal(Object.keys(m).length, A.ORCH_MAX);
  assert.equal(m.s1, undefined, 'nejstarší vypadlo');
  assert.equal(A.sessionOrch(storage, 's1', 'off'), 'off');
  mem.set('acd.orch', '{rozbité');
  assert.equal(A.sessionOrch(storage, 'x204', 'auto'), 'auto');
});
