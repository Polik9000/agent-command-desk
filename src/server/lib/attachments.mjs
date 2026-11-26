// @ts-check
// Přílohy: uložení do <stateDir>/attachments/<účet>/<projekt>/<id>/<název> (mimo repo).
// Povolené typy podle přípony + kontrola obsahu (signatura / text bez NUL), limity velikosti.
// Claude dostane jen složku příloh aktuálního účtu a projektu (--add-dir) a cesty v promptu.
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const MB = 1024 * 1024;
/** přípona → { mime, max, kind } */
export const TYPES = {
  '.png': { mime: 'image/png', max: 10 * MB, kind: 'image' },
  '.jpg': { mime: 'image/jpeg', max: 10 * MB, kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', max: 10 * MB, kind: 'image' },
  '.gif': { mime: 'image/gif', max: 10 * MB, kind: 'image' },
  '.webp': { mime: 'image/webp', max: 10 * MB, kind: 'image' },
  '.pdf': { mime: 'application/pdf', max: 20 * MB, kind: 'pdf' },
  '.txt': { mime: 'text/plain', max: 2 * MB, kind: 'text' },
  '.md': { mime: 'text/markdown', max: 2 * MB, kind: 'text' },
  '.csv': { mime: 'text/csv', max: 2 * MB, kind: 'text' },
  '.json': { mime: 'application/json', max: 2 * MB, kind: 'text' },
  '.log': { mime: 'text/plain', max: 2 * MB, kind: 'text' },
};
export const MAX_PER_RUN = 10;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const ID_RX = /^[0-9a-f]{32}$/;
const SEG_RX = /^[A-Za-z0-9_-]{1,64}$/;

/** Bezpečný název souboru (jen poslední část, bez řídicích a zakázaných znaků Windows). */
export function safeName(name) {
  let n = String(name ?? '').split(/[\\/]/).pop() ?? '';
  n = n.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (n.length > 120) { const ext = path.extname(n).slice(0, 10); n = n.slice(0, 120 - ext.length) + ext; }
  return n;
}

/** Ověří, že obsah odpovídá typu (podle prvních bajtů). */
export function contentMatches(ext, head) {
  const t = TYPES[ext];
  if (!t) return false;
  const b = head;
  const starts = (...xs) => xs.every((x, i) => b[i] === x);
  switch (ext) {
    case '.png': return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case '.jpg': case '.jpeg': return starts(0xff, 0xd8, 0xff);
    case '.gif': return starts(0x47, 0x49, 0x46, 0x38);
    case '.webp': return starts(0x52, 0x49, 0x46, 0x46) && b.subarray(8, 12).toString('latin1') === 'WEBP';
    case '.pdf': return b.subarray(0, 5).toString('latin1') === '%PDF-';
    default: return !b.includes(0); // text: žádné NUL bajty
  }
}

export class AttachmentStore {
  /** @param {string} stateDir @param {(m:string)=>void} log */
  constructor(stateDir, log) {
    this.root = path.join(stateDir, 'attachments');
    this.log = log;
  }

  /** Složka příloh účtu a projektu (id z allowlistu). */
  dirFor(accountId, projectId) {
    if (!SEG_RX.test(accountId) || !SEG_RX.test(projectId)) throw new Error('Neplatné id účtu nebo projektu.');
    return path.join(this.root, accountId, projectId);
  }

  /**
   * Uloží přílohu z požadavku (stream). Vrací metadata, nebo vyhodí chybu se `status`.
   * @param {import('node:http').IncomingMessage} req
   */
  save(req, accountId, projectId, rawName) {
    const err = (status, message) => Object.assign(new Error(message), { status });
    return new Promise((resolve, reject) => {
      const name = safeName(rawName);
      const ext = path.extname(name).toLowerCase();
      const type = TYPES[ext];
      if (!name || !type) { req.resume(); reject(err(415, 'Nepodporovaný typ souboru. Povoleno: obrázky (png, jpg, gif, webp), PDF, txt, md, csv, json, log.')); return; }
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > type.max) { req.resume(); reject(err(413, `Soubor je příliš velký (max. ${type.max / MB} MB).`)); return; }

      const id = randomBytes(16).toString('hex');
      const dir = path.join(this.dirFor(accountId, projectId), id);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      const out = createWriteStream(file, { flags: 'wx' });
      let size = 0;
      let head = Buffer.alloc(0);
      let failed = null;
      const fail = (e) => {
        if (failed) return;
        failed = e;
        req.unpipe?.(out);
        out.destroy();
        req.resume();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* nic */ }
        reject(e);
      };
      req.on('data', (c) => {
        if (failed) return;
        size += c.length;
        if (head.length < 16) head = Buffer.concat([head, c]).subarray(0, 16);
        if (size > type.max) { fail(err(413, `Soubor je příliš velký (max. ${type.max / MB} MB).`)); return; }
        if (type.kind === 'text' && c.includes(0)) { fail(err(415, 'Textový soubor obsahuje binární data.')); return; }
        if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', () => {
        if (failed) return;
        if (!size) { fail(err(400, 'Prázdný soubor.')); return; }
        if (!contentMatches(ext, head)) { fail(err(415, 'Obsah souboru neodpovídá jeho příponě.')); return; }
        out.end(() => resolve({ id, name, type: type.mime, kind: type.kind, size }));
      });
      req.on('error', (e) => fail(e));
      out.on('error', (e) => fail(err(500, `Uložení selhalo: ${e.message}`)));
    });
  }

  /** Cesta k souboru přílohy, nebo null (jen v rámci účtu a projektu). */
  resolve(accountId, projectId, id) {
    if (typeof id !== 'string' || !ID_RX.test(id)) return null;
    const dir = path.join(this.dirFor(accountId, projectId), id);
    try {
      const files = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile());
      return files.length === 1 ? path.join(dir, files[0]) : null;
    } catch { return null; }
  }

  remove(accountId, projectId, id) {
    if (typeof id !== 'string' || !ID_RX.test(id)) return false;
    const dir = path.join(this.dirFor(accountId, projectId), id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Smaže přílohy starší než 7 dní (volá se při startu). */
  cleanup(now = Date.now()) {
    let removed = 0;
    const walk = (dir, depth) => {
      let names;
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = path.join(dir, n);
        if (depth < 2) { walk(p, depth + 1); continue; }
        try { if (ID_RX.test(n) && now - statSync(p).mtimeMs > MAX_AGE_MS) { rmSync(p, { recursive: true, force: true }); removed++; } } catch { /* nic */ }
      }
    };
    walk(this.root, 0);
    if (removed) this.log(`Smazáno ${removed} starých příloh.`);
    return removed;
  }
}

/** Blok do promptu s cestami k přílohám. */
export function attachmentsPrompt(files) {
  if (!files.length) return '';
  return '\n\nPřílohy od uživatele (soubory jen ke čtení, přečti je nástrojem Read):\n' + files.map((f) => `- ${f}`).join('\n');
}

/** První bajty souboru (pro testy). */
export function readHead(file, n = 16) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(n); const r = readSync(fd, b, 0, n, 0); return b.subarray(0, r); } finally { closeSync(fd); }
}
