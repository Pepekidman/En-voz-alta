// Project Gutenberg (más de 75.000 libros de dominio público) mediante la API
// JSON de Gutendex. Se descarga el EPUB: texto limpio y con capítulos.
import { fetchJson, fetchFile, safeName } from './net.js';

const API = 'https://gutendex.com/books/';

// Libros copiados junto a la app (GitHub Pages): se descargan con un toque.
const MIRROR = new URL('../../libros/', import.meta.url).href;
let mirrorPromise = null;
function loadMirror() {
  if (!mirrorPromise) {
    mirrorPromise = fetch(MIRROR + 'index.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => ({ books: new Set(d?.books || []), covers: new Set(d?.covers || []) }))
      .catch(() => ({ books: new Set(), covers: new Set() }));
  }
  return mirrorPromise;
}

// Categorías: el filtro "topic" de Gutendex busca en temas y estanterías de Gutenberg.
const CATEGORIES = [
  // Crecimiento personal
  ['negocios', 'Negocios y dinero', 'business'],
  ['exito', 'Éxito y motivación', 'success'],
  ['desarrollo', 'Desarrollo personal', 'conduct of life'],
  ['estoicismo', 'Estoicismo', 'stoic'],
  ['meditacion', 'Meditación y espiritualidad', 'meditat'],
  ['aprender', 'Aprender y estudiar', 'self-culture'],
  ['oratoria', 'Oratoria y comunicación', 'public speaking'],
  ['liderazgo', 'Liderazgo', 'leadership'],
  ['salud', 'Salud y bienestar', 'health'],
  // Literatura y conocimiento
  ['novela', 'Novela', 'fiction'],
  ['cuentos', 'Cuentos', 'short stories'],
  ['poesia', 'Poesía', 'poetry'],
  ['teatro', 'Teatro', 'drama'],
  ['aventuras', 'Aventuras', 'adventure'],
  ['misterio', 'Misterio y policial', 'detective'],
  ['cf', 'Ciencia ficción', 'science fiction'],
  ['fantasia', 'Fantasía', 'fantasy'],
  ['terror', 'Terror', 'horror'],
  ['romance', 'Romance', 'love stories'],
  ['infantil', 'Infantil y juvenil', 'children'],
  ['historia', 'Historia', 'history'],
  ['biografia', 'Biografías', 'biography'],
  ['filosofia', 'Filosofía', 'philosophy'],
  ['ciencia', 'Ciencia', 'science'],
  ['religion', 'Religión', 'religion'],
  ['viajes', 'Viajes', 'travel'],
  ['humor', 'Humor', 'humor'],
  ['mitologia', 'Mitología', 'mythology'],
  ['politica', 'Política y sociedad', 'political'],
  ['psicologia', 'Psicología', 'psychology'],
  ['arte', 'Arte y música', 'art']
].map(([id, label, topic]) => ({ id, label, topic }));

// Colecciones recomendadas (números de libro verificados en Project Gutenberg)
const COLLECTIONS = [
  {
    id: 'col-es', label: '★ Para crecer, en español',
    desc: 'clásicos en español sobre carácter, voluntad, criterio y superación',
    ids: [66373, 64974, 28929, 43861, 22899, 79262, 65815, 56301, 62691, 63402, 58331, 60675, 77072, 12840]
  },
  {
    id: 'col-negocios', label: '★ Negocios y dinero',
    desc: 'Wattles, Barnum, Conwell, Franklin y otros clásicos de la riqueza (en inglés)',
    ids: [59844, 8581, 368, 43855, 14418, 41510, 4286]
  },
  {
    id: 'col-mentalidad', label: '★ Éxito y mentalidad',
    desc: 'James Allen, Samuel Smiles, Arnold Bennett, Emerson y más',
    ids: [4507, 935, 2541, 2274, 12811, 75928, 33917, 21291, 21622, 2944, 74878, 148, 64974, 43861]
  },
  {
    id: 'col-estoicos', label: '★ Estoicismo',
    desc: 'Marco Aurelio, Epicteto y Séneca (en inglés)',
    ids: [2680, 45109, 10661, 64576, 56075]
  },
  {
    id: 'col-meditar', label: '★ Meditar y espiritualidad',
    desc: 'Tao Te King, El profeta, Siddhartha, Dhammapada, Bhagavad Gita y más (en inglés)',
    ids: [216, 58585, 2500, 2017, 2388, 7452, 10740, 13402, 23559, 1653, 205]
  },
  {
    id: 'col-aprender', label: '★ Aprender y concentrarse',
    desc: 'memoria, concentración, lógica y métodos de estudio',
    ids: [66373, 28929, 41478, 1570, 41838, 23347, 30309, 16287, 12840]
  },
  {
    id: 'col-liderazgo', label: '★ Liderazgo y comunicación',
    desc: 'El arte de la guerra, El príncipe, Confucio y oratoria',
    ids: [132, 1232, 3330, 16317, 22899, 77072]
  }
];
CATEGORIES.unshift(...COLLECTIONS);

const SUBJECT_ES = [
  [/success|business|wealth|money|thrift/i, 'Negocios y éxito'], [/conduct of life|self-culture|self-actualization|character/i, 'Desarrollo personal'],
  [/stoic/i, 'Estoicismo'], [/meditat|spiritual life|new thought|mysticism/i, 'Espiritualidad'], [/public speaking|oratory/i, 'Oratoria'],
  [/leadership/i, 'Liderazgo'], [/health|hygiene/i, 'Salud'],
  [/fiction/i, 'Novela'], [/short stories/i, 'Cuentos'], [/poetry/i, 'Poesía'], [/drama/i, 'Teatro'],
  [/adventure/i, 'Aventuras'], [/detective|mystery/i, 'Misterio'], [/science fiction/i, 'Ciencia ficción'],
  [/fantasy/i, 'Fantasía'], [/horror|ghost/i, 'Terror'], [/love stories|romance/i, 'Romance'],
  [/juvenile|children/i, 'Infantil y juvenil'], [/history/i, 'Historia'], [/biography/i, 'Biografía'],
  [/philosophy/i, 'Filosofía'], [/religio|bible|christian/i, 'Religión'], [/travel|voyages/i, 'Viajes'],
  [/humor|satire/i, 'Humor'], [/mytholog/i, 'Mitología'], [/essays?\b/i, 'Ensayo'], [/war\b/i, 'Guerra']
];

function translateSubjects(subjects, shelves) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(shelves || []), ...(subjects || [])]) {
    const s = raw.replace(/^Category:\s*/i, '');
    for (const [re, es] of SUBJECT_ES) {
      if (re.test(s) && !seen.has(es)) { seen.add(es); out.push(es); }
    }
  }
  return out;
}

