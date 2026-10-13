// Procesamiento de texto: limpieza, segmentación en frases y preparación
// del texto hablado para que la puntuación produzca pausas naturales.

// Abreviaturas que NO terminan una frase (en minúsculas, sin el punto final).
const ABBREVIATIONS = new Set([
  // Español
  'sr', 'sra', 'srta', 'sres', 'sras', 'dr', 'dra', 'drs', 'lic', 'ing', 'arq', 'prof', 'profa',
  'ud', 'uds', 'vd', 'vds', 'dña', 'sto', 'sta', 'fr', 'mons', 'gral', 'cnel', 'tte',
  'pág', 'págs', 'pag', 'pags', 'pp', 'núm', 'nro', 'vol', 'vols', 'cap', 'caps',
  'arts', 'fig', 'figs', 'ej', 'etc', 'aprox', 'av', 'avda', 'cía', 'cia', 'admón',
  'dpto', 'depto', 'tel', 'telf', 'eds', 'op', 'cit', 'ib', 'ibíd', 'ibid', 'cf', 'cfr',
  'vs', 'ss', 'sig', 'sigs', 'máx', 'mín', 'ee', 'uu', 'esq', 'gob', 'lda', 'ltda', 'mtro', 'mtra',
  // Inglés
  'mr', 'mrs', 'ms', 'jr', 'st', 'mt', 'ft', 'approx', 'dept', 'inc', 'ltd', 'corp'
]);

// Sólo cuentan como abreviatura si les sigue un número («art. 5», «No. 3»).
const REF_ABBREVIATIONS = new Set(['art', 'no', 'n', 'p', 'c', 'núm', 'num', 'nro', 'pág', 'pag', 'cap', 'vol', 'fig', 't', 'ed', 'sec', 'párr', 'apdo', 'inc', 'lib', 'tomo', 'ch', 'vv', 'v']);

const TERMINALS = '.!?…';
const CLOSERS = '"\'”’»)]}';
const OPENERS = '"\'“‘«([{¿¡—–-';

const LETTER = /\p{L}/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;

/** Limpia caracteres invisibles, ligaduras y espacios. */
export function cleanText(s) {
  return s
    .replace(/­/g, '') // guion suave
    .replace(/[​-‍﻿⁠]/g, '')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ|ﬆ/g, 'st')
    .replace(/[  -   　\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Une líneas de un texto con cortes de línea "duros" (PDF, TXT de Gutenberg):
 * elimina guiones de corte de palabra y une con espacio.
 */
export function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) { out = line; continue; }
    const prev = out[out.length - 1];
    const beforePrev = out[out.length - 2] || '';
    const first = line[0];
    if ((prev === '-' || prev === '‐') && LETTER.test(beforePrev) && LOWER.test(first)) {
      out = out.slice(0, -1) + line; // pala- bra → palabra
    } else {
      out += ' ' + line;
    }
  }
  return out;
}

function wordBefore(text, dotIndex) {
  let i = dotIndex - 1;
  while (i >= 0 && LETTER.test(text[i])) i--;
  return text.slice(i + 1, dotIndex);
}

