// Integrační test strážce: spustí server (bez okna, testovací token a config, bez skutečného claude) a zkouší 401/403/200.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkRequest, createSecret } from '../src/server/lib/guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(root, '.test-state', 'security');
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
let proc, port;

before(async () => {
  mkdirSync(stateDir, { recursive: true });
  const configFile = path.join(stateDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    app: { id: 'acd-test', name: 'ACD test' },
    claudeExe: process.execPath, // existující spustitelný soubor; účty neexistují, takže se nikdy nespustí
    stateDir,
    accounts: [{ id: 'a', label: 'A', configDir: path.join(stateDir, 'neexistuje'), expectedEmail: 'a@example.com' }],
    projects: [{ id: 'p', label: 'P', path: root }],
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
function req(method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); });
    r.on('error', reject);
    r.end();
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
