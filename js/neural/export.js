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
  await engine.ensureLoaded();
  const worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
  const parts = [];
  let reqId = 0;
  const waiting = new Map();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'mp3') {
      parts.push(...m.parts);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(); }
    } else if (m.type === 'ready') {
      const w = waiting.get('ready');
      if (w) { waiting.delete('ready'); w(); }
    }
  };
  const send = (msg, transfer) => new Promise((resolve) => {
    const id = msg.type === 'init' ? 'ready' : ++reqId;
    waiting.set(id, resolve);
    worker.postMessage({ ...msg, id }, transfer || []);
  });

  try {
    let sampleRate = null;
    const t0 = performance.now();
    const total = Math.max(1, player.cum[to] - player.cum[from]);
    for (let i = from; i < to; i++) {
      if (signal && signal.cancelled) throw new DOMException('Cancelado', 'AbortError');
      const info = player.chunks(i);
      for (let c = 0; c < info.chunks.length; c++) {
        const isLast = c === info.chunks.length - 1;
        const res = await engine.synth(info.chunks[c].text, true);
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
    return new Blob(parts, { type: 'audio/mpeg' });
  } finally {
    worker.terminate();
  }
}
