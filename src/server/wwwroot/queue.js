'use strict';
/* Fronta zpráv – čistá logika bez DOM (testy: tests/queue.test.mjs).
   Položka patří k jednomu účtu, projektu a sezení a nikdy se neodešle jinam.
   Po přerušení (Stop, chyba, limit, plán ke schválení) je fronta pozastavena a nic se samo neodešle. */
(function (root) {
  const MAX_ITEMS = 20;
  const MAX_PROMPT = 100000;
  /** Důvody pozastavení → text pro UI. */
  const PAUSE_TEXT = {
    stopped: 'Běh byl zastaven.',
    error: 'Běh skončil chybou.',
    limit: 'Účet narazil na limit.',
    plan: 'Plán čeká na schválení.',
    context: 'Fronta patří k jinému sezení, účtu nebo projektu.',
    manual: 'Pozastaveno.',
  };

  class MessageQueue {
    constructor() {
      /** @type {{id:number, prompt:string, mode:string, account:string, project:string, sessionId:string|null, run:any}[]} */
      this.items = [];
      /** @type {string|null} */
      this.paused = null;
      this.nextId = 1;
    }

    get length() { return this.items.length; }
    get pauseText() { return this.paused ? PAUSE_TEXT[this.paused] || PAUSE_TEXT.manual : ''; }

    /**
     * Přidá zprávu. `run` = právě běžící běh; dokud nezná své sezení (nové sezení), doplní ho bindSession.
     * @returns {{id:number}} @throws {Error}
     */
    add({ prompt, mode, account, project, sessionId, run }) {
      const text = String(prompt || '').trim();
      if (!text) throw new Error('Prázdná zpráva.');
      if (text.length > MAX_PROMPT) throw new Error('Zpráva je příliš dlouhá.');
      if (this.items.length >= MAX_ITEMS) throw new Error(`Fronta je plná (max. ${MAX_ITEMS}).`);
      if (mode !== 'auto' && mode !== 'plan') throw new Error('Neplatný režim.');
      const item = { id: this.nextId++, prompt: text, mode, account, project, sessionId: sessionId || null, run: run || null };
      this.items.push(item);
      return item;
    }

    /** Běh se dozvěděl id sezení (init) → doplnit položkám, které na něj čekají. */
    bindSession(run, sessionId) {
      if (!run || !sessionId) return;
      for (const it of this.items) if (!it.sessionId && it.run === run) it.sessionId = sessionId;
    }

    remove(id) { this.items = this.items.filter((i) => i.id !== id); if (!this.items.length) this.paused = null; }

    move(id, delta) {
      const i = this.items.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= this.items.length) return false;
      const [it] = this.items.splice(i, 1);
      this.items.splice(j, 0, it);
      return true;
    }

    update(id, prompt) {
      const it = this.items.find((x) => x.id === id);
      const text = String(prompt || '').trim();
      if (!it) return false;
      if (!text) throw new Error('Prázdná zpráva.');
      if (text.length > MAX_PROMPT) throw new Error('Zpráva je příliš dlouhá.');
      it.prompt = text;
      return true;
    }

    clear() { this.items = []; this.paused = null; }
    pause(reason) { if (this.items.length) this.paused = reason || 'manual'; }
    resume() { this.paused = null; }

    /**
     * Konec běhu. outcome: 'ok' | 'stopped' | 'error' | 'limit' | 'plan'.
     * @returns {boolean} zda odeslat další položku
     */
    onRunEnd(outcome) {
      if (outcome !== 'ok') { this.pause(outcome); return false; }
      return !this.paused && this.items.length > 0;
    }

    /**
     * Vezme další položku, pokud patří k aktuálnímu účtu, projektu a sezení. Jinak frontu pozastaví.
     * @param {{account:string, project:string, sessionId:string|null}} ctx
     */
    takeNext(ctx) {
      if (this.paused || !this.items.length) return null;
      const it = this.items[0];
      if (it.account !== ctx.account || it.project !== ctx.project || (it.sessionId || null) !== (ctx.sessionId || null)) {
        this.paused = 'context';
        return null;
      }
      this.items.shift();
      return it;
    }
  }

  MessageQueue.MAX_ITEMS = MAX_ITEMS;
  root.MessageQueue = MessageQueue;
})(typeof window !== 'undefined' ? window : globalThis);
