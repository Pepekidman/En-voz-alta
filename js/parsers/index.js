// Punto de entrada de los lectores de formatos. Cada lector devuelve
// { title, author, lang, paragraphs: [{t, x, pg?}], chapters: [{title, p, depth?}], cover? }
import { cleanText, textToParagraphs, chaptersFromHeadings, detectLanguage, stripGutenbergBoilerplate } from '../text.js';
import { domToParagraphs, decodeText, parseXml, loadJSZip, makeThumbnail, baseName, resolvePath } from './common.js';

export const ACCEPT = '.txt,.text,.md,.markdown,.pdf,.epub,.docx,.odt,.html,.htm,.xhtml,.fb2,.rtf,text/plain,application/pdf,application/epub+zip';

export function detectFormat(name, type = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'epub' || type === 'application/epub+zip') return 'epub';
  if (ext === 'docx') return 'docx';
  if (ext === 'odt') return 'odt';
  if (ext === 'fb2') return 'fb2';
  if (ext === 'rtf' || type === 'application/rtf') return 'rtf';
  if (['html', 'htm', 'xhtml'].includes(ext) || type === 'text/html') return 'html';
  if (['md', 'markdown'].includes(ext) || type === 'text/markdown') return 'md';
  if (['txt', 'text'].includes(ext) || type.startsWith('text/')) return 'txt';
  return null;
}

function firstByTag(doc, name) {
  const el = doc.getElementsByTagNameNS('*', name)[0] || doc.getElementsByTagName(name)[0];
  return el ? cleanText(el.textContent || '') : '';
}

// ---------------------------------------------------------------- EPUB
async function parseEpub(buffer, { onProgress }) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);
  const read = async (path) => {
    const f = zip.file(path) || zip.file(decodeURIComponent(path));
    return f ? f.async('string') : null;
  };
  const container = await read('META-INF/container.xml');
  if (!container) throw new Error('EPUB inválido: falta META-INF/container.xml');
  const rootfile = parseXml(container).getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  const opf = parseXml(await read(opfPath));

  const title = firstByTag(opf, 'title');
  const author = firstByTag(opf, 'creator');
  const lang = firstByTag(opf, 'language') || null;

  const manifest = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) {
    manifest.set(it.getAttribute('id'), {
      href: resolvePath(opfPath, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || ''
    });
  }
  const spineEl = opf.getElementsByTagNameNS('*', 'spine')[0];
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')]
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((m) => m && /html|xml/.test(m.type));

  const paragraphs = [];
  const fileStart = new Map();
  const anchors = new Map();
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    const html = await read(item.href);
    if (onProgress) onProgress((i + 1) / spine.length, `Sección ${i + 1} de ${spine.length}`);
    if (!html) continue;
    const doc = parseXml(html, 'application/xhtml+xml');
    const body = doc.body || doc.getElementsByTagNameNS('*', 'body')[0];
    if (!body) continue;
    fileStart.set(item.href, paragraphs.length);
    domToParagraphs(body, {
      out: paragraphs,
      onAnchor: (id, idx) => anchors.set(item.href + '#' + id, idx)
    });
  }

  // Índice: EPUB3 nav o EPUB2 NCX
  const toc = [];
  const locate = (base, href) => {
    const [file, frag] = href.split('#');
    const path = resolvePath(base, file || base.split('/').pop());
    const key = frag ? path + '#' + decodeURIComponent(frag) : null;
    if (key && anchors.has(key)) return anchors.get(key);
    if (fileStart.has(path)) return fileStart.get(path);
    return -1;
  };
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  if (navItem) {
    const nav = parseXml(await read(navItem.href) || '', 'application/xhtml+xml');
    const navs = [...nav.getElementsByTagNameNS('*', 'nav')];
    const tocNav = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navs[0];
    if (tocNav) {
      const walk = (ol, depth) => {
        for (const li of ol.children) {
          const a = [...li.children].find((c) => /^(a|span)$/i.test(c.localName));
          const href = a && a.getAttribute('href');
          if (a && href) {
            const p = locate(navItem.href, href);
            const t = cleanText(a.textContent || '');
            if (p >= 0 && t) toc.push({ title: t.slice(0, 90), p, depth });
          }
          const sub = [...li.children].find((c) => /^ol$/i.test(c.localName));
          if (sub && depth < 2) walk(sub, depth + 1);
        }
      };
      const ol = [...tocNav.children].find((c) => /^ol$/i.test(c.localName));
      if (ol) walk(ol, 0);
    }
  }
  if (!toc.length) {
    const ncxId = spineEl && spineEl.getAttribute('toc');
    const ncxItem = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => /ncx/.test(m.type));
    if (ncxItem) {
      const ncx = parseXml(await read(ncxItem.href) || '');
      const walk = (parent, depth) => {
        for (const np of parent.children) {
          if (np.localName !== 'navPoint') continue;
          const label = np.getElementsByTagNameNS('*', 'text')[0];
          const content = np.getElementsByTagNameNS('*', 'content')[0];
          const href = content && content.getAttribute('src');
          if (label && href) {
            const p = locate(ncxItem.href, href);
            if (p >= 0) toc.push({ title: cleanText(label.textContent).slice(0, 90), p, depth });
          }
          if (depth < 2) walk(np, depth + 1);
        }
      };
      const navMap = ncx.getElementsByTagNameNS('*', 'navMap')[0];
      if (navMap) walk(navMap, 0);
    }
  }
  toc.sort((a, b) => a.p - b.p);

  // Portada
  let cover = null;
  try {
    let coverItem = [...manifest.values()].find((m) => /cover-image/.test(m.props));
    if (!coverItem) {
      const meta = [...opf.getElementsByTagNameNS('*', 'meta')].find((m) => m.getAttribute('name') === 'cover');
      if (meta) coverItem = manifest.get(meta.getAttribute('content'));
    }
    if (coverItem && /image/.test(coverItem.type)) {
      const blob = await zip.file(coverItem.href)?.async('blob');
      if (blob) cover = await makeThumbnail(new Blob([blob], { type: coverItem.type }));
    }
  } catch {}

  return { title, author, lang, paragraphs, chapters: toc.length ? toc : chaptersFromHeadings(paragraphs), cover };
}

