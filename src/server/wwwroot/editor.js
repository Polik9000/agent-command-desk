'use strict';
/* Pokračování seznamů v poli pro psaní – čistá logika bez DOM (testy: tests/editor.test.mjs).
   Enter za „1. text“ → nový řádek „2. “, za „- text“ → „- “; Enter na prázdné položce seznam ukončí.
   Shift+Enter = obyčejný nový řádek (řeší volající), Ctrl+Enter = odeslat. */
(function (root) {
  const NUMBERED = /^(\s*)(\d{1,3})([.)])(\s+)(.*)$/; // 1–3 číslice: „2026. rok“ není seznam
  const BULLET = /^(\s*)(- \[[ xX]\]|[-*•])(\s+)(.*)$/;  // zaškrtávací položka dřív než obyčejná pomlčka

  /**
   * @param {string} text celý text pole
   * @param {number} caret pozice kurzoru (bez výběru)
   * @returns {null | {from:number, to:number, insert:string, caret:number}} null = obyčejný Enter
   */
  function continueList(text, caret) {
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = text.indexOf('\n', caret);
    if (lineEnd < 0) lineEnd = text.length;
    const before = text.slice(lineStart, caret);
    const line = text.slice(lineStart, lineEnd);

    let m = NUMBERED.exec(line);
    if (m) {
      const [, indent, num, sep, space, content] = m;
      const markerLen = indent.length + num.length + sep.length + space.length;
      if (before.length < markerLen) return null; // kurzor uvnitř značky → obyčejný Enter
      if (!content.trim()) return { from: lineStart, to: lineEnd, insert: '', caret: lineStart }; // prázdná položka → konec seznamu
      const next = `${indent}${Number(num) + 1}${sep}${space}`;
      return { from: caret, to: caret, insert: `\n${next}`, caret: caret + 1 + next.length };
    }
    m = BULLET.exec(line);
    if (m) {
      const [, indent, bullet, space, content] = m;
      const markerLen = indent.length + bullet.length + space.length;
      if (before.length < markerLen) return null;
      if (!content.trim()) return { from: lineStart, to: lineEnd, insert: '', caret: lineStart };
      const next = `${indent}${bullet.startsWith('- [') ? '- [ ]' : bullet}${space}`;
      return { from: caret, to: caret, insert: `\n${next}`, caret: caret + 1 + next.length };
    }
    return null;
  }

  root.ListEditor = { continueList };
})(typeof window !== 'undefined' ? window : globalThis);
