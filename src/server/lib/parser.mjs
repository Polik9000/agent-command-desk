// @ts-check
// Převádí řádky `--output-format stream-json` na malé normalizované události pro UI.
// Jedna instance na běh (drží id aktuální zprávy pro text_delta a soubory plánu).
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUnder } from './config.mjs';

const MAX_TOOL_OUTPUT = 20_000;
const MAX_IMAGE_B64 = 2_000_000; // ~1,5 MB obrázku
const MAX_IMAGES = 3;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Obrázky z výsledku nástroje (snímek obrazovky, přečtený obrázek) – jen base64 známých typů, omezeně. */
function images(content) {
  if (!Array.isArray(content)) return undefined;
  const out = content.filter((b) => b?.type === 'image' && b.source?.type === 'base64' && IMAGE_TYPES.has(b.source.media_type)
    && typeof b.source.data === 'string' && b.source.data.length <= MAX_IMAGE_B64 && /^[A-Za-z0-9+/=\s]+$/.test(b.source.data.slice(0, 200)))
    .slice(0, MAX_IMAGES).map((b) => ({ mediaType: b.source.media_type, data: b.source.data.replace(/\s+/g, '') }));
  return out.length ? out : undefined;
}
const short = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const TASK_STATUS = new Set(['running', 'completed', 'failed', 'stopped', 'killed', 'pending']);
const str = (v) => (typeof v === 'string' ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
/** Tokeny z result.usage (vstup, výstup, čtení a zápis cache). */
function usage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const r = { input: num(u.input_tokens) ?? 0, output: num(u.output_tokens) ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0, cacheWrite: num(u.cache_creation_input_tokens) ?? 0 };
  return r.input + r.output + r.cacheRead + r.cacheWrite > 0 ? r : undefined;
}
/**
 * Tokeny a odhad ceny tohoto tahu po modelech (`model_usage_since_last_result`, ověřeno na 2.1.332): obsahuje hlavní
 * konverzaci i pracovníky (subagenty). `result.usage` je jen hlavní konverzace – součet se proto počítá jen odsud.
 */
function modelUsage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const out = Object.entries(m).slice(0, 20).filter(([k, v]) => typeof k === 'string' && k.length <= 100 && v && typeof v === 'object')
    .map(([model, v]) => ({ model, input: num(v.inputTokens) ?? 0, output: num(v.outputTokens) ?? 0,
      cacheRead: num(v.cacheReadInputTokens) ?? 0, cacheWrite: num(v.cacheCreationInputTokens) ?? 0, costUsd: num(v.costUSD) }));
  return out.length ? out : undefined;
}
/** Počty subagentů tahu (`subagent_stats`). */
function subagentStats(st) {
  if (!st || typeof st !== 'object') return undefined;
  const spawned = num(st.spawned);
  return spawned ? { spawned, completed: num(st.completed) ?? 0, failed: num(st.failed) ?? 0 } : undefined;
}
/** Okna limitu předplatného (five_hour, seven_day…) s využitím 0–1. */
function windows(w) {
  if (!w || typeof w !== 'object') return [];
  return Object.entries(w).slice(0, 10).filter(([, v]) => v && typeof v === 'object')
    .map(([type, v]) => ({ type, utilization: num(v.utilization), resetsAt: num(v.resetsAt), status: str(v.status) }));
}
const NAME_RX = /^[A-Za-z0-9][\w:.-]{0,99}$/;
/** Názvy příkazů a skillů z init (pro paletu): jen rozumné řetězce, nejvýš 300. */
const names = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && NAME_RX.test(x)))].slice(0, 300) : []);
const MCP_STATUS = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);
const MCP_SOURCE = new Set(['claudeai', 'plugin', 'user', 'project', 'local', 'dynamic', 'enterprise', 'managed']);
// Názvy MCP serverů mají i mezery a dvojtečky („claude.ai Gmail“, „plugin:x:y“) – jen bez řídicích znaků.
const MCP_NAME_RX = /^[^\u0000-\u001f\u007f<>]{1,120}$/;
/** Stav MCP serverů z init (název, stav, zdroj – žádná konfigurace ani přihlašovací údaje). */
const mcpServers = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && MCP_NAME_RX.test(x.name)).slice(0, 100)
  .map((x) => ({ name: x.name, status: MCP_STATUS.has(x.status) ? x.status : 'unknown',
    ...(MCP_SOURCE.has(x.source) ? { source: x.source } : {}) })) : undefined);

