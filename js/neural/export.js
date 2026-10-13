// Exporta un rango de frases a un archivo MP3 usando la voz neural.

function floatToInt16(pcm, padSamples = 0) {
  const out = new Int16Array(pcm.length + padSamples);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

/**
 * opts: { engine (NeuralEngine con voz cargada), player, from, to (frases),
 *         onProgress(fraction, etaSec), signal: { cancelled } }
 * Devuelve un Blob audio/mpeg.
 */
export async function exportMp3({ engine, player, from, to, onProgress, signal, kbps = 48 }) {
  const abortError = () => new DOMException('Cancelado', 'AbortError');
  // Cualquier espera termina en cuanto el usuario cancela
  const cancelled = new Promise((_, reject) => {
    if (signal) signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  cancelled.catch(() => {});
  const race = (p) => Promise.race([p, cancelled]);
  await race(engine.ensureLoaded());
  const worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
  let blob = new Blob([], { type: 'audio/mpeg' });
  let parts = [];
  let pending = 0;
  let reqId = 0;
  const waiting = new Map();
  // Se consolida en un Blob cada ~4 MB para no acumular todo el MP3 en memoria
  const flushParts = () => {
    if (!parts.length) return;
    blob = new Blob([blob, ...parts], { type: 'audio/mpeg' });
    parts = [];
    pending = 0;
  };
  const failAll = (err) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  worker.onerror = (e) => { e.preventDefault && e.preventDefault(); failAll(new Error('El codificador de audio falló: ' + (e.message || 'error'))); };
  worker.onmessageerror = () => failAll(new Error('El codificador de audio no respondió'));
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'mp3') {
      for (const part of m.parts) { parts.push(part); pending += part.byteLength; }
      if (pending > 4 * 1024 * 1024) flushParts();
    }
    const w = waiting.get(m.type === 'ready' ? 'ready' : m.id);
    if (w) { waiting.delete(m.type === 'ready' ? 'ready' : m.id); w.resolve(); }
  };
  const send = (msg, transfer) => race(new Promise((resolve, reject) => {
    const id = msg.type === 'init' ? 'ready' : ++reqId;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  }));

  try {
    let sampleRate = null;
    const t0 = performance.now();
    const total = Math.max(1, player.cum[to] - player.cum[from]);
    for (let i = from; i < to; i++) {
      if (signal && signal.aborted) throw abortError();
      const info = player.chunks(i);
      for (let c = 0; c < info.chunks.length; c++) {
        const isLast = c === info.chunks.length - 1;
        const res = await race(engine.synth(info.chunks[c].text, true));
        engine.cache.delete(info.chunks[c].text);
        if (!sampleRate) {
          sampleRate = res.sampleRate;
          await send({ type: 'init', sampleRate, kbps });
        }
        const pause = isLast ? player.pauseAfter(i) : 0;
        const pcm = floatToInt16(res.pcm, Math.round((pause / 1000) * sampleRate));
        await send({ type: 'pcm', pcm }, [pcm.buffer]);
      }
      const doneFrac = (player.cum[i + 1] - player.cum[from]) / total;
      const elapsed = (performance.now() - t0) / 1000;
      onProgress && onProgress(doneFrac, doneFrac > 0.01 ? (elapsed / doneFrac) * (1 - doneFrac) : null);
    }
    if (!sampleRate) throw new Error('No hay texto para exportar.');
    await send({ type: 'flush' });
    flushParts();
    return blob;
  } finally {
    worker.terminate();
  }
}
