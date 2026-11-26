// Řádek vstupu --input-format stream-json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userLine } from '../src/server/lib/claude.mjs';

test('userLine: jeden JSON řádek se zprávou uživatele', () => {
  const l = userLine('ahoj\n"svět"');
  assert.ok(l.endsWith('\n'));
  assert.equal(l.trimEnd().includes('\n'), false);
  assert.deepEqual(JSON.parse(l), { type: 'user', message: { role: 'user', content: 'ahoj\n"svět"' } });
});
