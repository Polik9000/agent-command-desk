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

  const KIND_LABEL = { add: _t('přidaný řádek'), del: _t('odebraný řádek'), ctx: _t('řádek') };
  const AREA_LABEL = { staged: _t('připraveno ke commitu'), worktree: _t('neuložené změny'), untracked: _t('nový soubor') };

  /**
   * Zpráva pro Clauda z komentářů k diffu.
   * @param {Array<{file:string, area:string, kind:string, line:number, side:string, text:string, note:string}>} comments
   */
  function commentsMessage(comments) {
    const items = comments.slice().sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const lines = [_t('Moje komentáře ke změnám v projektu (git diff). Projdi je a uprav kód podle nich:'), ''];
    items.forEach((c, i) => {
      const code = c.text.replace(/^[+\- ]/, '').trim().slice(0, 200);
      const where = `${inlineCode(c.file)}, ${KIND_LABEL[c.kind] || _t('řádek')} ${c.line}${c.side === 'old' ? _t(' (číslováno podle původní verze)') : ''}`
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

  /**
   * Průběh ze seznamu úkolů Claude Code: hotové / celkem, aktuální (první rozpracovaný) a odhad zbývajícího času
   * = průměrná délka hotových úkolů s časy × zbývající úkoly − čas strávený v aktuálním.
   * @param {Array<{status:string, start?:number, end?:number}>} tasks
   */
  function taskProgress(tasks, now) {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const current = tasks.findIndex((t) => t.status === 'in_progress');
    const done = total > 0 && completed === total;
    const durations = tasks.filter((t) => t.status === 'completed' && t.start != null && t.end != null).map((t) => t.end - t.start);
    let etaMs = null;
    if (!done && durations.length) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const inCur = current >= 0 && tasks[current].start != null ? now - tasks[current].start : 0;
      etaMs = Math.max(0, Math.round(avg * (total - completed) - Math.min(inCur, avg)));
    }
    return { total, completed, current, done, percent: total ? Math.round((completed / total) * 100) : 0, etaMs: done ? 0 : etaMs };
  }

  /** „asi 3 min“ / „asi 40 s“ / „už brzy“. */
  function fmtEta(ms) {
    if (ms == null) return '';
    if (ms < 15_000) return _t('už brzy');
    if (ms < 90_000) return _t('asi {0} s', Math.round(ms / 10_000) * 10);
    if (ms < 3_600_000) return _t('asi {0} min', Math.round(ms / 60_000));
    return _t('asi {0} h', (ms / 3_600_000).toLocaleString(LOC, { maximumFractionDigits: 1 }));
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

  root.Review = { fold, findAll, diffLines, commentsMessage, inlineCode, progressMarks, taskProgress, fmtEta,
    atQuery, rankFiles };
})(typeof window !== 'undefined' ? window : globalThis);
