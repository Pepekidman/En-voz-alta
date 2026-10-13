// Registro local de errores para diagnóstico (Ajustes → Diagnóstico).
// Se guarda sólo en este dispositivo; el usuario puede copiarlo y enviarlo.

const KEY = 'evz-log';
const MAX = 40;

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function logError(context, err) {
  const entry = {
    at: new Date().toISOString(),
    context: String(context || ''),
    message: String((err && (err.message || err.reason || err)) || 'error'),
    name: (err && err.name) || '',
    stack: ((err && err.stack) || '').split('\n').slice(0, 4).join('\n')
  };
  try {
    const list = read();
    list.push(entry);
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {}
  console.error(`[${entry.context}]`, err);
  return entry;
}

export function getLog() {
  return read();
}

export function clearLog() {
  try { localStorage.removeItem(KEY); } catch {}
}

/** Informe de texto con datos del entorno, listo para copiar. */
export function report(extra = {}) {
  const env = {
    app: extra.version,
    fecha: new Date().toISOString(),
    navegador: navigator.userAgent,
    instalada: matchMedia('(display-mode: standalone)').matches,
    aislada: self.crossOriginIsolated,
    enLinea: navigator.onLine,
    ...extra
  };
  const lines = Object.entries(env).map(([k, v]) => `${k}: ${v}`);
  const errs = read().slice(-15).reverse().map((e) => `• ${e.at.slice(0, 19).replace('T', ' ')} [${e.context}] ${e.name ? e.name + ': ' : ''}${e.message}${e.stack ? '\n  ' + e.stack.replace(/\n/g, '\n  ') : ''}`);
  return `En Voz Alta — informe de diagnóstico\n${lines.join('\n')}\n\nÚltimos errores:\n${errs.join('\n') || '(ninguno)'}`;
}

export function installGlobalHandlers() {
  window.addEventListener('error', (e) => logError('error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => logError('promesa', e.reason));
}
