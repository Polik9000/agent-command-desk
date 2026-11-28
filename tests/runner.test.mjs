// Proces claude na sezení: převzetí čekajícího procesu, nový proces při jiném nastavení, pojistky režimu, limit čekání.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner, commandsInfo } from '../src/server/lib/claude.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(root, 'tests', 'fixtures', 'fake-claude.mjs');
const cfg = (extra = {}) => ({ claudeExeFull: process.execPath, interactivePermissions: false, appendSystemPrompt: '',
  disallowedTools: [], sessionProcessMinutes: 10, ...extra });
const spawnFn = (exe, args, opts) => spawn(process.execPath, [FAKE, ...args], opts);
const account = { id: 'a', configDirFull: path.join(root, '.test-state', 'runner-acc') };
const project = { id: 'p', pathFull: root };
const logs = [];
const mk = (extra, opts = {}) => new ClaudeRunner(cfg(extra), (m) => logs.push(m), { spawnFn, ...opts });

/** Jeden tah: vrátí události a výsledek (pid procesu a číslo tahu z falešného claude). */
async function turn(runner, prompt, resume = null, mode = 'auto', opts = {}) {
  const run = await runner.start(account, project, mode, prompt, resume, { addDirs: [], ...opts });
  const events = [];
  run.on('event', (e) => events.push(e));
  await new Promise((r) => run.once('end', r));
  const result = events.find((e) => e.type === 'result');
  const [, pid, , n] = String(result?.result ?? '').split(':');
  return { run, events, pid, turn: Number(n), exit: events.find((e) => e.type === 'exit'), sessionId: run.sessionId };
}
const closed = (runner) => Promise.all([...runner.idle.values()].map((p) => p.closed));

test('stejné sezení → stejný proces; čekající proces nedrží sezení', async () => {
  const r = mk();
  const t1 = await turn(r, 'ahoj');
  assert.equal(t1.exit.kept, true);
  assert.equal(t1.run.warm, false);
  assert.equal(r.idle.size, 1);
  assert.equal(r.isSessionBusy(t1.sessionId), false, 'čekající proces neblokuje sezení');
  const t2 = await turn(r, 'znovu', t1.sessionId);
  assert.equal(t2.run.warm, true);
  // Cena: Claude Code posílá součet za proces (0,1 → 0,2); ven jde cena jen tohoto tahu.
  const cost = (t) => t.events.find((e) => e.type === 'result');
  assert.equal(cost(t1).costUsd, 0.1);
  assert.ok(Math.abs(cost(t2).costUsd - 0.1) < 1e-9 && Math.abs(cost(t2).totalCostUsd - 0.2) < 1e-9);
  assert.equal(t2.pid, t1.pid);
  assert.equal(t2.turn, 2);
  const t3 = await turn(r, 'plán', t1.sessionId, 'plan');
  assert.equal(t3.pid, t1.pid, 'jiný režim = řídicí příkaz, ne nový proces');
  assert.equal(t3.sessionId, t1.sessionId);
  const t4 = await turn(r, 'model', t1.sessionId, 'plan', { model: 'sonnet', effort: 'high' });
  assert.notEqual(t4.pid, t3.pid);
  assert.equal(r.idle.size, 1, 'na sezení nejvýš jeden čekající proces');
  r.stopAll();
  await closed(r);
});

test('ExitPlanMode, chyba nebo sessionProcessMinutes 0 → proces se neodloží a skončí', async () => {
  const r = mk();
  const a = await turn(r, 'EXITPLAN', null, 'plan');
  assert.equal(a.exit.kept, undefined);
  assert.equal(a.exit.code, 0);
  assert.equal(r.idle.size, 0);
  const b = await turn(r, 'FAIL');
  assert.equal(b.exit.kept, undefined);
  assert.equal(r.idle.size, 0);
  const off = mk({ sessionProcessMinutes: 0 });
  const c = await turn(off, 'ahoj');
  assert.equal(c.exit.kept, undefined);
  assert.equal(off.idle.size, 0);
});

test('převzatý proces hlásí jiný režim → zastavit', async () => {
  const r = mk();
  const t1 = await turn(r, 'ahoj');
  const t2 = await turn(r, 'DRIFT', t1.sessionId);
  assert.ok(t2.events.some((e) => e.type === 'error' && /jiném režimu/.test(e.message)));
  assert.equal(t2.exit.stopped, true);
  assert.equal(t2.events.some((e) => e.type === 'result'), false, 'výsledek tahu v jiném režimu se nepředá');
  assert.equal(r.idle.size, 0);
});

test('limit čekání a nejvýš 3 čekající procesy; stopAll zavře i čekající', async () => {
  const r = mk({}, { idleMs: 200 });
  const t = await turn(r, 'ahoj');
  const p = r.idle.get(t.sessionId);
  await p.closed; // po 200 ms se vstup zavře a proces skončí
  assert.equal(r.idle.size, 0);

  const many = mk();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await turn(many, `s${i}`)).sessionId);
  assert.equal(many.idle.size, 3);
  assert.equal(many.idle.has(ids[0]), false, 'nejstarší se zavřel');
  const procs = [...many.idle.values()];
  many.stopAll();
  await Promise.all(procs.map((x) => x.closed));
  assert.equal(many.idle.size, 0);
});

test('closeProject zavře čekající procesy projektu', async () => {
  const r = mk();
  const t = await turn(r, 'ahoj');
  const p = r.idle.get(t.sessionId);
  r.closeProject('p');
  await p.closed;
  assert.equal(r.idle.size, 0);
});

