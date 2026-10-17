// Worker de síntesis neural (Piper): texto → fonemas (espeak-ng) → audio (ONNX).
// Es un worker clásico porque piper_phonemize.js y ort.wasm.min.js son scripts UMD.
/* global ort, createPiperPhonemize */

const VENDOR = new URL('../../vendor/', self.location.href).href;
importScripts(VENDOR + 'ort/ort.wasm.min.js', VENDOR + 'piper/piper_phonemize.js');

ort.env.wasm.wasmPaths = VENDOR + 'ort/';
// Hilos: automático o los que pida la app (?hilos=N), nunca más que los automáticos
const autoThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
const askedThreads = Number(new URL(self.location.href).searchParams.get('hilos')) || 0;
ort.env.wasm.numThreads = askedThreads ? Math.max(1, Math.min(autoThreads, askedThreads)) : autoThreads;
ort.env.logLevel = 'error';

let phonemizer = null;
let phonemizerCalls = 0;
let assets = null;
let printed = [];
let session = null;
let config = null;
let voiceKey = null;

// espeak-ng pierde memoria en cada llamada y su memoria es fija: tras ~90
// frases se rompe ("Aborted()"). Se recrea el módulo antes de agotarla
// (reutilizando el wasm compilado y los datos ya descargados, es rápido).
const PHONEMIZER_MAX_CALLS = 30;

function loadAssets() {
  if (!assets) {
    const get = async (file) => {
      const r = await fetch(VENDOR + 'piper/' + file);
      if (!r.ok) throw new Error('No se pudo cargar el motor de voz (' + file + ').');
      return r.arrayBuffer();
    };
    assets = Promise.all([get('piper_phonemize.wasm').then((b) => WebAssembly.compile(b)), get('piper_phonemize.data')]);
    assets.catch(() => { assets = null; });
  }
  return assets;
}

async function getPhonemizer() {
  if (phonemizer && phonemizerCalls >= PHONEMIZER_MAX_CALLS) phonemizer = null;
  if (!phonemizer) {
    const [wasm, data] = await loadAssets();
    phonemizerCalls = 0;
    phonemizer = await createPiperPhonemize({
      print: (line) => printed.push(line),
      printErr: () => {},
      locateFile: (file) => VENDOR + 'piper/' + file,
      getPreloadedPackage: () => data,
      instantiateWasm: (imports, receive) => {
        WebAssembly.instantiate(wasm, imports).then((inst) => receive(inst, wasm));
        return {};
      }
    });
  }
  return phonemizer;
}

// Caracteres que el analizador JSON del fonemizador rechaza (y lo rompen)
function cleanText(text) {
  return String(text)
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function runPhonemizer(text) {
  printed = [];
  phonemizerCalls++;
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

async function phonemize(text) {
  text = cleanText(text);
  await getPhonemizer();
  try {
    return runPhonemizer(text);
  } catch {
    // El módulo quedó inutilizable: se recrea y se reintenta una vez
    phonemizer = null;
    await getPhonemizer();
    try {
      return runPhonemizer(text);
    } catch {
      phonemizer = null;
      // Último intento solo con letras, números y puntuación básica
      const simple = text.replace(/[^\p{L}\p{N}\s.,;:¡!¿?'"()-]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (!simple || simple === text) throw new Error('El motor no pudo leer esta frase.');
      await getPhonemizer();
      try {
        return runPhonemizer(simple);
      } catch {
        phonemizer = null;
        throw new Error('El motor no pudo leer esta frase.');
      }
    }
  }
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

async function synthesize(text, { speaker = 0, lengthScale, speed = 1 } = {}) {
  const ids = await phonemize(text);
  if (!ids.length) return new Float32Array(0);
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([
      inf.noise_scale ?? 0.667,
      (lengthScale ?? inf.length_scale ?? 1) / (speed > 0 ? speed : 1),
      inf.noise_w ?? 0.8
    ]), [3])
  };
  if ((config.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker)]), [1]);
  let out;
  try {
    out = await session.run(feeds);
  } catch (err) {
    // Un fallo interno de ONNX deja el motor inutilizable: hay que reiniciar el worker
    if (err instanceof WebAssembly.RuntimeError || /Aborted|out of bounds|memory/i.test(String(err && err.message))) err.fatal = true;
    throw err;
  }
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
    self.postMessage({ type: 'error', id: msg.id, message: (err && err.message) || String(err), fatal: !!(err && err.fatal) });
  }
};
