// Catálogo de voces neuronales Piper y gestión de descargas (Cache Storage).

export const VOICE_CACHE = 'piper-voces-v1';
export const RUNTIME_CACHE = 'piper-motor-v1';

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/';
const SAMPLES = 'https://rhasspy.github.io/piper-samples/samples/';

// Archivos del motor (mismo origen). Se descargan sólo al activar las voces neuronales.
const VENDOR = new URL('../../vendor/', import.meta.url).href;
export const RUNTIME_FILES = [
  { url: VENDOR + 'ort/ort.wasm.min.js', size: 48327 },
  { url: VENDOR + 'ort/ort-wasm-simd-threaded.mjs', size: 20856 },
  { url: VENDOR + 'ort/ort-wasm-simd-threaded.wasm', size: 11210254 },
  { url: VENDOR + 'piper/piper_phonemize.js', size: 120714 },
  { url: VENDOR + 'piper/piper_phonemize.wasm', size: 635212 },
  { url: VENDOR + 'piper/piper_phonemize.data', size: 18077249 }
];
export const RUNTIME_SIZE = RUNTIME_FILES.reduce((n, f) => n + f.size, 0);

function entry(key, { region, name, quality, mb, speakers, note, recommended }) {
  const [code, voiceName, q] = key.split('-');
  const family = code.split('_')[0];
  const path = `${family}/${code}/${voiceName}/${q}/${key}`;
  return {
    key,
    lang: family,
    region,
    name,
    quality,
    size: Math.round(mb * 1048576),
    speakers: speakers || 1,
    note: note || '',
    recommended: !!recommended,
    modelUrl: HF + path + '.onnx',
    configUrl: HF + path + '.onnx.json',
    sampleUrl: `${SAMPLES}${family}/${code}/${voiceName}/${q}/speaker_0.mp3`
  };
}

export const CATALOG = [
  entry('es_MX-claude-high', { region: 'México', name: 'Claude', quality: 'Alta', mb: 60.2, recommended: true, note: 'Español latino, la más natural.' }),
  entry('es_MX-ald-medium', { region: 'México', name: 'Ald', quality: 'Media', mb: 60.3, note: 'Español latino.' }),
  entry('es_ES-davefx-medium', { region: 'España', name: 'Davefx', quality: 'Media', mb: 60.3, note: 'Español de España.' }),
  entry('es_ES-sharvard-medium', { region: 'España', name: 'Sharvard', quality: 'Media', mb: 73.2, speakers: 2, note: 'Dos voces: femenina y masculina.' }),
  entry('es_ES-carlfm-x_low', { region: 'España', name: 'Carlfm', quality: 'Rápida', mb: 26.8, note: 'Más liviana y veloz, para teléfonos lentos.' }),
  entry('en_US-lessac-medium', { region: 'EE. UU.', name: 'Lessac', quality: 'Media', mb: 60.3, note: 'Inglés.' }),
  entry('en_GB-alba-medium', { region: 'Reino Unido', name: 'Alba', quality: 'Media', mb: 60.3, note: 'Inglés británico.' }),
  entry('pt_BR-faber-medium', { region: 'Brasil', name: 'Faber', quality: 'Media', mb: 60.3, note: 'Portugués.' })
];

// ------------------------------------------------------------ voces locales

const LOCAL_KEY = 'evz-local-voices';
const LOCAL_BASE = new URL('../../voces-locales/', import.meta.url).href;

export function localVoices() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
}

function saveLocalVoices(list) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch {}
}

export function allVoices() {
  return [...CATALOG, ...localVoices()];
}

export function findVoice(key) {
  return allVoices().find((v) => v.key === key) || null;
}