// ---------------------------------------------------------------- DOCX
async function parseDocx(buffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('DOCX inválido: falta word/document.xml');
  const doc = parseXml(xml);
  const paragraphs = [];
  for (const p of doc.getElementsByTagName('w:p')) {
    let text = '';
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const name = c.nodeName;
        if (name === 'w:t') text += c.textContent;
        else if (name === 'w:tab' || name === 'w:br' || name === 'w:cr') text += ' ';
        else if (name === 'w:p') continue; // párrafos anidados se procesan aparte
        else if (name === 'w:footnoteReference' || name === 'w:endnoteReference') continue;
        else if (name !== 'w:instrText' && name !== 'w:delText') walk(c);
      }
    };
    walk(p);
    const x = cleanText(text);
    if (!x) continue;
    const style = p.getElementsByTagName('w:pStyle')[0];
    const val = (style && style.getAttribute('w:val')) || '';
    const t = /heading|t[ií]tulo|title|encabezado|ttulo/i.test(val) && x.length < 200 ? 'h' : 'p';
    paragraphs.push({ t, x });
  }
  let title = '';
  let author = '';
  try {
    const core = parseXml(await zip.file('docProps/core.xml').async('string'));
    title = firstByTag(core, 'title');
    author = firstByTag(core, 'creator');
  } catch {}
  return { title, author, lang: null, paragraphs, chapters: chaptersFromHeadings(paragraphs) };
}

// ---------------------------------------------------------------- ODT
async function parseOdt(buffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('content.xml')?.async('string');
  if (!xml) throw new Error('ODT inválido: falta content.xml');
  const doc = parseXml(xml);
  const paragraphs = [];
  const all = doc.getElementsByTagName('*');
  for (const el of all) {
    if (el.nodeName !== 'text:p' && el.nodeName !== 'text:h') continue;
    // omitir notas al pie y párrafos anidados en otros párrafos
    let skip = false;
    for (let a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) {
      if (a.nodeName === 'text:note' || a.nodeName === 'text:p' || a.nodeName === 'text:h') { skip = true; break; }
    }
    if (skip) continue;
    let text = '';
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) text += c.nodeValue;
        else if (c.nodeType === 1) {
          if (c.nodeName === 'text:s' || c.nodeName === 'text:tab' || c.nodeName === 'text:line-break') text += ' ';
          else if (c.nodeName === 'text:note') continue;
          else walk(c);
        }
      }
    };
    walk(el);
    const x = cleanText(text);
    if (x) paragraphs.push({ t: el.nodeName === 'text:h' ? 'h' : 'p', x });
  }
  let title = '';
  let author = '';
  try {
    const meta = parseXml(await zip.file('meta.xml').async('string'));
    title = firstByTag(meta, 'title');
    author = firstByTag(meta, 'initial-creator') || firstByTag(meta, 'creator');
  } catch {}
  return { title, author, lang: null, paragraphs, chapters: chaptersFromHeadings(paragraphs) };
}

