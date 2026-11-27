// @ts-check
// Sezení = transkripty <projectsDirectory>\<cwd s ne-alfanumerickými znaky → '-'>\<id>.jsonl
// v adresáři zvoleného účtu. Resume a historie jen pro sezení, která tu existují.
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidId = (id) => typeof id === 'string' && ID_RX.test(id);

export const projectDir = (projectsDirectory, projectPath) =>
  path.join(projectsDirectory, projectPath.replace(/[^a-zA-Z0-9]/g, '-'));

export function transcriptPath(projectsDirectory, projectPath, sessionId) {
  if (!isValidId(sessionId)) return null;
  const p = path.join(projectDir(projectsDirectory, projectPath), `${sessionId}.jsonl`);
  return existsSync(p) ? p : null;
}

function readLines(file) {
  try { return readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; }
}

/** Text uživatelské zprávy; systémové vložky (<…>) nejsou zprávy uživatele. */
function userText(o) {
  const c = o?.message?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.find((b) => b?.type === 'text' && typeof b.text === 'string')?.text : undefined;
  if (!text || !text.trim() || text.trimStart().startsWith('<')) return undefined;
  return text;
}

/** Název: poslední custom-title, jinak ai-title, jinak první uživatelská zpráva. */
function readTitle(file) {
  let custom, ai, firstUser;
  for (const line of readLines(file)) {
    // Rychlé předfiltrování – transkripty mohou mít megabajty.
    const relevant = line.includes('"type":"ai-title"') || line.includes('"type":"custom-title"') ||
      (!firstUser && line.includes('"type":"user"'));
    if (!relevant) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title') custom = o.customTitle ?? o.title ?? custom;
    else if (o.type === 'ai-title') ai = o.aiTitle ?? ai;
    else if (o.type === 'user' && !firstUser && o.isMeta == null) firstUser = userText(o);
  }
  const t = String(custom ?? ai ?? firstUser ?? '(bez názvu)').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

export function listSessions(projectsDirectory, projectPath, max = 50) {
  const dir = projectDir(projectsDirectory, projectPath);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.jsonl') && isValidId(n.slice(0, -6)))
    .map((n) => ({ n, mtime: statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map(({ n, mtime }) => ({ id: n.slice(0, -6), updated: new Date(mtime).toISOString(), title: readTitle(path.join(dir, n)) }));
}

/** Zjednodušená historie: texty uživatele a Claude, názvy nástrojů. */
export function history(file, maxItems = 400) {
  const items = [];
  for (const line of readLines(file)) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain === true) continue;
    if (o.type === 'user' && o.isMeta == null) {
      const t = userText(o);
      if (t) items.push({ role: 'user', text: t });
    } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type === 'text' && b.text) items.push({ role: 'assistant', text: b.text });
        else if (b?.type === 'tool_use') items.push({ role: 'tool', name: b.name });
      }
    }
  }
  return items.slice(-maxItems);
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Hledání: nejvýš tolik nejnovějších sezení a tolik bajtů na jeden transkript. */
export const SEARCH_MAX_FILES = 50;
export const SEARCH_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Fulltext v textech uživatele a Claude (bez nástrojů a vedlejších agentů) v sezeních jednoho účtu a projektu.
 * Bez rozlišení velikosti písmen a diakritiky. Vrací sezení s úryvkem kolem první shody.
 * @param {string} q 2–100 znaků
 */
export function searchSessions(projectsDirectory, projectPath, q, { maxFiles = SEARCH_MAX_FILES, maxResults = 30 } = {}) {
  const needle = fold(String(q).replace(/\s+/g, ' ').trim());
  if (needle.length < 2 || needle.length > 100) return [];
  const dir = projectDir(projectsDirectory, projectPath);
  const out = [];
  for (const s of listSessions(projectsDirectory, projectPath, maxFiles)) {
    const file = path.join(dir, `${s.id}.jsonl`);
    try { if (statSync(file).size > SEARCH_MAX_BYTES) continue; } catch { continue; }
    let hit = null;
    for (const line of readLines(file)) {
      if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain === true) continue;
      const texts = o.type === 'user' && o.isMeta == null ? [userText(o)]
        : o.type === 'assistant' && Array.isArray(o.message?.content) ? o.message.content.filter((b) => b?.type === 'text').map((b) => b.text) : [];
      for (const t of texts) {
        if (typeof t !== 'string') continue;
        const flat = t.replace(/\s+/g, ' ');
        // fold() zachová délku jen pro složené znaky; pro úryvek stačí přibližná pozice.
        const i = fold(flat).indexOf(needle);
        if (i < 0) continue;
        const from = Math.max(0, i - 50);
        hit = { role: o.type === 'user' ? 'user' : 'assistant',
          snippet: (from > 0 ? '…' : '') + flat.slice(from, i + needle.length + 70).trim() + (i + needle.length + 70 < flat.length ? '…' : '') };
        break;
      }
      if (hit) break;
    }
    if (hit) out.push({ ...s, ...hit });
    if (out.length >= maxResults) break;
  }
  return out;
}
