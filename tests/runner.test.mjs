// Proces claude na sezení: převzetí čekajícího procesu, nový proces při jiném nastavení, pojistky režimu, limit čekání.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner, PROGRESS_PROMPT } from '../src/server/lib/claude.mjs';

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

test('stejné sezení a nastavení → stejný proces; jiný režim, model nebo effort → nový proces s --resume', async () => {
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
  assert.notEqual(t3.pid, t1.pid);
  assert.equal(t3.sessionId, t1.sessionId);
  const t4 = await turn(r, 'model', t1.sessionId, 'plan', { model: 'sonnet' });
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

test('sledování průběhu: přidá pevný text k systémovému promptu a změna volby = nový proces', async () => {
  const seen = [];
  const r = new ClaudeRunner(cfg({ appendSystemPrompt: 'Vlastní.' }), () => {}, {
    spawnFn: (exe, args, opts) => { seen.push(args); return spawn(process.execPath, [FAKE, ...args], opts); } });
  const t1 = await turn(r, 'ahoj', null, 'auto', { progress: true });
  const sys = (a) => a[a.indexOf('--append-system-prompt') + 1];
  assert.equal(sys(seen[0]), `Vlastní.\n\n${PROGRESS_PROMPT}`);
  const t2 = await turn(r, 'znovu', t1.sessionId, 'auto', { progress: true });
  assert.equal(t2.pid, t1.pid);
  const t3 = await turn(r, 'bez', t1.sessionId, 'auto', { progress: false });
  assert.notEqual(t3.pid, t1.pid);
  assert.equal(sys(seen[1]), 'Vlastní.');
  r.stopAll();
  await closed(r);
});
