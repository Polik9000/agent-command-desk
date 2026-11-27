// Falešný `claude -p --input-format stream-json` pro testy běhů: na každou zprávu ze stdin odpoví jedním tahem.
// Text zprávy řídí chování: EXITPLAN = nástroj ExitPlanMode, DRIFT = init hlásí jiný režim, FAIL = výsledek s chybou.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = opt('--resume') ?? randomUUID();
const mode = opt('--permission-mode');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let turn = 0;

createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== 'user') return;
  const text = String(m.message?.content ?? '');
  turn++;
  out({ type: 'system', subtype: 'init', session_id: sessionId, permissionMode: text.includes('DRIFT') ? 'acceptEdits' : mode,
    model: opt('--model') ?? 'default', cwd: process.cwd(), claude_code_version: 'fake' });
  out({ type: 'user', isReplay: true, message: { role: 'user', content: text } });
  if (text.includes('EXITPLAN'))
    out({ type: 'assistant', message: { id: `m${turn}x`, content: [{ type: 'tool_use', id: `tu${turn}`, name: 'ExitPlanMode', input: {} }] } });
  out({ type: 'assistant', message: { id: `m${turn}`, content: [{ type: 'text', text: `pid ${process.pid} turn ${turn}` }] } });
  out({ type: 'result', subtype: text.includes('FAIL') ? 'error_during_execution' : 'success', is_error: text.includes('FAIL'),
    result: `pid:${process.pid}:turn:${turn}`, session_id: sessionId, total_cost_usd: 0.1 * turn }); // jako Claude Code: součet za proces
});
