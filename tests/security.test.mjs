// Integrační test strážce: spustí server (bez okna, testovací token a config, bez skutečného claude) a zkouší 401/403/200.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkRequest, createSecret } from '../src/server/lib/guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(root, '.test-state', 'security');
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
let proc, port;

before(async () => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(stateDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    app: { id: 'acd-test', name: 'ACD test' },
    claudeExe: process.execPath, // existující spustitelný soubor; účty neexistují, takže se nikdy nespustí
    stateDir,
    accounts: [{ id: 'a', label: 'A', configDir: path.join(stateDir, 'neexistuje'), expectedEmail: 'a@example.com' }],
    projects: [{ id: 'p', label: 'P', path: root }, { id: 'p2', label: 'P2', path: root }],
  }));
  proc = spawn(process.execPath, [path.join(root, 'src', 'server', 'server.mjs')], {
    env: { ...process.env, ACD_CONFIG: configFile, ACD_TOKEN: TOKEN, ACD_PORT: '0', ACD_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; const m = /naslouchá na http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('exit', (c) => reject(new Error(`server skončil ${c}: ${err}`)));
    setTimeout(() => reject(new Error('timeout')), 15000);
  });
});
after(() => proc?.kill());

/** Surový požadavek (fetch neumí přepsat Host). */
function req(method, p, headers = {}, payload) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); });
    r.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 0, body: '' }) : reject(e)));
    r.end(payload);
  });
}

test('bez tokenu → 401', async () => assert.equal((await req('GET', '/api/ping')).status, 401));
test('špatný token → 401', async () => assert.equal((await req('GET', '/api/ping', { 'X-ACD-Token': 'x'.repeat(46) })).status, 401));
test('s tokenem → 200', async () => assert.equal((await req('GET', '/api/ping', { 'X-ACD-Token': TOKEN })).status, 200));
test('cizí Origin → 403', async () => assert.equal((await req('GET', '/api/ping', { 'X-ACD-Token': TOKEN, Origin: 'http://evil.example' })).status, 403));
test('cizí Host → 403', async () => assert.equal((await req('GET', '/api/ping', { 'X-ACD-Token': TOKEN, Host: 'evil.example' })).status, 403));
test('POST bez Origin → 403', async () => assert.equal((await req('POST', '/api/runs', { 'X-ACD-Token': TOKEN })).status, 403));
test('Sec-Fetch-Site cross-site → 403', async () => assert.equal((await req('GET', '/api/ping', { 'X-ACD-Token': TOKEN, 'Sec-Fetch-Site': 'cross-site' })).status, 403));
test('statika s CSP, mimo wwwroot nic', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await req('GET', '/..%2fconfig.example.json')).status, 404);
  assert.equal((await req('GET', '/%2e%2e/server.mjs')).status, 404);
  assert.equal((await req('GET', '/local/config.json')).status, 404);
  assert.equal((await req('GET', '/..%2f..%2f..%2flocal%2fconfig.json')).status, 404);
});
test('volitelné téma: bez local/theme.css prázdné CSS, ikona vždy', async () => {
  const t = await req('GET', '/theme.local.css');
  assert.equal(t.status, 200);
  assert.match(t.headers['content-type'], /text\/css/);
  assert.equal((await req('GET', '/theme.css')).status, 200);
  assert.equal((await req('GET', '/favicon.svg')).status, 200);
});
test('/api/state vrací název aplikace, ne cesty', async () => {
  const r = await req('GET', '/api/state', { 'X-ACD-Token': TOKEN });
  assert.equal(r.status, 200);
  const st = JSON.parse(r.body);
  assert.equal(st.app.name, 'ACD test');
  assert.equal(st.projects[0].path, undefined);
  assert.equal(st.projects[0].pathFull, undefined);
});

test('checkRequest bez serveru', () => {
  const s = createSecret(); s.port = 1234;
  const mk = (h, method = 'GET', url = '/api/x') => ({ method, url, headers: { host: '127.0.0.1:1234', ...h } });
  assert.deepEqual(checkRequest(mk({}), s), { status: 401, reason: 'token' });
  assert.equal(checkRequest(mk({ 'x-acd-token': s.token }), s), null);
  assert.equal(checkRequest(mk({ 'x-acd-token': s.token, origin: 'http://localhost:1234' }, 'POST'), s), null);
  assert.equal(checkRequest(mk({ host: 'localhost:9999' }), s).status, 403);
});

