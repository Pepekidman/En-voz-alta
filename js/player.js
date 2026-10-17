// Reproductor: recorre el documento frase a frase, gestiona pausas por
// puntuación, velocidad, temporizador de sueño y progreso.
import { splitSentences, splitLong, toSpeech, compileDictionary } from './text.js';

const MAX_CHUNK = 220;
const DEFAULT_CPS = 14; // caracteres por segundo a velocidad 1

export class Player extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.doc = null;
    this.sentences = [];
    this.paraFirst = [];
    this.idx = 0;
    this.playing = false;
    this.settings = {};
    this.dict = [];
    this.voice = null;
    this.chunkCache = new Map();
    this.sleep = null; // { type: 'minutes', until } | { type: 'chapter', chapterEnd }
    this.stopAfterSentence = false;
    this.cps = DEFAULT_CPS;
    this.errors = 0;
    this.timer = null;
    this.estimateTimer = null;
    this.unitStart = 0;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Carga un documento: content = { paragraphs, chapters } */
  load(meta, content) {
    this.stop();
    this.doc = { meta, content };
    this.sentences = [];
    this.paraFirst = new Array(content.paragraphs.length);
    content.paragraphs.forEach((para, p) => {
      this.paraFirst[p] = this.sentences.length;
      const parts = para.t === 'h' ? [{ s: 0, e: para.x.length }] : splitSentences(para.x);
      for (const part of parts) this.sentences.push({ p, s: part.s, e: part.e });
    });
    // Acumulado de caracteres para estimar tiempos
    this.cum = new Float64Array(this.sentences.length + 1);
    for (let i = 0; i < this.sentences.length; i++) {
      const s = this.sentences[i];
      this.cum[i + 1] = this.cum[i] + (s.e - s.s);
    }
    this.chunkCache.clear();
    this.idx = this.findSentence(meta.progress?.p ?? 0, meta.progress?.c ?? 0);
  }

  configure(settings) {
    const prev = this.settings;
    this.settings = { ...settings };
    if (prev.dictionary !== settings.dictionary || prev.expandAbbr !== settings.expandAbbr ||
        prev.skipRefs !== settings.skipRefs || prev.skipUrls !== settings.skipUrls) {
      this.dict = compileDictionary(settings.dictionary || []);
      this.chunkCache.clear();
    }
  }

  setVoice(voice) {
    this.voice = voice;
    if (this.playing) this.restart();
  }

  /** Cambia el motor de voz (sistema o neural) conservando la posición. */
  setEngine(engine) {
    if (engine === this.engine) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.stop();
    this.engine = engine;
    this.engine.setRate && this.engine.setRate(this.settings.rate || 1);
    if (wasPlaying) this.play();
  }

  setRate(rate) {
    this.settings.rate = rate;
    if (this.engine.liveRate) this.engine.setRate(rate);
    else if (this.playing) this.restart();
    this.emit('progress', this.progressInfo());
  }

  setPitch(pitch) {
    this.settings.pitch = pitch;
    if (this.playing && !this.engine.isNeural) this.restart();
  }

  get lang() {
    return this.doc?.meta?.lang || 'es';
  }

  findSentence(p, c = 0) {
    if (!this.sentences.length) return 0;
    p = Math.max(0, Math.min(p, this.paraFirst.length - 1));
    let i = this.paraFirst[p] ?? 0;
    while (i + 1 < this.sentences.length && this.sentences[i + 1].p === p && this.sentences[i + 1].s <= c) i++;
    return i;
  }

  sentenceText(i) {
    const s = this.sentences[i];
    if (!s) return '';
    return this.doc.content.paragraphs[s.p].x.slice(s.s, s.e);
  }

  /** Divide la frase i en fragmentos hablables con su correspondencia al texto mostrado. */
  chunks(i) {
    if (this.chunkCache.has(i)) return this.chunkCache.get(i);
    const s = this.sentences[i];
    const para = this.doc.content.paragraphs[s.p];
    const display = para.x.slice(s.s, s.e);
    const spoken = toSpeech(display, {
      lang: this.lang,
      dict: this.dict,
      expandAbbr: this.settings.expandAbbr !== false,
      skipRefs: this.settings.skipRefs !== false,
      skipUrls: this.settings.skipUrls !== false,
      heading: para.t === 'h'
    });
    const parts = spoken ? splitLong(spoken, MAX_CHUNK) : [];
    const ratio = spoken.length ? display.length / spoken.length : 1;
    const out = parts.map((pt) => ({
      text: spoken.slice(pt.s, pt.e),
      spokenStart: pt.s,
      dStart: Math.round(pt.s * ratio),
      dEnd: Math.round(pt.e * ratio)
    }));
    const res = { display, spoken, chunks: out };
    if (this.chunkCache.size > 400) this.chunkCache.clear();
    this.chunkCache.set(i, res);
    return res;
  }

  pauseAfter(i) {
    const st = this.settings;
    const cur = this.sentences[i];
    const next = this.sentences[i + 1];
    if (!next) return 0;
    const paras = this.doc.content.paragraphs;
    if (next.p !== cur.p) {
      if (paras[cur.p].t === 'h' || paras[next.p].t === 'h') return st.headingPause ?? 800;
      return st.paraPause ?? 450;
    }
    return st.sentencePause ?? 0;
  }

  // ------------------------------------------------------------ control

  play(fromIdx) {
    if (!this.doc || !this.sentences.length) return;
    if (typeof fromIdx === 'number') this.idx = Math.max(0, Math.min(fromIdx, this.sentences.length - 1));
    else if (this.finished) this.idx = 0; // al terminar, ▶ vuelve a empezar
    if (this.idx >= this.sentences.length) this.idx = 0;
    this.finished = false;
    this.playing = true;
    this.errors = 0;
    this.stopAfterSentence = false;
    if (this.engine.unlock) this.engine.unlock(); // dentro del toque del usuario (iOS)
    if (this.engine.setRate) this.engine.setRate(this.settings.rate || 1);
    this.emit('state', { playing: true });
    this.startUnit(this.idx, 0, this.engine.cancel());
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    clearTimeout(this.timer);
    this.stopEstimate();
    this.engine.cancel();
    this.emit('state', { playing: false });
    this.emit('save', this.position());
  }

  stop() {
    this.playing = false;
    clearTimeout(this.timer);
    this.stopEstimate();
    this.engine.cancel();
  }

  toggle() {
    if (this.playing) this.pause(); else this.play();
  }

  restart() {
    if (!this.playing) return;
    clearTimeout(this.timer);
    this.startUnit(this.idx, 0, this.engine.cancel());
  }

  seek(i) {
    this.finished = false;
    i = Math.max(0, Math.min(i, this.sentences.length - 1));
    this.idx = i;
    this.emit('sentence', { idx: i, seek: true });
    this.emit('progress', this.progressInfo());
    if (this.playing) this.restart();
    else this.emit('save', this.position());
  }

  nextSentence() { this.seek(this.idx + 1); }
  prevSentence() { this.seek(this.idx - 1); }

  nextParagraph() {
    const p = this.sentences[this.idx]?.p ?? 0;
    if (p + 1 < this.paraFirst.length) this.seek(this.paraFirst[p + 1]);
  }

  prevParagraph() {
    const s = this.sentences[this.idx];
    if (!s) return;
    const first = this.paraFirst[s.p];
    // Si ya estamos al inicio del párrafo, ir al anterior
    if (this.idx > first) this.seek(first);
    else if (s.p > 0) this.seek(this.paraFirst[s.p - 1]);
  }

  /** Retrocede/avanza aproximadamente `sec` segundos, ajustando al inicio de frase. */
  skipSeconds(sec) {
    const chars = sec * this.cps * (this.settings.rate || 1);
    const target = this.cum[this.idx] + chars;
    let i = this.idx;
    if (sec < 0) while (i > 0 && this.cum[i] > target) i--;
    else while (i < this.sentences.length - 1 && this.cum[i + 1] <= target) i++;
    if (i === this.idx) i += sec < 0 ? -1 : 1;
    this.seek(i);
  }

  // ------------------------------------------------------------ motor

  startUnit(i, chunkIdx, gen) {
    if (gen !== this.engine.gen || !this.playing) return;
    if (i >= this.sentences.length) return this.finish();
    const info = this.chunks(i);
    if (!info.chunks.length) {
      // Frase sin contenido hablable (p. ej. sólo símbolos): saltar
      this.idx = i;
      return this.startUnit(i + 1, 0, gen);
    }
    const ch = info.chunks[chunkIdx];
    const isLast = chunkIdx === info.chunks.length - 1;
    let queuedNext = false;
    const st = this.settings;
    const engine = this.engine;
    // Los motores neuronales insertan la pausa como silencio dentro del audio
    const pauseAfter = engine.handlesPauses ? this.unitPause(i, isLast) : 0;
    engine.speak(ch.text, {
      pauseAfter,
      voice: this.voice,
      lang: this.voice ? undefined : this.lang,
      rate: st.rate || 1,
      pitch: st.pitch || 1,
      volume: st.volume ?? 1,
      onstart: () => {
        this.errors = 0;
        this.unitStart = performance.now();
        if (this.idx !== i || chunkIdx === 0) {
          this.idx = i;
          this.emit('sentence', { idx: i });
          this.emit('progress', this.progressInfo());
        }
        this.emit('chunk', { idx: i, dStart: ch.dStart, dEnd: ch.dEnd });
        if (st.wordHighlight === 'estimate') this.startEstimate(i, info, ch);
        // Encolar el siguiente fragmento por adelantado si no hay pausa entre medio
        const next = this.nextUnit(i, chunkIdx);
        if (next && (engine.handlesPauses || this.unitPause(i, isLast) === 0) && !this.mustStopAt(i, isLast)) {
          queuedNext = true;
          this.startUnit(next.i, next.c, gen);
        }
        if (engine.prefetch) {
          // Preparar ~N segundos de escucha por adelantado (si el motor lo pide)
          const chars = engine.prefetchSeconds ? engine.prefetchSeconds * this.cps * (st.rate || 1) : Infinity;
          engine.prefetch(this.upcomingTexts(i, chunkIdx, engine.prefetchMax || 4, chars));
        }
      },
      onboundary: (charIndex) => {
        if (st.wordHighlight === 'off') return;
        this.stopEstimate();
        this.emitWord(i, info, ch, charIndex);
      },
      onend: () => {
        this.stopEstimate();
        const elapsed = (performance.now() - this.unitStart) / 1000 - pauseAfter / 1000 / (st.rate || 1);
        if (elapsed > 0.8 && ch.text.length > 25) {
          const cps1 = ch.text.length / elapsed / (st.rate || 1);
          if (cps1 > 4 && cps1 < 40) this.cps = this.cps * 0.8 + cps1 * 0.2;
        }
        if (isLast) this.emit('sentenceEnd', { idx: i });
        if (this.mustStopAt(i, isLast)) {
          this.idx = Math.min(i + 1, this.sentences.length - 1);
          this.sleep = null;
          this.emit('sleep', null);
          this.pause();
          return;
        }
        if (queuedNext) return;
        const next = this.nextUnit(i, chunkIdx);
        if (!next) return this.finish();
        const wait = engine.handlesPauses ? 0 : this.unitPause(i, isLast);
        clearTimeout(this.timer);
        if (wait > 0) this.timer = setTimeout(() => this.startUnit(next.i, next.c, gen), wait);
        else this.startUnit(next.i, next.c, gen);
      },
      onerror: (e) => {
        this.errors++;
        this.emit('error', { idx: i, error: e.error || 'error', message: e.message || '' });
        if (this.errors >= 3 || e.error === 'not-allowed' || e.error === 'not-supported' ||
            e.error === 'language-unavailable' || e.error === 'voice-unavailable') {
          this.pause();
          return;
        }
        if (queuedNext) return;
        const next = this.nextUnit(i, chunkIdx);
        if (next) this.timer = setTimeout(() => this.startUnit(next.i, next.c, gen), 300);
      }
    }, gen);
  }

  /** Textos de los próximos fragmentos (para sintetizar por adelantado). */
  upcomingTexts(i, c, n, maxChars = Infinity) {
    const out = [];
    let u = { i, c };
    let chars = 0;
    for (let k = 0; k < n && chars < maxChars; k++) {
      u = this.nextUnit(u.i, u.c);
      if (!u) break;
      const ch = this.chunks(u.i).chunks[u.c];
      if (ch) { out.push(ch.text); chars += ch.text.length; }
    }
    return out;
  }

  nextUnit(i, c) {
    const info = this.chunks(i);
    if (c + 1 < info.chunks.length) return { i, c: c + 1 };
    if (i + 1 < this.sentences.length) return { i: i + 1, c: 0 };
    return null;
  }

  unitPause(i, isLast) {
    return isLast ? this.pauseAfter(i) : 0;
  }

  mustStopAt(i, isLast) {
    if (!isLast) return false;
    if (this.stopAfterSentence) return true;
    const sl = this.sleep;
    if (!sl) return false;
    if (sl.type === 'minutes') return Date.now() >= sl.until;
    if (sl.type === 'chapter') {
      const next = this.sentences[i + 1];
      return !next || next.p >= this.chapterEndParagraph(this.sentences[i].p);
    }
    return false;
  }

  finish() {
    this.playing = false;
    this.finished = true;
    this.engine.cancel();
    this.idx = this.sentences.length - 1;
    this.emit('state', { playing: false });
    this.emit('finished', {});
    this.emit('save', this.position(true));
  }

  emitWord(i, info, ch, charIndex) {
    const spokenPos = ch.spokenStart + charIndex;
    const spokenWordsBefore = (info.spoken.slice(0, spokenPos).match(/\S+/g) || []).length;
    const totalSpoken = (info.spoken.match(/\S+/g) || []).length || 1;
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(info.display))) words.push([m.index, m.index + m[0].length]);
    if (!words.length) return;
    const k = Math.min(words.length - 1, Math.round(spokenWordsBefore * (words.length / totalSpoken)));
    this.emit('word', { idx: i, s: words[k][0], e: words[k][1] });
  }

  startEstimate(i, info, ch) {
    this.stopEstimate();
    const t0 = performance.now();
    this.estimateTimer = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      const pos = Math.min(ch.text.length - 1, Math.floor(el * this.cps * (this.settings.rate || 1)));
      this.emitWord(i, info, ch, Math.max(0, pos));
    }, 120);
  }

  stopEstimate() {
    if (this.estimateTimer) clearInterval(this.estimateTimer);
    this.estimateTimer = null;
  }

  // ------------------------------------------------------------ temporizador

  setSleep(option) {
    if (!option) this.sleep = null;
    else if (option === 'chapter') {
      const chEnd = this.chapterEndParagraph(this.sentences[this.idx]?.p ?? 0);
      this.sleep = { type: 'chapter', chapterEnd: chEnd };
    } else this.sleep = { type: 'minutes', until: Date.now() + option * 60000, minutes: option };
    this.emit('sleep', this.sleep);
  }

  chapterEndParagraph(p) {
    const chs = this.doc?.content?.chapters || [];
    for (const c of chs) if (c.p > p) return c.p;
    return this.paraFirst.length;
  }

  // ------------------------------------------------------------ progreso

  position(done = false) {
    const s = this.sentences[this.idx];
    const total = this.cum[this.sentences.length] || 1;
    const pct = done ? 1 : (this.cum[this.idx] || 0) / total;
    return { p: s ? s.p : 0, c: s ? s.s : 0, pct, updatedAt: Date.now() };
  }

  /** Segundos estimados para recorrer los caracteres entre dos frases. */
  secondsBetween(a, b) {
    const chars = (this.cum[b] || 0) - (this.cum[a] || 0);
    return chars / (this.cps * (this.settings.rate || 1));
  }

  progressInfo() {
    const n = this.sentences.length;
    const total = this.cum[n] || 1;
    const p = this.sentences[this.idx]?.p ?? 0;
    const chEnd = this.chapterEndParagraph(p);
    const chEndSentence = chEnd < this.paraFirst.length ? this.paraFirst[chEnd] : n;
    return {
      idx: this.idx,
      count: n,
      pct: (this.cum[this.idx] || 0) / total,
      remaining: this.secondsBetween(this.idx, n),
      chapterRemaining: this.secondsBetween(this.idx, chEndSentence),
      wpm: Math.round((this.cps * (this.settings.rate || 1) * 60) / 6)
    };
  }
}
