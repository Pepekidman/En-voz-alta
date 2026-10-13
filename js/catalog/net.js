// Descargas con progreso. Si el sitio no permite descargas desde otras apps
// (CORS), el error lleva code = 'CORS' para ofrecer abrirlo en el navegador.

export async function fetchJson(url, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error('No se pudo conectar con el catálogo');
    err.code = 'CORS';
    throw err;
  }
  if (!res.ok) throw new Error(`El catálogo respondió ${res.status}`);
  return res.json();
}

export async function fetchFile(url, { name, type, signal, onProgress, expectedSize } = {}) {
  let res;
  try {
    res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error('El sitio no permite la descarga directa');
    err.code = 'CORS';
    throw err;
  }
  if (!res.ok) throw new Error(`La descarga falló (${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || expectedSize || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (onProgress && total) onProgress(Math.min(0.99, loaded / total));
  }
  return new File(chunks, name, { type: type || res.headers.get('Content-Type') || 'application/octet-stream' });
}

export function safeName(s) {
  return s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'libro';
}