/* ---------- Přílohy ---------- */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const origin = () => ({ 'X-ACD-Token': TOKEN, Origin: `http://127.0.0.1:${port}` });
const upload = (name, data, { account = 'a', project = 'p', headers = origin() } = {}) =>
  req('POST', `/api/attachments?account=${account}&project=${project}&name=${encodeURIComponent(name)}`,
    { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': data.length }, data);

test('příloha: PNG se uloží do složky stavu, název bez cesty', async () => {
  const r = await upload('../../../zlý soubor.png', PNG);
  assert.equal(r.status, 200, r.body);
  const a = JSON.parse(r.body);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  assert.equal(a.name, 'zlý soubor.png');
  assert.equal(a.type, 'image/png');
  assert.ok(existsSync(path.join(stateDir, 'attachments', 'a', 'p', a.id, 'zlý soubor.png')));
});
test('příloha: bez tokenu 401, bez Origin 403', async () => {
  assert.equal((await upload('x.png', PNG, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 401);
  assert.equal((await upload('x.png', PNG, { headers: { 'X-ACD-Token': TOKEN } })).status, 403);
});
test('příloha: nepovolený typ, podvržený obsah, binární text → 415', async () => {
  assert.equal((await upload('virus.exe', PNG)).status, 415);
  assert.equal((await upload('obrazek.png', Buffer.from('není to png'))).status, 415);
  assert.equal((await upload('poznamky.txt', Buffer.from([0x61, 0x00, 0x62]))).status, 415);
  assert.equal((await upload('bez-pripony', PNG)).status, 415);
});
test('příloha: příliš velká → 413, prázdná → 400, neznámý účet → 400', async () => {
  const big = await upload('velky.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  assert.ok(big.status === 413 || big.status === 0, `status ${big.status}`);
  assert.equal((await upload('prazdny.txt', Buffer.alloc(0))).status, 400);
  assert.equal((await upload('x.png', PNG, { account: 'osobni' })).status, 400);
});
test('příloha: smazání jen ve svém účtu a projektu', async () => {
  const a = JSON.parse((await upload('smaz.png', PNG)).body);
  assert.equal(JSON.parse((await req('DELETE', `/api/attachments/${a.id}?account=a&project=p2`, origin())).body).removed, false);
  assert.equal(JSON.parse((await req('DELETE', `/api/attachments/${a.id}?account=a&project=p`, origin())).body).removed, true);
  assert.equal((await req('DELETE', `/api/attachments/${a.id}?account=a&project=p`, { 'X-ACD-Token': TOKEN })).status, 403);
});
test('běh: neexistující příloha nebo příloha z jiného projektu → 400 (claude se nespustí)', async () => {
  const a = JSON.parse((await upload('jinde.png', PNG, { project: 'p2' })).body);
  const run = (attachments) => {
    const body = Buffer.from(JSON.stringify({ account: 'a', project: 'p', mode: 'auto', prompt: 'ahoj', attachments }));
    return req('POST', '/api/runs', { ...origin(), 'Content-Type': 'application/json', 'Content-Length': body.length }, body);
  };
  const r1 = await run(['0'.repeat(32)]);
  assert.equal(r1.status, 400);
  assert.match(JSON.parse(r1.body).error, /Příloha/);
  assert.equal((await run([a.id])).status, 400);
  assert.equal((await run(['../../x'])).status, 400);
  assert.equal((await run(Array(11).fill(a.id))).status, 400);
});

test('zpráva do běhu: bez Origin 403, neexistující běh 404', async () => {
  const body = Buffer.from(JSON.stringify({ prompt: 'ahoj' }));
  const h = { 'Content-Type': 'application/json', 'Content-Length': body.length };
  assert.equal((await req('POST', '/api/runs/abc123/message', { 'X-ACD-Token': TOKEN, ...h }, body)).status, 403);
  assert.equal((await req('POST', '/api/runs/abc123/message', { ...origin(), ...h }, body)).status, 404);
  assert.equal((await req('POST', '/api/runs/zzz/message', { ...origin(), ...h }, body)).status, 404);
});

test('běh: model mimo allowlist a neplatný effort → 400 (claude se nespustí)', async () => {
  const run = (extra) => {
    const body = Buffer.from(JSON.stringify({ account: 'a', project: 'p', mode: 'auto', prompt: 'ahoj', ...extra }));
    return req('POST', '/api/runs', { ...origin(), 'Content-Type': 'application/json', 'Content-Length': body.length }, body);
  };
  assert.match(JSON.parse((await run({ model: 'gpt-5' })).body).error, /model/i);
  assert.equal((await run({ model: '--dangerously-skip-permissions' })).status, 400);
  assert.equal((await run({ model: 42 })).status, 400);
  assert.match(JSON.parse((await run({ effort: 'ultra' })).body).error, /effort/i);
  // povolené hodnoty projdou validací (pak skončí na neověřeném účtu → 409)
  assert.equal((await run({ model: 'opus', effort: 'high' })).status, 409);
});
test('/api/state: seznam modelů a effortů', async () => {
  const st = JSON.parse((await req('GET', '/api/state', { 'X-ACD-Token': TOKEN })).body);
  assert.ok(st.models.some((m) => m.id === '' ) && st.models.some((m) => m.id === 'opus'));
  assert.deepEqual(st.efforts, ['', 'low', 'medium', 'high', 'xhigh', 'max']);
});
