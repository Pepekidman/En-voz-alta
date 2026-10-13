// Service worker: guarda la app completa para usarla sin conexión y recibe
// archivos compartidos desde otras apps (Web Share Target).
const BUILD = '__BUILD__';
const CACHE = `evz-${BUILD}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/db.js',
  'js/text.js',
  'js/speech.js',
  'js/player.js',
  'js/media.js',
  'js/parsers/index.js',
  'js/parsers/common.js',
  'js/parsers/pdf.js',
  'js/explore.js',
  'js/log.js',
  'js/catalog/index.js',
  'js/catalog/net.js',
  'js/catalog/gutenberg.js',
  'js/neural/engine.js',
  'js/neural/voices.js',
  'js/neural/worker.js',
  'js/neural/export.js',
  'js/neural/mp3-worker.js',
  'vendor/lame/lame.min.js',
  'vendor/pdfjs/pdf.min.js',
  'vendor/pdfjs/pdf.worker.min.js',
  'vendor/jszip/jszip.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('evz-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function openShareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('en-voz-alta-share', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('inbox', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const items = [];
    for (const f of form.getAll('file')) {
      if (f && typeof f !== 'string') items.push({ file: f, name: f.name, type: f.type });
    }
    const title = form.get('title') || '';
    const text = form.get('text') || '';
    const url = form.get('url') || '';
    if (!items.length && (text || url)) items.push({ title, text, url });
    const db = await openShareDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('inbox', 'readwrite');
      const store = tx.objectStore('inbox');
      for (const it of items) store.add(it);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // Si falla, la app se abre igualmente
  }
  return Response.redirect('./?share=1', 303);
}

// Aislamiento entre orígenes: permite que el motor de voz neural use varios
// hilos (SharedArrayBuffer). GitHub Pages no permite configurar estas cabeceras,
// así que las añade el service worker a las respuestas que sirve.
// «credentialless» permite mostrar imágenes de otros sitios (portadas del
// catálogo) sin perder el aislamiento; Safari sólo admite «require-corp».
const UA = self.navigator.userAgent || '';
const COEP = /Safari/.test(UA) && !/Chrome|Chromium|CriOS|Android|Edg/.test(UA) ? 'require-corp' : 'credentialless';

function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', COEP);
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// El motor neural (≈30 MB) lo guarda la app en su propia caché al activarlo.
// Los libros copiados (/libros/) se guardan en la biblioteca al descargarlos.
const RUNTIME_PATH = /\/vendor\/(ort|piper)\/|\/libros\//;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Navegación: app shell desde caché (funciona sin conexión)
    event.respondWith(
      caches.match('index.html').then((cached) => cached || fetch(req))
        .catch(() => caches.match('index.html'))
        .then(isolate)
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return isolate(cached);
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic' && !RUNTIME_PATH.test(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return isolate(res);
      });
    })
  );
});
