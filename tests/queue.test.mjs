// Fronta zpráv (wwwroot/queue.js) – načtená do izolovaného kontextu jako v prohlížeči.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src', 'server', 'wwwroot', 'queue.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const { MessageQueue } = sandbox.window;

const ctx = { account: 'a', project: 'p', sessionId: 's1' };
const add = (q, prompt, extra = {}) => q.add({ prompt, mode: 'auto', account: 'a', project: 'p', sessionId: 's1', ...extra });

test('A běží, B a C ve frontě → po A jde B, pak C, stejné sezení', () => {
  const q = new MessageQueue();
  add(q, 'B'); add(q, 'C');
  assert.equal(q.onRunEnd('ok'), true);
  assert.equal(q.takeNext(ctx).prompt, 'B');
  assert.equal(q.onRunEnd('ok'), true);
  assert.equal(q.takeNext(ctx).prompt, 'C');
  assert.equal(q.onRunEnd('ok'), false);
  assert.equal(q.takeNext(ctx), null);
});

test('Stop, chyba, limit a plán frontu pozastaví; nic se samo neodešle', () => {
  for (const outcome of ['stopped', 'error', 'limit', 'plan']) {
    const q = new MessageQueue();
    add(q, 'B');
    assert.equal(q.onRunEnd(outcome), false);
    assert.equal(q.paused, outcome);
    assert.equal(q.takeNext(ctx), null);
    assert.ok(q.pauseText);
    q.resume();
    assert.equal(q.takeNext(ctx).prompt, 'B');
  }
});

test('položka se nikdy neodešle do jiného účtu, projektu ani sezení', () => {
  for (const other of [{ account: 'b' }, { project: 'q' }, { sessionId: 's2' }, { sessionId: null }]) {
    const q = new MessageQueue();
    add(q, 'B');
    assert.equal(q.takeNext({ ...ctx, ...other }), null);
    assert.equal(q.paused, 'context');
    assert.equal(q.length, 1);
  }
});

test('nové sezení: položka čeká na id sezení z běhu', () => {
  const q = new MessageQueue();
  const run = {};
  const other = {};
  add(q, 'B', { sessionId: null, run });
  add(q, 'C', { sessionId: null, run: other });
  q.bindSession(run, 'novy');
  assert.equal(q.items[0].sessionId, 'novy');
  assert.equal(q.items[1].sessionId, null);
  assert.equal(q.takeNext({ ...ctx, sessionId: 'novy' }).prompt, 'B');
});

test('úprava, smazání, posun', () => {
  const q = new MessageQueue();
  const b = add(q, 'B'); const c = add(q, 'C'); const d = add(q, 'D');
  assert.equal(q.move(d.id, -1), true);
  assert.deepEqual([...q.items.map((i) => i.prompt)], ['B', 'D', 'C']);
  assert.equal(q.move(b.id, -1), false);
  assert.equal(q.move(c.id, 1), false);
  q.update(c.id, '  C2 ');
  assert.equal(q.items[2].prompt, 'C2');
  assert.throws(() => q.update(c.id, '   '), /Prázdná/);
  q.remove(d.id);
  assert.deepEqual([...q.items.map((i) => i.prompt)], ['B', 'C2']);
});

test('validace: prázdná, dlouhá, plná fronta, neplatný režim', () => {
  const q = new MessageQueue();
  assert.throws(() => add(q, '  '), /Prázdná/);
  assert.throws(() => add(q, 'x'.repeat(100001)), /dlouhá/);
  assert.throws(() => add(q, 'x', { mode: 'bypassPermissions' }), /režim/);
  assert.equal(add(new MessageQueue(), 'ručně', { mode: 'default' }).mode, 'default');
  for (let i = 0; i < MessageQueue.MAX_ITEMS; i++) add(q, `m${i}`);
  assert.throws(() => add(q, 'navíc'), /plná/);
});

test('vyprázdnění i smazání poslední položky zruší pozastavení', () => {
  const q = new MessageQueue();
  const b = add(q, 'B');
  q.onRunEnd('stopped');
  q.remove(b.id);
  assert.equal(q.paused, null);
  add(q, 'C'); q.pause('manual'); q.clear();
  assert.equal(q.paused, null);
  assert.equal(q.length, 0);
});

test('přetažení: moveTo na libovolnou pozici', () => {
  const q = new MessageQueue();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => add(q, t));
  assert.equal(q.moveTo(d.id, 0), true);
  assert.deepEqual([...q.items.map((i) => i.prompt)], ['D', 'A', 'B', 'C']);
  q.moveTo(d.id, 99);
  assert.deepEqual([...q.items.map((i) => i.prompt)], ['A', 'B', 'C', 'D']);
  assert.equal(q.moveTo(b.id, 1), false);
  q.moveTo(a.id, 2);
  assert.deepEqual([...q.items.map((i) => i.prompt)], ['B', 'C', 'A', 'D']);
  assert.equal(q.moveTo(999, 0), false);
  void c;
});
