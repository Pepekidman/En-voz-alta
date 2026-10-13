// Lector de PDF: extrae texto con pdf.js, reconstruye párrafos y elimina
// encabezados, pies de página y números de página.
import { cleanText, joinLines, looksLikeHeading } from '../text.js';
import { baseName } from './common.js';

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../../vendor/pdfjs/pdf.min.js').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return m;
    });
  }
  return pdfjsPromise;
}

const TERMINAL_END = /[.!?…:»"”)\]]$/;
const PAGE_NUMBER = /^(?:p[áa]g(?:ina)?\.?\s*|page\s*)?[-–—\s]*(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:\/|de|of)\s*\d{1,4})?[-–—\s]*$/i;

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function mode(arr) {
  const counts = new Map();
  let best = 0;
  let bestV = arr[0] || 0;
  for (const v of arr) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > best) { best = c; bestV = v; }
  }
  return bestV;
}

/** Agrupa los fragmentos de texto de una página en líneas. */
function itemsToLines(items) {
  const lines = [];
  let cur = null;
  const pushCur = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      lines.push(cur);
    }
    cur = null;
  };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.round(Math.hypot(c, d) || it.height || 10);
    if (!it.str) {
      if (it.hasEOL) pushCur();
      continue;
    }
    const w = it.width || 0;
    if (cur && Math.abs(y - cur.y) > Math.max(2, size * 0.5)) pushCur();
    if (!cur) {
      cur = { text: it.str, x, xEnd: x + w, y, size, sizes: [size] };
    } else {
      const gap = x - cur.xEnd;
      const needsSpace = gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
      cur.text += (needsSpace ? ' ' : '') + it.str;
      cur.xEnd = Math.max(cur.xEnd, x + w);
      cur.x = Math.min(cur.x, x);
      cur.sizes.push(size);
    }
    if (it.hasEOL) pushCur();
  }
  pushCur();
  for (const l of lines) {
    l.size = mode(l.sizes);
    delete l.sizes;
  }
  return lines;
}

