// Motiv okna (tmavý / světlý / podle systému) – načítá se v <head> před vykreslením, aby okno neproblikla.
// Volba je jen v tomto prohlížeči (localStorage acd.theme). CSS: :root[data-theme="light"] v theme.css.
(() => {
  const KEY = 'acd.theme';
  const CHOICES = ['dark', 'light', 'system'];
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  let mem = 'dark'; // když localStorage nejde, platí volba jen pro toto okno
  const read = () => {
    try { const v = localStorage.getItem(KEY); return CHOICES.includes(v) ? v : mem; } catch { return mem; }
  };
  const apply = () => {
    const c = read();
    document.documentElement.dataset.theme = c === 'system' ? (mq.matches ? 'light' : 'dark') : c;
  };
  mq.addEventListener('change', apply);
  apply();
  window.acdTheme = {
    CHOICES,
    get: read,
    set(c) {
      if (!CHOICES.includes(c)) return;
      mem = c;
      try { localStorage.setItem(KEY, c); } catch { /* bez úložiště */ }
      apply();
    },
  };
})();