function personName(a) {
  // "Cervantes Saavedra, Miguel de" → "Miguel de Cervantes Saavedra"
  const parts = a.name.split(', ');
  const name = parts.length === 2 ? `${parts[1]} ${parts[0]}` : a.name;
  const years = a.birth_year || a.death_year ? ` (${a.birth_year ?? '?'}–${a.death_year ?? '?'})` : '';
  return name + years;
}

function pickFile(formats) {
  const keys = Object.keys(formats);
  const find = (re) => keys.find((k) => re.test(k) && !/\.zip$/i.test(formats[k]));
  const epub = find(/^application\/epub\+zip/);
  if (epub) return { url: formats[epub], format: 'epub', ext: 'epub', type: 'application/epub+zip' };
  const txt = find(/^text\/plain/);
  if (txt) return { url: formats[txt], format: 'txt', ext: 'txt', type: 'text/plain' };
  const html = find(/^text\/html/);
  if (html) return { url: formats[html], format: 'html', ext: 'html', type: 'text/html' };
  return null;
}

function toBook(r, mirror) {
  const file = pickFile(r.formats || {});
  if (!file) return null;
  const mirrored = mirror && mirror.books.has(r.id);
  return {
    mirrored,
    mirrorUrl: mirrored ? `${MIRROR}pg${r.id}.epub` : null,
    source: 'gutenberg',
    id: String(r.id),
    title: r.title.replace(/\s*\$[a-z]\s*/g, ' ').replace(/\s+/g, ' ').trim(),
    authors: (r.authors || []).map(personName),
    authorQuery: r.authors && r.authors[0] ? r.authors[0].name.split(',')[0] : '',
    lang: (r.languages || [])[0] || '',
    subjects: translateSubjects(r.subjects, r.bookshelves),
    downloads: r.download_count || 0,
    cover: mirror && mirror.covers.has(r.id) ? `${MIRROR}pg${r.id}.jpg` : (r.formats?.['image/jpeg'] || null),
    format: file.format,
    fileUrl: file.url,
    fileType: file.type,
    fileExt: file.ext,
    pageUrl: `https://www.gutenberg.org/ebooks/${r.id}`
  };
}

