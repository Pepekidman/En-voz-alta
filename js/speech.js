// Envoltorio de la Web Speech API (voces del sistema, funcionan sin conexión
// cuando el dispositivo tiene instalados los datos de voz).

const ua = navigator.userAgent;
export const IS_ANDROID = /Android/i.test(ua);
export const IS_IOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class SpeechEngine {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.supported = !!this.synth && typeof window.SpeechSynthesisUtterance !== 'undefined';
    this.voices = [];
    this.gen = 0;
    this.live = new Set(); // referencias para evitar que el GC elimine utterances activas
    this.lastCancel = 0;
    this.boundarySeen = false;
    this.keepAlive = null;
    if (this.supported) {
      this.voices = this.synth.getVoices() || [];
      this.synth.addEventListener?.('voiceschanged', () => {
        this.voices = this.synth.getVoices() || [];
        this.onvoiceschanged && this.onvoiceschanged(this.voices);
      });
    }
  }

  /** Espera a que el navegador publique la lista de voces. */
  loadVoices(timeout = 2500) {
    if (!this.supported) return Promise.resolve([]);
    const v = this.synth.getVoices();
    if (v && v.length) { this.voices = v; return Promise.resolve(v); }
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const list = this.synth.getVoices();
        if ((list && list.length) || Date.now() - start > timeout) {
          this.voices = list || [];
          resolve(this.voices);
        } else setTimeout(tick, 150);
      };
      tick();
    });
  }

  voicesFor(lang) {
    if (!lang) return this.voices.slice();
    const l = lang.toLowerCase().slice(0, 2);
    return this.voices.filter((v) => (v.lang || '').toLowerCase().replace('_', '-').startsWith(l));
  }

  /** Elige la mejor voz para un idioma: la guardada, una local o la predeterminada. */
  pickVoice(lang, preferredURI) {
    if (preferredURI) {
      const v = this.voices.find((x) => x.voiceURI === preferredURI);
      if (v) return v;
    }
    const list = this.voicesFor(lang);
    if (!list.length) return null;
    const navLang = (navigator.language || '').toLowerCase();
    const score = (v) =>
      (v.localService ? 4 : 0) +
      ((v.lang || '').toLowerCase().replace('_', '-') === navLang ? 2 : 0) +
      (v.default ? 1 : 0) +
      (/natural|neural|premium|enhanced|mejorad/i.test(v.name) ? 1 : 0);
    return list.slice().sort((a, b) => score(b) - score(a))[0];
  }

  /** Cancela todo lo pendiente. Devuelve la nueva generación. */
  cancel() {
    this.gen++;
    this.stopKeepAlive();
    if (this.supported && (this.synth.speaking || this.synth.pending)) {
      this.synth.cancel();
      this.lastCancel = Date.now();
    }
    this.live.clear();
    return this.gen;
  }

  /**
   * Encola un texto. Los callbacks sólo se ejecutan si la generación sigue vigente.
   * opts: { voice, lang, rate, pitch, volume, onstart, onend, onboundary, onerror }
   */
  speak(text, opts, gen = this.gen) {
    if (!this.supported) { opts.onerror && opts.onerror({ error: 'not-supported' }); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (opts.voice) { u.voice = opts.voice; u.lang = opts.voice.lang; } else if (opts.lang) u.lang = opts.lang;
    u.rate = opts.rate ?? 1;
    u.pitch = opts.pitch ?? 1;
    u.volume = opts.volume ?? 1;
    const alive = () => gen === this.gen;
    u.onstart = () => { if (alive() && opts.onstart) opts.onstart(); };
    u.onboundary = (e) => {
      if (!alive()) return;
      if (e.name === 'word' || e.name === undefined) {
        this.boundarySeen = true;
        opts.onboundary && opts.onboundary(e.charIndex, e.charLength);
      }
    };
    u.onend = () => { this.live.delete(u); if (alive() && opts.onend) opts.onend(); };
    u.onerror = (e) => {
      this.live.delete(u);
      if (!alive()) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      opts.onerror && opts.onerror(e);
    };
    this.live.add(u);
    // Algunos motores descartan lo que se encola justo después de cancel()
    const wait = 150 - (Date.now() - this.lastCancel);
    const go = () => {
      if (!alive()) return;
      this.synth.speak(u);
      this.startKeepAlive(opts.voice);
    };
    if (wait > 0) setTimeout(go, wait); else go();
  }

  // En Chrome de escritorio las voces en red se cortan a los ~15 s; un
  // pause()/resume() periódico lo evita. En Android pause() equivale a cancel().
  startKeepAlive(voice) {
    if (IS_ANDROID || IS_IOS || !voice || voice.localService) return;
    if (this.keepAlive) return;
    this.keepAlive = setInterval(() => {
      if (!this.synth.speaking) return this.stopKeepAlive();
      this.synth.pause();
      this.synth.resume();
    }, 10000);
  }

  stopKeepAlive() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }
}
