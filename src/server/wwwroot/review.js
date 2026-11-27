'use strict';
/* Čistá logika bez DOM (testy: tests/review.test.mjs):
   – hledání v konverzaci bez ohledu na diakritiku a velikost písmen (mapování pozic zpět do původního textu),
   – čísla řádků v unified diffu (pro komentáře k řádkům),
   – text zprávy pro Clauda z komentářů k diffu. */
(function (root) {
  const foldChar = (c) => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  /**
   * Výskyty `query` v `text` (bez diakritiky a velikosti písmen).
   * @returns {Array<[number, number]>} dvojice [začátek, konec) v původním textu
   */
  function findAll(text, query) {
    const needle = fold(query).trim();
    if (!needle || !text) return [];
    let folded = '';
    const map = []; // index ve folded → index v původním textu
    for (let i = 0; i < text.length; i++) {
      // Náhradní dvojice (emoji) zpracuj jako celek, ať se nerozdělí.
      const cp = text.codePointAt(i);
      const ch = cp > 0xffff ? text.slice(i, i + 2) : text[i];
      const f = foldChar(ch);
      for (let k = 0; k < f.length; k++) { folded += f[k]; map.push(i); }
      if (ch.length === 2) i++;
    }
    const out = [];
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
      const start = map[at];
      const lastIdx = map[at + needle.length - 1];
      let end = lastIdx + ((text.codePointAt(lastIdx) ?? 0) > 0xffff ? 2 : 1);
      while (end < text.length && foldChar(text[end]) === '') end++; // následné kombinující znaky (čárka v NFD)
      out.push([start, end]);
    }
    return out;
  }

  /**
   * Řádky unified diffu s čísly. kind: file | hunk | add | del | ctx | meta („\ No newline…“).
   * `line` = číslo v nové verzi (add, ctx), u odebraných v původní (`side: 'old'`).
   * @returns {Array<{kind:string, text:string, line?:number, side?:'new'|'old'}>}
   */
  function diffLines(diff) {
    const out = [];
    let oldNo = 0, newNo = 0, inHunk = false;
    for (const text of String(diff || '').replace(/\n$/, '').split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (h) { oldNo = Number(h[1]); newNo = Number(h[2]); inHunk = true; out.push({ kind: 'hunk', text }); continue; }
      if (text.startsWith('diff --git')) inHunk = false;
      if (!inHunk) { out.push({ kind: 'file', text }); continue; } // hlavičky souboru (index, ---, +++ …)
      if (text.startsWith('+')) out.push({ kind: 'add', text, line: newNo++, side: 'new' });
      else if (text.startsWith('-')) out.push({ kind: 'del', text, line: oldNo++, side: 'old' });
      else if (text.startsWith('\\')) out.push({ kind: 'meta', text });
      else { out.push({ kind: 'ctx', text, line: newNo, side: 'new' }); oldNo++; newNo++; }
    }
    return out;
  }

  /** Kód v Markdownu tak, aby ho neukončil zpětný apostrof v textu. */
  function inlineCode(s) {
    const t = String(s);
    const runs = t.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
    const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${t}${pad}${fence}`;
  }

  const KIND_LABEL = { add: 'přidaný řádek', del: 'odebraný řádek', ctx: 'řádek' };
  const AREA_LABEL = { staged: 'připraveno ke commitu', worktree: 'neuložené změny', untracked: 'nový soubor' };

  /**
   * Zpráva pro Clauda z komentářů k diffu.
   * @param {Array<{file:string, area:string, kind:string, line:number, side:string, text:string, note:string}>} comments
   */
  function commentsMessage(comments) {
    const items = comments.slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const lines = ['Moje komentáře ke změnám v projektu (git diff). Projdi je a uprav kód podle nich:', ''];
    items.forEach((c, i) => {
      const code = c.text.replace(/^[+\- ]/, '').trim().slice(0, 200);
      const where = `${inlineCode(c.file)}, ${KIND_LABEL[c.kind] || 'řádek'} ${c.line}${c.side === 'old' ? ' (číslováno podle původní verze)' : ''}`
        + (AREA_LABEL[c.area] ? `, ${AREA_LABEL[c.area]}` : '');
      lines.push(`${i + 1}. ${where}${code ? `: ${inlineCode(code)}` : ''}`);
      for (const l of c.note.trim().split('\n')) lines.push(`   ${l}`);
    });
    return lines.join('\n');
  }

  /* ---------- Průběh práce: značky [[plan: …]] a [[step: N|done]] (viz PROGRESS_PROMPT na serveru) ---------- */
  const MARK_LINE_RX = /^[ \t]*\[\[(plan|step):[^\]\n]*\]\][ \t]*(\r?\n|$)/gm;
  const MARK_RX = /\[\[(plan|step):\s*([^\]\n]*)\]\]/g;
  const MAX_STEPS = 12;

  /**
   * Značky průběhu v textu odpovědi a text bez nich.
   * @param {string} text @param {boolean} [partial] text se ještě píše → skrýt i rozepsanou značku na konci
   * @returns {{clean:string, marks:Array<{type:'plan', steps:string[]}|{type:'step', step:number|'done'}>}}
   */
  function progressMarks(text, partial) {
    const src = String(text || '');
    const marks = [];
    for (const m of src.matchAll(MARK_RX)) {
      const body = m[2].trim();
      if (m[1] === 'plan') {
        const steps = body.split('|').map((s) => s.trim()).filter(Boolean).slice(0, MAX_STEPS).map((s) => s.slice(0, 160));
        if (steps.length) marks.push({ type: 'plan', steps });
      } else if (/^done$/i.test(body)) marks.push({ type: 'step', step: 'done' });
      else if (/^\d{1,2}$/.test(body)) marks.push({ type: 'step', step: Number(body) });
    }
    let clean = src.replace(MARK_LINE_RX, '').replace(MARK_RX, '');
    if (partial) clean = clean.replace(/\[\[?(?:[a-z]{0,4}(?::[^\]\n]{0,200})?\]?)?$/, ''); // „[[st…“ při psaní
    return { clean: clean.replace(/^\s*\n/, ''), marks };
  }

  /** Nový stav průběhu. */
  const newProgress = () => ({ steps: [], cur: 0, done: false, times: [], endAt: 0 });

  /** Použije značku na stav (mění ho). `now` v ms; null = čas neznámý (historie). */
  function applyMark(st, mark, now) {
    if (mark.type === 'plan') {
      const same = mark.steps.length === st.steps.length && mark.steps.every((s, i) => s === st.steps[i]);
      if (!same) {
        st.steps = mark.steps;
        st.cur = Math.min(st.cur, st.steps.length);
        st.times = st.times.slice(0, st.cur + 1);
        st.done = false;
      }
    } else if (mark.step === 'done') {
      if (!st.steps.length) return st;
      st.done = true;
      st.cur = st.steps.length;
      st.endAt = now ?? 0;
    } else if (mark.step >= 1 && mark.step <= st.steps.length) {
      st.cur = mark.step;
      st.done = false;
      if (now != null && st.times[mark.step] == null) st.times[mark.step] = now;
    }
    return st;
  }

  /**
   * Procenta a odhad zbývajícího času: průměrná délka hotových kroků × zbývající kroky − čas v aktuálním kroku.
   * @returns {{total:number, cur:number, completed:number, percent:number, etaMs:number|null}}
   */
  function progressInfo(st, now) {
    const total = st.steps.length;
    if (!total) return { total: 0, cur: 0, completed: 0, percent: 0, etaMs: null };
    if (st.done) return { total, cur: total, completed: total, percent: 100, etaMs: 0 };
    const completed = Math.max(0, st.cur - 1);
    const durations = [];
    for (let i = 1; i < st.cur; i++) if (st.times[i] != null && st.times[i + 1] != null) durations.push(st.times[i + 1] - st.times[i]);
    let etaMs = null;
    if (durations.length && st.times[st.cur] != null) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      etaMs = Math.max(0, Math.round(avg * (total - completed) - (now - st.times[st.cur])));
    }
    return { total, cur: st.cur, completed, percent: Math.round((completed / total) * 100), etaMs };
  }

  /** „asi 3 min“ / „asi 40 s“ / „už brzy“. */
  function fmtEta(ms) {
    if (ms == null) return '';
    if (ms < 15_000) return 'už brzy';
    if (ms < 90_000) return `asi ${Math.round(ms / 10_000) * 10} s`;
    if (ms < 3_600_000) return `asi ${Math.round(ms / 60_000)} min`;
    return `asi ${(ms / 3_600_000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} h`;
  }

  /* ---------- @ soubor v poli pro psaní ---------- */
  /** Rozepsané „@něco“ těsně před kurzorem (na začátku nebo po mezeře). */
  function atQuery(value, caret) {
    const m = /(^|\s)@([^\s@"]{0,200})$/.exec(String(value).slice(0, caret));
    return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
  }
  /** Soubory podle dotazu: všechna slova (bez diakritiky), shoda v názvu souboru dřív; nejvýš `max`. */
  function rankFiles(files, q, max = 12) {
    const terms = fold(q).split(/[\s/\\]+/).filter(Boolean);
    const name = (p) => fold(p.slice(p.lastIndexOf('/') + 1));
    const hits = terms.length ? files.filter((p) => { const f = fold(p); return terms.every((t) => f.includes(t)); }) : files.slice(0, 200);
    const score = (p) => (terms.length && name(p).startsWith(terms[terms.length - 1]) ? 0 : terms.length && name(p).includes(terms[terms.length - 1]) ? 1 : 2);
    return hits.map((p, i) => [p, score(p), i]).sort((a, b) => a[1] - b[1] || a[0].length - b[0].length || a[2] - b[2]).slice(0, max).map((x) => x[0]);
  }

  root.Review = { fold, findAll, diffLines, commentsMessage, inlineCode, progressMarks, newProgress, applyMark, progressInfo, fmtEta,
    atQuery, rankFiles };
})(typeof window !== 'undefined' ? window : globalThis);
