// Sezení: seznam, název a hledání v transkriptech (bez skutečného claude).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, searchSessions, projectDir } from '../src/server/lib/sessions.mjs';

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
