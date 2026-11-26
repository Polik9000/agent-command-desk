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