/** Agrega una voz desde archivos (.onnx + .onnx.json) elegidos por el usuario. */
export async function importVoiceFiles(files) {
  const onnx = files.find((f) => /\.onnx$/i.test(f.name));
  const json = files.find((f) => /\.json$/i.test(f.name));
  if (!onnx || !json) throw new Error('Elige los dos archivos de la voz: el .onnx y su .onnx.json.');
  const cfg = JSON.parse(await json.text());
  if (!cfg.espeak || !cfg.audio) throw new Error('El archivo .json no parece de una voz Piper.');
  const key = onnx.name.replace(/\.onnx$/i, '');
  const v = {
    key,
    lang: (cfg.language?.family || cfg.espeak.voice || 'es').slice(0, 2),
    region: cfg.language?.country_english || cfg.language?.code || '',
    name: key,
    quality: cfg.audio.quality || '',
    size: onnx.size,
    speakers: cfg.num_speakers || 1,
    note: 'Importada desde archivos.',
    local: true,
    modelUrl: LOCAL_BASE + encodeURIComponent(key) + '.onnx',
    configUrl: LOCAL_BASE + encodeURIComponent(key) + '.onnx.json'
  };
  const cache = await caches.open(VOICE_CACHE);
  await cache.put(v.modelUrl, new Response(onnx, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(onnx.size) } }));
  await cache.put(v.configUrl, new Response(JSON.stringify(cfg), { headers: { 'Content-Type': 'application/json' } }));
  saveLocalVoices([...localVoices().filter((x) => x.key !== key), v]);
  return v;
}

// ------------------------------------------------------------ estado y descargas

async function has(cacheName, url) {
  try {
    const c = await caches.open(cacheName);
    return !!(await c.match(url));
  } catch {
    return false;
  }
}

export async function isRuntimeReady() {
  if (!('caches' in self)) return false;
  for (const f of RUNTIME_FILES) if (!(await has(RUNTIME_CACHE, f.url))) return false;
  return true;
}

export async function isVoiceDownloaded(v) {
  return (await has(VOICE_CACHE, v.modelUrl)) && (await has(VOICE_CACHE, v.configUrl));
}

export async function downloadedKeys() {
  const out = new Set();
  for (const v of allVoices()) if (await isVoiceDownloaded(v)) out.add(v.key);
  return out;
}

/** Descarga una URL a la caché informando el progreso (bytes). */
async function fetchToCache(cacheName, url, onBytes, signal) {
  const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`Error ${res.status} al descargar ${url.split('/').pop()}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onBytes && onBytes(value.byteLength, total);
  }
  const type = /\.wasm$/.test(url) ? 'application/wasm' : /\.m?js$/.test(url) ? 'text/javascript' : (res.headers.get('Content-Type') || 'application/octet-stream');
  const blob = new Blob(chunks, { type });
  const cache = await caches.open(cacheName);
  await cache.put(url, new Response(blob, {
    headers: { 'Content-Type': blob.type, 'Content-Length': String(blob.size) }
  }));
  return loaded;
}

/** Descarga sólo el motor de voz (si falta). */
export async function downloadRuntime({ onProgress, signal } = {}) {
  const need = [];
  for (const f of RUNTIME_FILES) if (!(await has(RUNTIME_CACHE, f.url))) need.push(f);
  const total = need.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  for (const f of need) {
    await fetchToCache(RUNTIME_CACHE, f.url, (b) => { done += b; onProgress && onProgress(Math.min(1, done / total)); }, signal);
  }
}

/** Descarga el motor (si falta) y la voz. onProgress(fraction, label). */
export async function downloadVoice(v, { onProgress, signal } = {}) {
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const needRuntime = [];
  for (const f of RUNTIME_FILES) if (!(await has(RUNTIME_CACHE, f.url))) needRuntime.push(f);
  const total = needRuntime.reduce((n, f) => n + f.size, 0) + v.size + 4096;
  let done = 0;
  const tick = (label) => (bytes) => {
    done += bytes;
    onProgress && onProgress(Math.min(0.999, done / total), label);
  };
  for (const f of needRuntime) await fetchToCache(RUNTIME_CACHE, f.url, tick('Motor de voz'), signal);
  await fetchToCache(VOICE_CACHE, v.configUrl, tick('Configuración'), signal);
  await fetchToCache(VOICE_CACHE, v.modelUrl, tick(`Voz ${v.name}`), signal);
  onProgress && onProgress(1, 'Listo');
}

export async function deleteVoice(v) {
  const cache = await caches.open(VOICE_CACHE);
  await cache.delete(v.modelUrl);
  await cache.delete(v.configUrl);
  if (v.local) saveLocalVoices(localVoices().filter((x) => x.key !== v.key));
}

export function fmtSize(bytes) {
  return bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
