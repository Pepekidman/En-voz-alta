// Worker de síntesis neural (Piper): texto → fonemas (espeak-ng) → audio (ONNX).
// Es un worker clásico porque piper_phonemize.js y ort.wasm.min.js son scripts UMD.
/* global ort, createPiperPhonemize */

const VENDOR = new URL('../../vendor/', self.location.href).href;
importScripts(VENDOR + 'ort/ort.wasm.min.js', VENDOR + 'piper/piper_phonemize.js');

ort.env.wasm.wasmPaths = VENDOR + 'ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
ort.env.logLevel = 'error';

let phonemizer = null;
let printed = [];
let session = null;
let config = null;
let voiceKey = null;

async function getPhonemizer() {
  if (!phonemizer) {
    phonemizer = await createPiperPhonemize({
      print: (line) => printed.push(line),
      printErr: () => {},
      locateFile: (file) => VENDOR + 'piper/' + file
    });
  }
  return phonemizer;
}

function phonemize(text) {
  printed = [];
  phonemizer.callMain(['-l', config.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  const ids = [];
  for (const line of printed) {
    try {
      const j = JSON.parse(line);
      if (Array.isArray(j.phoneme_ids)) ids.push(...j.phoneme_ids);
    } catch {}
  }
  return ids;
}

async function loadVoice({ key, modelUrl, configUrl, cacheName }) {
  if (voiceKey === key && session) return;
  const cache = await caches.open(cacheName);
  const [m, c] = await Promise.all([cache.match(modelUrl), cache.match(configUrl)]);
  if (!m || !c) throw new Error('La voz no está descargada en este dispositivo.');
  const cfg = await c.json();
  const buf = await m.arrayBuffer();
  if (session) { try { await session.release(); } catch {} session = null; }
  session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  config = cfg;
  voiceKey = key;
}

async function synthesize(text, { speaker = 0, lengthScale } = {}) {
  const ids = phonemize(text);
  if (!ids.length) return new Float32Array(0);
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([
      inf.noise_scale ?? 0.667,
      lengthScale ?? inf.length_scale ?? 1,
      inf.noise_w ?? 0.8
    ]), [3])
  };
  if ((config.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker)]), [1]);
  const out = await session.run(feeds);
  const data = (out.output || Object.values(out)[0]).data;
  // Copia propia para poder transferirla al hilo principal
  return data instanceof Float32Array && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : Float32Array.from(data);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const t0 = performance.now();
      await getPhonemizer();
      await loadVoice(msg.voice);
      self.postMessage({ type: 'loaded', id: msg.id, key: voiceKey, sampleRate: config.audio.sample_rate, threads: ort.env.wasm.numThreads, ms: performance.now() - t0 });
    } else if (msg.type === 'synth') {
      if (!session) throw new Error('No hay voz cargada');
      const t0 = performance.now();
      const pcm = await synthesize(msg.text, msg.opts);
      self.postMessage({ type: 'audio', id: msg.id, pcm, sampleRate: config.audio.sample_rate, ms: performance.now() - t0 }, [pcm.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: (err && err.message) || String(err) });
  }
};
