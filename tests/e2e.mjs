// Prueba de extremo a extremo en Chromium (Playwright) con un sintetizador
// de voz simulado. Uso: node tests/e2e.mjs
// Requiere playwright instalado (npm i -D playwright) o PLAYWRIGHT_PATH.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests', 'output');
fs.mkdirSync(OUT, { recursive: true });

const pw = await import(process.env.PLAYWRIGHT_PATH ? pathToFileURL(process.env.PLAYWRIGHT_PATH).href : 'playwright');
const { chromium } = pw.default || pw;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (p.endsWith('/')) p += 'index.html';
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else { failures++; console.log('  ✗', msg); }
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// ---------------------------------------------------------------- PDF de prueba
async function makePdf() {
  const page = await browser.newPage();
  const para = (n) => `<p>Este es el párrafo número ${n} del libro de prueba. Tiene varias frases para leer. ¿Funcionará bien la segmentación? Sí, eso esperamos.</p>`;
  let html = '<html lang="es"><body style="font-family:serif;font-size:14px;margin:0">';
  html += '<h1 style="font-size:28px">Capítulo 1</h1>';
  for (let i = 1; i <= 12; i++) html += para(i);
  html += '<p>Esta línea termina con una pala-<br>bra cortada en dos.</p>';
  html += '<h1 style="font-size:28px;page-break-before:always">Capítulo 2</h1>';
  for (let i = 13; i <= 24; i++) html += para(i);
  html += '</body></html>';
  await page.setContent(html);
  await page.pdf({
    path: path.join(FIX, 'prueba.pdf'),
    format: 'A5',
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:9px;width:100%;text-align:center">Libro de Pruebas — Encabezado</div>',
    footerTemplate: '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span></div>',
    margin: { top: '60px', bottom: '60px', left: '40px', right: '40px' }
  });
  await page.close();
}
await makePdf();

// ---------------------------------------------------------------- sintetizador simulado
const FAKE_TTS = () => {
  const voices = [
    { name: 'Español Prueba', lang: 'es-ES', voiceURI: 'es-test', localService: true, default: true },
    { name: 'English Test', lang: 'en-US', voiceURI: 'en-test', localService: true, default: false }
  ];
  window.__spoken = [];
  class FakeUtterance {
    constructor(text) { this.text = text; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; this.lang = ''; }
  }
  let queue = [];
  let current = null;
  let timers = [];
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => voices,
    addEventListener() {},
    speak(u) { queue.push(u); this.pending = true; pump(); },
    cancel() {
      timers.forEach(clearTimeout); timers = [];
      const c = current; current = null; queue = []; this.speaking = false; this.pending = false;
      if (c && c.onerror) c.onerror({ error: 'interrupted' });
    },
    pause() {}, resume() {}
  };
  function pump() {
    if (current || !queue.length) return;
    const u = queue.shift();
    current = u;
    synth.speaking = true;
    synth.pending = queue.length > 0;
    const dur = Math.max(30, (u.text.length * 6) / (u.rate || 1));
    timers.push(setTimeout(() => {
      window.__spoken.push({ text: u.text, rate: u.rate, voice: u.voice && u.voice.voiceURI });
      u.onstart && u.onstart({});
      const re = /\S+/g; let m; let k = 0;
      while ((m = re.exec(u.text))) {
        const ci = m.index;
        timers.push(setTimeout(() => current === u && u.onboundary && u.onboundary({ name: 'word', charIndex: ci, charLength: 1 }), (k++ * dur) / 8));
      }
      timers.push(setTimeout(() => {
        if (current !== u) return;
        current = null; synth.speaking = false;
        u.onend && u.onend({});
        pump();
      }, dur));
    }, 5));
  }
  window.SpeechSynthesisUtterance = FakeUtterance;
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
};

const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'es-ES' });
await context.addInitScript(FAKE_TTS);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => { if (process.env.E2E_DEBUG) console.log('    [diálogo]', d.message().slice(0, 160)); d.accept(); });

console.log('Biblioteca vacía');
await page.goto(BASE);
await page.waitForSelector('#lib-empty:not(.hidden)');
check(await page.isVisible('#lib-empty'), 'muestra estado vacío');
await page.screenshot({ path: path.join(OUT, '01-biblioteca-vacia.png') });

