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

  root.Review = { fold, findAll, diffLines, commentsMessage, inlineCode };
})(typeof window !== 'undefined' ? window : globalThis);
