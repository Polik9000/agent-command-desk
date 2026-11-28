// Falešný `claude -p --input-format stream-json` pro testy běhů: na každou zprávu ze stdin odpoví jedním tahem.
// Text zprávy řídí chování: EXITPLAN = nástroj ExitPlanMode, DRIFT = init hlásí jiný režim, FAIL = výsledek s chybou,
// SLOW = výsledek až po 3 s (lze přerušit). Řídicí požadavky: initialize, set_permission_mode, set_model, interrupt,
// get_context_usage (jako Claude Code 2.1.332).
// --fake-batch: odpověď na initialize pozdrží do první zprávy a pošle ji s celým tahem jedním zápisem
// (stdout se u rodiče přečte jako jeden blok – tak se to stávalo na macOS, issue #2).
// Orchestrace: --version (nebo --fake-version X) vypíše verzi; --agents <soubor> načte pracovníky. Zpráva s ÚKOL
// (vícekrokový úkol) se s pracovníky deleguje na acd-explore (Agent + task_* + model_usage_since_last_result),
// jakákoli jiná zpráva zůstane u hlavního modelu. AGENTS? vypíše pracovníky a zda dostal pokyny orchestrace.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--version')) process.stdout.write(`${opt('--fake-version') ?? '2.1.332'} (Claude Code)\n`, () => process.exit(0));
/** @type {Record<string, any>} */
let agents = {};
if (opt('--agents')) agents = JSON.parse(readFileSync(opt('--agents'), 'utf8'));
const guided = (opt('--append-system-prompt') ?? '').includes('Orchestration is enabled');
const sessionId = args.includes('--fork-session') ? randomUUID() : opt('--resume') ?? randomUUID();
let mode = opt('--permission-mode');
let model = opt('--model') ?? 'default';
/** @type {string[]|null} rozepsaný blok výstupu (jen --fake-batch, do konce prvního tahu) */
let pending = args.includes('--fake-batch') ? [] : null;
const out = (o) => { const l = JSON.stringify(o) + '\n'; if (pending) pending.push(l); else process.stdout.write(l); };
const flush = () => { if (pending) { const b = pending.join(''); pending = null; process.stdout.write(b); } };
let turn = 0;
let slow = null; // {timer, turn}

const delegated = new Set();
let spawnedTotal = 0; // subagent_stats je součet za proces (jako Claude Code 2.1.332)
const finish = (t, isError, extra = {}) => {
  const main = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 5, costUSD: 0.1 };
  const mu = { [`claude-${model}`]: main, ...(delegated.has(t) ? { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 300, cacheCreationInputTokens: 50, costUSD: 0.01 } } : {}) };
  out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError,
    result: `pid:${process.pid}:turn:${t}`, session_id: sessionId, total_cost_usd: 0.1 * t, // součet za proces
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    model_usage_since_last_result: mu,
    subagent_stats: { spawned: spawnedTotal, completed: spawnedTotal, failed: 0, max_depth: spawnedTotal ? 1 : 0 }, ...extra });
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') {
    const r = m.request || {};
    let response = {};
    if (r.subtype === 'initialize') response = { commands: [{ name: 'review', description: 'Zkontroluje změny', argumentHint: '[větev]' }, { name: 'a b', description: 'x' }], agents: [{ name: 'Explore', description: 'Hledá v kódu' }] };
    else if (r.subtype === 'set_permission_mode') { mode = r.mode; response = { mode }; out({ type: 'system', subtype: 'status', permissionMode: mode, session_id: sessionId }); }
    else if (r.subtype === 'set_model') { model = r.model; response = { model }; }
    else if (r.subtype === 'get_context_usage') response = { percentage: 12, totalTokens: 24000, maxTokens: 200000, categories: [{ name: 'Messages', tokens: 1000 }] };
    else if (r.subtype === 'interrupt') {
      response = { still_queued: [] };
      if (slow) { clearTimeout(slow.timer); const t = slow.turn; slow = null; finish(t, true, { terminal_reason: 'aborted_tools' }); }
    } else { out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Unsupported control request subtype: ${r.subtype}` } }); return; }
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    return;
  }
  if (m.type !== 'user') return;
  const text = String(m.message?.content ?? '');
  turn++;
  out({ type: 'system', subtype: 'init', session_id: sessionId, permissionMode: text.includes('DRIFT') ? 'acceptEdits' : mode,
    model, cwd: process.cwd(), claude_code_version: 'fake' });
  out({ type: 'user', isReplay: true, uuid: randomUUID(), message: { role: 'user', content: text } });
  if (text.includes('EXITPLAN'))
    out({ type: 'assistant', message: { id: `m${turn}x`, content: [{ type: 'tool_use', id: `tu${turn}`, name: 'ExitPlanMode', input: {} }] } });
  out({ type: 'assistant', message: { id: `m${turn}`, content: [{ type: 'text', text: `pid ${process.pid} turn ${turn} model ${model}` }] } });
  if (text.includes('AGENTS?'))
    out({ type: 'assistant', message: { id: `m${turn}a`, content: [{ type: 'text', text: `agents:${Object.keys(agents).join(',') || '-'} guided:${guided}` }] } });
  if (text.includes('ÚKOL') && agents['acd-explore']) {
    const tu = `tu${turn}agent`;
    delegated.add(turn);
    spawnedTotal++;
    out({ type: 'assistant', message: { id: `m${turn}d`, content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: 'Najdi použití', subagent_type: 'acd-explore', prompt: 'Najdi…' } }] } });
    out({ type: 'system', subtype: 'task_started', task_id: `t${turn}`, tool_use_id: tu, subagent_type: 'acd-explore', task_type: 'local_agent', description: 'Najdi použití', session_id: sessionId });
    out({ type: 'assistant', parent_tool_use_id: tu, message: { id: `m${turn}c`, model: agents['acd-explore'].model, content: [{ type: 'text', text: 'nalezeno 2×' }] } });
    out({ type: 'system', subtype: 'task_notification', task_id: `t${turn}`, tool_use_id: tu, status: 'completed', usage: { total_tokens: 900, tool_uses: 1, duration_ms: 50 }, session_id: sessionId });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tu, content: 'nalezeno 2×' }] } });
  }
  if (text.includes('SLOW')) { flush(); const t = turn; slow = { turn: t, timer: setTimeout(() => { slow = null; finish(t, false); }, 3000) }; return; }
  finish(turn, text.includes('FAIL'));
  flush();
});
