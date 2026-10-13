// Controles del sistema (pantalla de bloqueo, auriculares) y pantalla encendida.
// speechSynthesis no crea una sesión multimedia por sí solo: se reproduce un
// audio silencioso en bucle para que el sistema muestre los controles.

function silentWavUrl(seconds = 10, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class MediaControls {
  constructor(handlers) {
    this.handlers = handlers;
    this.enabled = true;
    this.audio = null;
    this.ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
    this.wakeLock = null;
    this.wantWake = false;
    this.selfPaused = false;
    if (this.ms) {
      const set = (action, fn) => {
        try { this.ms.setActionHandler(action, fn); } catch {}
      };
      set('play', () => handlers.play());
      set('pause', () => handlers.pause());
      set('stop', () => handlers.pause());
      set('previoustrack', () => handlers.prev());
      set('nexttrack', () => handlers.next());
      set('seekbackward', () => handlers.back());
      set('seekforward', () => handlers.forward());
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantWake) this.requestWake();
    });
  }

  ensureAudio() {
    if (this.audio) return this.audio;
    const a = document.createElement('audio');
    a.src = silentWavUrl();
    a.loop = true;
    a.preload = 'auto';
    a.setAttribute('playsinline', '');
    // Si el sistema detiene el audio (p. ej. foco de audio), lo reanudamos
    // mientras se siga leyendo; la pausa real llega por el manejador 'pause'.
    a.addEventListener('pause', () => {
      if (!this.selfPaused && this.active) setTimeout(() => this.active && a.play().catch(() => {}), 400);
    });
    this.audio = a;
    return a;
  }

  setMetadata({ title, artist, album, artwork }) {
    if (!this.ms || !window.MediaMetadata) return;
    try {
      this.ms.metadata = new MediaMetadata({ title, artist, album, artwork });
    } catch {}
  }

  playing() {
    this.active = true;
    if (this.enabled) {
      const a = this.ensureAudio();
      this.selfPaused = false;
      a.play().catch(() => {});
    } else if (this.audio && !this.audio.paused) {
      this.selfPaused = true;
      this.audio.pause();
    }
    if (this.ms) this.ms.playbackState = 'playing';
    if (this.wantWake) this.requestWake();
  }

  paused() {
    this.active = false;
    if (this.audio) {
      this.selfPaused = true;
      this.audio.pause();
    }
    if (this.ms) this.ms.playbackState = 'paused';
    this.releaseWake();
  }

  setKeepScreenOn(on) {
    this.wantWake = on;
    if (!on) this.releaseWake();
    else if (this.active) this.requestWake();
  }

  async requestWake() {
    if (!('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch {}
  }

  releaseWake() {
    if (this.wakeLock) this.wakeLock.release().catch(() => {});
    this.wakeLock = null;
  }
}