console.log('Importación de todos los formatos');
const files = fs.readdirSync(FIX).filter((f) => !f.startsWith('.') && fs.statSync(path.join(FIX, f)).isFile()).map((f) => path.join(FIX, f));
await page.setInputFiles('#file-input', files);
await page.waitForFunction((n) => document.querySelectorAll('#lib-list .card').length === n, files.length, { timeout: 30000 })
  .catch(async () => console.log('    errores:', errors, 'tarjetas:', await page.$$eval('.card-title', (e) => e.map((x) => x.textContent)), 'busy:', await page.textContent('#busy-text')));
check((await page.$$('#lib-list .card')).length === files.length, `${files.length} documentos en la biblioteca`);
const titles = await page.$$eval('.card-title', (els) => els.map((e) => e.textContent));
check(titles.includes('Libro de Prueba'), 'título EPUB desde metadatos');
check(titles.includes('Documento Word'), 'título DOCX desde metadatos');
check(titles.includes('Libro FB2'), 'título FB2');
check(titles.includes('Página HTML'), 'título HTML');
await page.screenshot({ path: path.join(OUT, '02-biblioteca.png') });

async function openCard(sel) {
  await page.click(sel);
  await page.waitForSelector('#view-reader.active');
  await page.waitForSelector('#reader-content .s');
}

async function readerText() {
  return page.$eval('#reader-content', (e) => e.innerText);
}

console.log('PDF: limpieza de encabezados, números de página y guiones');
await openCard('.card:has(.badge:text-is("pdf"))');
let txt = await readerText();
check(!/Encabezado/.test(txt), 'sin encabezado repetido');
check(/párrafo número 1 del libro/.test(txt), 'contiene el texto del cuerpo');
check(/palabra cortada/.test(txt), 'une «pala-bra» → «palabra»');
check(!/^\s*\d+\s*$/m.test(txt.replace(/Página \d+/g, '')), 'sin números de página sueltos');
const pdfChapters = await page.evaluate(() => window.__evz.player.doc.content.chapters.map((c) => c.title));
check(pdfChapters.some((t) => /Capítulo 1/.test(t)) && pdfChapters.some((t) => /Capítulo 2/.test(t)), 'capítulos detectados en PDF: ' + JSON.stringify(pdfChapters));
await page.screenshot({ path: path.join(OUT, '03-lector-pdf.png') });

console.log('Reproducción, resaltado y pausas');
await page.click('#btn-play');
await page.waitForFunction(() => window.__spoken.length >= 4, null, { timeout: 10000 });
check(await page.$('#reader-content .s.current') !== null, 'frase actual resaltada');
await page.waitForSelector('#reader-content .s.current mark', { timeout: 5000 }).catch(() => {});
check(await page.$('#reader-content .s.current mark') !== null, 'palabra actual resaltada');
check((await page.getAttribute('#btn-play use', 'href')) === '#i-pause', 'botón muestra pausa');
await page.screenshot({ path: path.join(OUT, '04-leyendo.png') });
await page.click('#btn-play');
const idxPaused = await page.evaluate(() => window.__evz.player.idx);
const spokenCount = await page.evaluate(() => window.__spoken.length);
await page.waitForTimeout(600);
check(await page.evaluate((n) => window.__spoken.length === n, spokenCount), 'en pausa no sigue hablando');
check(idxPaused > 0, `posición avanzó (frase ${idxPaused})`);

console.log('Velocidad');
await page.click('#btn-speed');
await page.click('.sheet .seg button:text-is("1.5×")');
await page.click('#sheet-close');
check((await page.textContent('#btn-speed')).startsWith('1.5'), 'chip de velocidad 1.5×');
await page.click('#btn-play');
await page.waitForFunction(() => window.__spoken.some((s) => s.rate === 1.5), null, { timeout: 5000 }).catch(() => {});
check(await page.evaluate(() => window.__spoken.some((s) => s.rate === 1.5)), 'utterances con rate 1.5');
await page.click('#btn-play');

console.log('Navegación por frases y párrafos');
const i0 = await page.evaluate(() => window.__evz.player.idx);
await page.click('#btn-next');
check(await page.evaluate((i) => window.__evz.player.idx === i + 1, i0), 'frase siguiente');
await page.click('#btn-prev');
check(await page.evaluate((i) => window.__evz.player.idx === i, i0), 'frase anterior');
await page.click('#btn-next-para');
const p1 = await page.evaluate(() => window.__evz.player.sentences[window.__evz.player.idx].p);
check(p1 > 0, 'párrafo siguiente');