function isAbbreviation(text, dotIndex) {
  // Palabra inmediatamente antes del punto
  let i = dotIndex - 1;
  while (i >= 0 && LETTER.test(text[i])) i--;
  const word = text.slice(i + 1, dotIndex);
  if (!word) return false;
  // Iniciales: "J. R. R. Tolkien", "EE.UU."
  if (word.length === 1 && UPPER.test(word)) return true;
  // Abreviaturas con puntos internos: "p.ej", "a.C", "EE.UU"
  if (i >= 0 && text[i] === '.' && word.length <= 3) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Segmenta un párrafo en frases. Devuelve [{s, e}] con índices sobre `text`.
 */
export function splitSentences(text) {
  const out = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (TERMINALS.includes(ch)) {
      let j = i;
      while (j < n && TERMINALS.includes(text[j])) j++;
      while (j < n && CLOSERS.includes(text[j])) j++;
      // Debe venir un espacio (o fin) para considerar corte
      if (j < n && text[j] !== ' ') { i = j; continue; }
      let k = j;
      while (k < n && text[k] === ' ') k++;
      if (k >= n) break; // fin del párrafo
      // Saltar signos de apertura para ver la primera letra/dígito siguiente
      let m = k;
      while (m < n && OPENERS.includes(text[m])) m++;
      const next = text[m] || '';
      const single = j - i === 1 && ch === '.';
      let split = true;
      if (LOWER.test(next)) split = false; // "¿Vienes? —preguntó"
      else if (single && isAbbreviation(text, i)) split = false;
      // «art. 5», «pág. 23», «No. 3»: abreviatura de referencia seguida de número
      else if (single && /\d/.test(next) && REF_ABBREVIATIONS.has(wordBefore(text, i).toLowerCase())) split = false;
      else if (single && /\d/.test(text[i - 1] || '') && /\d/.test(next) ) split = false;
      if (split) {
        out.push({ s: start, e: j });
        start = k;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < n) {
    const tail = text.slice(start).trim();
    if (tail) out.push({ s: start, e: n });
  }
  return mergeTiny(text, out);
}

// Une fragmentos muy cortos ("I.", "1.") con la frase siguiente para evitar
// pausas artificiales.
function mergeTiny(text, parts) {
  if (parts.length < 2) return parts;
  const merged = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const t = text.slice(p.s, p.e).trim();
    if (t.length <= 3 && i + 1 < parts.length && !/[!?…]/.test(t)) {
      parts[i + 1] = { s: p.s, e: parts[i + 1].e };
      continue;
    }
    merged.push(p);
  }
  return merged;
}

/**
 * Divide un texto largo en trozos de como máximo `max` caracteres, cortando
 * preferentemente en puntuación interna y luego en espacios. Devuelve [{s, e}].
 */
export function splitLong(text, max = 220) {
  if (text.length <= max) return [{ s: 0, e: text.length }];
  const out = [];
  let start = 0;
  while (text.length - start > max) {
    const windowEnd = start + max;
    let cut = -1;
    for (const re of [/[;:]\s/g, /[,—–)]\s/g, /\s(?=y |e |o |u |pero |que |and |or |but )/g, /\s/g]) {
      re.lastIndex = start + Math.floor(max * 0.4);
      let m;
      let best = -1;
      while ((m = re.exec(text)) && m.index < windowEnd) best = m.index + m[0].length;
      if (best > start) { cut = best; break; }
    }
    if (cut <= start) cut = windowEnd;
    out.push({ s: start, e: cut });
    start = cut;
  }
  out.push({ s: start, e: text.length });
  return out;
}

// ---------------------------------------------------------------------------
// Texto hablado

const EXPANSIONS = {
  es: [
    ['Sr.', 'señor'], ['Sra.', 'señora'], ['Srta.', 'señorita'], ['Sres.', 'señores'], ['Sras.', 'señoras'],
    ['Dr.', 'doctor'], ['Dra.', 'doctora'], ['Lic.', 'licenciado'], ['Ing.', 'ingeniero'], ['Prof.', 'profesor'],
    ['Ud.', 'usted'], ['Uds.', 'ustedes'], ['Vd.', 'usted'], ['Vds.', 'ustedes'], ['Dña.', 'doña'],
    ['Sto.', 'santo'], ['Sta.', 'santa'], ['Gral.', 'general'], ['Av.', 'avenida'], ['Avda.', 'avenida'],
    ['pág.', 'página'], ['págs.', 'páginas'], ['p. ej.', 'por ejemplo'], ['p.ej.', 'por ejemplo'],
    ['etc.', 'etcétera'], ['aprox.', 'aproximadamente'], ['núm.', 'número'], ['n.º', 'número'],
    ['nº', 'número'], ['Nº', 'número'], ['N.º', 'número'], ['cap.', 'capítulo'], ['vol.', 'volumen'],
    ['fig.', 'figura'], ['art.', 'artículo'], ['tel.', 'teléfono'], ['EE. UU.', 'Estados Unidos'],
    ['EE.UU.', 'Estados Unidos'], ['a. C.', 'antes de Cristo'], ['a.C.', 'antes de Cristo'],
    ['d. C.', 'después de Cristo'], ['d.C.', 'después de Cristo'], ['vs.', 'versus'], ['cf.', 'compárese'],
    ['ej.', 'ejemplo'], ['máx.', 'máximo'], ['mín.', 'mínimo'], ['S. XX', 'siglo XX']
  ],
  en: [
    ['Mr.', 'Mister'], ['Mrs.', 'Missus'], ['Ms.', 'Miz'], ['Dr.', 'Doctor'], ['St.', 'Saint'],
    ['Prof.', 'Professor'], ['e.g.', 'for example'], ['i.e.', 'that is'], ['etc.', 'et cetera'],
    ['vs.', 'versus'], ['approx.', 'approximately'], ['vol.', 'volume'],
    ['fig.', 'figure'], ['pp.', 'pages'], ['U.S.', 'U S'], ['Jr.', 'Junior']
  ],
  pt: [
    ['Sr.', 'senhor'], ['Sra.', 'senhora'], ['Dr.', 'doutor'], ['Dra.', 'doutora'], ['pág.', 'página'],
    ['etc.', 'etcétera'], ['p. ex.', 'por exemplo'], ['nº', 'número'], ['V. Sa.', 'Vossa Senhoria']
  ]
};

