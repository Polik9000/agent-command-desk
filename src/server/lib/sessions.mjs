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
      if (t) items.push({ role: 'user', text: t, uuid: isValidId(o.uuid) ? o.uuid : undefined });
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

/* ---------- Přehled sezení (jen čtení z transkriptu) ---------- */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const OV_MAX_BYTES = 32 * 1024 * 1024;
const OV_MAX_AGENT_FILES = 40;
const s300 = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');

/**
 * Co se v sezení stalo: upravené soubory (i vedlejšími agenty), spuštění agenti, poslední seznam úkolů (TodoWrite),
 * použité nástroje a MCP servery. Čte jen transkript sezení a soubory jeho agentů (`<id>/subagents/agent-*.jsonl`).
 * @param {string} file transkript sezení
 * @param {string} projectPath cesta projektu (soubory uvnitř se ukážou relativně)
 */
export function overview(file, projectPath) {
  const root = path.resolve(projectPath);
  const rootLc = root.toLowerCase() + path.sep;
  /** @type {Map<string, {path:string, outside:boolean, edits:number, writes:number, failed:number, main:boolean, agent:boolean}>} */
  const files = new Map();
  /** @type {Map<string, {key:string}>} id tool_use → soubor (kvůli chybám) */
  const pendingEdits = new Map();
  /** @type {Map<string, {id:string, description:string, type:string, status:string}>} */
  const agents = new Map();
  /** @type {Map<string, number>} */ const tools = new Map();
  /** @type {Map<string, number>} */ const mcp = new Map();
  let todos = null, todosAt = null, started = null, updated = null, userMsgs = 0, replies = 0;
  /** Seznam úkolů Claude Code (TaskCreate/TaskUpdate): id → {content, status} */
  const tasks = new Map();
  /** @type {Map<string, string>} tool_use TaskCreate → název úkolu */
  const pendingTasks = new Map();

  const rel = (p) => {
    const abs = path.resolve(root, p);
    const inside = (abs.toLowerCase() + path.sep).startsWith(rootLc) || abs.toLowerCase() === root.toLowerCase();
    return inside ? { path: path.relative(root, abs).replaceAll('\\', '/') || '.', outside: false } : { path: abs, outside: true };
  };
  const scan = (lines, fromAgent) => {
    for (const line of lines) {
      if (!line || !(line.includes('"type":"assistant"') || line.includes('"type":"user"'))) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const sub = fromAgent || o.isSidechain === true;
      if (!sub && typeof o.timestamp === 'string') { started ??= o.timestamp; updated = o.timestamp; }
      const content = Array.isArray(o.message?.content) ? o.message.content : [];
      if (o.type === 'assistant') {
        if (!sub && content.some((b) => b?.type === 'text' && b.text)) replies++;
        for (const b of content) {
          if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
          const input = b.input && typeof b.input === 'object' ? b.input : {};
          if (!sub) tools.set(b.name, (tools.get(b.name) ?? 0) + 1);
          const m = /^mcp__(.+?)__/.exec(b.name);
          if (m) mcp.set(m[1], (mcp.get(m[1]) ?? 0) + 1);
          if (EDIT_TOOLS.has(b.name)) {
            const fp = input.file_path ?? input.notebook_path;
            if (typeof fp !== 'string' || !fp) continue;
            const r = rel(fp);
            const key = r.outside ? r.path.toLowerCase() : r.path;
            const f = files.get(key) ?? { ...r, edits: 0, writes: 0, failed: 0, main: false, agent: false };
            if (b.name === 'Write') f.writes++; else f.edits++;
            if (sub) f.agent = true; else f.main = true;
            files.set(key, f);
            if (typeof b.id === 'string') pendingEdits.set(b.id, { key });
          } else if (!sub && AGENT_TOOLS.has(b.name) && typeof b.id === 'string') {
            agents.set(b.id, { id: b.id, description: s300(input.description) || '(bez popisu)', type: s300(input.subagent_type), status: 'running' });
          } else if (!sub && b.name === 'TaskCreate' && typeof b.id === 'string') {
            pendingTasks.set(b.id, s300(input.subject) || s300(input.description) || '(bez názvu)');
          } else if (!sub && b.name === 'TaskUpdate' && tasks.has(String(input.taskId))) {
            const st = input.status;
            if (st === 'deleted') tasks.delete(String(input.taskId));
            else if (['pending', 'in_progress', 'completed'].includes(st)) tasks.get(String(input.taskId)).status = st;
            todosAt = typeof o.timestamp === 'string' ? o.timestamp : todosAt;
          } else if (!sub && b.name === 'TodoWrite' && Array.isArray(input.todos)) {
            todos = input.todos.slice(0, 100).filter((t) => t && typeof t === 'object')
              .map((t) => ({ content: s300(t.content), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
            todosAt = typeof o.timestamp === 'string' ? o.timestamp : null;
          }
        }
      } else if (o.type === 'user') {
        if (!sub && o.isMeta == null && userText(o)) userMsgs++;
        for (const b of content) {
          if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const pt = pendingTasks.get(b.tool_use_id);
          if (pt != null) {
            // „Task #3 created successfully: …“ → id úkolu pro TaskUpdate
            const txt = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x?.text ?? '').join(' ') : '';
            const mm = /#(\d+)/.exec(txt);
            if (mm && b.is_error !== true) { tasks.set(mm[1], { content: pt, status: 'pending' }); todosAt = typeof o.timestamp === 'string' ? o.timestamp : todosAt; }
            pendingTasks.delete(b.tool_use_id);
          }
          const pe = pendingEdits.get(b.tool_use_id);
          if (pe && b.is_error === true) { const f = files.get(pe.key); if (f) f.failed++; }
          const a = !sub && agents.get(b.tool_use_id);
          if (a) {
            const st = typeof o.toolUseResult?.status === 'string' ? o.toolUseResult.status : '';
            a.status = b.is_error === true ? 'error' : /async|launched|running/i.test(st) ? 'background' : 'done';
          }
        }
      }
    }
  };

  try { if (statSync(file).size <= OV_MAX_BYTES) scan(readLines(file), false); } catch { /* chybí */ }
  // Vedlejší agenti mají vlastní transkripty vedle sezení; meta.json říká, zda agent na pozadí doběhl.
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let names = [];
  try { names = readdirSync(subDir); } catch { /* sezení bez agentů */ }
  for (const n of names.filter((x) => /^agent-[\w-]+\.jsonl$/.test(x)).slice(0, OV_MAX_AGENT_FILES)) {
    const f = path.join(subDir, n);
    try { if (statSync(f).size <= OV_MAX_BYTES) scan(readLines(f), true); } catch { continue; }
    try {
      const meta = JSON.parse(readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      const a = typeof meta?.toolUseId === 'string' && agents.get(meta.toolUseId);
      if (a && a.status === 'background' && meta.finished === true) a.status = 'done';
    } catch { /* bez meta */ }
  }

  const sortBy = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  return {
    files: [...files.values()].sort((a, b) => Number(a.outside) - Number(b.outside) || a.path.localeCompare(b.path)).slice(0, 300),
    agents: [...agents.values()].slice(0, 100).map(({ id, ...a }) => a),
    todos: tasks.size ? [...tasks.values()].slice(0, 100) : todos, todosAt,
    tools: sortBy(tools).slice(0, 30),
    mcp: sortBy(mcp).slice(0, 30),
    userMessages: userMsgs, replies, started, updated,
  };
}