// ---------------------------------------------------------------- FB2
function parseFb2(buffer) {
  const doc = parseXml(decodeText(buffer));
  const info = doc.getElementsByTagNameNS('*', 'title-info')[0] || doc;
  const title = firstByTag(info, 'book-title');
  const authorEl = info.getElementsByTagNameNS('*', 'author')[0];
  const author = authorEl
    ? cleanText(['first-name', 'middle-name', 'last-name'].map((n) => firstByTag(authorEl, n)).join(' '))
    : '';
  const lang = firstByTag(info, 'lang') || null;
  const paragraphs = [];
  const bodies = [...doc.getElementsByTagNameNS('*', 'body')].filter((b) => b.getAttribute('name') !== 'notes');
  const walk = (n, inTitle) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const name = c.localName;
      if (name === 'title') walk(c, true);
      else if (name === 'p' || name === 'v' || name === 'subtitle' || name === 'text-author') {
        const x = cleanText(c.textContent || '');
        if (x) paragraphs.push({ t: inTitle || name === 'subtitle' ? 'h' : 'p', x });
      } else if (name !== 'binary' && name !== 'image') walk(c, inTitle);
    }
  };
  for (const b of bodies) walk(b, false);
  // Unir líneas de título consecutivas ("Capítulo 1" + "El comienzo")
  const merged = [];
  for (const p of paragraphs) {
    const last = merged[merged.length - 1];
    if (last && last.t === 'h' && p.t === 'h' && last.x.length + p.x.length < 90 && !last._closed) {
      last.x += '. ' + p.x;
    } else merged.push(p);
  }
  return { title, author, lang, paragraphs: merged, chapters: chaptersFromHeadings(merged) };
}

// ---------------------------------------------------------------- HTML
function parseHtml(buffer) {
  const doc = new DOMParser().parseFromString(decodeText(buffer), 'text/html');
  const title = cleanText(doc.title || '');
  const lang = doc.documentElement.getAttribute('lang') || null;
  const main = doc.querySelector('article, main') || doc.body;
  const paragraphs = domToParagraphs(main);
  return { title, author: '', lang, paragraphs, chapters: chaptersFromHeadings(paragraphs) };
}