function lineKey(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Marca como eliminables encabezados/pies repetidos y números de página. */
function removeRunningHeaders(pages) {
  const EDGE = 2;
  const body = mode(pages.flatMap((pg) => pg.lines.map((l) => l.size))) || 10;
  const counts = new Map();
  for (const pg of pages) {
    const byY = pg.lines.slice().sort((a, b) => b.y - a.y);
    const edges = new Set([...byY.slice(0, EDGE), ...byY.slice(-EDGE)]);
    pg.edges = edges;
    const seen = new Set();
    for (const l of edges) {
      const k = lineKey(l.text);
      if (seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  // En documentos cortos la línea debe repetirse en todas las páginas
  const minRepeat = pages.length >= 5 ? 3 : pages.length >= 2 ? pages.length : Infinity;
  for (const pg of pages) {
    pg.lines = pg.lines.filter((l) => {
      if (!pg.edges.has(l)) return true;
      const t = l.text.trim();
      if (PAGE_NUMBER.test(t)) return false;
      // Los títulos reales suelen ir en letra más grande que el cuerpo
      if (l.size >= body * 1.15) return true;
      if ((counts.get(lineKey(t)) || 0) >= minRepeat && t.length < 120) return false;
      return true;
    });
    delete pg.edges;
  }
}

/** Reconstruye párrafos a partir de las líneas de todas las páginas. */
function linesToParagraphs(pages) {
  const allSizes = [];
  for (const pg of pages) for (const l of pg.lines) allSizes.push(l.size);
  const body = mode(allSizes) || 10;

  const spacings = [];
  for (const pg of pages) {
    for (let i = 1; i < pg.lines.length; i++) {
      const a = pg.lines[i - 1];
      const b = pg.lines[i];
      const gap = a.y - b.y;
      if (gap > 0 && Math.abs(a.size - body) < 1 && Math.abs(b.size - body) < 1) spacings.push(gap);
    }
  }
  const spacing = median(spacings) || body * 1.2;

  const paragraphs = [];
  let buf = [];
  let bufPage = 1;
  let bufHeading = false;
  const flush = () => {
    if (!buf.length) return;
    const x = cleanText(joinLines(buf));
    if (x) {
      const t = bufHeading && x.length < 160 ? 'h' : looksLikeHeading(x) ? 'h' : 'p';
      paragraphs.push({ t, x, pg: bufPage });
    }
    buf = [];
    bufHeading = false;
  };

  for (const pg of pages) {
    const lines = pg.lines;
    if (!lines.length) continue;
    const left = mode(lines.map((l) => Math.round(l.x)));
    const right = Math.max(...lines.map((l) => l.xEnd));
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const prev = i > 0 ? lines[i - 1] : null;
      const isBig = l.size >= body * 1.2 && l.text.length < 120;
      let newPara = false;
      if (!buf.length) newPara = true;
      else if (isBig !== bufHeading) newPara = true;
      else if (prev) {
        const gap = prev.y - l.y;
        const prevText = prev.text;
        if (gap > spacing * 1.6) newPara = true;
        else if (l.x > left + body * 0.9 && TERMINAL_END.test(prevText) && !bufHeading) newPara = true;
        else if (prev.xEnd < right - body * 4 && TERMINAL_END.test(prevText) && !bufHeading) newPara = true;
        else if (gap < -spacing && TERMINAL_END.test(prevText)) newPara = true; // salto de columna
      } else {
        // Primera línea de la página: continúa el párrafo anterior si quedó abierto
        const last = buf[buf.length - 1] || '';
        if (TERMINAL_END.test(last.trim()) || bufHeading || isBig) newPara = true;
        else if (l.x > left + body * 0.9 && /^[\p{Lu}¿¡—«"]/u.test(l.text)) newPara = true;
      }
      if (newPara) {
        flush();
        bufPage = pg.num;
        bufHeading = isBig;
      }
      buf.push(l.text);
    }
  }
  flush();
  return paragraphs;
}

async function outlineToChapters(pdf, outline, paragraphs) {
  const chapters = [];
  const firstParaOfPage = (pageNum) => {
    for (let i = 0; i < paragraphs.length; i++) if (paragraphs[i].pg >= pageNum) return i;
    return -1;
  };
  const visit = async (items, depth) => {
    for (const item of items || []) {
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const idx = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          const p = firstParaOfPage(idx + 1);
          if (p >= 0 && item.title) chapters.push({ title: cleanText(item.title).slice(0, 90), p, depth });
        }
      } catch {
        // destino roto: se ignora
      }
      if (depth < 2 && item.items && item.items.length) await visit(item.items, depth + 1);
    }
  };
  await visit(outline, 0);
  chapters.sort((a, b) => a.p - b.p);
  return chapters;
}

async function renderCover(pdf) {
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = 240 / vp1.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await Promise.race([
      page.render({ canvas, viewport }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
    ]);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

export async function parsePdf(buffer, { name = '', onProgress, cleanup = true } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  });
  const pdf = await task.promise;
  try {
    let title = '';
    let author = '';
    let lang = null;
    try {
      const meta = await pdf.getMetadata();
      title = cleanText(meta?.info?.Title || '');
      author = cleanText(meta?.info?.Author || '');
      lang = meta?.info?.Language || null;
    } catch {}

    const pages = [];
    let chars = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const lines = itemsToLines(tc.items);
      chars += lines.reduce((n, l) => n + l.text.length, 0);
      pages.push({ num: i, lines });
      page.cleanup();
      if (onProgress) onProgress(i / pdf.numPages, `Página ${i} de ${pdf.numPages}`);
    }
    if (chars < 20 * Math.min(pdf.numPages, 5)) {
      const err = new Error('Este PDF no contiene texto seleccionable (parece escaneado como imagen). Sin OCR no se puede leer en voz alta.');
      err.code = 'NO_TEXT';
      throw err;
    }
    if (cleanup) removeRunningHeaders(pages);
    const paragraphs = linesToParagraphs(pages);

    let chapters = [];
    try {
      const outline = await pdf.getOutline();
      if (outline && outline.length) chapters = await outlineToChapters(pdf, outline, paragraphs);
    } catch {}
    if (!chapters.length) {
      paragraphs.forEach((p, i) => {
        if (p.t === 'h' && p.x.length <= 90) chapters.push({ title: p.x, p: i });
      });
      if (chapters.length > 400) chapters = [];
    }
    const cover = await renderCover(pdf);
    if (!title || /^(untitled|microsoft word|documento?\d*)/i.test(title)) title = baseName(name);
    return { title, author, lang, paragraphs, chapters, cover, pages: pdf.numPages };
  } finally {
    task.destroy();
  }
}
