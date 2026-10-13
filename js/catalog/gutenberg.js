// Project Gutenberg (más de 75.000 libros de dominio público) mediante la API
// JSON de Gutendex. Se descarga el EPUB: texto limpio y con capítulos.
import { fetchJson, fetchFile, safeName } from './net.js';

const API = 'https://gutendex.com/books/';

// Categorías: el filtro "topic" de Gutendex busca en temas y estanterías de Gutenberg.
const CATEGORIES = [
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

const SUBJECT_ES = [
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

function toBook(r) {
  const file = pickFile(r.formats || {});
  if (!file) return null;
  return {
    source: 'gutenberg',
    id: String(r.id),
    title: r.title.replace(/\s*\$[a-z]\s*/g, ' ').replace(/\s+/g, ' ').trim(),
    authors: (r.authors || []).map(personName),
    authorQuery: r.authors && r.authors[0] ? r.authors[0].name.split(',')[0] : '',
    lang: (r.languages || [])[0] || '',
    subjects: translateSubjects(r.subjects, r.bookshelves),
    downloads: r.download_count || 0,
    cover: r.formats?.['image/jpeg'] || null,
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
  sorts: [
    { id: 'popular', label: 'Más populares' },
    { id: 'descending', label: 'Agregados recientemente' },
    { id: 'ascending', label: 'Más antiguos en el catálogo' }
  ],
  async search({ q, lang, cat, sort, page = 1, signal }) {
    const p = new URLSearchParams();
    if (q) p.set('search', q);
    if (lang) p.set('languages', lang);
    const c = CATEGORIES.find((x) => x.id === cat);
    if (c) p.set('topic', c.topic);
    if (sort) p.set('sort', sort);
    if (page > 1) p.set('page', String(page));
    p.set('mime_type', 'application/epub');
    const data = await fetchJson(`${API}?${p}`, { signal });
    const items = (data.results || []).map(toBook).filter(Boolean);
    return { items, total: data.count || 0, next: data.next ? page + 1 : null };
  },
  viaProxy(url, proxy) {
    return `${proxy.replace(/\/+$/, '')}/?url=${encodeURIComponent(url)}`;
  },
  async download(b, { signal, onProgress, proxy } = {}) {
    const url = proxy ? this.viaProxy(b.fileUrl, proxy) : b.fileUrl;
    return fetchFile(url, { name: `pg${b.id} ${safeName(b.title)}.${b.fileExt}`, type: b.fileType, signal, onProgress });
  }
};