// ---------------------------------------------------------------- Markdown
function parseMarkdown(buffer) {
  const text = decodeText(buffer).replace(/\r\n?/g, '\n');
  const inline = (s) =>
    s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(.+?)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1');
  const paragraphs = [];
  let buf = [];
  let inCode = false;
  const flush = () => {
    const x = cleanText(inline(buf.join(' ')));
    if (x) paragraphs.push({ t: 'p', x });
    buf = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^```|^~~~/.test(line.trim())) { flush(); inCode = !inCode; continue; }
    if (inCode) { if (line.trim()) buf.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); continue; }
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); const x = cleanText(inline(h[1])); if (x) paragraphs.push({ t: 'h', x }); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { flush(); buf.push(line.replace(/^\s*([-*+]|\d+[.)])\s+/, '')); continue; }
    if (/^\s*>/.test(line)) { buf.push(line.replace(/^\s*>+\s?/, '')); continue; }
    if (/^\s*\|/.test(line)) { if (/^\s*\|?\s*:?-+/.test(line)) continue; flush(); buf.push(line.replace(/\|/g, ' ')); flush(); continue; }
    if (/^(=+|-+)\s*$/.test(line) && buf.length) { // títulos estilo Setext
      const x = cleanText(inline(buf.join(' ')));
      buf = [];
      if (x) paragraphs.push({ t: 'h', x });
      continue;
    }
    buf.push(line);
  }
  flush();
  return { title: '', author: '', lang: null, paragraphs, chapters: chaptersFromHeadings(paragraphs) };
}

// ---------------------------------------------------------------- RTF
function parseRtf(buffer) {
  const src = new TextDecoder('latin1').decode(new Uint8Array(buffer));
  let out = '';
  let depth = 0;
  const skipStack = [];
  let skip = false;
  let ucSkip = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { skipStack.push(skip); depth++; continue; }
    if (ch === '}') { skip = skipStack.pop() || false; depth--; continue; }
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') { if (!skip) out += nx; i++; continue; }
      if (nx === "'") {
        const hex = src.substr(i + 2, 2);
        if (!skip) out += new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(hex, 16)]));
        i += 3;
        continue;
      }
      if (nx === '*') { skip = true; i++; continue; }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40));
      if (m) {
        const word = m[1];
        const arg = m[2];
        i += m[0].length;
        if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'footnote', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator'].includes(word)) skip = true;
        else if (!skip) {
          if (word === 'par' || word === 'line') out += '\n';
          else if (word === 'tab') out += ' ';
          else if (word === 'u' && arg) { out += String.fromCharCode((+arg + 65536) % 65536); ucSkip = 1; }
          else if (word === 'emdash') out += '—';
          else if (word === 'endash') out += '–';
          else if (word === 'lquote') out += '‘';
          else if (word === 'rquote') out += '’';
          else if (word === 'ldblquote') out += '“';
          else if (word === 'rdblquote') out += '”';
        }
        continue;
      }
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    if (ucSkip > 0) { ucSkip--; continue; }
    if (!skip) out += ch;
  }
  const paragraphs = out.split('\n').map((l) => cleanText(l)).filter(Boolean).map((x) => ({ t: 'p', x }));
  return { title: '', author: '', lang: null, paragraphs, chapters: [] };
}

// ---------------------------------------------------------------- TXT
function parseTxt(buffer) {
  const paragraphs = textToParagraphs(decodeText(buffer));
  return { title: '', author: '', lang: null, paragraphs, chapters: chaptersFromHeadings(paragraphs) };
}

export function parsePlainText(text) {
  const paragraphs = textToParagraphs(text);
  return finalize({ title: '', author: '', lang: null, paragraphs, chapters: chaptersFromHeadings(paragraphs) }, '');
}

function finalize(res, name) {
  res.paragraphs = (res.paragraphs || []).filter((p) => p.x && p.x.trim());
  if (!res.paragraphs.length) throw new Error('No se encontró texto legible en el archivo.');
  ({ paragraphs: res.paragraphs, chapters: res.chapters } = stripGutenbergBoilerplate(res.paragraphs, res.chapters || []));
  if (!res.title) {
    const firstH = res.paragraphs.find((p) => p.t === 'h');
    res.title = baseName(name) || (firstH ? firstH.x : res.paragraphs[0].x).slice(0, 80);
  }
  const sample = res.paragraphs.slice(0, 300).map((p) => p.x).join(' ');
  const detected = detectLanguage(sample);
  res.lang = (detected || (res.lang || '').slice(0, 2).toLowerCase() || null);
  res.chapters = (res.chapters || []).filter((c) => c.p >= 0 && c.p < res.paragraphs.length);
  // Quitar entradas duplicadas que apuntan al mismo párrafo
  const seen = new Set();
  res.chapters = res.chapters.filter((c) => (seen.has(c.p) ? false : (seen.add(c.p), true)));
  return res;
}

/** Lee un File/Blob y devuelve el documento normalizado. */
export async function parseFile(file, { onProgress, pdfCleanup = true } = {}) {
  const format = detectFormat(file.name || '', file.type || '');
  if (!format) throw new Error(`Formato no soportado: ${file.name}`);
  const buffer = await file.arrayBuffer();
  let res;
  switch (format) {
    case 'pdf': {
      const { parsePdf } = await import('./pdf.js');
      res = await parsePdf(buffer, { name: file.name, onProgress, cleanup: pdfCleanup });
      break;
    }
    case 'epub': res = await parseEpub(buffer, { onProgress }); break;
    case 'docx': res = await parseDocx(buffer); break;
    case 'odt': res = await parseOdt(buffer); break;
    case 'fb2': res = parseFb2(buffer); break;
    case 'html': res = parseHtml(buffer); break;
    case 'md': res = parseMarkdown(buffer); break;
    case 'rtf': res = parseRtf(buffer); break;
    default: res = parseTxt(buffer);
  }
  res.format = format;
  return finalize(res, file.name || '');
}
