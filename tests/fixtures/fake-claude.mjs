// Falešný `claude -p --input-format stream-json` pro testy běhů: na každou zprávu ze stdin odpoví jedním tahem.
// Text zprávy řídí chování: EXITPLAN = nástroj ExitPlanMode, DRIFT = init hlásí jiný režim, FAIL = výsledek s chybou,
// SLOW = výsledek až po 3 s (lze přerušit). Řídicí požadavky: initialize, set_permission_mode, set_model, interrupt,
// get_context_usage (jako Claude Code 2.1.332).
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = args.includes('--fork-session') ? randomUUID() : opt('--resume') ?? randomUUID();
let mode = opt('--permission-mode');
let model = opt('--model') ?? 'default';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let turn = 0;
let slow = null; // {timer, turn}

const finish = (t, isError, extra = {}) => out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError,
  result: `pid:${process.pid}:turn:${t}`, session_id: sessionId, total_cost_usd: 0.1 * t, ...extra }); // součet za proces

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
  if (text.includes('SLOW')) { const t = turn; slow = { turn: t, timer: setTimeout(() => { slow = null; finish(t, false); }, 3000) }; return; }
  finish(turn, text.includes('FAIL'));
});
