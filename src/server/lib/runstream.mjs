// @ts-check
// Běh → HTTP odpověď text/event-stream. Posluchače se připojí dřív, než se pustí zadržené události běhu
// (run.release), takže ani rychlé úvodní události (commands z initialize) se neztratí (issue #2).
import { ev } from './parser.mjs';

/**
 * @param {import('node:http').ServerResponse} res
 * @param {any} run běh z ClaudeRunner.start (EventEmitter s release/stop/ended)
 * @param {object} head pole úvodní události `run`
 * @param {Array<(e:any) => void>} [observers] další posluchači událostí (statistiky)
 */
export function streamRun(res, run, head, observers = []) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
  const send = (e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
  send(ev('run', head));
  run.on('event', send);
  for (const o of observers) run.on('event', o);
  run.once('end', () => res.end());
  // Okno zavřeno / spojení přerušeno → běh nenecháme viset.
  res.on('close', () => { if (!run.ended) run.stop(); });
  run.release?.();
}