export const gutenberg = {
  id: 'gutenberg',
  name: 'Project Gutenberg',
  note: 'Más de 75.000 libros clásicos de dominio público, gratis y legales. Se descargan en EPUB, el mejor formato para escuchar.',
  categories: CATEGORIES,
  emptyHelp: `<b>¿Buscas un autor actual?</b> Project Gutenberg sólo tiene libros de <b>dominio público</b>: obras antiguas, en general de autores fallecidos hace más de 70 años. Autores como Brian Tracy, Isaac Asimov o Robert Kiyosaki tienen derechos de autor vigentes y no se pueden descargar gratis de forma legal.
    <br><br>Si compraste el libro en PDF o EPUB <i>sin DRM</i>, agrégalo con <button class="linklike" data-action="add-file">Agregar archivo</button>. También puedes probar con clásicos del mismo tema en las categorías de arriba (Negocios, Éxito, Estoicismo…).`,
  sorts: [
    { id: 'popular', label: 'Más populares' },
    { id: 'descending', label: 'Agregados recientemente' },
    { id: 'ascending', label: 'Más antiguos en el catálogo' }
  ],
  async search({ q, lang, cat, sort, page = 1, signal }) {
    const p = new URLSearchParams();
    const c = CATEGORIES.find((x) => x.id === cat);
    if (c && c.ids) {
      // Colección elegida a mano: se muestran todos sus libros, en cualquier idioma
      p.set('ids', c.ids.join(','));
    } else {
      if (q) p.set('search', q);
      if (lang) p.set('languages', lang);
      if (c) p.set('topic', c.topic);
      p.set('mime_type', 'application/epub');
    }
    if (sort) p.set('sort', sort);
    if (page > 1) p.set('page', String(page));
    const [data, mirror] = await Promise.all([fetchJson(`${API}?${p}`, { signal }), loadMirror()]);
    let items = (data.results || []).map((r) => toBook(r, mirror)).filter(Boolean);
    if (c && c.ids) items = items.sort((a, b) => (b.lang === 'es') - (a.lang === 'es'));
    return { items, total: data.count || 0, next: data.next ? page + 1 : null, collection: !!(c && c.ids) };
  },
  viaProxy(url, proxy) {
    return `${proxy.replace(/\/+$/, '')}/?url=${encodeURIComponent(url)}`;
  },
  async download(b, { signal, onProgress, proxy } = {}) {
    if (b.mirrored) {
      return fetchFile(b.mirrorUrl, { name: `pg${b.id} ${safeName(b.title)}.epub`, type: 'application/epub+zip', signal, onProgress });
    }
    const url = proxy ? this.viaProxy(b.fileUrl, proxy) : b.fileUrl;
    return fetchFile(url, { name: `pg${b.id} ${safeName(b.title)}.${b.fileExt}`, type: b.fileType, signal, onProgress });
  },
  canDownloadDirect(b, proxy) {
    return !!(b.mirrored || proxy);
  }
};