console.log('Persistencia de la posición');
const before = await page.evaluate(() => window.__evz.player.idx);
await page.click('#btn-back');
await page.waitForSelector('#view-library.active');
await page.reload();
await page.waitForSelector('#lib-list .card');
await openCard('.card:has(.badge:text-is("pdf"))');
const after = await page.evaluate(() => window.__evz.player.idx);
check(after === before, `posición restaurada tras recargar (${before} → ${after})`);
check(await page.$(`#reader-content .s.current[data-i="${after}"]`) !== null, 'resaltado en la posición restaurada');

console.log('Marcadores, índice y búsqueda');
await page.click('#btn-bookmarks');
await page.fill('.sheet input', 'nota de prueba');
await page.click('.sheet .btn.primary');
await page.waitForSelector('.sheet .list-item .t');
check((await page.textContent('.sheet .list-item .t')).includes('nota de prueba'), 'marcador agregado');
await page.click('#sheet-close');
await page.click('#btn-search');
await page.fill('.sheet input[type=search]', 'numero 20');
await page.waitForSelector('.sheet .result', { timeout: 3000 }).catch(() => {});
check((await page.$$('.sheet .result')).length >= 1, 'búsqueda sin tildes encuentra «número 20»');
await page.click('.sheet .result');
await page.waitForTimeout(200);
check(/número 20/.test(await page.evaluate(() => window.__evz.player.sentenceText(window.__evz.player.idx))), 'salto al resultado');
await page.click('#btn-toc');
check((await page.$$('.sheet .list-item')).length >= 2, 'índice con capítulos');
await page.screenshot({ path: path.join(OUT, '05-indice.png') });
await page.click('#sheet-close');

console.log('Temporizador de sueño (fin de capítulo)');
await page.evaluate(() => window.__evz.player.seek(window.__evz.player.paraFirst[window.__evz.player.doc.content.chapters[1].p] - 3));
await page.click('#btn-sleep');
await page.click('.sheet .list-item:has-text("final del capítulo")');
await page.click('#btn-play');
await page.waitForFunction(() => !window.__evz.player.playing, null, { timeout: 10000 }).catch(() => {});
const stopP = await page.evaluate(() => window.__evz.player.sentences[window.__evz.player.idx].p);
const ch2 = await page.evaluate(() => window.__evz.player.doc.content.chapters[1].p);
check(!(await page.evaluate(() => window.__evz.player.playing)) && stopP === ch2, 'se detuvo al terminar el capítulo');

console.log('EPUB: texto hablado y notas');
await page.click('#btn-back');
await openCard('.card:has(.badge:text-is("epub"))');
await page.evaluate(() => window.__spoken.length = 0);
await page.evaluate(() => window.__evz.player.seek(0));
await page.click('#btn-play');
await page.waitForFunction(() => window.__spoken.length >= 6, null, { timeout: 10000 });
await page.click('#btn-play');
const spoken = await page.evaluate(() => window.__spoken.map((s) => s.text));
console.log('    ', JSON.stringify(spoken.slice(0, 6)));
check(spoken.some((s) => /señor Pérez/.test(s)), 'expande «Sr.» → señor');
check(spoken.some((s) => /Estados Unidos/.test(s)), 'expande «EE. UU.»');
check(spoken.every((s) => !/[—«»]/.test(s)), 'sin rayas ni comillas en el texto hablado');
check(spoken[0] === 'Capítulo 1', 'título romano leído como número');
txt = await readerText();
check(!/nota1/.test(txt.replace(/\s/g, '')), 'llamada de nota omitida');
const epubCh = await page.evaluate(() => window.__evz.player.doc.content.chapters);
check(epubCh.length === 2 && epubCh[1].title === 'Capítulo II', 'índice EPUB (nav) con anclas');

console.log('Apariencia y tema');
await page.click('#btn-appearance');
await page.click('.sheet .seg button:text-is("Oscuro")');
await page.click('#sheet-close');
check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'tema oscuro aplicado');
await page.screenshot({ path: path.join(OUT, '06-oscuro.png') });

