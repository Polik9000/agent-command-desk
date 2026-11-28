// Orchestrace (issue #1): konfigurace, definice pracovníků, oprávnění, argumenty CLI, soubor definic, fallbacky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner } from '../src/server/lib/claude.mjs';
import {
  normalizeOrchestration, buildAgents, guidance, composePrompt, userAgentNames, parseVersion, versionAtLeast,
  WORKER_PRESETS, READ_ONLY_TOOLS, agentsDir, clearAgentsDir,
} from '../src/server/lib/orchestration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(root, 'tests', 'fixtures', 'fake-claude.mjs');
const base = path.join(root, '.test-state', 'orchestration');
const MODELS = [{ id: '', label: 'Výchozí' }, { id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }];
const account = { id: 'a', configDirFull: path.join(base, 'acc') };
const project = { id: 'p', pathFull: path.join(base, 'proj') };
for (const d of [account.configDirFull, project.pathFull]) mkdirSync(d, { recursive: true });

/* ---------------- konfigurace ---------------- */

test('normalizeOrchestration: výchozí = off a 4 pracovníci s modely Haiku/Sonnet', () => {
  const o = normalizeOrchestration(undefined, MODELS);
  assert.equal(o.defaultMode, 'off');
  assert.deepEqual(o.warnings, []);
  assert.deepEqual(o.workers.map((w) => [w.name, w.model, w.readOnly]),
    [['acd-explore', 'haiku', true], ['acd-plan', 'haiku', true], ['acd-implementer', 'sonnet', false], ['acd-reviewer', 'sonnet', true]]);
  for (const w of o.workers) assert.ok(w.description.length > 40, `${w.name}: popis pro výběr orchestrátorem`);
});

test('normalizeOrchestration: přepsání modelu, vypnutí, vlastní pracovník; neplatné jen varování', () => {
  const o = normalizeOrchestration({ defaultMode: 'auto', workers: {
    'acd-explore': { model: 'sonnet' }, 'acd-plan': { enabled: false }, 'acd-reviewer': { model: 'gpt-5' },
    'acd-docs': { description: 'Píše dokumentaci', prompt: 'Piš stručně.', model: 'haiku' },
    'acd-bez-popisu': { prompt: 'x' }, 'jiny': { description: 'd', prompt: 'p' }, 'acd-zly': 'x',
  } }, MODELS);
  assert.equal(o.defaultMode, 'auto');
  const by = Object.fromEntries(o.workers.map((w) => [w.name, w]));
  assert.equal(by['acd-explore'].model, 'sonnet');
  assert.equal(by['acd-plan'], undefined);
  assert.equal(by['acd-reviewer'].model, 'sonnet', 'model mimo allowlist → výchozí');
  assert.equal(by['acd-docs'].readOnly, true, 'vlastní pracovník je bez readOnly:false jen pro čtení');
  assert.equal(by['acd-bez-popisu'], undefined);
  assert.equal(by.jiny, undefined);
  assert.equal(o.warnings.length, 4, o.warnings.join('\n'));
  assert.equal(normalizeOrchestration({ defaultMode: 'vzdy' }, MODELS).defaultMode, 'off');
  assert.equal(normalizeOrchestration('auto', MODELS).warnings.length, 1);
});

test('model pracovníka jen z allowlistu: bez haiku v seznamu → inherit', () => {
  const o = normalizeOrchestration({}, [{ id: '', label: 'x' }, { id: 'sonnet', label: 'S' }]);
  assert.equal(o.workers.find((w) => w.name === 'acd-explore').model, 'inherit');
  assert.equal(o.workers.find((w) => w.name === 'acd-implementer').model, 'sonnet');
});

/* ---------------- definice a oprávnění ---------------- */

test('buildAgents: čtecí role bez zápisu a Bash, nikde permissionMode, zakázané nástroje sezení platí i pro pracovníky', () => {
  const { workers } = normalizeOrchestration({}, MODELS);
  const b = buildAgents(workers, { disallowedTools: ['WebFetch'] });
  assert.deepEqual(Object.keys(b.defs), Object.keys(WORKER_PRESETS));
  for (const [name, d] of Object.entries(b.defs)) {
    assert.equal('permissionMode' in d, false, `${name}: permissionMode by mohl zvýšit oprávnění`);
    assert.ok(d.disallowedTools.includes('WebFetch'), `${name}: zakázané nástroje sezení`);
    for (const k of Object.keys(d)) assert.ok(['description', 'prompt', 'model', 'tools', 'disallowedTools'].includes(k), k);
  }
  for (const name of ['acd-explore', 'acd-plan', 'acd-reviewer']) {
    assert.deepEqual(b.defs[name].tools, READ_ONLY_TOOLS);
    for (const t of ['Write', 'Edit', 'Bash', 'NotebookEdit', 'Agent']) assert.ok(b.defs[name].disallowedTools.includes(t), `${name} nesmí ${t}`);
  }
  assert.equal(b.defs['acd-implementer'].tools, undefined, 'implementátor dědí nástroje sezení');
  assert.equal(b.defs['acd-explore'].model, 'haiku');
  const inh = buildAgents([{ name: 'acd-x', model: 'inherit', readOnly: true, description: 'd', prompt: 'p' }]);
  assert.equal(inh.defs['acd-x'].model, undefined, 'inherit = model rodiče (pole se nevyplní)');
});

