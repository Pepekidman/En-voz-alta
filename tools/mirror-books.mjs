// Copia (espejo) de libros de Project Gutenberg para servirlos desde GitHub Pages.
// Gutenberg no permite descargas desde apps web (sin CORS); los libros copiados
// aquí se descargan desde el mismo sitio de la app, con un solo toque.
//
// Se ejecuta en GitHub Actions al publicar: node tools/mirror-books.mjs <carpeta>
// Copia las colecciones recomendadas y los libros en español más populares.
// Respeta a Gutenberg: descarga sólo lo que falta (con caché entre ejecuciones),
// de a uno y con pausas.
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || 'mirror/libros');
const POPULAR_PAGES = Number(process.env.MIRROR_POPULAR_PAGES || 4); // 32 libros por página
const LANGS = (process.env.MIRROR_LANGS || 'es').split(',');
const MAX_BYTES = 8 * 1024 * 1024;
// Tiempo máximo por publicación: lo que falte se copia en la siguiente
const BUDGET_MS = Number(process.env.MIRROR_BUDGET_MIN || 18) * 60000;
const START = Date.now();
const UA = 'EnVozAlta-mirror/1.0 (+https://github.com/Pepekidman/En-voz-alta)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (res.ok) return res;
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= tries) { console.warn(`  ✗ ${url}: ${e.message}`); return null; }
      await sleep(3000 * i);
    }
  }
}

// IDs de las colecciones recomendadas (se leen del propio catálogo de la app)
function collectionIds() {
  const src = fs.readFileSync(new URL('../js/catalog/gutenberg.js', import.meta.url), 'utf8');
  const ids = new Set();
  for (const m of src.matchAll(/ids:\s*\[([\d,\s]+)\]/g)) for (const n of m[1].split(',')) if (n.trim()) ids.add(Number(n));
  return ids;
}

async function popularIds() {
  const ids = new Set();
  for (const lang of LANGS) {
    for (let page = 1; page <= POPULAR_PAGES; page++) {
      const res = await get(`https://gutendex.com/books/?languages=${lang}&sort=popular&mime_type=application%2Fepub&page=${page}`);
      if (!res) break;
      const data = await res.json();
      for (const b of data.results || []) ids.add(b.id);
      if (!data.next) break;
      await sleep(1000);
    }
  }
  return ids;
}

async function main() {
  const ids = new Set([...collectionIds(), ...(await popularIds())]);
  console.log(`Libros a reflejar: ${ids.size}`);
  let downloaded = 0;
  let failed = 0;
  // Índice con lo que ya está copiado (se actualiza a medida que avanza)
  const writeIndex = () => {
    const books = [...ids].filter((id) => fs.existsSync(path.join(OUT, `pg${id}.epub`)));
    const covers = books.filter((id) => fs.existsSync(path.join(OUT, `pg${id}.jpg`)));
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ updated: new Date().toISOString(), books, covers }));
    return books.length;
  };
  writeIndex();
  for (const id of ids) {
    if (Date.now() - START > BUDGET_MS) { console.log('Tiempo agotado: el resto se copiará en la próxima publicación.'); break; }
    if (failed >= 12 && downloaded === 0) { console.log('Gutenberg no responde: se reintentará en la próxima publicación.'); break; }
    const epub = path.join(OUT, `pg${id}.epub`);
    const cover = path.join(OUT, `pg${id}.jpg`);
    if (!fs.existsSync(epub)) {
      // EPUB sin imágenes: más liviano y con todo el texto
      const res = (await get(`https://www.gutenberg.org/ebooks/${id}.epub.noimages`)) ||
        (await get(`https://www.gutenberg.org/ebooks/${id}.epub3.images`));
      if (!res) { failed++; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES || buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        console.warn(`  ✗ pg${id}: archivo inválido (${buf.length} bytes)`);
        failed++;
        continue;
      }
      fs.writeFileSync(epub, buf);
      downloaded++;
      if (downloaded % 10 === 0) { writeIndex(); console.log(`  … ${downloaded} libros copiados`); }
      await sleep(1500);
    }
    if (!fs.existsSync(cover)) {
      const res = await get(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`, 1);
      if (res) fs.writeFileSync(cover, Buffer.from(await res.arrayBuffer()));
      await sleep(500);
    }
  }
  const total = writeIndex();
  console.log(`Listo: ${total} libros disponibles (${downloaded} descargados ahora, ${failed} con error).`);
}

main().catch((e) => {
  console.error(e);
  // Nunca bloquear la publicación de la app por el espejo
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ updated: new Date().toISOString(), books: [], covers: [] }));
});
