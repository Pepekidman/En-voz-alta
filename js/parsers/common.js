// Utilidades compartidas por los lectores de formatos.
import { cleanText, looksLikeHeading } from '../text.js';

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI', 'DD', 'DT', 'PRE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'CAPTION', 'ADDRESS', 'HEADER', 'FOOTER',
  'ASIDE', 'MAIN', 'NAV', 'UL', 'OL', 'DL', 'TABLE', 'TR', 'TBODY', 'THEAD', 'BODY', 'CENTER', 'HR', 'BR'
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'IMG', 'IFRAME', 'OBJECT', 'VIDEO', 'AUDIO', 'HEAD', 'TITLE']);

function localName(el) {
  return (el.localName || el.nodeName || '').toUpperCase();
}

// ¿Es una llamada a nota al pie? (<sup><a>12</a></sup>, <a epub:type="noteref">)
function isNoteRef(el) {
  const name = localName(el);
  const type = (el.getAttribute && (el.getAttribute('epub:type') || el.getAttribute('role') || '')) || '';
  if (/noteref|doc-noteref/.test(type)) return true;
  if (name === 'SUP' || (name === 'A' && el.parentNode && localName(el.parentNode) === 'SUP')) {
    const t = (el.textContent || '').trim();
    if (/^[\[(]?(\d{1,3}|[*†‡a-z])[\])]?$/.test(t)) return true;
  }
  return false;
}

/**
 * Recorre un árbol DOM (HTML/XHTML) y extrae bloques de texto.
 * onAnchor(id, paragraphIndex) se invoca para cada elemento con id (para el índice).
 */
export function domToParagraphs(root, { out = [], onAnchor } = {}) {
  let buf = '';
  let bufType = 'p';
  const flush = () => {
    const x = cleanText(buf);
    if (x) out.push({ t: bufType, x });
    buf = '';
    bufType = 'p';
  };
  const walk = (node) => {
    if (node.nodeType === 3) { buf += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const name = localName(node);
    if (SKIP_TAGS.has(name)) {
      if (name === 'IMG') {
        const alt = node.getAttribute('alt');
        if (alt && alt.trim().length > 20) buf += ' ' + alt + ' ';
      }
      return;
    }
    if (isNoteRef(node)) return;
    const id = node.getAttribute && node.getAttribute('id');
    const block = BLOCK_TAGS.has(name);
    if (block) flush();
    if (id && onAnchor) onAnchor(id, out.length);
    if (name === 'BR') { buf += ' '; return; }
    const isHeading = /^H[1-6]$/.test(name);
    if (isHeading) bufType = 'h';
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    if (block) {
      if (isHeading) bufType = 'h';
      flush();
    }
  };
  walk(root);
  flush();
  // Párrafos cortos con forma de título se marcan como títulos
  for (const p of out) if (p.t === 'p' && looksLikeHeading(p.x) && p.x.length < 40) p.t = 'h';
  return out;
}

/** Decodifica bytes de texto probando UTF-8 y luego Windows-1252. */
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  const err = doc.getElementsByTagName('parsererror');
  if (err.length && type !== 'text/html') {
    // XHTML mal formado: reintentar como HTML tolerante
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

/** Carga JSZip (script UMD) bajo demanda. */
let jszipPromise = null;
export function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/jszip/jszip.min.js', import.meta.url).href;
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('No se pudo cargar JSZip'));
      document.head.appendChild(s);
    });
  }
  return jszipPromise;
}

/** Reduce una imagen a miniatura JPEG (data URL) para la portada. */
export async function makeThumbnail(blob, maxW = 240) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return c.toDataURL('image/jpeg', 0.75);
  } catch {
    return null;
  }
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

/** Resuelve una ruta relativa dentro de un ZIP. */
export function resolvePath(base, rel) {
  const clean = decodeURIComponent(rel.split('#')[0]);
  if (clean.startsWith('/')) return clean.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
