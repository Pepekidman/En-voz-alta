// Servidor de descarga para «Explorar» de En Voz Alta (Cloudflare Workers, plan gratuito).
// Descarga un libro de Project Gutenberg a pedido del usuario y le añade la
// cabecera CORS para que la app pueda guardarlo. Sólo acepta los dominios de
// la lista y peticiones GET; no guarda nada.
//
// Uso desde la app: https://<tu-worker>.workers.dev/?url=<url del libro>

const ALLOWED_HOSTS = [
  'www.gutenberg.org',
  'gutenberg.org',
  'aleph.gutenberg.org',
  'gutenberg.pglaf.org'
];
const MAX_BYTES = 60 * 1024 * 1024;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type'
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Método no permitido', { status: 405, headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    let url;
    try {
      url = new URL(target);
    } catch {
      return new Response('Falta el parámetro url', { status: 400, headers: cors });
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) {
      return new Response('Dominio no permitido', { status: 403, headers: cors });
    }
    const upstream = await fetch(url.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'EnVozAlta/1.0 (lector personal; descarga a pedido del usuario)' },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    const finalHost = new URL(upstream.url).hostname;
    if (!ALLOWED_HOSTS.includes(finalHost)) return new Response('Redirección no permitida', { status: 403, headers: cors });
    const size = Number(upstream.headers.get('Content-Length') || 0);
    if (size > MAX_BYTES) return new Response('Archivo demasiado grande', { status: 413, headers: cors });
    const headers = new Headers(cors);
    for (const h of ['Content-Type', 'Content-Length', 'Last-Modified']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
