'use strict';
/* Jazyk rozhraní: čeština (výchozí) nebo angličtina. Volba je jen v tomto prohlížeči (localStorage acd.lang), mění se
   v Nastavení → Vzhled a platí po načtení okna.
   _t('česká věta {0}', arg) – text v kódu; _tr('text ze serveru') – hlášky serveru (přesná shoda nebo vzor s {0}).
   Klíče a překlady: i18n.en.js (kontroluje tests/i18n.test.mjs). Čeština = klíč sám. */
(function (root) {
  const KEY = 'acd.lang';
  const LANGS = ['cs', 'en'];
  let mem = 'cs';
  const read = () => { try { const v = localStorage.getItem(KEY); return LANGS.includes(v) ? v : mem; } catch { return mem; } };
  const lang = read();
  const EN = lang === 'en' ? (root.ACD_EN || {}) : {};
  const fmt = (s, args) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s);

  /** Text v kódu: v češtině klíč, v angličtině překlad (chybí-li, česky). */
  function _t(key, ...args) { return fmt(lang === 'en' && key in EN ? EN[key] : key, args); }

  // Hlášky serveru: přesná shoda, jinak vzory z klíčů s {n}; zachycené části se překládají znovu.
  let patterns = null;
  const cache = new Map();
  const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  function buildPatterns() {
    patterns = [];
    for (const key of Object.keys(EN)) {
      if (!/\{\d+\}/.test(key)) continue;
      const order = [];
      const src = esc(key).replace(/\{(\d+)\}/g, (m, i) => { order.push(+i); return '([\\s\\S]*?)'; });
      patterns.push({ rx: new RegExp(`^${src}$`), order, to: EN[key] });
    }
    patterns.sort((a, b) => b.to.length - a.to.length);
  }
  function tr(msg) {
    if (lang !== 'en' || typeof msg !== 'string' || !msg) return msg;
    if (msg in EN) return EN[msg];
    if (cache.has(msg)) return cache.get(msg);
    if (!patterns) buildPatterns();
    let out = msg;
    for (const p of patterns) {
      const m = p.rx.exec(msg);
      if (!m) continue;
      const args = [];
      p.order.forEach((idx, g) => { args[idx] = tr(m[g + 1]); });
      out = fmt(p.to, args);
      break;
    }
    if (cache.size < 500) cache.set(msg, out);
    return out;
  }

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  /** Statické HTML: texty a atributy podle přesné shody (po normalizaci mezer). */
  function applyDom(node) {
    if (lang !== 'en') return;
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (p && /^(SCRIPT|STYLE)$/.test(p.tagName)) continue;
      const t = norm(n.data);
      if (t && t in EN) n.data = n.data.replace(/\S[\s\S]*\S|\S/, () => EN[t]); // okolní mezery zůstanou
    }
    for (const el of node.querySelectorAll('[title],[placeholder],[aria-label],[alt]')) {
      for (const a of ['title', 'placeholder', 'aria-label', 'alt']) {
        const v = el.getAttribute(a);
        if (v && norm(v) in EN) el.setAttribute(a, EN[norm(v)]);
      }
    }
  }

  function setLang(l) {
    if (!LANGS.includes(l)) return;
    mem = l;
    try { localStorage.setItem(KEY, l); } catch { /* bez úložiště – platí jen do načtení */ }
  }

  root.ACD_LANG = lang;
  root.LOC = lang === 'en' ? 'en-GB' : 'cs-CZ';
  root._t = _t;
  root._tr = tr;
  root.acdI18n = { lang, LANGS, setLang, applyDom, EN };
  document.documentElement.lang = lang;
  document.addEventListener('DOMContentLoaded', () => applyDom(document.body));
})(window);
