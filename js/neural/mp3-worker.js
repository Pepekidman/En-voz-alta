// Codificador MP3 (lamejs) en un worker para no bloquear la interfaz.
/* global lamejs */
importScripts(new URL('../../vendor/lame/lame.min.js', self.location.href).href);

let encoder = null;
const BLOCK = 1152 * 10;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    encoder = new lamejs.Mp3Encoder(1, m.sampleRate, m.kbps || 48);
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'pcm') {
    const pcm = m.pcm; // Int16Array
    const parts = [];
    for (let i = 0; i < pcm.length; i += BLOCK) {
      const out = encoder.encodeBuffer(pcm.subarray(i, i + BLOCK));
      if (out.length) parts.push(out);
    }
    self.postMessage({ type: 'mp3', id: m.id, parts }, parts.map((p) => p.buffer));
  } else if (m.type === 'flush') {
    const out = encoder.flush();
    self.postMessage({ type: 'mp3', id: m.id, parts: out.length ? [out] : [], done: true });
    encoder = null;
  }
};
