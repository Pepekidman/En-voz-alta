// Motor de voz neural: sintetiza con Piper en un worker y reproduce el audio
// con un elemento <audio> (funciona con la pantalla apagada y con los controles
// del sistema). Expone la misma interfaz que SpeechEngine para el reproductor.
import { VOICE_CACHE } from './voices.js';

const CACHE_LIMIT = 40;

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
    this.stats = { synthMs: 0, audioMs: 0 };
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
    this.worker = new Worker(new URL('./worker.js', import.meta.url));
    this.worker.onmessage = (e) => {
      const m = e.data;
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === 'error') w.reject(new Error(m.message));
      else w.resolve(m);
    };
    this.worker.onerror = (e) => {
      e.preventDefault && e.preventDefault();
      this.resetWorker(new Error(e.message || 'El motor de voz se detuvo (¿poca memoria?)'));
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
          this.resetWorker(new Error('El motor de voz no respondió a tiempo'));
        };
        timer = setTimeout(check, timeoutMs);
      }
      this.ensureWorker().postMessage({ ...msg, id }, transfer || []);
    });
  }

  ensureLoaded() {
    if (!this.loaded && this.voice) {
      const v = this.voice;
      this.loaded = this.call({ type: 'load', voice: { key: v.key, modelUrl: v.modelUrl, configUrl: v.configUrl, cacheName: VOICE_CACHE } }, null, 120000);
      this.loaded.catch(() => { this.loaded = null; });
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
    this.rate = rate;
    this.audio.playbackRate = rate;
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

  synth(text, urgent) {
    let p = this.cache.get(text);
    if (p) {
      if (urgent) this.promote(text);
      return p;
    }
    p = new Promise((resolve, reject) => {
      const job = { text, resolve, reject };
      if (urgent) this.jobs.unshift(job); else this.jobs.push(job);
    });
    p.then(() => { p.done = true; }, () => this.cache.delete(text));
    this.cache.set(text, p);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    this.pump();
    return p;
  }

  promote(text) {
    const i = this.jobs.findIndex((j) => j.text === text);
    if (i > 0) this.jobs.unshift(this.jobs.splice(i, 1)[0]);
  }

  async pump() {
    if (this.busy || !this.jobs.length) return;
    this.busy = true;
    const job = this.jobs.shift();
    try {
      if (!this.ensureLoaded()) throw new Error('No hay una voz neural cargada');
      await this.loaded;
      const res = await this.call({ type: 'synth', text: job.text, opts: { speaker: this.speaker } }, null, 60000);
      this.stats.synthMs += res.ms;
      this.stats.audioMs += (res.pcm.length / res.sampleRate) * 1000;
      job.resolve({ pcm: res.pcm, sampleRate: res.sampleRate });
    } catch (e) {
      job.reject(e);
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  /** Sintetiza por adelantado las próximas frases. */
  prefetch(texts) {
    for (const t of texts) if (t && !this.cache.has(t)) this.synth(t, false);
  }

  /** Relación tiempo de síntesis / duración del audio (< 1 = más rápido que tiempo real). */
  get realTimeFactor() {
    return this.stats.audioMs ? this.stats.synthMs / this.stats.audioMs : null;
  }

  // ------------------------------------------------------------ interfaz del reproductor

  cancel() {
    this.gen++;
    this.queue = [];
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
    const item = { text, opts, gen, pauseAfter: opts.pauseAfter || 0 };
    this.queue.push(item);
    this.synth(text, !this.current && this.queue.length === 1);
    if (!this.current) this.playNext();
  }

  async playNext() {
    if (this.current || !this.queue.length) return;
    const item = this.queue.shift();
    if (item.gen !== this.gen) return this.playNext();
    this.current = item;
    let res;
    try {
      if (this.onstatus && !this.cache.get(item.text)?.done) this.onstatus('synth');
      res = await this.synth(item.text, true);
    } catch (e) {
      if (this.current === item) this.current = null;
      if (item.gen === this.gen) item.opts.onerror && item.opts.onerror({ error: 'synthesis-failed', message: e.message });
      return;
    }
    if (this.current !== item || item.gen !== this.gen) return;
    this.onstatus && this.onstatus('play');
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(pcmToWav(res.pcm, res.sampleRate, item.pauseAfter));
    const a = this.audio;
    this.lastSelfPause = performance.now(); // cambiar src puede emitir 'pause'
    a.src = this.url;
    a.playbackRate = this.rate;
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
