// @ts-check
// Převádí řádky `--output-format stream-json` na malé normalizované události pro UI.
// Jedna instance na běh (drží id aktuální zprávy pro text_delta a soubory plánu).
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUnder } from './config.mjs';

const MAX_TOOL_OUTPUT = 20_000;
const str = (v) => (typeof v === 'string' ? v : undefined);
const NAME_RX = /^[A-Za-z0-9][\w:.-]{0,99}$/;
/** Názvy příkazů a skillů z init (pro paletu): jen rozumné řetězce, nejvýš 300. */
const names = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && NAME_RX.test(x)))].slice(0, 300) : []);

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
            cwd: str(e.cwd), version: str(e.claude_code_version), slashCommands: names(e.slash_commands), skills: names(e.skills) }));
        } else if (e.subtype === 'api_retry') {
          out.push(ev('retry', { attempt: e.attempt, maxRetries: e.max_retries, error: str(e.error), errorStatus: e.error_status }));
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
          if (text) out.push(ev('user_replay', { text: text.slice(0, 200) }));
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
            decision,
            denied: decision !== undefined && decision !== 'accept',
            decisionSource: str(d?.source),
            decisionReason: str(d?.reason) ?? str(d?.reason_type),
            parent,
          }));
        }
        break;
      }

      case 'rate_limit_event': {
        const info = e.rate_limit_info ?? {};
        const lt = str(info.rateLimitType);
        const util = lt ? info.unifiedWindows?.[lt]?.utilization : undefined;
        out.push(ev('rate_limit', { status: str(info.status), limitType: lt, resetsAt: info.resetsAt,
          utilization: typeof util === 'number' ? util : undefined }));
        break;
      }

      case 'result': {
        const denials = (Array.isArray(e.permission_denials) ? e.permission_denials : [])
          .map((p) => ({ toolName: str(p?.tool_name), toolUseId: str(p?.tool_use_id) }));
        this.sessionId ??= str(e.session_id);
        out.push(ev('result', {
          subtype: str(e.subtype), isError: e.is_error === true, result: str(e.result), costUsd: e.total_cost_usd,
          numTurns: e.num_turns, durationMs: e.duration_ms, sessionId: str(e.session_id),
          terminalReason: str(e.terminal_reason), apiErrorStatus: e.api_error_status, denials,
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
