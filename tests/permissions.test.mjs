// Interaktivní oprávnění: výběr pravidel pro „Povolit vždy“, odpovědi pro stdin claude, parser control_request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { alwaysUpdates, ruleLabel, inputPreview, controlResponse, controlError } from '../src/server/lib/permissions.mjs';
import { StreamParser } from '../src/server/lib/parser.mjs';
import { allowedModes } from '../src/server/lib/claude.mjs';

// Skutečné návrhy z Claude Code 2.1.332 (Bash mkdir v režimu default).
const SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir slozka-a *' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['C:\\x'], destination: 'session' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

test('alwaysUpdates: jen addRules + allow + localSettings; nikdy setMode, adresáře ani jiná místa', () => {
  assert.deepEqual(alwaysUpdates(SUGGESTIONS), [SUGGESTIONS[0]]);
  assert.deepEqual(alwaysUpdates([{ type: 'setMode', mode: 'bypassPermissions', destination: 'localSettings' }]), []);
  assert.deepEqual(alwaysUpdates([{ ...SUGGESTIONS[0], behavior: 'deny' }]), []);
  assert.deepEqual(alwaysUpdates([{ ...SUGGESTIONS[0], destination: 'userSettings' }]), []);
  assert.deepEqual(alwaysUpdates([{ ...SUGGESTIONS[0], rules: [{ toolName: 'Bash(*)' }, { toolName: 'Bash', ruleContent: 'a\nb' }, { toolName: 'Read' }] }]),
    [{ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'localSettings' }]);
  assert.deepEqual(alwaysUpdates('nic'), []);
  assert.equal(ruleLabel(SUGGESTIONS[0].rules[0]), 'Bash(mkdir slozka-a *)');
  assert.equal(ruleLabel({ toolName: 'Read' }), 'Read');
});

test('controlResponse: jednou / vždy / zamítnout / limit; vstup nástroje se nemění', () => {
  const input = { command: 'mkdir slozka-a' };
  const r = (d) => JSON.parse(controlResponse('req-1', d, input, SUGGESTIONS));
  assert.deepEqual(r('once'), { type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: input } } });
  assert.deepEqual(r('always').response.response.updatedPermissions, [SUGGESTIONS[0]]);
  assert.equal(r('deny').response.response.behavior, 'deny');
  assert.match(r('timeout').response.response.message, /limitu/);
  assert.equal(JSON.parse(controlResponse('x', 'always', input, [SUGGESTIONS[2]])).response.response.updatedPermissions, undefined);
  assert.ok(controlResponse('x', 'once', input, []).endsWith('\n'));
  assert.deepEqual(JSON.parse(controlError('q')), { type: 'control_response', response: { subtype: 'error', request_id: 'q', error: 'Nepodporováno.' } });
});

test('inputPreview: příkaz, cesta, jinak zkrácený JSON', () => {
  assert.equal(inputPreview('Bash', { command: 'ls' }).command, 'ls');
  assert.equal(inputPreview('Write', { file_path: 'a.txt', content: 'x' }).path, 'a.txt');
  assert.equal(inputPreview('Write', { file_path: 'a.txt' }).json, undefined);
  assert.equal(inputPreview('X', { q: 'y'.repeat(3000) }).json.length, 2001);
  assert.equal(inputPreview('Bash', null).json, '{}');
});

test('parser: control_request can_use_tool a jiné podtypy', () => {
  const p = new StreamParser(path.join(os.tmpdir(), 'x', 'plans'));
  const [a] = p.parse(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash',
    display_name: 'Bash', input: { command: 'mkdir a' }, description: 'Create', permission_suggestions: SUGGESTIONS, blocked_path: 'C:\\a', tool_use_id: 't1' } }));
  assert.equal(a.type, 'control_permission');
  assert.equal(a.requestId, 'r1');
  assert.equal(a.toolName, 'Bash');
  assert.deepEqual(a.suggestions, SUGGESTIONS);
  const [b] = p.parse(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }));
  assert.deepEqual(b, { type: 'control_other', requestId: 'r2', subtype: 'hook_callback' });
  assert.deepEqual(p.parse(JSON.stringify({ type: 'control_request', request: { subtype: 'can_use_tool' } })), []);
});

test('allowedModes: Úpravy (acceptEdits) vždy, Ručně (default) jen s interactivePermissions, nikdy bypass/dontAsk', () => {
  assert.deepEqual(allowedModes({}), ['auto', 'plan', 'acceptEdits']);
  assert.deepEqual(allowedModes({ interactivePermissions: false }), ['auto', 'plan', 'acceptEdits']);
  assert.deepEqual(allowedModes({ interactivePermissions: true }), ['auto', 'plan', 'acceptEdits', 'default']);
  assert.deepEqual(allowedModes({ interactivePermissions: 'true' }), ['auto', 'plan', 'acceptEdits']);
});