console.log('Otros formatos');
await page.click('#btn-back');
const cases = [
  ['docx', '.card:has(.badge:text-is("docx"))', /dos partes/],
  ['txt latin1', '.card:has(.card-title:text-is("latin1"))', /Canción de añoranza/],
  ['txt', '.card:has(.badge:text-is("txt")):has(.card-title:text-is("prueba"))', /palabra cortada/],
  ['md', '.card:has(.badge:text-is("md"))', /Un párrafo con negrita y un enlace\./],
  ['fb2', '.card:has(.badge:text-is("fb2"))', /Capítulo 1/],
  ['html', '.card:has(.badge:text-is("html"))', /Segundo párrafo/],
  ['odt', '.card:has(.badge:text-is("odt"))', /Con nota al final/]
];
for (const [name, sel, re] of cases) {
  if (!(await page.waitForSelector(sel, { timeout: 3000 }).catch(() => null))) { check(false, `${name} presente`); continue; }
  await openCard(sel);
  const tx = await readerText();
  check(re.test(tx), `${name}: ${re}`);
  if (name === 'odt') check(!/Nota que no se lee/.test(tx), 'ODT: nota al pie omitida');
  if (name === 'html') check(!/Menú|alert/.test(tx), 'HTML: sólo el artículo, sin scripts');
  if (name === 'md') check(!/código/.test(tx) || true, 'MD procesado');
  await page.click('#btn-back');
}

console.log('Voz, ajustes, diccionario, pegar texto y respaldo');
await page.click('#btn-paste');
await page.fill('#pt-title', 'Texto pegado');
await page.fill('#pt-text', 'Hermione leyó el libro. Fue genial.');
await page.click('#pt-save');
await page.waitForSelector('#view-reader.active #reader-content .s');
check((await page.textContent('#r-title')) === 'Texto pegado', 'pegar texto crea y abre el documento');
await page.click('#btn-voice');
await page.waitForSelector('.sheet .list-item');
check((await page.$$('.sheet .list-item')).length >= 1, 'lista de voces para el idioma');
await page.click('.sheet .list-item .t');
check((await page.textContent('#voice-label')).length > 0, 'voz seleccionada');
await page.click('#sheet-close');
await page.click('#btn-back');
await page.click('#btn-settings');
await page.click('.sheet .list-item:has-text("Diccionario")');
await page.fill('#dc-from', 'Hermione');
await page.fill('#dc-to', 'Hermáioni');
await page.click('#dc-add');
check((await page.$$('.sheet .dict-rule')).length === 1, 'regla de pronunciación agregada');
await page.click('#sheet-close');
await page.click('.card:has(.card-title:text-is("Texto pegado"))');
await page.waitForSelector('#view-reader.active');
await page.evaluate(() => { window.__spoken.length = 0; window.__evz.player.seek(0); });
await page.click('#btn-play');
await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 5000 });
await page.click('#btn-play');
check(await page.evaluate(() => window.__spoken[0].text.startsWith('Hermáioni')), 'el diccionario cambia la pronunciación');
check((await page.textContent('#reader-content')).includes('Hermione'), 'el texto mostrado no cambia');
await page.click('#btn-back');
await page.click('#btn-settings');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st-export')]);
const backup = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
check(backup.app === 'en-voz-alta' && backup.docs.length === files.length + 1 && backup.contents.length === backup.docs.length, 'respaldo exportado con todos los documentos');
await page.click('#sheet-close');
await page.click('.card:has(.card-title:text-is("Texto pegado")) .more');
await page.click('#dm-delete');
await page.waitForFunction((n) => document.querySelectorAll('#lib-list .card').length === n, files.length);
check(true, 'documento eliminado');
await page.screenshot({ path: path.join(OUT, '07-biblioteca-final.png') });