const ROMAN_KEYWORDS = /(cap[ií]tulo|parte|libro|tomo|volumen|siglo|acto|escena|canto|secci[oó]n|lecci[oó]n|chapter|part|book|volume|century|act|scene|section|lesson|cap[ií]tulo)\s+([IVXLCDM]+)\b/giu;

export function romanToInt(s) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const up = s.toUpperCase();
  if (!/^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(up) || !up) return null;
  let total = 0;
  for (let i = 0; i < up.length; i++) {
    const v = map[up[i]];
    const nx = map[up[i + 1]] || 0;
    total += v < nx ? -v : v;
  }
  return total;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const expansionCache = new Map();
function expansionRules(lang) {
  const key = (lang || 'es').slice(0, 2);
  if (expansionCache.has(key)) return expansionCache.get(key);
  const list = EXPANSIONS[key] || [];
  const rules = list
    .slice()
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => {
      const caseSensitive = /^[A-Z]/.test(from) && from.length <= 4;
      return [new RegExp('(?<![\\p{L}\\p{N}.])' + escapeRe(from) + '(?![\\p{L}\\p{N}])', caseSensitive ? 'gu' : 'giu'), to];
    });
  expansionCache.set(key, rules);
  return rules;
}

/**
 * Compila las reglas del diccionario de pronunciación del usuario.
 * Cada regla: { from, to, regex?: boolean, caseSensitive?: boolean, enabled?: boolean }
 */
export function compileDictionary(rules = []) {
  const out = [];
  for (const r of rules) {
    if (!r || r.enabled === false || !r.from) continue;
    try {
      const flags = 'gu' + (r.caseSensitive ? '' : 'i');
      const re = r.regex
        ? new RegExp(r.from, flags)
        : new RegExp('(?<![\\p{L}\\p{N}])' + escapeRe(r.from) + '(?![\\p{L}\\p{N}])', flags);
      out.push([re, r.to ?? '']);
    } catch {
      // regla inválida: se ignora
    }
  }
  return out;
}

/**
 * Convierte el texto mostrado en el texto que se envía al sintetizador.
 * opts: { lang, dict (compilado), expandAbbr, skipRefs, skipUrls, heading }
 */