/** Odstraní undefined/null pole (menší SSE zprávy). */
export function ev(type, fields = {}) {
  const o = { type };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) o[k] = v;
  return o;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((b) => (b?.type === 'text' ? b.text ?? '' : `[${b?.type}]`)).join('\n');
  if (content == null) return '';
  return JSON.stringify(content);
}

const truncate = (s) =>
  s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n… (zkráceno, celkem ${s.length} znaků)`;

export class StreamParser {
  /** @param {string} plansDir  <configDir>\plans */
  constructor(plansDir) {
    this.plansDir = plansDir;
    /** @type {Map<string,string>} */
    this.currentMessage = new Map();
    /** @type {Set<string>} */
    this.planFiles = new Set();
    /** @type {string|undefined} */
    this.sessionId = undefined;
  }

  /** @param {string} line @returns {object[]} */
  parse(line) {
    if (!line || !line.trim()) return [];
    let e;
    try { e = JSON.parse(line); } catch { return []; }
    if (!e || typeof e !== 'object') return [];
    const parent = str(e.parent_tool_use_id);
    const out = [];

    switch (e.type) {
      case 'system':
        if (e.subtype === 'init') {
          this.sessionId = str(e.session_id);
          out.push(ev('init', { sessionId: this.sessionId, model: str(e.model), permissionMode: str(e.permissionMode),
            cwd: str(e.cwd), version: str(e.claude_code_version), slashCommands: names(e.slash_commands), skills: names(e.skills),
            mcpServers: mcpServers(e.mcp_servers) }));
        } else if (e.subtype === 'api_retry') {
          out.push(ev('retry', { attempt: e.attempt, maxRetries: e.max_retries, error: str(e.error), errorStatus: e.error_status }));
        } else if (e.subtype === 'status' && typeof e.permissionMode === 'string') {
          out.push(ev('status', { permissionMode: e.permissionMode }));
        } else if (e.subtype === 'session_title_changed') {
          out.push(ev('title', { title: short(e.title, 200) }));
        } else if (e.subtype === 'task_started' || e.subtype === 'task_progress' || e.subtype === 'task_updated' || e.subtype === 'task_notification') {
          // Agenti a příkazy na pozadí: začal / průběh / změna stavu / hotovo.
          const u = e.usage && typeof e.usage === 'object' ? e.usage : {};
          const status = str(e.patch?.status) ?? str(e.status);
          out.push(ev('task', { phase: e.subtype.slice(5), taskId: short(e.task_id, 80), toolUseId: str(e.tool_use_id),
            description: short(e.description, 300), taskType: short(e.task_type, 40), subagentType: short(e.subagent_type, 80),
            background: e.is_backgrounded === true ? true : undefined, status: status && TASK_STATUS.has(status) ? status : undefined,
            lastTool: short(e.last_tool_name, 80), tokens: num(u.total_tokens), toolUses: num(u.tool_uses), ms: num(u.duration_ms),
            summary: short(e.summary, 500), parent }));
        } else if (e.subtype === 'background_tasks_changed') {
          out.push(ev('bg_tasks', { tasks: (Array.isArray(e.tasks) ? e.tasks : []).slice(0, 30)
            .map((t) => ({ taskId: short(t?.task_id, 80), taskType: short(t?.task_type, 40), description: short(t?.description, 300) })) }));
        }
        break;

      case 'stream_event':
        out.push(...this.#streamEvent(e.event, parent));
        break;

      case 'assistant': {
        const msgId = str(e.message?.id);
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (b?.type === 'text') out.push(ev('text', { messageId: msgId, text: str(b.text), parent }));
          else if (b?.type === 'tool_use') {
            this.#trackPlan(str(b.name), b.input);
            out.push(ev('tool_use', { id: str(b.id), name: str(b.name), input: b.input, parent }));
          }
        }
        break;
      }

      case 'user': {
        // --replay-user-messages: Claude Code potvrzuje, že zprávu ze vstupu převzal (první = úvodní prompt).
        if (e.isReplay === true) {
          const c = e.message?.content;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '';
          if (text) out.push(ev('user_replay', { text: text.slice(0, 200), uuid: str(e.uuid) }));
          break;
        }
        /** @type {Map<string, any>} */
        const decisions = new Map();
        for (const m of Array.isArray(e.tool_result_meta) ? e.tool_result_meta : [])
          if (typeof m?.id === 'string' && m.permission_decision) decisions.set(m.id, m.permission_decision);
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (b?.type !== 'tool_result') continue;
          const id = str(b.tool_use_id) ?? '';
          const d = decisions.get(id);
          const decision = str(d?.decision);
          out.push(ev('tool_result', {
            id,
            isError: b.is_error === true,
            content: truncate(resultText(b.content)),
            images: images(b.content),
            decision,
            denied: decision !== undefined && decision !== 'accept',
            decisionSource: str(d?.source),
            decisionReason: str(d?.reason) ?? str(d?.reason_type),
            parent,
          }));
        }
        break;
      }

      // Odpověď Claude Code na řídicí požadavek aplikace (initialize, interrupt, set_permission_mode…).
      case 'control_response': {
        const r = e.response ?? {};
        const requestId = str(r.request_id);
        if (requestId) out.push(ev('control_response', { requestId, ok: r.subtype === 'success', data: r.response, error: str(r.error) }));
        break;
      }

      // Žádost o rozhodnutí od Claude Code (jen s --permission-prompt-tool stdio). Odpovídá runner, ne UI přímo.
      case 'control_request': {
        const r = e.request ?? {};
        const requestId = str(e.request_id);
        if (!requestId) break;
        if (r.subtype === 'can_use_tool') {
          out.push(ev('control_permission', { requestId, toolName: str(r.tool_name) ?? '?', displayName: str(r.display_name),
            description: str(r.description), blockedPath: str(r.blocked_path), toolUseId: str(r.tool_use_id),
            input: r.input, suggestions: r.permission_suggestions }));
        } else out.push(ev('control_other', { requestId, subtype: str(r.subtype) }));
        break;
      }

      case 'rate_limit_event': {
        const info = e.rate_limit_info ?? {};
        const lt = str(info.rateLimitType);
        const util = lt ? info.unifiedWindows?.[lt]?.utilization : undefined;
        out.push(ev('rate_limit', { status: str(info.status), limitType: lt, resetsAt: info.resetsAt,
          utilization: typeof util === 'number' ? util : undefined, windows: windows(info.unifiedWindows) }));
        break;
      }

      case 'result': {
        const denials = (Array.isArray(e.permission_denials) ? e.permission_denials : [])
          .map((p) => ({ toolName: str(p?.tool_name), toolUseId: str(p?.tool_use_id) }));
        this.sessionId ??= str(e.session_id);
        out.push(ev('result', {
          subtype: str(e.subtype), isError: e.is_error === true, result: str(e.result), costUsd: e.total_cost_usd,
          numTurns: e.num_turns, durationMs: e.duration_ms, sessionId: str(e.session_id),
          terminalReason: str(e.terminal_reason), apiErrorStatus: e.api_error_status, denials, usage: usage(e.usage),
          modelUsage: modelUsage(e.model_usage_since_last_result), subagents: subagentStats(e.subagent_stats),
        }));
        break;
      }
    }
    return out;
  }

  #streamEvent(se, parent) {
    if (!se || typeof se !== 'object') return [];
    const key = parent ?? '';
    switch (se.type) {
      case 'message_start': {
        const id = str(se.message?.id) ?? randomUUID();
        this.currentMessage.set(key, id);
        return [ev('message_start', { messageId: id, parent })];
      }
      case 'content_block_start':
        if (se.content_block?.type === 'tool_use')
          return [ev('tool_start', { id: str(se.content_block.id), name: str(se.content_block.name), parent })];
        return [];
      case 'content_block_delta':
        if (se.delta?.type === 'text_delta')
          return [ev('text_delta', { messageId: this.currentMessage.get(key), index: se.index, text: str(se.delta.text), parent })];
        return [];
      default:
        return [];
    }
  }

  #trackPlan(tool, input) {
    if (!['Write', 'Edit', 'MultiEdit'].includes(tool ?? '')) return;
    const fp = str(input?.file_path);
    if (!fp || !path.isAbsolute(fp)) return;
    if (isUnder(fp, this.plansDir) && path.extname(fp).toLowerCase() === '.md') this.planFiles.add(path.resolve(fp));
  }
}
