// Statistiky v čase: jen čísla, limity řídce, čtení podle dní, mazání starých záznamů.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UsageLog, KEEP_DAYS } from '../src/server/lib/usage.mjs';

const dir = path.join(os.tmpdir(), `acd-usage-${process.pid}`);
const DAY = 86_400_000;
const fresh = () => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); };

test('observer: běh z result s modelem z init, bez textů', () => {
  fresh();
  let now = Date.UTC(2026, 10, 27, 12);
  const u = new UsageLog(dir, { now: () => now });
  const obs = u.observer('a', 'p', { model: '', effort: 'low' });
  obs({ type: 'init', model: 'claude-sonnet-5-5' });
  obs({ type: 'text', text: 'TAJNÝ TEXT' });
  obs({ type: 'result', result: 'TAJNÝ VÝSLEDEK', costUsd: 0.12, durationMs: 3000, numTurns: 2, isError: false,
    usage: { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 } });
  const raw = readFileSync(path.join(dir, 'usage.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /TAJN/);
  const { runs } = u.read(30);
  assert.deepEqual(runs, [{ kind: 'run', t: now, account: 'a', project: 'p', model: 'claude-sonnet-5-5', effort: 'low',
    input: 10, output: 20, cacheRead: 300, cacheWrite: 40, cost: 0.12, ms: 3000, turns: 2, error: 0 }]);
});

test('limit: nejvýš jednou za 10 minut na okno, při změně ≥ 2 body hned', () => {
  fresh();
  let now = Date.UTC(2026, 10, 27, 12);
  const u = new UsageLog(dir, { now: () => now });
  const w = (u5) => [{ type: 'five_hour', utilization: u5, resetsAt: 1 }, { type: 'seven_day', utilization: 0.3 }];
  u.addLimit('a', w(0.5));
  now += 60_000; u.addLimit('a', w(0.51));   // malá změna, brzy → nic
  now += 60_000; u.addLimit('a', w(0.55));   // změna ≥ 2 body → jen five_hour
  now += 11 * 60_000; u.addLimit('a', w(0.55)); // po 10 min → obě
  u.addLimit('a', 'nic');
  const { limits } = u.read(1);
  assert.deepEqual(limits.map((l) => [l.window, l.utilization]), [['five_hour', 0.5], ['seven_day', 0.3], ['five_hour', 0.55], ['five_hour', 0.55], ['seven_day', 0.3]]);
});

test('read podle dní a prune starších než KEEP_DAYS; poškozený řádek nevadí', () => {
  fresh();
  const now = Date.UTC(2026, 10, 27, 12);
  const f = path.join(dir, 'usage.jsonl');
  const rec = (daysAgo) => JSON.stringify({ kind: 'run', t: now - daysAgo * DAY, account: 'a', project: 'p' });
  writeFileSync(f, [rec(KEEP_DAYS + 5), rec(40), 'nesmysl{', rec(3), rec(0)].join('\n') + '\n');
  const u = new UsageLog(dir, { now: () => now });
  assert.equal(u.read(7).runs.length, 2);
  assert.equal(u.read(1000).runs.length, 3); // nejvýš 180 dní
  u.prune();
  assert.equal(readFileSync(f, 'utf8').trim().split('\n').length, 3);
  assert.equal(new UsageLog(path.join(dir, 'nic')).read(30).runs.length, 0);
});

test('observer: tah s pracovníky → byModel (hlavní + pracovníci) a počet pracovníků; jeden model → beze změny', () => {
  fresh();
  const now = Date.UTC(2026, 10, 28, 12);
  const u = new UsageLog(dir, { now: () => now });
  const obs = u.observer('a', 'p', { model: 'sonnet' });
  obs({ type: 'result', costUsd: 0.12, usage: { input: 4, output: 296, cacheRead: 10, cacheWrite: 20 }, subagents: { spawned: 2 },
    modelUsage: [{ model: 'claude-sonnet-5-5', input: 4, output: 296, cacheRead: 10, cacheWrite: 20, costUsd: 0.1 },
      { model: 'claude-haiku-5-5', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.02 }] });
  obs({ type: 'result', usage: { input: 1, output: 1 }, modelUsage: [{ model: 'claude-sonnet-5-5', input: 1, output: 1 }] });
  const [a, b] = u.read(1).runs;
  assert.equal(a.input, 4, 'input… = hlavní konverzace jako dřív');
  assert.equal(a.workers, 2);
  assert.deepEqual(a.byModel['claude-haiku-5-5'], { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.02 });
  assert.equal(b.byModel, undefined);
  assert.equal(b.workers, undefined);
});