test('agent uživatele nebo projektu se stejným jménem se nezastíní', () => {
  const dir = path.join(base, 'user-agents');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'muj.md'), '---\nname: acd-reviewer\ndescription: můj\n---\nprompt');
  writeFileSync(path.join(dir, 'acd-plan.md'), 'bez frontmatteru');
  const taken = userAgentNames([dir, path.join(base, 'neexistuje')]);
  assert.ok(taken.has('acd-reviewer') && taken.has('acd-plan'));
  const b = buildAgents(normalizeOrchestration({}, MODELS).workers, { taken });
  assert.deepEqual(Object.keys(b.defs).sort(), ['acd-explore', 'acd-implementer']);
  assert.deepEqual(b.skipped.map((s) => s.name).sort(), ['acd-plan', 'acd-reviewer']);
});

test('pokyny: skládají se za appendSystemPrompt uživatele; nesmí slibovat úsporu', () => {
  const g = guidance([{ name: 'acd-explore', model: 'haiku', readOnly: true }]);
  assert.match(g, /acd-explore \(haiku\), read-only/);
  assert.match(g, /Do small or simple tasks yourself/);
  assert.match(g, /never let two workers edit the same/);
  assert.match(g, /Do not claim that delegation saved tokens/);
  assert.equal(composePrompt('Uživatel', g), `Uživatel\n\n${g}`);
  assert.equal(composePrompt('', g), g);
});

test('verze CLI', () => {
  assert.deepEqual(parseVersion('2.1.332 (Claude Code)'), [2, 1, 332]);
  assert.equal(parseVersion('v22.1'), null);
  assert.ok(versionAtLeast('2.1.281', '2.1.281'));
  assert.ok(versionAtLeast('2.2.0', '2.1.281'));
  assert.ok(versionAtLeast('3.0.0', '2.1.281'));
  assert.ok(!versionAtLeast('2.1.280', '2.1.281'));
  assert.ok(!versionAtLeast(null, '2.1.281'));
});

/* ---------------- runner s falešným claude ---------------- */

const stateDir = path.join(base, 'state');
const mkRunner = ({ orchestration = {}, extra = {}, fakeArgs = [], spawned = [] } = {}) => {
  const cfg = { claudeExeFull: process.execPath, interactivePermissions: false, appendSystemPrompt: 'Pokyn uživatele.',
    disallowedTools: [], sessionProcessMinutes: 10, stateDirFull: stateDir, models: MODELS,
    orchestration: normalizeOrchestration(orchestration, MODELS), ...extra };
  const spawnFn = (exe, args, opts) => { spawned.push(args); return spawn(process.execPath, [FAKE, ...fakeArgs, ...args], opts); };
  return new ClaudeRunner(cfg, () => {}, { spawnFn });
};
async function turn(r, prompt, resume = null, orchestration = 'off', opts = {}) {
  const run = await r.start(account, project, 'auto', prompt, resume, { addDirs: [], orchestration, ...opts });
  const events = [];
  run.on('event', (e) => events.push(e));
  await new Promise((s) => run.once('end', s));
  const text = events.filter((e) => e.type === 'text' && !e.parent).map((e) => e.text).join('\n');
  const pid = /pid (\d+)/.exec(text)?.[1];
  return { run, events, text, pid, sessionId: run.sessionId };
}
const files = () => (existsSync(agentsDir(stateDir)) ? readdirSync(agentsDir(stateDir)) : []);
const closeAll = async (r) => { const p = [...r.idle.values()].map((x) => x.closed); r.stopAll(); await Promise.all(p); };

