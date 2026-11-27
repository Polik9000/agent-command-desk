// Sezení: seznam, název a hledání v transkriptech (bez skutečného claude).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, searchSessions, projectDir, overview } from '../src/server/lib/sessions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projects = path.join(root, '.test-state', 'sessions', 'projects');
const projectPath = path.join(root, '.test-state', 'sessions', 'muj projekt');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const line = (o) => JSON.stringify(o);
const user = (text, extra = {}) => line({ type: 'user', message: { role: 'user', content: text }, ...extra });
const asst = (text, extra = {}) => line({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { command: 'tajny-prikaz' } }] }, ...extra });

before(() => {
  rmSync(path.join(root, '.test-state', 'sessions'), { recursive: true, force: true });
  const dir = projectDir(projects, projectPath);
  mkdirSync(dir, { recursive: true });
  const files = [
    [user('Napiš pozvánku na Čtenářský piknik v parku'), asst('Tady je návrh pozvánky…'), line({ type: 'ai-title', aiTitle: 'Pozvánka na piknik' })],
    [user('Oprav chybu v přihlašování'), asst('Chyba byla v kontrole tokenu, opraveno.'), user('vedlejší agent: piknik', { isSidechain: true })],
    [user('<command-name>/kickoff</command-name>'), user('Jen meta zpráva o pikniku', { isMeta: true }), asst('Hotovo bez shody.')],
  ];
  files.forEach((lines, i) => {
    const f = path.join(dir, `${ids[i]}.jsonl`);
    writeFileSync(f, lines.join('\n') + '\n');
    const t = new Date(Date.UTC(2026, 10, 20 + i));
    utimesSync(f, t, t);
  });
  writeFileSync(path.join(dir, 'neni-sezeni.jsonl'), user('piknik'));
});

test('listSessions: nejnovější první, název z ai-title nebo první zprávy', () => {
  const l = listSessions(projects, projectPath);
  assert.deepEqual(l.map((s) => s.id), [ids[2], ids[1], ids[0]]);
  assert.equal(l.find((s) => s.id === ids[0]).title, 'Pozvánka na piknik');
  assert.equal(l.find((s) => s.id === ids[1]).title, 'Oprav chybu v přihlašování');
});

test('searchSessions: bez diakritiky a velikosti písmen, s úryvkem; ne nástroje, meta ani vedlejší agenti', () => {
  const r = searchSessions(projects, projectPath, 'CTENARSKY piknik');
  assert.deepEqual(r.map((s) => s.id), [ids[0]]);
  assert.equal(r[0].role, 'user');
  assert.match(r[0].snippet, /Čtenářský piknik/);
  assert.deepEqual(searchSessions(projects, projectPath, 'tokenu').map((s) => [s.id, s.role]), [[ids[1], 'assistant']]);
  assert.deepEqual(searchSessions(projects, projectPath, 'piknik').map((s) => s.id), [ids[0]]); // sidechain a meta ne
  assert.deepEqual(searchSessions(projects, projectPath, 'tajny-prikaz'), []);                  // vstup nástroje ne
  assert.deepEqual(searchSessions(projects, projectPath, 'x'), []);                             // příliš krátké
  assert.deepEqual(searchSessions(projects, path.join(root, 'jiny'), 'piknik'), []);           // jiný projekt
});

test('overview: upravené soubory (i agenty), agenti, poslední úkoly, nástroje a MCP', () => {
  const id = '44444444-4444-4444-8444-444444444444';
  const dir = projectDir(projects, projectPath);
  const tu = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const tr = (id, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', ...extra });
  const a = (blocks, ts) => line({ type: 'assistant', timestamp: ts, message: { content: blocks } });
  const u = (blocks, extra = {}) => line({ type: 'user', message: { content: blocks }, ...extra });
  const out = path.join(root, '.test-state', 'jinde.md');
  writeFileSync(path.join(dir, `${id}.jsonl`), [
    user('Uprav web', { timestamp: '2026-11-27T10:00:00.000Z' }),
    a([{ type: 'text', text: 'Jdu na to.' }, tu('e1', 'Edit', { file_path: path.join(projectPath, 'src', 'a.js') }),
      tu('e2', 'Write', { file_path: path.join(projectPath, 'src', 'a.js') }), tu('e3', 'Edit', { file_path: out })], '2026-11-27T10:01:00.000Z'),
    u([tr('e1'), tr('e2', { is_error: true }), tr('e3')]),
    a([tu('t1', 'TodoWrite', { todos: [{ content: 'Starý', status: 'pending' }] }), tu('g1', 'Agent', { description: 'Průzkum', subagent_type: 'Explore' }),
      tu('g2', 'Task', { description: 'Na pozadí', subagent_type: 'general-purpose' }), tu('m1', 'mcp__github__search', {})]),
    u([tr('g1'), tr('g2')], { toolUseResult: { status: 'async_launched' } }),
    a([tu('t2', 'TodoWrite', { todos: [{ content: 'Hotovo', status: 'completed' }, { content: 'Teď', status: 'in_progress' }, { x: 1 }] })], '2026-11-27T10:05:00.000Z'),
  ].join('\n') + '\n');
  const sub = path.join(dir, id, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, 'agent-abc.jsonl'), a([tu('s1', 'Edit', { file_path: path.join(projectPath, 'README.md') }), tu('s2', 'Bash', {})]) + '\n');
  writeFileSync(path.join(sub, 'agent-abc.meta.json'), JSON.stringify({ toolUseId: 'g2', finished: true }));

  const o = overview(path.join(dir, `${id}.jsonl`), projectPath);
  assert.deepEqual(o.files.map((f) => [f.path, f.edits, f.writes, f.failed, f.main, f.agent, f.outside]), [
    ['README.md', 1, 0, 0, false, true, false],
    ['src/a.js', 1, 1, 1, true, false, false],
    [path.resolve(out), 1, 0, 0, true, false, true],
  ]);
  // g1 i g2 dostaly stejný toolUseResult (async) → na pozadí; g2 podle meta.json doběhl.
  assert.deepEqual(o.agents, [{ description: 'Průzkum', type: 'Explore', status: 'background' }, { description: 'Na pozadí', type: 'general-purpose', status: 'done' }]);
  assert.deepEqual(o.todos, [{ content: 'Hotovo', status: 'completed' }, { content: 'Teď', status: 'in_progress' }, { content: '', status: 'pending' }]);
  assert.equal(o.todosAt, '2026-11-27T10:05:00.000Z');
  assert.deepEqual(o.tools.find((t) => t.name === 'Edit'), { name: 'Edit', count: 2 }); // Bash agenta se nepočítá
  assert.equal(o.tools.some((t) => t.name === 'Bash'), false);
  assert.deepEqual(o.mcp, [{ name: 'github', count: 1 }]);
  assert.equal(o.userMessages, 1);
  assert.equal(o.replies, 1);
  assert.equal(o.started, '2026-11-27T10:00:00.000Z');
  assert.equal(o.updated, '2026-11-27T10:05:00.000Z');
});