export function toSpeech(text, opts = {}) {
  const lang = (opts.lang || 'es').slice(0, 2);
  let s = text;

  if (opts.dict) for (const [re, to] of opts.dict) s = s.replace(re, to);

  if (opts.skipRefs !== false) {
    s = s.replace(/\[(\d{1,3}|[a-z]|\*)\]/g, '');
    s = s.replace(/(?<=\p{L}[.,;:!?»”"]?)[¹²³⁴⁵⁶⁷⁸⁹⁰]+/gu, '');
  }
  if (opts.skipUrls !== false) {
    const word = lang === 'en' ? 'link' : 'enlace';
    s = s.replace(/\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi, word);
  }
  if (opts.expandAbbr !== false) {
    for (const [re, to] of expansionRules(lang)) s = s.replace(re, to);
  }

  // Números romanos tras palabras clave: "Capítulo IV" → "Capítulo 4"
  s = s.replace(ROMAN_KEYWORDS, (m, kw, rn, offset, whole) => {
    if (rn !== rn.toUpperCase()) return m; // «parte mi padre» no es un número
    if (rn === 'I' && /^\s+\p{Ll}/u.test(whole.slice(offset + m.length))) return m; // «part I think»
    const v = romanToInt(rn);
    return v ? `${kw} ${v}` : m;
  });
  if (opts.heading) {
    const only = s.trim().replace(/[.:]$/, '');
    const v = only === only.toUpperCase() ? romanToInt(only) : null;
    if (v && only.length <= 8) s = String(v);
  }

  // Rayas de diálogo e incisos → pausas
  s = s.replace(/^\s*[—―–]\s*/, '');
  s = s.replace(/\s*[—―]\s*/g, ', ');
  s = s.replace(/\s+[–-]{1,2}\s+/g, ', ');
  // Paréntesis y corchetes → pausas breves
  s = s.replace(/\s*[([]\s*/g, ', ').replace(/\s*[)\]]\s*/g, ', ');
  // Comillas: no aportan pausa y algunos motores las leen
  s = s.replace(/[«»“”„"]/g, '').replace(/(^|[\s(])[‘'](?=\p{L})/gu, '$1').replace(/(?<=\p{L})[’'](?=[\s.,;:!?]|$)/gu, '');
  // Símbolos que algunos motores pronuncian literalmente
  s = s.replace(/[*_#~|•·▪►■□●◦^=<>]+/g, ' ');
  s = s.replace(/\s&\s/g, lang === 'en' ? ' and ' : lang === 'pt' ? ' e ' : ' y ');
  // Puntos suspensivos normalizados
  s = s.replace(/\.{3,}/g, '…');

  // Limpieza de comas y espacios redundantes
  s = s.replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/,\s*([.!?…])/g, '$1')
    .replace(/([.!?…])\s*,/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .replace(/[\s,;:]+$/, (m) => (m.includes(':') ? ':' : ''))
    .trim();
  return s;
}

// ---------------------------------------------------------------------------
// Detección de idioma por palabras vacías

const STOPWORDS = {
  es: 'el los las del y por con una para es al lo como más pero sus le ya este porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante uno les ni contra ese eso ante ellos esto él ella yo había fue ser estaba dijo así qué',
  en: 'the of and to in is that it was for on are with as his they be at have this from or had by not but what all were we when your can said there an which she do how their if will up other about out then them these so some her would him into has more no could my than been who its now',
  pt: 'não uma os do da em com mais as dos ao ele das tem à seu sua ou quando muito há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas esse eles você foram essa nem suas meu minha',
  fr: 'le et les des un du une est pour qui dans par plus pas au sur ne ce il sont avec son elle nous vous mais ou leur cette été être fait comme tout',
  it: 'il che è per non sono con gli alla della delle anche come questo più nel loro ma era hanno sua suo essere quando molto degli',
  de: 'der die und den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei'
};
const STOP_SETS = Object.fromEntries(
  Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))])
);

export function detectLanguage(sample) {
  const words = sample.toLowerCase().slice(0, 20000).match(/\p{L}+/gu) || [];
  if (words.length < 5) return null;
  const scores = {};
  for (const k of Object.keys(STOP_SETS)) scores[k] = 0;
  for (const w of words) for (const k in STOP_SETS) if (STOP_SETS[k].has(w)) scores[k]++;
  let best = null;
  let bestScore = 0;
  for (const k in scores) if (scores[k] > bestScore) { best = k; bestScore = scores[k]; }
  return bestScore >= 3 ? best : null;
}

// ---------------------------------------------------------------------------
// Utilidades de párrafos

const HEADING_RE = /^(cap[ií]tulo|chapter|parte|part|libro|book|pr[oó]logo|prologue|ep[ií]logo|epilogue|introducci[oó]n|introduction|prefacio|preface|pref[aá]cio|ap[eé]ndice|appendix|conclusi[oó]n|conclusion|[ií]ndice|contents)\b[\s\p{L}\p{N}.:,'-]{0,60}$/iu;

/** ¿Parece un título (capítulo, prólogo, número romano solo...)? */
export function looksLikeHeading(line) {
  const t = line.trim();
  if (!t || t.length > 70) return false;
  if (HEADING_RE.test(t)) return true;
  if (/^[IVXLCDM]{1,7}\.?$/.test(t) && romanToInt(t.replace('.', ''))) return true;
  if (/^\d{1,3}\.?$/.test(t)) return false; // probablemente número de página
  return false;
}

/** Convierte texto plano en párrafos [{t:'p'|'h', x}]. */
export function textToParagraphs(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const out = [];
  const push = (x, t = 'p') => {
    const c = cleanText(x);
    if (c) out.push({ t, x: c });
  };

  // ¿Texto con cortes de línea "duros"? (las líneas terminan a mitad de frase)
  let pairs = 0;
  let open = 0;
  let blanks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) { blanks++; continue; }
    if (i + 1 < lines.length && lines[i + 1].trim()) {
      pairs++;
      if (!/[.!?…:;»"”)\]]$/.test(lines[i]) && !looksLikeHeading(lines[i])) open++;
    }
  }
  const wrapped = pairs > 0 && open / pairs > 0.4;

  if (!wrapped) {
    // Cada línea es un párrafo
    for (const l of lines) if (l.trim()) push(l, looksLikeHeading(l) ? 'h' : 'p');
    return out;
  }

  if (blanks > 0) {
    // Párrafos separados por líneas en blanco
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      if (buf.length <= 2 && buf.every((l) => looksLikeHeading(l))) push(buf.join(' '), 'h');
      else push(joinLines(buf));
      buf = [];
    };
    for (const l of lines) {
      if (!l.trim()) flush();
      else buf.push(l);
    }
    flush();
    return out;
  }

  // Cortes duros sin líneas en blanco: nuevo párrafo tras una línea corta
  // que termina en punto, o ante una línea con sangría.
  const lens = lines.map((l) => l.trim().length).sort((a, b) => a - b);
  const typical = lens[Math.floor(lens.length * 0.75)] || 60;
  let buf = [];
  const flush = () => { if (buf.length) push(joinLines(buf)); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (looksLikeHeading(l)) { flush(); push(l, 'h'); continue; }
    const prev = buf[buf.length - 1];
    if (prev && (/^\s{2,}|^\t/.test(l) || (/[.!?…:»"”]$/.test(prev) && prev.trim().length < typical * 0.8))) flush();
    buf.push(l);
  }
  flush();
  return out;
}

/** Capítulos a partir de los títulos detectados. */
export function chaptersFromHeadings(paragraphs) {
  const chapters = [];
  paragraphs.forEach((p, i) => {
    if (p.t === 'h') chapters.push({ title: p.x.slice(0, 80), p: i });
  });
  return chapters;
}

/** Escapa HTML para inserción segura. */
export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Limpieza de libros de Project Gutenberg

const PG_START = /\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG/i;
const PG_END = /\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG|^End of (the )?Project Gutenberg'?s?\b/i;
const PG_CREDITS = /^(produced by|this e-?book was produced by|e-?text prepared by|updated editions will replace|an anonymous volunteer)/i;

/**
 * Quita el encabezado y la licencia de Project Gutenberg (en inglés) para que
 * no se lean en voz alta. Ajusta los índices de capítulos.
 */
export function stripGutenbergBoilerplate(paragraphs, chapters = []) {
  const n = paragraphs.length;
  let start = -1;
  for (let i = 0; i < Math.min(n, Math.max(60, Math.floor(n * 0.25))); i++) {
    if (PG_START.test(paragraphs[i].x)) { start = i; break; }
  }
  let end = n;
  for (let i = n - 1; i >= Math.floor(n * 0.6); i--) {
    if (PG_END.test(paragraphs[i].x)) end = i;
  }
  if (start < 0 && end === n) return { paragraphs, chapters };
  let from = start + 1;
  while (from < end && from <= start + 6 && PG_CREDITS.test(paragraphs[from].x)) from++;
  const kept = paragraphs.slice(from, end);
  if (kept.length < 3) return { paragraphs, chapters };
  const outChapters = chapters
    .map((c) => ({ ...c, p: c.p - from }))
    .filter((c) => c.p >= 0 && c.p < kept.length);
  return { paragraphs: kept, chapters: outChapters };
}