test('Vypnuto: žádné --agents, pokyny ani událost orchestration; argumenty jako dřív', async () => {
  const spawned = [];
  const r = mkRunner({ spawned });
  const t = await turn(r, 'AGENTS?');
  assert.match(t.text, /agents:- guided:false/);
  assert.equal(t.events.some((e) => e.type === 'orchestration'), false);
  const args = spawned.find((a) => a.includes('-p'));
  assert.equal(args.includes('--agents'), false);
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'Pokyn uživatele.');
  assert.equal(spawned.some((a) => a.includes('--version')), false, 'Vypnuto nezjišťuje ani verzi');
  await closeAll(r);
});

test('Auto: platný soubor --agents po dobu života procesu, pokyny za appendSystemPrompt, smazání po zavření', async () => {
  const spawned = [];
  const r = mkRunner({ spawned });
  const t = await turn(r, 'AGENTS?', null, 'auto');
  assert.match(t.text, /agents:acd-explore,acd-plan,acd-implementer,acd-reviewer guided:true/);
  const o = t.events.find((e) => e.type === 'orchestration');
  assert.equal(o.active, true);
  assert.deepEqual(o.workers.map((w) => `${w.name}:${w.model}`), ['acd-explore:haiku', 'acd-plan:haiku', 'acd-implementer:sonnet', 'acd-reviewer:sonnet']);
  assert.equal('defs' in o, false, 'definice (prompty) do UI nejdou');
  const args = spawned.find((a) => a.includes('-p'));
  const file = args[args.indexOf('--agents') + 1];
  assert.ok(file.startsWith(agentsDir(stateDir)), 'soubor ve složce stavu aplikace, ne v projektu');
  assert.ok(args[args.indexOf('--append-system-prompt') + 1].startsWith('Pokyn uživatele.\n\nOrchestration is enabled'));
  for (const bad of ['bypassPermissions', 'dontAsk', '--dangerously-skip-permissions']) assert.equal(args.includes(bad), false);
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none', 'bez interactivePermissions dál vše zamítnout');
  assert.ok(existsSync(file), 'soubor žije, dokud proces čeká na další zprávu');
  const t2 = await turn(r, 'AGENTS?', t.sessionId, 'auto');
  assert.equal(t2.pid, t.pid, 'stejný režim orchestrace = převzatý proces');
  assert.ok(existsSync(file));
  const p = r.idle.get(t.sessionId);
  r.closeProject('p');
  await p.closed;
  assert.equal(existsSync(file), false, 'po zavření procesu smazán');
  assert.equal(JSON.parse(JSON.stringify(t2.events.find((e) => e.type === 'orchestration'))).active, true);
});

test('Auto s interactivePermissions: žádosti o svolení dál přes okno (host/stdio), nic se nezvyšuje', async () => {
  const spawned = [];
  const r = mkRunner({ spawned, extra: { interactivePermissions: true } });
  await turn(r, 'ahoj', null, 'auto');
  const args = spawned.find((a) => a.includes('-p'));
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'host');
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  const defs = JSON.parse(readFileSync(args[args.indexOf('--agents') + 1], 'utf8'));
  for (const d of Object.values(defs)) assert.equal(d.permissionMode, undefined);
  await closeAll(r);
});

test('přepnutí Vypnuto ↔ Auto = nový proces s --resume (jako effort)', async () => {
  const r = mkRunner();
  const t1 = await turn(r, 'ahoj');
  const t2 = await turn(r, 'AGENTS?', t1.sessionId, 'auto');
  assert.notEqual(t2.pid, t1.pid);
  assert.equal(t2.sessionId, t1.sessionId);
  const t3 = await turn(r, 'AGENTS?', t1.sessionId, 'off');
  assert.notEqual(t3.pid, t2.pid);
  assert.match(t3.text, /agents:- guided:false/);
  await closeAll(r);
  assert.deepEqual(files(), [], 'žádný soubor definic nezůstal');
});

test('stopAll, limit čekání i chyba procesu smažou soubor definic; zbytky po pádu se smažou při startu', async () => {
  const r = mkRunner();
  await turn(r, 'ahoj', null, 'auto');
  assert.equal(files().length, 1);
  await closeAll(r);
  assert.equal(files().length, 0);

  const idle = mkRunner();
  idle.idleMsOverride = 100;
  const t = await turn(idle, 'ahoj', null, 'auto');
  await (idle.idle.get(t.sessionId)?.closed ?? Promise.resolve());
  assert.equal(files().length, 0, 'po limitu čekání');

  const fail = mkRunner();
  await turn(fail, 'FAIL', null, 'auto'); // chybový výsledek → proces se zavře
  for (const end = Date.now() + 5000; files().length && Date.now() < end;) await new Promise((s) => setTimeout(s, 10));
  assert.equal(files().length, 0, 'po chybě');

  mkdirSync(agentsDir(stateDir), { recursive: true });
  writeFileSync(path.join(agentsDir(stateDir), 'zbytek.json'), '{}');
  mkRunner();
  assert.equal(files().length, 0, 'nový runner uklidí zbytky');
  clearAgentsDir(path.join(base, 'neni')); // neexistující složka nevadí
});