test('převzatý proces: jiný režim a model přes řídicí příkaz (stejný proces), effort = nový proces', async () => {
  const r = mk();
  const t1 = await turn(r, 'ahoj', null, 'plan');
  const cmds = t1.events.find((e) => e.type === 'commands');
  assert.deepEqual(cmds.commands.map((c) => c.name), ['review']); // jen rozumné názvy
  assert.equal(cmds.commands[0].argumentHint, '[větev]');
  assert.deepEqual(cmds.agents, [{ name: 'Explore', description: 'Hledá v kódu' }]);
  const t2 = await turn(r, 'auto', t1.sessionId, 'auto', { model: 'sonnet' });
  assert.equal(t2.pid, t1.pid, 'režim a model se změní bez nového procesu');
  assert.equal(t2.events.find((e) => e.type === 'init').permissionMode, 'auto');
  assert.match(t2.events.find((e) => e.type === 'text').text, /model sonnet/);
  assert.equal(t2.exit.kept, true);
  const t3 = await turn(r, 'effort', t1.sessionId, 'auto', { model: 'sonnet', effort: 'low' });
  assert.notEqual(t3.pid, t1.pid);
  const t4 = await turn(r, 'výchozí model', t1.sessionId, 'auto', { effort: 'low' });
  assert.notEqual(t4.pid, t3.pid, 'zpět na výchozí model jen novým procesem');
  r.stopAll();
  await closed(r);
});

test('přerušení: tah skončí, proces zůstane připravený; kontext ze sezení', async () => {
  const r = mk();
  const run = await r.start(account, project, 'auto', 'SLOW', null, { addDirs: [] });
  const events = [];
  run.on('event', (e) => events.push(e));
  await new Promise((res) => setTimeout(res, 400));
  run.interrupt();
  await new Promise((res) => run.once('end', res));
  const result = events.find((e) => e.type === 'result');
  assert.equal(result.interrupted, true);
  const exit = events.find((e) => e.type === 'exit');
  assert.equal(exit.kept, true);
  assert.equal(exit.stopped, true);
  const t2 = await turn(r, 'dál', run.sessionId);
  assert.equal(t2.run.warm, true);
  const c = await r.sessionControl(account, project, run.sessionId, 'get_context_usage');
  assert.equal(c.percentage, 12);
  r.stopAll();
  await closed(r);
});

test('kopie sezení: nové id, původní sezení neblokuje', async () => {
  const r = mk();
  const t1 = await turn(r, 'ahoj');
  const copy = await r.start(account, project, 'plan', 'bokem', t1.sessionId, { addDirs: [], side: true });
  assert.equal(r.isSessionBusy(t1.sessionId), false);
  const ev2 = [];
  copy.on('event', (e) => ev2.push(e));
  await new Promise((res) => copy.once('end', res));
  assert.notEqual(copy.sessionId, t1.sessionId);
  assert.equal(ev2.find((e) => e.type === 'exit').kept, undefined, 'otázka bokem se neodkládá');
  r.stopAll();
  await closed(r);
});

test('commandsInfo: popisy zkrácené, účet a nic dalšího se nepředá', () => {
  const c = commandsInfo({ commands: [{ name: 'x', description: 'a\n  b', argumentHint: 1 }], account: { email: 'tajne@example.com' }, agents: ['Plan'] });
  assert.deepEqual(c, { commands: [{ name: 'x', description: 'a b', argumentHint: '' }], agents: [{ name: 'Plan', description: '' }] });
  assert.deepEqual(commandsInfo(null), { commands: [], agents: [] });
});

/* ---- issue #2: úvodní události (commands z initialize) se nesmí ztratit ---- */
const batchSpawn = (exe, args, opts) => spawn(process.execPath, [FAKE, '--fake-batch', ...args], opts);
const events = (run) => { const list = []; run.on('event', (e) => list.push(e)); return list; };
/** Čeká na podmínku (ne pevnou dobu): kontroluje každých 5 ms, nejvýš 10 s. */
async function until(cond, maxMs = 10_000) {
  const end = Date.now() + maxMs;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'podmínka nenastala');
}

test('initialize ve stejném bloku jako celý tah → commands patří prvnímu tahu, před result', async () => {
  const r = mk({}, { spawnFn: batchSpawn });
  const run = await r.start(account, project, 'auto', 'ahoj', null, { addDirs: [] });
  const ev1 = events(run);
  await new Promise((res) => run.once('end', res));
  const types = ev1.map((e) => e.type);
  assert.ok(types.includes('commands'), `commands chybí: ${types.join(',')}`);
  assert.ok(types.indexOf('commands') < types.indexOf('init'), 'v pořadí proudu: odpověď na initialize je před tahem');
  const t2 = await turn(r, 'znovu', run.sessionId);
  assert.equal(t2.events.filter((e) => e.type === 'commands').length, 0, 'druhý tah už commands znovu nedostane');
  r.stopAll();
  await closed(r);
});

test('posluchač připojený až po skončení běhu dostane všechny události včetně end', async () => {
  const r = mk();
  const run = await r.start(account, project, 'auto', 'ahoj', null, { addDirs: [] });
  await until(() => run.ended);
  let ended = false;
  const list = [];
  run.on('event', (e) => list.push(e));
  run.once('end', () => { ended = true; });
  await until(() => ended);
  const types = list.map((e) => e.type);
  for (const t of ['commands', 'init', 'result', 'exit']) assert.ok(types.includes(t), `${t} chybí: ${types.join(',')}`);
  assert.ok(types.indexOf('result') < types.indexOf('exit'));
  r.stopAll();
  await closed(r);
});

test('posluchač připojený hned: commands před init i result', async () => {
  const r = mk();
  const t = await turn(r, 'ahoj');
  const types = t.events.map((e) => e.type);
  assert.ok(types.indexOf('commands') >= 0 && types.indexOf('commands') < types.indexOf('init'), types.join(','));
  r.stopAll();
  await closed(r);
});
