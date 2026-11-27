// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StreamParser } from '../src/server/lib/parser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = readFileSync(path.join(root, 'docs', 'sample-stream.jsonl'), 'utf8').split(/\r?\n/);

test('vzorek streamu → init, tool karta, text, limit, výsledek', () => {
  const p = new StreamParser(path.join(os.tmpdir(), 'x', 'plans'));
  const events = sample.flatMap((l) => p.parse(l));
  const types = new Set(events.map((e) => e.type));
  for (const t of ['init', 'message_start', 'tool_start', 'tool_use', 'tool_result', 'text_delta', 'text', 'rate_limit', 'result'])
    assert.ok(types.has(t), `chybí ${t}`);
  const init = events.find((e) => e.type === 'init');
  assert.equal(p.sessionId, init.sessionId);
  assert.deepEqual(init.slashCommands, ['compact', 'context', 'cost', 'init', 'review']);
  assert.deepEqual(init.skills, []);
  const use = events.find((e) => e.type === 'tool_use');
  const res = events.find((e) => e.type === 'tool_result');
  assert.equal(use.id, res.id);
  assert.equal(res.denied, false);
  assert.equal(events.at(-1).type, 'result');
  const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  const finals = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(deltas, finals);
});

test('zamítnutí z tool_result_meta', () => {
  const p = new StreamParser(path.join(os.tmpdir(), 'x', 'plans'));
  const [e] = p.parse(JSON.stringify({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'blocked', is_error: true }] },
    tool_result_meta: [{ id: 't1', permission_decision: { decision: 'deny', source: 'mode', reason_type: 'mode' } }],
  }));
  assert.equal(e.denied, true);
  assert.equal(e.decisionSource, 'mode');
});

test('limit: rate_limit_event rejected', () => {
  const p = new StreamParser(path.join(os.tmpdir(), 'x', 'plans'));
  const [e] = p.parse(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1795650600, unifiedWindows: { five_hour: { utilization: 1 } } } }));
  assert.deepEqual(e, { type: 'rate_limit', status: 'rejected', limitType: 'five_hour', resetsAt: 1795650600, utilization: 1 });
});

test('plán: Write do <configDir>/plans se zaznamená, jinam ne', () => {
  const plans = path.join(os.tmpdir(), 'cfg', 'plans');
  const p = new StreamParser(plans);
  const write = (fp) => p.parse(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: fp, content: '# Plán' } }] } }));
  write(path.join(plans, 'muj-plan.md'));
  write(plans + path.sep + '..' + path.sep + 'settings.md');
  write(path.join(os.tmpdir(), 'projekt', 'README.md'));
  write('relativni/plan.md');
  assert.deepEqual([...p.planFiles], [path.join(plans, 'muj-plan.md')]);
});

test('nevalidní řádky se ignorují', () => {
  const p = new StreamParser(path.join(os.tmpdir(), 'x', 'plans'));
  assert.deepEqual(p.parse('není json'), []);
  assert.deepEqual(p.parse(''), []);
  assert.deepEqual(p.parse('42'), []);
});

test('replay: potvrzení převzaté zprávy (--replay-user-messages)', () => {
  const p = new StreamParser(path.join(os.tmpdir(), 'x', 'plans'));
  const [a] = p.parse(JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: 'Doplňující pokyn' } }));
  assert.deepEqual(a, { type: 'user_replay', text: 'Doplňující pokyn' });
  const [b] = p.parse(JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: 'blok' }] } }));
  assert.equal(b.text, 'blok');
  // tool_result bez isReplay se dál zpracuje jako výsledek nástroje
  const [c] = p.parse(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }));
  assert.equal(c.type, 'tool_result');
});

test('init: názvy příkazů a skillů jen jako rozumné řetězce', () => {
  const p = new StreamParser(path.join(os.tmpdir(), 'x', 'plans'));
  const [init] = p.parse(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's',
    slash_commands: ['kickoff', 'commit-commands:commit', 'kickoff', 42, '-x', 'a b', '<img>', 'x'.repeat(101)], skills: 'nic' }));
  assert.deepEqual(init.slashCommands, ['kickoff', 'commit-commands:commit']);
  assert.deepEqual(init.skills, []);
});