test('spawn selže → soubor definic se smaže a chyba jde dál', async () => {
  const cfg = { claudeExeFull: process.execPath, interactivePermissions: false, appendSystemPrompt: '', disallowedTools: [],
    sessionProcessMinutes: 10, stateDirFull: stateDir, models: MODELS, orchestration: normalizeOrchestration({}, MODELS) };
  const spawnFn = (exe, args, opts) => {
    if (args.includes('--version')) return spawn(process.execPath, [FAKE, ...args], opts);
    throw new Error('spawn EACCES');
  };
  const r = new ClaudeRunner(cfg, () => {}, { spawnFn });
  await assert.rejects(r.start(account, project, 'auto', 'ahoj', null, { addDirs: [], orchestration: 'auto' }), /EACCES/);
  assert.deepEqual(files(), []);
});

test('stará verze CLI → běh bez orchestrace s diagnostikou; běžný chat funguje', async () => {
  const spawned = [];
  const r = mkRunner({ spawned, fakeArgs: ['--fake-version', '2.1.200'] });
  const t = await turn(r, 'AGENTS?', null, 'auto');
  const o = t.events.find((e) => e.type === 'orchestration');
  assert.equal(o.active, false);
  assert.match(o.reason, /2\.1\.281.*2\.1\.200/);
  assert.match(t.text, /agents:- guided:false/);
  assert.ok(t.events.some((e) => e.type === 'result' && !e.isError));
  await closeAll(r);
});

test('neplatná konfigurace pracovníků → varování v události, chat běží', async () => {
  const r = mkRunner({ orchestration: { workers: { 'acd-explore': { enabled: false }, 'acd-plan': { enabled: false },
    'acd-implementer': { enabled: false }, 'acd-reviewer': { enabled: false }, 'zle': {} } } });
  const t = await turn(r, 'ahoj', null, 'auto');
  const o = t.events.find((e) => e.type === 'orchestration');
  assert.equal(o.active, false);
  assert.match(o.reason, /Žádný pracovník/);
  assert.equal(o.warnings.length, 1);
  await closeAll(r);
});

test('otázka bokem běží bez orchestrace', async () => {
  const spawned = [];
  const r = mkRunner({ spawned });
  const t1 = await turn(r, 'ahoj');
  const side = await r.start(account, project, 'plan', 'AGENTS?', t1.sessionId, { addDirs: [], side: true, orchestration: 'auto' });
  const ev = [];
  side.on('event', (e) => ev.push(e));
  await new Promise((s) => side.once('end', s));
  assert.equal(ev.find((e) => e.type === 'orchestration').active, false);
  assert.ok(ev.some((e) => e.type === 'text' && /agents:-/.test(e.text)));
  await closeAll(r);
});

test('neplatný režim orchestrace → chyba', async () => {
  const r = mkRunner();
  await assert.rejects(r.start(account, project, 'auto', 'x', null, { orchestration: 'vzdy' }), /orchestrace/);
});

test('fixture: v Auto vícekrokový úkol deleguje (karta s rodičem, model, součet po modelech); triviální zpráva ne', async () => {
  const r = mkRunner();
  const big = await turn(r, 'ÚKOL: najdi všechna použití a navrhni úpravu', null, 'auto');
  const call = big.events.find((e) => e.type === 'tool_use' && e.name === 'Agent');
  assert.equal(call.input.subagent_type, 'acd-explore');
  assert.ok(big.events.some((e) => e.type === 'text' && e.parent === call.id), 'výstup pracovníka patří k jeho kartě');
  const done = big.events.find((e) => e.type === 'task' && e.phase === 'notification');
  assert.equal(done.tokens, 900);
  const res = big.events.find((e) => e.type === 'result');
  assert.deepEqual(res.modelUsage.map((m) => m.model), ['claude-default', 'claude-haiku-5-5']);
  assert.equal(res.subagents.spawned, 1);
  const small = await turn(r, 'ahoj', big.sessionId, 'auto');
  assert.equal(small.pid, big.pid, 'stejný proces – subagent_stats je u něj součtem za proces');
  assert.equal(small.events.some((e) => e.type === 'tool_use' && e.name === 'Agent'), false, 'triviální zpráva zůstane u hlavního modelu');
  assert.equal(small.events.find((e) => e.type === 'result').subagents, undefined);
  await closeAll(r);
});