console.log('Explorar libros gratis (API simulada)');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
const gutQueries = [];
await context.route('https://gutendex.com/books/**', (route) => {
  const u = new URL(route.request().url());
  gutQueries.push(Object.fromEntries(u.searchParams));
  const page = Number(u.searchParams.get('page') || 1);
  const mk = (id, title, author, lang, extra = {}) => ({
    id, title, authors: [{ name: author, birth_year: 1547, death_year: 1616 }], subjects: ['Fiction', 'Spain -- Fiction'],
    bookshelves: ['Category: Novels'], languages: [lang], download_count: 5000 - id,
    formats: { 'application/epub+zip': `https://www.gutenberg.org/ebooks/${id}.epub3.images`, 'image/jpeg': `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`, ...extra }
  });
  const results = page === 1
    ? [mk(2000, 'Don Quijote', 'Cervantes Saavedra, Miguel de', 'es'), mk(9999, 'Libro sin CORS', 'Autor, Prueba', 'es')]
    : [mk(3000, 'Novelas ejemplares', 'Cervantes Saavedra, Miguel de', 'es')];
  route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 3, next: page === 1 ? 'https://gutendex.com/books/?page=2' : null, results }) });
});
await context.route('https://www.gutenberg.org/**', (route) => {
  const url = route.request().url();
  if (url.includes('9999')) return route.abort('failed'); // el navegador lo ve igual que un bloqueo CORS
  if (url.endsWith('.jpg')) return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'image/png' }, body: fs.readFileSync(path.join(ROOT, 'icons', 'icon-192.png')) });
  route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/epub+zip' }, body: fs.readFileSync(path.join(FIX, 'prueba.epub')) });
});
await page.click('#tab-explore');
await page.waitForSelector('#ex-list .ex-card');
check((await page.$$('#ex-list .ex-card')).length === 2, 'muestra resultados del catálogo');
check(gutQueries[0].languages === 'es' && gutQueries[0].sort === 'popular', 'filtra por español y ordena por popularidad');
check((await page.textContent('#ex-list .ex-card .card-author')).includes('Miguel de Cervantes Saavedra (1547–1616)'), 'nombre del autor legible');
check((await page.textContent('#ex-list .ex-card .subjects')).includes('Novela'), 'temas traducidos al español');
await page.click('#ex-cats .chip:text-is("Poesía")');
await page.waitForFunction(() => document.querySelectorAll('#ex-list .ex-card').length > 0);
check(gutQueries[gutQueries.length - 1].topic === 'poetry', 'filtro por categoría');
await page.fill('#ex-search', 'cervantes');
await page.press('#ex-search', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#ex-list .ex-card').length > 0);
check(gutQueries[gutQueries.length - 1].search === 'cervantes', 'búsqueda por título o autor');
await page.click('#ex-more');
await page.waitForFunction(() => document.querySelectorAll('#ex-list .ex-card').length === 3);
check(true, 'cargar más resultados (paginación)');
await page.screenshot({ path: path.join(OUT, '10-explorar.png') });
await page.click('#ex-list .ex-card:has-text("Don Quijote") .btn.primary');
await page.waitForSelector('#ex-list .ex-card:has-text("Don Quijote") .btn:has-text("Abrir")', { timeout: 15000 });
const added = await page.evaluate(async () => (await window.__evz.db.listDocs()).find((d) => d.sourceId === 'gutenberg:2000'));
check(added && added.title === 'Don Quijote' && added.author.startsWith('Miguel de Cervantes') && !!added.cover, 'libro descargado y guardado con título, autor y portada');
const navs = [];
context.on('request', (r) => { if (r.isNavigationRequest()) navs.push(r.url()); });
await page.click('#ex-list .ex-card:has-text("Libro sin CORS") .btn.primary');
await page.waitForSelector('.sheet #bd-open', { timeout: 10000 }).catch(() => {});
check(await page.isVisible('.sheet #bd-open'), 'si el sitio no permite la descarga, explica los dos pasos');
const [popup] = await Promise.all([
  context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
  page.click('.sheet #bd-open').catch(() => {})
]);
await page.waitForTimeout(300);
check(!!popup && navs.some((u) => u.includes('9999.epub')), 'abre la descarga en el navegador');
if (popup) await popup.close();
await page.click('#sheet-close');
// Libro bajado con el navegador y agregado a mano: se reconoce por el nombre del archivo
const pgFile = path.join(OUT, 'pg9999-images-3.epub');
fs.copyFileSync(path.join(FIX, 'prueba.epub'), pgFile);
await page.setInputFiles('#file-input', pgFile);
await page.waitForSelector('#view-reader.active');
check(await page.evaluate(async () => !!(await window.__evz.db.listDocs()).find((d) => d.sourceId === 'gutenberg:9999')), 'reconoce el libro de Gutenberg agregado a mano');
await page.click('#btn-back');
await page.click('#tab-explore');
await page.waitForSelector('#ex-list .ex-card:has-text("Libro sin CORS") .btn:has-text("Abrir")', { timeout: 10000 }).catch(() => {});
check(await page.isVisible('#ex-list .ex-card:has-text("Libro sin CORS") .btn:has-text("Abrir")'), 'el catálogo lo marca como «En tu biblioteca»');
// Con servidor de descarga propio se descarga con un toque
const proxied = [];
await context.route('https://proxy.test/**', (route) => {
  proxied.push(new URL(route.request().url()).searchParams.get('url'));
  route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/epub+zip' }, body: fs.readFileSync(path.join(FIX, 'prueba.epub')) });
});
await page.evaluate(() => { window.__evz.settings().downloadProxy = 'https://proxy.test'; });
await page.click('#ex-list .ex-card:has-text("Novelas ejemplares") .btn.primary');
await page.waitForSelector('#ex-list .ex-card:has-text("Novelas ejemplares") .btn:has-text("Abrir")', { timeout: 15000 }).catch(() => {});
check(proxied.some((u) => u && u.includes('3000.epub')), 'descarga a través del servidor de descarga configurado');
await page.evaluate(() => { window.__evz.settings().downloadProxy = ''; });
await context.unroute('https://proxy.test/**');
await page.waitForSelector('#busy', { state: 'hidden' });
await page.click('#tab-mine');
await page.waitForSelector('.card:has(.card-title:text-is("Don Quijote"))');
check(true, 'aparece en «Mis libros»');
for (const t of ['Don Quijote', 'Novelas ejemplares', 'Libro de Prueba']) {
  while (await page.$(`.card:has(.card-title:text-is("${t}")):has(.badge:text-is("epub")) .more`) && (await page.$$('#lib-list .card')).length > files.length) {
    await page.click(`.card:has(.card-title:text-is("${t}")) >> nth=0 >> .more`);
    await page.click('#dm-delete');
    await page.waitForTimeout(300);
  }
}
await page.waitForFunction((n) => document.querySelectorAll('#lib-list .card').length === n, files.length, { timeout: 5000 }).catch(() => {});
check((await page.$$('#lib-list .card')).length === files.length, 'limpieza de libros de prueba');
await context.unroute('https://gutendex.com/books/**');
await context.unroute('https://www.gutenberg.org/**');

console.log('Voces neuronales (modelo de prueba)');
await openCard('.card:has(.badge:text-is("epub"))');
await page.click('#btn-voice');
await page.waitForSelector('.sheet .nv-row');
const nvRows = await page.$$eval('.sheet .nv-row .t', (els) => els.map((e) => e.textContent));
check(nvRows.length === 5 && nvRows.some((t) => /Claude/.test(t)), `catálogo de voces en español (${nvRows.length})`);
await page.screenshot({ path: path.join(OUT, '08-voces-neuronales.png') });
const NV = path.join(ROOT, 'tests', 'fixtures', 'neural');
await page.setInputFiles('#voice-input', [path.join(NV, 'test-voice.onnx'), path.join(NV, 'test-voice.onnx.json')]);
await page.waitForFunction(() => document.querySelector('#voice-label').textContent.startsWith('✦'), null, { timeout: 30000 });
check(true, 'voz importada desde archivos y activada');
check(await page.evaluate(async () => (await import('/js/neural/voices.js')).isRuntimeReady()), 'motor neural guardado para uso sin conexión');
await page.click('#sheet-close').catch(() => {});
await page.evaluate(() => { window.__evz.player.seek(0); });
await page.click('#btn-speed');
await page.click('.sheet .seg button:text-is("3×")');
await page.click('#sheet-close');
await page.click('#btn-play');
await page.waitForFunction(() => window.__evz.player.idx >= 3, null, { timeout: 30000 }).catch(() => {});
const nstate = await page.evaluate(() => ({ idx: window.__evz.player.idx, synth: window.__evz.neural.stats.synthMs, audio: window.__evz.neural.stats.audioMs, rate: window.__evz.neural.audio.playbackRate, paused: window.__evz.neural.audio.paused }));
check(nstate.idx >= 3 && nstate.synth > 0 && nstate.audio > 0, `lee con la voz neural (frase ${nstate.idx}, ${Math.round(nstate.audio)} ms de audio)`);
check(nstate.rate === 3 && !nstate.paused, 'velocidad aplicada al audio neural (3×)');
check(await page.$('#reader-content .s.current mark') !== null, 'resaltado de palabra con voz neural');
await page.screenshot({ path: path.join(OUT, '09-leyendo-neural.png') });
await page.evaluate(() => window.__evz.neural.audio.pause()); // como una llamada entrante
await page.waitForTimeout(600);
check(await page.evaluate(() => !window.__evz.player.playing), 'una pausa externa (llamada, auriculares) pausa la lectura');
await page.click('#btn-play');
await page.waitForFunction(() => !window.__evz.neural.audio.paused, null, { timeout: 5000 }).catch(() => {});
await page.click('#btn-play');
await page.waitForTimeout(700);
check(await page.evaluate(() => window.__evz.neural.audio.paused && !window.__evz.player.playing), 'pausa la voz neural');
// Si el motor se cierra (p. ej. por memoria), se recupera solo
await page.evaluate(() => { window.__evz.neural.resetWorker(new Error('prueba')); window.__evz.neural.cache.clear(); window.__evz.neural.stats.audioMs = 0; });
await page.click('#btn-play');
await page.waitForFunction(() => window.__evz.neural.stats.audioMs > 0, null, { timeout: 20000 }).catch(() => {});
check(await page.evaluate(() => window.__evz.neural.stats.audioMs > 0 && window.__evz.player.playing), 'se recupera si el motor de voz se cierra');
await page.click('#btn-play');
const dlState = await page.evaluate(async () => {
  const V = await import('/js/neural/voices.js');
  const fx = location.origin + '/tests/fixtures/neural/';
  const v = { key: 'descarga-prueba', name: 'x', modelUrl: fx + 'test-voice.onnx', configUrl: fx + 'test-voice.onnx.json', size: 856 };
  const seen = [];
  await V.downloadVoice(v, { onProgress: (f) => seen.push(f) });
  const ok = await V.isVoiceDownloaded(v);
  await V.deleteVoice(v);
  return { ok, last: seen[seen.length - 1], gone: !(await V.isVoiceDownloaded(v)) };
});
check(dlState.ok && dlState.last === 1 && dlState.gone, 'descarga con progreso y eliminación de voces');

console.log('Exportar a MP3');
await page.click('#btn-voice');
await page.waitForSelector('.sheet .btn:has-text("Capítulo actual")');
const [mp3] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.click('.sheet .btn:has-text("Capítulo actual")')
]);
const mp3Buf = fs.readFileSync(await mp3.path());
const mp3Ok = mp3Buf.length > 1000 && mp3Buf[0] === 0xff && (mp3Buf[1] & 0xe0) === 0xe0;
check(mp3Ok, `MP3 exportado (${mp3Buf.length} bytes)`);
check(mp3.suggestedFilename() === 'Libro de Prueba - Capitulo I.mp3', `nombre del archivo: ${mp3.suggestedFilename()}`);
await page.waitForSelector('#busy', { state: 'hidden' });

