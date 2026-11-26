// Přílohy: bezpečné názvy, kontrola obsahu, úklid starých.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeName, contentMatches, AttachmentStore, attachmentsPrompt } from '../src/server/lib/attachments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('safeName: jen poslední část cesty, bez zakázaných znaků', () => {
  assert.equal(safeName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(safeName('C:\\Windows\\win.ini'), 'win.ini');
  assert.equal(safeName('a<b>c:d"e|f?g*h.png'), 'a_b_c_d_e_f_g_h.png');
  assert.equal(safeName('..'), '');
  assert.equal(safeName('.skryty.png'), 'skryty.png');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.equal(safeName('snímek obrazovky 2026.png'), 'snímek obrazovky 2026.png');
  assert.ok(safeName('x'.repeat(300) + '.png').length <= 120);
  assert.ok(safeName('x'.repeat(300) + '.png').endsWith('.png'));
});

test('contentMatches: signatury obrázků a PDF, text bez NUL', () => {
  const b = (...x) => Buffer.from(x);
  assert.ok(contentMatches('.png', b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)));
  assert.ok(contentMatches('.jpg', b(0xff, 0xd8, 0xff, 0xe0)));
  assert.ok(contentMatches('.gif', Buffer.from('GIF89a')));
  assert.ok(contentMatches('.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ')));
  assert.ok(contentMatches('.pdf', Buffer.from('%PDF-1.7')));
  assert.ok(contentMatches('.md', Buffer.from('# Nadpis')));
  assert.ok(!contentMatches('.png', Buffer.from('%PDF-1.7')));
  assert.ok(!contentMatches('.pdf', b(0x89, 0x50)));
  assert.ok(!contentMatches('.txt', b(0x61, 0x00)));
  assert.ok(!contentMatches('.exe', Buffer.from('MZ')));
});

test('store: resolve jen v rámci účtu a projektu, neplatná id odmítnuta', () => {
  const state = path.join(root, '.test-state', 'att-unit');
  rmSync(state, { recursive: true, force: true });
  const store = new AttachmentStore(state, () => {});
  const id = 'a'.repeat(32);
  const dir = path.join(store.dirFor('ucet', 'proj'), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'x.png'), 'x');
  assert.equal(store.resolve('ucet', 'proj', id), path.join(dir, 'x.png'));
  assert.equal(store.resolve('ucet', 'jiny', id), null);
  assert.equal(store.resolve('ucet', 'proj', '../' + id), null);
  assert.throws(() => store.dirFor('../ucet', 'proj'), /Neplatné/);
});

test('store: úklid smaže jen přílohy starší než 7 dní', () => {
  const state = path.join(root, '.test-state', 'att-clean');
  rmSync(state, { recursive: true, force: true });
  const store = new AttachmentStore(state, () => {});
  const old = path.join(store.dirFor('u', 'p'), 'b'.repeat(32));
  const fresh = path.join(store.dirFor('u', 'p'), 'c'.repeat(32));
  for (const d of [old, fresh]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'f.txt'), 'x'); }
  const t = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  utimesSync(old, t, t);
  assert.equal(store.cleanup(), 1);
  assert.ok(!existsSync(old));
  assert.ok(existsSync(fresh));
});

test('attachmentsPrompt: blok s cestami, prázdný bez příloh', () => {
  assert.equal(attachmentsPrompt([]), '');
  assert.match(attachmentsPrompt(['/a/b.png']), /Přílohy od uživatele[\s\S]*- \/a\/b\.png/);
});
