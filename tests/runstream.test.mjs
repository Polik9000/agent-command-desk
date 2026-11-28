// SSE vrstva (issue #2): události běhu, které nastaly dřív, než se server přihlásil, dorazí do prohlížeče.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeRunner } from '../src/server/lib/claude.mjs';
import { streamRun } from '../src/server/lib/runstream.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(root, 'tests', 'fixtures', 'fake-claude.mjs');
const cfg = { claudeExeFull: process.execPath, interactivePermissions: false, appendSystemPrompt: '', disallowedTools: [], sessionProcessMinutes: 10 };
const account = { id: 'a', configDirFull: path.join(root, '.test-state', 'runstream-acc') };
const project = { id: 'p', pathFull: root };

/** Falešná ServerResponse: sbírá zapsané rámce. */
function fakeRes() {
  const res = Object.assign(new EventEmitter(), { status: 0, headers: {}, frames: [], writableEnded: false,
    writeHead(s, h) { res.status = s; res.headers = h; },
    write(d) { res.frames.push(d); return true; },
    end() { res.writableEnded = true; res.emit('ended'); } });
  return res;
}

for (const batch of [false, true]) {
  test(`streamRun po už skončeném běhu: run, commands … result, exit a konec odpovědi${batch ? ' (vše v jednom bloku)' : ''}`, async () => {
    const spawnFn = (exe, args, opts) => spawn(process.execPath, [FAKE, ...(batch ? ['--fake-batch'] : []), ...args], opts);
    const r = new ClaudeRunner(cfg, () => {}, { spawnFn });
    const run = await r.start(account, project, 'auto', 'ahoj', null, { addDirs: [] });
    // Čeká na podmínku (ne pevnou dobu): každých 5 ms, nejvýš 10 s.
    for (const end = Date.now() + 10_000; !run.ended && Date.now() < end;) await new Promise((s) => setTimeout(s, 5));
    assert.equal(run.ended, true);
    const res = fakeRes();
    const seen = [];
    const done = new Promise((s) => res.once('ended', s));
    streamRun(res, run, { runId: run.id }, [(e) => seen.push(e.type)]);
    await done;
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    const types = res.frames.map((f) => JSON.parse(f.replace(/^data: /, '')).type);
    assert.equal(types[0], 'run');
    for (const t of ['commands', 'init', 'result', 'exit']) assert.ok(types.includes(t), `${t} chybí: ${types.join(',')}`);
    assert.ok(types.indexOf('commands') < types.indexOf('result'));
    assert.deepEqual(seen, types.slice(1), 'pozorovatel (statistiky) vidí totéž');
    r.stopAll();
    await Promise.all([...r.idle.values()].map((p) => p.closed));
  });
}