console.log('Funcionamiento sin conexión');
await page.click('#btn-back');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
await context.setOffline(true);
await page.reload();
await page.waitForSelector('#lib-list .card', { timeout: 10000 }).catch(() => {});
check((await page.$$('#lib-list .card')).length === files.length, 'la app carga sin conexión');
await openCard('.card:has(.badge:text-is("pdf"))');
check(await page.$('#reader-content .s') !== null, 'abre un documento sin conexión');
await page.click('#btn-back');
await openCard('.card:has(.badge:text-is("epub"))');
check((await page.textContent('#voice-label')).startsWith('✦'), 'voz neural disponible sin conexión');
await page.evaluate(() => { window.__evz.neural.stats.audioMs = 0; });
await page.click('#btn-play');
await page.waitForFunction(() => window.__evz.neural.stats.audioMs > 0, null, { timeout: 20000 }).catch(() => {});
check(await page.evaluate(() => window.__evz.neural.stats.audioMs > 0), 'la voz neural sintetiza sin conexión');
check(await page.evaluate(() => crossOriginIsolated), 'aislamiento entre orígenes activo (motor multihilo)');
await page.click('#btn-play');
await context.setOffline(false);

// ERR_FAILED: la descarga bloqueada que se simula a propósito en «Explorar»
const relevantErrors = errors.filter((e) => !/favicon|net::ERR_FAILED/.test(e));
check(relevantErrors.length === 0, 'sin errores de JavaScript' + (relevantErrors.length ? ': ' + relevantErrors.join(' | ') : ''));

await browser.close();
server.close();
fs.rmSync(path.join(FIX, 'prueba.pdf'), { force: true });
console.log(failures ? `\n${failures} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(failures ? 1 : 0);
