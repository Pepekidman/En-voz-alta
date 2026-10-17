// Motor de voz neural: sintetiza con Piper en un worker y reproduce el audio
// con un elemento <audio> (funciona con la pantalla apagada y con los controles
// del sistema). Expone la misma interfaz que SpeechEngine para el reproductor.
import { VOICE_CACHE } from './voices.js';

const CACHE_LIMIT = 40;
// Piper habla más rápido de forma natural (length_scale) y gasta menos CPU que
// acelerar el audio después; más allá de 2× pierde claridad y el resto lo
// acelera el reproductor.
const MAX_SYNTH_SPEED = 2;
const SYNTH_SPEEDS = [1, 1.25, 1.5, 1.75, 2];

const hidden = () => typeof document !== 'undefined' && document.hidden;

/** Convierte PCM float a WAV de 16 bits, añadiendo silencio al final. */
export function pcmToWav(pcm, sampleRate, padMs = 0) {
  const pad = Math.round((padMs / 1000) * sampleRate);
  const n = pcm.length + pad;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  const out = new Int16Array(buf, 44, n);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export class NeuralEngine {
  constructor() {
    this.supported = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && 'caches' in self;
    this.isNeural = true;
    this.handlesPauses = true; // las pausas se insertan como silencio en el audio
    this.liveRate = true; // la velocidad cambia sin volver a sintetizar
    this.boundarySeen = true;
    this.gen = 0;
    this.voice = null;
    this.speaker = 0;
    this.rate = 1;
    this.worker = null;
    this.reqId = 0;
    this.waiting = new Map(); // id → {resolve, reject}
    this.jobs = []; // textos pendientes de sintetizar
    this.busy = false;
    this.cache = new Map(); // texto → Promise<{pcm, sampleRate}>
    this.queue = [];
    this.current = null;
    this.loaded = null; // Promise de carga de la voz
    this.stats = { synthMs: 0, listenMs: 0 };
    // Diagnóstico por estado de pantalla: carga de síntesis y esperas entre frases
    const bucket = () => ({ jobs: 0, synthMs: 0, listenMs: 0, waits: 0, waitMs: 0, maxWaitMs: 0 });
    this.diag = { visible: bucket(), hidden: bucket() };
    this.prefetchSeconds = 75; // audio que se prepara por adelantado
    this.prefetchMax = 24;
    // Hilos del motor: con la pantalla apagada Android puede dejar menos núcleos
    // y demasiados hilos se estorban; se ajusta solo si la voz no da abasto.
    this.threads = 0; // 0 = automático
    this.loadedThreads = 0;
    this.threadTrial = null;
    this.hiddenLoad = null;
    this.hiddenJobs = 0;
    this.restartPending = false;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
    this.audio.addEventListener('ended', () => this.onEnded());
    // Pausa externa (llamada entrante, otra app, auriculares desconectados)
    // (los eventos llegan de forma asíncrona: se ignoran los causados por la app)
    this.lastSelfPause = 0;
    this.audio.addEventListener('pause', () => {
      const t = performance.now();
      setTimeout(() => {
        if (this.lastSelfPause > t - 50) return; // la app pausó o cambió de audio
        if (!this.audio.paused || this.audio.ended || !this.current || !this.current.started) return;
        this.onexternalpause && this.onexternalpause();
      }, 300);
    });
    this.audio.addEventListener('error', () => {
      const item = this.current;
      if (!item || !item.started) return;
      this.finishItem();
      item.opts.onerror && item.opts.onerror({ error: 'audio-error' });
    });
    this.url = null;
    this.boundaryTimer = null;
    this.onstatus = null;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./worker.js' + (this.threads ? '?hilos=' + this.threads : ''), import.meta.url));
    this.worker.onmessage = (e) => {
      const m = e.data;
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === 'error') w.reject(Object.assign(new Error(m.message), { fatal: !!m.fatal }));
      else w.resolve(m);
    };
    this.worker.onerror = (e) => {
      e.preventDefault && e.preventDefault();
      this.resetWorker(Object.assign(new Error(e.message || 'El motor de voz se detuvo (¿poca memoria?)'), { fatal: true }));
    };
    return this.worker;
  }

  /** Reinicia el worker (p. ej. si se cerró por falta de memoria). La voz se recarga sola. */
  resetWorker(err) {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.loaded = null;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }

  call(msg, transfer, timeoutMs = 0) {
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.waiting.set(id, { resolve: done(resolve), reject: done(reject) });
      if (timeoutMs) {
        // Con la pantalla apagada el sistema puede congelar el motor: no cuenta como fallo
        const check = () => {
          if (!this.waiting.has(id)) return;
          if (typeof document !== 'undefined' && document.hidden) { timer = setTimeout(check, timeoutMs); return; }
          this.resetWorker(Object.assign(new Error('El motor de voz no respondió a tiempo'), { fatal: true }));
        };
        timer = setTimeout(check, timeoutMs);
      }
      this.ensureWorker().postMessage({ ...msg, id }, transfer || []);
    });
  }

  ensureLoaded() {
    if (!this.loaded && this.voice) {
      const v = this.voice;
      const p = this.call({ type: 'load', voice: { key: v.key, modelUrl: v.modelUrl, configUrl: v.configUrl, cacheName: VOICE_CACHE } }, null, 120000);
      this.loaded = p;
      p.then((m) => { this.loadedThreads = m.threads || 1; }, () => { if (this.loaded === p) this.loaded = null; });
    }
    return this.loaded;
  }

  /** Carga una voz del catálogo (ya descargada). */
  setVoice(voice, speaker = 0) {
    if (this.voice && voice && this.voice.key === voice.key && this.loaded) {
      if (speaker !== this.speaker) { this.speaker = speaker; this.cache.clear(); }
      return this.loaded;
    }
    this.cancel();
    this.voice = voice;
    this.speaker = speaker;
    this.cache.clear();
    for (const j of this.jobs) j.reject(new Error('Cambio de voz'));
    this.jobs = [];
    this.loaded = null;
    return this.ensureLoaded();
  }

  setRate(rate) {
    const before = this.synthSpeed();
    this.rate = rate;
    this.audio.playbackRate = rate / ((this.current && this.current.speed) || 1);
    if (this.synthSpeed() !== before) this.dropOtherSpeeds();
  }

  /** Tras cambiar de velocidad, lo preparado de antemano se rehace a la nueva (salvo lo inmediato). */
  dropOtherSpeeds() {
    const want = this.synthSpeed();
    const keep = new Set(this.queue.map((q) => q.text));
    if (this.current) keep.add(this.current.text);
    const drop = new Set();
    for (const [key, p] of this.cache) {
      if (p.speed !== want && !keep.has(p.text)) { drop.add(key); this.cache.delete(key); }
    }
    this.jobs = this.jobs.filter((j) => {
      if (!drop.has(j.key)) return true;
      j.reject(Object.assign(new Error('Cancelado'), { cancelled: true }));
      return false;
    });
  }

  /** Velocidad a la que se sintetiza (el resto lo ajusta playbackRate). */
  synthSpeed() {
    const s = Math.min(MAX_SYNTH_SPEED, Math.max(1, Math.round(this.rate * 4) / 4));
    return SYNTH_SPEEDS.includes(s) ? s : 1;
  }

  /** iOS exige iniciar el audio dentro de un toque: se "desbloquea" el elemento. */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.audio.src = URL.createObjectURL(pcmToWav(new Float32Array(1), 8000));
      const p = this.audio.play();
      if (p) p.then(() => { if (!this.current) this.audio.pause(); }).catch(() => {});
    } catch {}
  }

  // ------------------------------------------------------------ síntesis

  /** Sintetiza un texto a una velocidad exacta (1 = normal). */
  synth(text, urgent, speed = 1, prefetch = false) {
    const key = speed === 1 ? text : speed + '|' + text;
    let p = this.cache.get(key);
    if (p) {
      if (!prefetch) this.promote(key, urgent);
      return p;
    }
    p = new Promise((resolve, reject) => {
      const job = { key, text, speed, prefetch, resolve, reject };
      if (urgent) this.jobs.unshift(job); else this.jobs.push(job);
    });
    p.speed = speed;
    p.text = text;
    p.then(() => { p.done = true; }, () => { if (this.cache.get(key) === p) this.cache.delete(key); });
    this.cache.set(key, p);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    this.pump();
    return p;
  }

  /** Audio para reproducir: el ya preparado (a cualquier velocidad) o uno nuevo a la velocidad actual. */
  lookup(text, urgent, prefetch = false) {
    const want = this.synthSpeed();
    const key = (s) => (s === 1 ? text : s + '|' + text);
    if (!this.cache.has(key(want))) {
      for (const s of SYNTH_SPEEDS) if (this.cache.has(key(s))) return this.synth(text, urgent, s, prefetch);
    }
    return this.synth(text, urgent, want, prefetch);
  }

  promote(key, urgent) {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i < 0) return;
    this.jobs[i].prefetch = false;
    if (urgent && i > 0) this.jobs.unshift(this.jobs.splice(i, 1)[0]);
  }

  /** Descarta lo que se iba a preparar por adelantado (tras saltar o pausar). */
  dropPrefetch() {
    const keep = [];
    for (const j of this.jobs) {
      if (!j.prefetch) { keep.push(j); continue; }
      this.cache.delete(j.key);
      j.reject(Object.assign(new Error('Cancelado'), { cancelled: true }));
    }
    this.jobs = keep;
  }

  async pump() {
    if (this.busy || !this.jobs.length) return;
    this.busy = true;
    if (this.restartPending) {
      // Cambio de hilos: se reinicia entre dos frases, la voz se recarga sola
      this.restartPending = false;
      this.resetWorker(Object.assign(new Error('Reinicio del motor'), { fatal: true }));
    }
    const job = this.jobs.shift();
    try {
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          if (!this.ensureLoaded()) throw new Error('No hay una voz neural cargada');
          await this.loaded;
          res = await this.call({ type: 'synth', text: job.text, opts: { speaker: this.speaker, speed: job.speed } }, null, 60000);
          break;
        } catch (e) {
          // El motor se rompió (memoria, cierre del sistema): se reinicia y se reintenta una vez
          if (!e.fatal || attempt > 0) throw e;
          this.resetWorker(e);
        }
      }
      this.noteJob(res.ms, ((res.pcm.length / res.sampleRate) * 1000 * job.speed) / (this.rate || 1));
      job.resolve({ pcm: res.pcm, sampleRate: res.sampleRate, speed: job.speed });
    } catch (e) {
      job.reject(e);
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  /** Sintetiza por adelantado las próximas frases. */
  prefetch(texts) {
    for (const t of texts) if (t) this.lookup(t, false, true);
  }

  /** Relación tiempo de síntesis / tiempo de escucha (< 1 = la voz se genera a tiempo). */
  get realTimeFactor() {
    return this.stats.listenMs ? this.stats.synthMs / this.stats.listenMs : null;
  }

  /** Carga con la pantalla apagada (null si aún no hay datos suficientes). */
  get hiddenRealTimeFactor() {
    const b = this.diag.hidden;
    return b.jobs >= 5 && b.listenMs ? b.synthMs / b.listenMs : null;
  }

  noteJob(synthMs, listenMs) {
    if (!(listenMs > 0)) return;
    this.stats.synthMs += synthMs;
    this.stats.listenMs += listenMs;
    const h = hidden();
    const b = h ? this.diag.hidden : this.diag.visible;
    b.jobs++;
    b.synthMs += synthMs;
    b.listenMs += listenMs;
    if (!h) return;
    const load = synthMs / listenMs;
    this.hiddenLoad = this.hiddenLoad == null ? load : this.hiddenLoad * 0.7 + load * 0.3;
    this.hiddenJobs++;
    this.adaptThreads();
  }

  noteWait(ms) {
    const b = hidden() ? this.diag.hidden : this.diag.visible;
    b.waits++;
    b.waitMs += ms;
    b.maxWaitMs = Math.max(b.maxWaitMs, ms);
  }

  // Si con la pantalla apagada la voz no llega a tiempo, se prueba con la mitad
  // de hilos; si no mejora, se vuelve a los de antes. Una sola prueba por sesión.
  adaptThreads() {
    const t = this.threadTrial;
    if (!t) {
      if (this.loadedThreads > 1 && this.hiddenJobs >= 5 && this.hiddenLoad > 0.85 && this.diag.hidden.waits >= 2) {
        this.threadTrial = { from: this.threads, fromThreads: this.loadedThreads, load: this.hiddenLoad, state: 'probando' };
        this.threads = Math.max(1, Math.ceil(this.loadedThreads / 2));
        this.hiddenLoad = null;
        this.hiddenJobs = 0;
        this.restartPending = true;
      }
      return;
    }
    if (t.state === 'probando' && this.hiddenJobs >= 6) {
      t.newLoad = this.hiddenLoad;
      if (this.hiddenLoad > t.load * 1.05) {
        t.state = 'revertido';
        this.threads = t.from;
        this.restartPending = true;
      } else {
        t.state = 'mejor';
      }
    }
  }

  /** Resumen para el informe de diagnóstico. */
  diagnostics() {
    const f = (b) => b.jobs
      ? `${b.jobs} frases, carga ${(b.synthMs / b.listenMs).toFixed(2)}, esperas ${b.waits} (máx ${(b.maxWaitMs / 1000).toFixed(1)} s)`
      : 'sin datos';
    const t = this.threadTrial;
    return {
      vozNeural: this.voice ? this.voice.key : '-',
      hilos: this.loadedThreads + (t ? ` (prueba ${t.fromThreads}→${this.threads || 'auto'}: ${t.state}, carga ${t.load.toFixed(2)}${t.newLoad != null ? '→' + t.newLoad.toFixed(2) : ''})` : ''),
      pantallaEncendida: f(this.diag.visible),
      pantallaApagada: f(this.diag.hidden)
    };
  }

  // ------------------------------------------------------------ interfaz del reproductor

  cancel() {
    this.gen++;
    this.queue = [];
    this.dropPrefetch();
    this.stopBoundary();
    if (this.current) {
      this.current = null;
      this.lastSelfPause = performance.now();
      this.audio.pause();
    }
    return this.gen;
  }

  speak(text, opts, gen = this.gen) {
    if (gen !== this.gen) return;
    const item = { text, opts, gen, pauseAfter: opts.pauseAfter || 0, continued: !!this.current };
    this.queue.push(item);
    this.lookup(text, !this.current && this.queue.length === 1);
    if (!this.current) this.playNext();
  }

  async playNext() {
    if (this.current || !this.queue.length) return;
    const item = this.queue.shift();
    if (item.gen !== this.gen) return this.playNext();
    this.current = item;
    let res;
    try {
      const p = this.lookup(item.text, true);
      const ready = !!p.done;
      const t0 = performance.now();
      if (!ready && this.onstatus) this.onstatus('synth');
      res = await p;
      // El audio no estaba listo al terminar la frase anterior: pausa de más
      if (!ready && item.continued) this.noteWait(performance.now() - t0);
    } catch (e) {
      if (this.current === item) this.current = null;
      if (item.gen === this.gen) item.opts.onerror && item.opts.onerror({ error: 'synthesis-failed', message: e.message });
      return;
    }
    if (this.current !== item || item.gen !== this.gen) return;
    this.onstatus && this.onstatus('play');
    if (this.url) URL.revokeObjectURL(this.url);
    item.speed = res.speed || 1;
    // El silencio se acorta igual que la voz sintetizada más rápido
    this.url = URL.createObjectURL(pcmToWav(res.pcm, res.sampleRate, item.pauseAfter / item.speed));
    const a = this.audio;
    this.lastSelfPause = performance.now(); // cambiar src puede emitir 'pause'
    a.src = this.url;
    a.playbackRate = this.rate / item.speed;
    if ('preservesPitch' in a) a.preservesPitch = true;
    item.started = true;
    try {
      await a.play();
    } catch (e) {
      if (this.current === item) this.current = null;
      if (item.gen === this.gen) item.opts.onerror && item.opts.onerror({ error: e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-error' });
      return;
    }
    if (this.current !== item) return;
    item.opts.onstart && item.opts.onstart();
    this.startBoundary(item, res);
  }

  finishItem() {
    this.stopBoundary();
    const item = this.current;
    this.current = null;
    return item;
  }

  onEnded() {
    // Ignorar el final del audio de desbloqueo o de un elemento aún sin empezar
    if (!this.current || !this.current.started) return;
    const item = this.finishItem();
    if (item.gen !== this.gen) return;
    item.opts.onend && item.opts.onend();
    this.playNext();
  }

  // Posición de la palabra estimada a partir del tiempo de audio
  startBoundary(item, res) {
    this.stopBoundary();
    const cb = item.opts.onboundary;
    if (!cb) return;
    const text = item.text;
    const starts = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) starts.push(m.index);
    if (!starts.length) return;
    const speechSec = res.pcm.length / res.sampleRate;
    let last = -1;
    const tick = () => {
      if (this.current !== item) return this.stopBoundary();
      const frac = Math.min(1, this.audio.currentTime / Math.max(0.05, speechSec * 0.97));
      const pos = frac * text.length;
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1] <= pos) k++;
      if (k !== last) { last = k; cb(starts[k], 0); }
    };
    tick();
    this.boundaryTimer = setInterval(tick, 90);
  }

  stopBoundary() {
    if (this.boundaryTimer) clearInterval(this.boundaryTimer);
    this.boundaryTimer = null;
  }

  pause() {
    this.lastSelfPause = performance.now();
    this.audio.pause();
  }
}
