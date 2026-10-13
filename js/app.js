// En Voz Alta — controlador principal de la interfaz.
import { db, takeSharedItems } from './db.js';
import { parseFile, parsePlainText, ACCEPT, detectFormat } from './parsers/index.js';
import { SpeechEngine, IS_ANDROID, IS_IOS } from './speech.js';
import { Player } from './player.js';
import { MediaControls } from './media.js';
import { escapeHtml, toSpeech, compileDictionary } from './text.js';

const VERSION = '1.0.0';

const DEFAULTS = {
  rate: 1,
  pitch: 1,
  volume: 1,
  voices: {}, // idioma → voiceURI
  paraPause: 450,
  headingPause: 850,
  sentencePause: 0,
  expandAbbr: true,
  skipRefs: true,
  skipUrls: true,
  dictionary: [],
  wordHighlight: 'auto', // auto | estimate | off
  highlight: true,
  follow: true,
  theme: 'auto',
  fontSize: 19,
  lineHeight: 1.65,
  font: 'serif',
  align: 'left',
  showPages: true,
  skipUnit: 'sentence', // botones del sistema: sentence | paragraph
  mediaSession: true,
  keepScreenOn: false,
  autoPlay: false,
  pdfCleanup: true,
  sort: 'recent'
};

const FONTS = {
  serif: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Noto Serif', 'Book Antiqua', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  readable: "Verdana, 'Atkinson Hyperlegible', 'Trebuchet MS', Tahoma, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Roboto Mono', monospace"
};

const LANGS = {
  es: 'Español', en: 'Inglés', pt: 'Portugués', fr: 'Francés', it: 'Italiano', de: 'Alemán',
  ca: 'Catalán', gl: 'Gallego', eu: 'Euskera', nl: 'Neerlandés', ru: 'Ruso', ja: 'Japonés', zh: 'Chino'
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let settings = { ...DEFAULTS };
let current = null; // { meta, content }
let lastSave = 0;
let followSuspended = false;
let currentSpan = null;
let currentSpanIdx = -1;
let sleepInterval = null;
let deferredInstall = null;
let swWaiting = null;

const engine = new SpeechEngine();
const player = new Player(engine);
const media = new MediaControls({
  play: () => player.play(),
  pause: () => player.pause(),
  prev: () => (settings.skipUnit === 'paragraph' ? player.prevParagraph() : player.prevSentence()),
  next: () => (settings.skipUnit === 'paragraph' ? player.nextParagraph() : player.nextSentence()),
  back: () => player.skipSeconds(-15),
  forward: () => player.skipSeconds(15)
});

// =================================================================== utilidades

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '0 min';
  const m = Math.round(sec / 60);
  if (m < 1) return '< 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} h ${String(mm).padStart(2, '0')} min` : `${h} h`;
}

function fmtRelative(ts) {
  if (!ts) return 'sin abrir';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

function normalizeSearch(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function hashColor(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hues = [168, 200, 18, 280, 340, 40, 220, 120];
  return `hsl(${hues[h % hues.length]} 38% 42%)`;
}

function initials(title) {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter((w) => w.length > 2 || /\p{Lu}/u.test(w));
  return (words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || title.slice(0, 1).toUpperCase() || '·');
}

let toastTimer = null;
function toast(msg, { action, onAction, duration = 3500 } = {}) {
  const el = $('#toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { el.classList.add('hidden'); onAction && onAction(); };
    el.appendChild(b);
  }
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

function busy(text, progress) {
  const el = $('#busy');
  if (text === false) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (text) $('#busy-text').textContent = text;
  const pr = $('#busy-progress');
  if (typeof progress === 'number') { pr.classList.remove('hidden'); pr.value = progress; }
  else pr.classList.add('hidden');
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// =================================================================== ajustes

let saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => db.set('settings', settings).catch(() => {}), 300);
  player.configure(settings);
}

function applyAppearance() {
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  try { localStorage.setItem('evz-theme', settings.theme); } catch {}
  root.style.setProperty('--reader-size', settings.fontSize + 'px');
  root.style.setProperty('--reader-lh', String(settings.lineHeight));
  root.style.setProperty('--reader-font', FONTS[settings.font] || FONTS.serif);
  root.style.setProperty('--reader-align', settings.align === 'justify' ? 'justify' : 'left');
  document.body.classList.toggle('no-highlight', !settings.highlight);
  document.body.classList.toggle('no-pages', !settings.showPages);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#2c6e63';
  media.enabled = settings.mediaSession;
  media.setKeepScreenOn(settings.keepScreenOn);
}

// =================================================================== vistas e historial

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
}

let ignorePop = 0;
window.addEventListener('popstate', () => {
  if (ignorePop > 0) { ignorePop--; return; }
  if (sheetOpen) { closeSheet(true); return; }
  if ($('#view-reader').classList.contains('active')) closeReader(true);
});

// =================================================================== hoja inferior

let sheetOpen = false;
let sheetOnClose = null;

function openSheet(title, body, { onClose } = {}) {
  $('#sheet-title').textContent = title;
  const container = $('#sheet-body');
  container.innerHTML = '';
  if (typeof body === 'string') container.innerHTML = body;
  else container.appendChild(body);
  container.scrollTop = 0;
  $('#sheet').classList.remove('hidden');
  $('#backdrop').classList.remove('hidden');
  if (!sheetOpen) history.pushState({ sheet: true }, '');
  sheetOpen = true;
  sheetOnClose = onClose || null;
  return container;
}

function closeSheet(fromPop = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('#sheet').classList.add('hidden');
  $('#backdrop').classList.add('hidden');
  const cb = sheetOnClose;
  sheetOnClose = null;
  cb && cb();
  if (!fromPop && history.state && history.state.sheet) { ignorePop++; history.back(); }
}

$('#sheet-close').addEventListener('click', () => closeSheet());
$('#backdrop').addEventListener('click', () => closeSheet());

function switchRow(label, desc, checked, onChange) {
  const row = el(`<label class="row"><div class="grow"><div class="label"></div><div class="desc"></div></div>
    <span class="switch"><input type="checkbox"><span></span></span></label>`);
  $('.label', row).textContent = label;
  if (desc) $('.desc', row).textContent = desc; else $('.desc', row).remove();
  const input = $('input', row);
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return row;
}

function rangeRow(label, { min, max, step, value, format, onInput }) {
  const row = el(`<div class="row"><div class="label" style="min-width:110px"></div><input type="range"><output></output></div>`);
  $('.label', row).textContent = label;
  const input = $('input', row);
  Object.assign(input, { min, max, step });
  input.value = value;
  const out = $('output', row);
  out.textContent = format(value);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  return row;
}

function segRow(options, value, onChange) {
  const wrap = el('<div class="seg"></div>');
  for (const [val, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('on', val === value);
    b.addEventListener('click', () => {
      $$('button', wrap).forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onChange(val);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function sectionTitle(text) {
  const h = el('<div class="section-title"></div>');
  h.textContent = text;
  return h;
}

// =================================================================== biblioteca

let libraryRender = 0;
async function renderLibrary() {
  const ticket = ++libraryRender;
  let docs = await db.listDocs();
  if (ticket !== libraryRender) return; // hay un render más reciente en curso
  const total = docs.length;
  const q = normalizeSearch($('#lib-search').value.trim());
  if (q) docs = docs.filter((d) => normalizeSearch(`${d.title} ${d.author || ''}`).includes(q));
  const sort = settings.sort;
  docs.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'es');
    if (sort === 'progress') return (b.progress?.pct || 0) - (a.progress?.pct || 0);
    if (sort === 'added') return b.addedAt - a.addedAt;
    return (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt);
  });
  const list = $('#lib-list');
  list.innerHTML = '';
  $('#lib-empty').classList.toggle('hidden', total > 0);
  for (const d of docs) list.appendChild(cardFor(d));
  if (total > 0 && !docs.length) list.appendChild(el('<p class="muted" style="text-align:center">Sin resultados.</p>'));
}

function cardFor(d) {
  const pct = Math.round((d.progress?.pct || 0) * 100);
  const remainingSec = ((d.chars || 0) * (1 - (d.progress?.pct || 0))) / (player.cps * (settings.rate || 1));
  const card = el(`<div class="card" role="button" tabindex="0">
    <div class="cover"></div>
    <div class="card-main">
      <div class="card-title"></div>
      <div class="card-author"></div>
      <div class="bar"><i></i></div>
      <div class="card-meta"><span class="badge"></span><span class="pct"></span><span class="when"></span></div>
    </div>
    <button class="icon-btn more" aria-label="Opciones"><svg class="ic"><use href="#i-more"/></svg></button>
  </div>`);
  const cover = $('.cover', card);
  if (d.cover) {
    const img = document.createElement('img');
    img.src = d.cover;
    img.alt = '';
    img.loading = 'lazy';
    cover.appendChild(img);
  } else {
    cover.style.background = hashColor(d.title);
    cover.textContent = initials(d.title);
  }
  $('.card-title', card).textContent = d.title;
  $('.card-author', card).textContent = d.author || '';
  $('.bar i', card).style.width = pct + '%';
  $('.badge', card).textContent = d.format || 'txt';
  $('.pct', card).textContent = pct >= 100 ? 'Terminado' : `${pct}% · ${fmtDuration(remainingSec)}`;
  $('.when', card).textContent = fmtRelative(d.lastOpenedAt);
  card.addEventListener('click', (e) => {
    if (e.target.closest('.more')) return;
    openReader(d.id);
  });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openReader(d.id); });
  $('.more', card).addEventListener('click', (e) => { e.stopPropagation(); openDocMenu(d.id); });
  return card;
}

async function openDocMenu(id) {
  const d = await db.getDoc(id);
  if (!d) return;
  const body = el('<div></div>');
  body.appendChild(el(`<div class="field"><label>Título</label><input id="dm-title"></div>`));
  body.appendChild(el(`<div class="field"><label>Autor</label><input id="dm-author"></div>`));
  body.appendChild(el(`<div class="field"><label>Idioma del texto (para elegir la voz)</label><select id="dm-lang"></select></div>`));
  const info = el('<p class="muted small"></p>');
  info.textContent = `${(d.format || '').toUpperCase()} · ${(d.chars || 0).toLocaleString('es')} caracteres · agregado ${fmtRelative(d.addedAt)}` +
    (d.fileName ? ` · ${d.fileName}` : '');
  body.appendChild(info);
  body.appendChild(el(`<div class="btn-row">
    <button class="btn secondary" id="dm-reset">Reiniciar progreso</button>
    <button class="btn secondary" id="dm-export"><svg class="ic"><use href="#i-download"/></svg> Exportar texto</button>
  </div>`));
  body.appendChild(el(`<div class="btn-row"><button class="btn danger" id="dm-delete"><svg class="ic"><use href="#i-trash"/></svg> Eliminar</button></div>`));
  openSheet('Documento', body);
  $('#dm-title').value = d.title;
  $('#dm-author').value = d.author || '';
  const sel = $('#dm-lang');
  for (const [code, name] of Object.entries(LANGS)) sel.appendChild(new Option(name, code));
  sel.value = d.lang || 'es';
  const saveMeta = async () => {
    await db.updateDoc(id, { title: $('#dm-title').value.trim() || d.title, author: $('#dm-author').value.trim(), lang: sel.value });
    renderLibrary();
  };
  $('#dm-title').addEventListener('change', saveMeta);
  $('#dm-author').addEventListener('change', saveMeta);
  sel.addEventListener('change', saveMeta);
  $('#dm-reset').onclick = async () => {
    await db.updateDoc(id, { progress: { p: 0, c: 0, pct: 0, updatedAt: Date.now() } });
    toast('Progreso reiniciado');
    closeSheet();
    renderLibrary();
  };
  $('#dm-export').onclick = async () => {
    const c = await db.getContent(id);
    const txt = c.paragraphs.map((p) => p.x).join('\n\n');
    download(`${d.title}.txt`, txt, 'text/plain;charset=utf-8');
  };
  $('#dm-delete').onclick = async () => {
    if (!confirm(`¿Eliminar «${d.title}» de la biblioteca?`)) return;
    await db.deleteDocument(id);
    closeSheet();
    renderLibrary();
    toast('Documento eliminado');
  };
}

$('#lib-search').addEventListener('input', () => renderLibrary());
$('#lib-sort').addEventListener('change', (e) => { settings.sort = e.target.value; saveSettings(); renderLibrary(); });

// =================================================================== importación

async function importFiles(files) {
  const imported = [];
  let failed = 0;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const existing = await db.listDocs();
  for (const file of files) {
    if (!detectFormat(file.name || '', file.type || '')) {
      toast(`Formato no soportado: ${file.name}`);
      failed++;
      continue;
    }
    const dup = existing.find((d) => d.fileName === file.name && d.size === file.size);
    if (dup && !confirm(`«${file.name}» ya está en la biblioteca. ¿Importarlo de nuevo?`)) continue;
    busy(`Leyendo ${file.name}…`, 0);
    try {
      const res = await parseFile(file, {
        pdfCleanup: settings.pdfCleanup,
        onProgress: (p, label) => busy(`${file.name}\n${label || ''}`, p)
      });
      imported.push(await saveParsed(res, { fileName: file.name, size: file.size }));
    } catch (e) {
      console.error(e);
      failed++;
      busy(false);
      alert(`No se pudo leer «${file.name}»:\n${e.message || e}`);
    }
  }
  busy(false);
  await renderLibrary();
  if (imported.length === 1 && !failed) openReader(imported[0].id);
  else if (imported.length) toast(`${imported.length} documento(s) agregado(s)`);
}

async function saveParsed(res, { fileName = '', size = 0 } = {}) {
  const id = uid();
  const chars = res.paragraphs.reduce((n, p) => n + p.x.length, 0);
  const meta = {
    id,
    title: res.title || 'Sin título',
    author: res.author || '',
    format: res.format || 'txt',
    lang: res.lang || 'es',
    addedAt: Date.now(),
    lastOpenedAt: 0,
    fileName,
    size,
    chars,
    pages: res.pages || null,
    cover: res.cover || null,
    progress: { p: 0, c: 0, pct: 0, updatedAt: Date.now() },
    bookmarks: []
  };
  await db.addDocument(meta, { id, paragraphs: res.paragraphs, chapters: res.chapters || [] });
  return meta;
}

$('#file-input').setAttribute('accept', ACCEPT);
$('#file-input').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});

// Arrastrar y soltar (escritorio)
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) importFiles(files);
});

$('#btn-paste').addEventListener('click', () => {
  const body = el(`<div>
    <div class="field"><label for="pt-title">Título</label><input id="pt-title" placeholder="Opcional"></div>
    <div class="field"><label for="pt-text">Texto</label><textarea id="pt-text" placeholder="Pega aquí el texto que quieres escuchar"></textarea></div>
    <div class="btn-row">
      <button class="btn secondary" id="pt-clip"><svg class="ic"><use href="#i-clipboard"/></svg> Pegar del portapapeles</button>
      <button class="btn primary" id="pt-save">Guardar y abrir</button>
    </div></div>`);
  openSheet('Pegar texto', body);
  $('#pt-clip').onclick = async () => {
    try {
      $('#pt-text').value = await navigator.clipboard.readText();
    } catch {
      toast('No se pudo leer el portapapeles. Mantén pulsado el cuadro y elige «Pegar».');
    }
  };
  $('#pt-save').onclick = async () => {
    const text = $('#pt-text').value;
    if (!text.trim()) return toast('El texto está vacío');
    try {
      const res = parsePlainText(text);
      const t = $('#pt-title').value.trim();
      res.title = t || res.paragraphs[0].x.slice(0, 60);
      res.format = 'texto';
      const meta = await saveParsed(res);
      closeSheet();
      await renderLibrary();
      openReader(meta.id);
    } catch (e) {
      toast(e.message);
    }
  };
});

// =================================================================== lector

const BLOCK = 40;
const MAX_BLOCKS = 7;
let blockFirst = -1;
let blockLast = -1;
const reader = $('#reader');
const content = $('#reader-content');

async function openReader(id) {
  const [meta, cont] = await Promise.all([db.getDoc(id), db.getContent(id)]);
  if (!meta || !cont) return toast('No se encontró el documento');
  current = { meta, content: cont };
  meta.lastOpenedAt = Date.now();
  db.updateDoc(id, { lastOpenedAt: meta.lastOpenedAt });
  player.configure(settings);
  player.load(meta, cont);
  pickVoice();
  $('#r-title').textContent = meta.title;
  $('#seek').max = Math.max(0, player.sentences.length - 1);
  currentSpan = null;
  currentSpanIdx = -1;
  followSuspended = false;
  $('#btn-follow').classList.add('hidden');
  showView('reader');
  history.pushState({ reader: id }, '');
  renderAround(player.sentences[player.idx]?.p ?? 0);
  highlightSentence(player.idx, { force: true, instant: true });
  updateProgressUI(player.progressInfo());
  updateSpeedChip();
  media.setMetadata(mediaMetadata());
  if (settings.autoPlay) player.play();
}

function closeReader(fromPop = false) {
  if (player.playing) player.pause();
  saveProgress(true);
  player.setSleep(null);
  current = null;
  showView('library');
  renderLibrary();
  if (!fromPop && history.state && history.state.reader) { ignorePop++; history.back(); }
}

$('#btn-back').addEventListener('click', () => closeReader());

function mediaMetadata() {
  const m = current?.meta;
  const art = m?.cover
    ? [{ src: m.cover, sizes: '240x340', type: 'image/jpeg' }]
    : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
  return { title: chapterTitleFor(player.sentences[player.idx]?.p ?? 0) || m?.title || 'En Voz Alta', artist: m?.author || m?.title || '', album: m?.title || 'En Voz Alta', artwork: art };
}

function maxBlock() {
  return Math.max(0, Math.ceil(current.content.paragraphs.length / BLOCK) - 1);
}

function buildBlock(k) {
  const paras = current.content.paragraphs;
  const start = k * BLOCK;
  const end = Math.min(paras.length, start + BLOCK);
  const bm = new Set((current.meta.bookmarks || []).map((b) => b.p));
  const div = document.createElement('div');
  div.className = 'block';
  div.dataset.k = k;
  let html = '';
  for (let p = start; p < end; p++) {
    const para = paras[p];
    if (para.pg && (p === 0 || paras[p - 1].pg !== para.pg)) html += `<div class="page-mark">Página ${para.pg}</div>`;
    const tag = para.t === 'h' ? 'h2' : 'p';
    const first = player.paraFirst[p];
    const last = p + 1 < paras.length ? player.paraFirst[p + 1] : player.sentences.length;
    let inner = '';
    let pos = 0;
    for (let i = first; i < last; i++) {
      const s = player.sentences[i];
      if (s.s > pos) inner += escapeHtml(para.x.slice(pos, s.s));
      inner += `<span class="s" data-i="${i}">${escapeHtml(para.x.slice(s.s, s.e))}</span>`;
      pos = s.e;
    }
    if (pos < para.x.length) inner += escapeHtml(para.x.slice(pos));
    html += `<${tag} data-p="${p}"${bm.has(p) ? ' class="bookmarked"' : ''}>${inner}</${tag}>`;
  }
  div.innerHTML = html;
  return div;
}

function renderAround(p) {
  const k = Math.floor(p / BLOCK);
  content.innerHTML = '';
  blockFirst = Math.max(0, k - 1);
  blockLast = Math.min(maxBlock(), k + 1);
  for (let j = blockFirst; j <= blockLast; j++) content.appendChild(buildBlock(j));
  currentSpan = null;
}

function appendNext() {
  if (!current || blockLast >= maxBlock()) return;
  blockLast++;
  content.appendChild(buildBlock(blockLast));
  if (blockLast - blockFirst + 1 > MAX_BLOCKS) {
    const first = content.firstElementChild;
    const h = first.offsetHeight;
    first.remove();
    blockFirst++;
    reader.scrollTop -= h;
  }
}

function prependPrev() {
  if (!current || blockFirst <= 0) return;
  blockFirst--;
  const before = reader.scrollHeight;
  content.insertBefore(buildBlock(blockFirst), content.firstElementChild);
  reader.scrollTop += reader.scrollHeight - before;
  if (blockLast - blockFirst + 1 > MAX_BLOCKS) {
    content.lastElementChild.remove();
    blockLast--;
  }
}

let scrollTicking = false;
reader.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    if (!current) return;
    if (reader.scrollTop + reader.clientHeight > reader.scrollHeight - 1500) appendNext();
    if (reader.scrollTop < 900) prependPrev();
  });
}, { passive: true });

// Si el usuario se desplaza mientras se lee, se deja de seguir la lectura
const userScroll = () => {
  if (!player.playing || !settings.follow) return;
  followSuspended = true;
  $('#btn-follow').classList.remove('hidden');
};
reader.addEventListener('touchmove', userScroll, { passive: true });
reader.addEventListener('wheel', userScroll, { passive: true });

$('#btn-follow').addEventListener('click', () => {
  followSuspended = false;
  $('#btn-follow').classList.add('hidden');
  highlightSentence(player.idx, { force: true });
});

function spanFor(i) {
  return content.querySelector(`.s[data-i="${i}"]`);
}

function restoreSpan() {
  if (currentSpan) {
    currentSpan.classList.remove('current');
    if (currentSpan.querySelector('mark')) currentSpan.textContent = player.sentenceText(currentSpanIdx);
  }
  currentSpan = null;
}

function highlightSentence(i, { force = false, instant = false } = {}) {
  if (!current || !player.sentences[i]) return;
  restoreSpan();
  let span = spanFor(i);
  if (!span) {
    renderAround(player.sentences[i].p);
    span = spanFor(i);
  }
  if (!span) return;
  currentSpan = span;
  currentSpanIdx = i;
  span.classList.add('current');
  if (force || (settings.follow && !followSuspended)) scrollToSpan(span, force, instant);
  updateChapterLabel();
}

function scrollToSpan(span, force, instant) {
  const r = span.getBoundingClientRect();
  const rr = reader.getBoundingClientRect();
  const top = r.top - rr.top;
  if (force || top < rr.height * 0.12 || r.bottom - rr.top > rr.height * 0.7) {
    reader.scrollTo({ top: reader.scrollTop + top - rr.height * 0.28, behavior: instant ? 'auto' : 'smooth' });
  }
}

function highlightWord(i, s, e) {
  if (!settings.highlight || i !== currentSpanIdx || !currentSpan) return;
  const text = player.sentenceText(i);
  currentSpan.innerHTML = escapeHtml(text.slice(0, s)) + '<mark>' + escapeHtml(text.slice(s, e)) + '</mark>' + escapeHtml(text.slice(e));
}

function chapterIndexFor(p) {
  const chs = current?.content?.chapters || [];
  let lo = 0;
  let hi = chs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chs[mid].p <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function chapterTitleFor(p) {
  const ci = chapterIndexFor(p);
  if (ci >= 0) return current.content.chapters[ci].title;
  return '';
}

let lastChapterLabel = '';
function updateChapterLabel() {
  if (!current) return;
  const p = player.sentences[player.idx]?.p ?? 0;
  let label = chapterTitleFor(p);
  const pg = current.content.paragraphs[p]?.pg;
  if (pg) label = label ? `${label} · pág. ${pg}` : `Página ${pg}`;
  $('#r-chapter').textContent = label;
  if (label !== lastChapterLabel) {
    lastChapterLabel = label;
    media.setMetadata(mediaMetadata());
  }
}

// Tocar una frase la selecciona como posición de lectura
content.addEventListener('click', (e) => {
  const s = e.target.closest('.s');
  if (!s) return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 2) return; // está seleccionando texto
  followSuspended = false;
  $('#btn-follow').classList.add('hidden');
  player.seek(parseInt(s.dataset.i, 10));
});

// ------------------------------------------------------------ reproductor UI

function updatePlayButton() {
  const playing = player.playing;
  $('#btn-play use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#btn-play').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
}

function updateProgressUI(info) {
  if (!info) return;
  if (!seeking) $('#seek').value = info.idx;
  $('#pct').textContent = `${Math.floor(info.pct * 100)}%`;
  const chs = current?.content?.chapters?.length;
  $('#remaining').textContent = chs
    ? `Capítulo: ${fmtDuration(info.chapterRemaining)} · Total: ${fmtDuration(info.remaining)}`
    : `Quedan ${fmtDuration(info.remaining)}`;
}

function updateSpeedChip() {
  $('#btn-speed').textContent = `${(settings.rate || 1).toFixed(2).replace(/0$/, '')}×`;
}

let seeking = false;
$('#seek').addEventListener('input', (e) => {
  seeking = true;
  const i = parseInt(e.target.value, 10);
  const s = player.sentences[i];
  if (!s) return;
  const total = player.cum[player.sentences.length] || 1;
  $('#pct').textContent = `${Math.floor((player.cum[i] / total) * 100)}%`;
  const t = chapterTitleFor(s.p);
  const pg = current.content.paragraphs[s.p]?.pg;
  $('#remaining').textContent = [t, pg ? `pág. ${pg}` : ''].filter(Boolean).join(' · ') || '';
});
$('#seek').addEventListener('change', (e) => {
  seeking = false;
  followSuspended = false;
  $('#btn-follow').classList.add('hidden');
  const i = parseInt(e.target.value, 10);
  player.seek(i);
  highlightSentence(i, { force: true, instant: true });
});

$('#btn-play').addEventListener('click', () => {
  if (!engine.supported) {
    alert('Este navegador no permite la síntesis de voz. Usa Chrome en Android o Safari en iPhone.');
    return;
  }
  if (!player.playing) {
    followSuspended = false;
    $('#btn-follow').classList.add('hidden');
  }
  player.toggle();
});
$('#btn-prev').addEventListener('click', () => player.prevSentence());
$('#btn-next').addEventListener('click', () => player.nextSentence());
$('#btn-prev-para').addEventListener('click', () => player.prevParagraph());
$('#btn-next-para').addEventListener('click', () => player.nextParagraph());

player.addEventListener('state', (e) => {
  updatePlayButton();
  if (e.detail.playing) media.playing(); else media.paused();
});
player.addEventListener('sentence', (e) => {
  highlightSentence(e.detail.idx, { force: !!e.detail.seek && !player.playing });
  saveProgress(false);
});
player.addEventListener('word', (e) => highlightWord(e.detail.idx, e.detail.s, e.detail.e));
player.addEventListener('progress', (e) => updateProgressUI(e.detail));
player.addEventListener('save', () => saveProgress(true));
player.addEventListener('finished', () => toast('Fin del documento'));
player.addEventListener('sleep', () => updateSleepChip());
player.addEventListener('error', (e) => {
  const err = e.detail.error;
  const msgs = {
    'not-allowed': 'El navegador bloqueó la voz. Toca ▶ de nuevo.',
    'language-unavailable': 'No hay voz instalada para este idioma. Revisa «Voz».',
    'voice-unavailable': 'La voz elegida no está disponible. Elige otra en «Voz».',
    'synthesis-unavailable': 'El motor de voz no está disponible.',
    'network': 'La voz elegida necesita internet. Elige una voz local en «Voz».',
    'audio-busy': 'El audio está ocupado por otra app.'
  };
  toast(msgs[err] || `Error de voz (${err}).`, { duration: 5000 });
});

async function saveProgress(force) {
  if (!current) return;
  const now = Date.now();
  if (!force && now - lastSave < 3000) return;
  lastSave = now;
  const pos = player.position();
  current.meta.progress = pos;
  try { await db.updateDoc(current.meta.id, { progress: pos, lastOpenedAt: now }); } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress(true);
});
window.addEventListener('pagehide', () => saveProgress(true));

// Atajos de teclado
document.addEventListener('keydown', (e) => {
  if (!current || sheetOpen) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowRight') player.nextSentence();
  else if (e.key === 'ArrowLeft') player.prevSentence();
  else if (e.key === 'ArrowDown' && e.shiftKey) player.nextParagraph();
  else if (e.key === 'ArrowUp' && e.shiftKey) player.prevParagraph();
});

// =================================================================== voz

function pickVoice() {
  const lang = current?.meta?.lang || 'es';
  const v = engine.pickVoice(lang, settings.voices[lang]);
  player.setVoice(v);
  $('#voice-label').textContent = v ? shortVoiceName(v) : 'Voz';
}

function shortVoiceName(v) {
  return v.name.replace(/^(Microsoft|Google|Apple)\s+/i, '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/ - .*$/, '').trim().slice(0, 18) || v.lang;
}

engine.onvoiceschanged = () => { if (current) pickVoice(); };

$('#btn-voice').addEventListener('click', openVoiceSheet);

async function openVoiceSheet() {
  await engine.loadVoices();
  const lang = current?.meta?.lang || 'es';
  const body = el('<div></div>');
  const langField = el('<div class="field"><label>Idioma del documento</label><select></select></div>');
  const sel = $('select', langField);
  for (const [code, name] of Object.entries(LANGS)) sel.appendChild(new Option(name, code));
  sel.value = lang;
  sel.addEventListener('change', async () => {
    current.meta.lang = sel.value;
    player.doc.meta.lang = sel.value;
    player.chunkCache.clear();
    await db.updateDoc(current.meta.id, { lang: sel.value });
    pickVoice();
    openVoiceSheet();
  });
  body.appendChild(langField);

  let voices = engine.voicesFor(lang);
  const all = !voices.length;
  if (all) {
    body.appendChild(el(`<div class="note">No se encontraron voces para este idioma en el dispositivo. Se muestran todas las disponibles. Lee abajo cómo instalar voces.</div>`));
    voices = engine.voices.slice();
  }
  if (!engine.supported || !engine.voices.length) {
    body.appendChild(el(`<div class="note">Este navegador no ofrece voces. En Android usa <b>Chrome</b>; en iPhone/iPad usa <b>Safari</b>.</div>`));
  }
  voices.sort((a, b) => (b.localService - a.localService) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const curURI = player.voice?.voiceURI;
  body.appendChild(sectionTitle(`Voces (${voices.length})`));
  for (const v of voices) {
    const row = el(`<div class="list-item">
      <span class="radio"></span>
      <div class="grow"><div class="t"></div><div class="sub"></div></div>
      <button class="btn small secondary">Probar</button></div>`);
    $('.radio', row).classList.toggle('on', v.voiceURI === curURI);
    $('.t', row).textContent = v.name;
    const sub = $('.sub', row);
    sub.textContent = v.lang + ' ';
    const badge = el(`<span class="voice-badge ${v.localService ? 'local' : 'net'}"></span>`);
    badge.textContent = v.localService ? 'sin conexión' : 'en línea';
    sub.appendChild(badge);
    if (v.default) sub.appendChild(document.createTextNode(' · predeterminada'));
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      settings.voices[lang] = v.voiceURI;
      saveSettings();
      player.setVoice(v);
      $('#voice-label').textContent = shortVoiceName(v);
      $$('.radio', body).forEach((r) => r.classList.remove('on'));
      $('.radio', row).classList.add('on');
    });
    $('button', row).addEventListener('click', () => testVoice(v));
    body.appendChild(row);
  }
  body.appendChild(sectionTitle('Voces sin conexión'));
  body.appendChild(el(voiceHelpHtml()));
  openSheet('Voz', body);
}

function testVoice(v) {
  const wasPlaying = player.playing;
  if (wasPlaying) player.pause();
  const sample = {
    es: 'Hola. Así sonará la lectura de tus libros, con pausas en comas, puntos y párrafos.',
    en: 'Hello. This is how your books will sound, with pauses at commas and periods.',
    pt: 'Olá. É assim que seus livros vão soar.',
    fr: 'Bonjour. Voici comment vos livres seront lus.',
    it: 'Ciao. Ecco come suoneranno i tuoi libri.',
    de: 'Hallo. So werden deine Bücher klingen.'
  }[(v.lang || 'es').slice(0, 2)] || 'Hola.';
  engine.cancel();
  engine.speak(sample, { voice: v, rate: settings.rate, pitch: settings.pitch });
}

function voiceHelpHtml() {
  return `<div class="note">
    <b>Android</b> (motor «Servicios de voz de Google»):
    <ol>
      <li>Ajustes → Sistema → Idiomas → <i>Salida de texto a voz</i>.</li>
      <li>Motor preferido: <i>Servicios de voz de Google</i> → ⚙️ → <i>Instalar datos de voz</i>.</li>
      <li>Descarga <i>Español</i> (y otras voces que quieras). Así funciona sin internet.</li>
    </ol>
    <b>iPhone / iPad</b>: Ajustes → Accesibilidad → Contenido leído → Voces → Español → descarga una voz «Mejorada».
    <p class="small muted" style="margin:8px 0 0">Las voces marcadas «en línea» necesitan internet; elige una «sin conexión» para usar la app offline.</p>
  </div>`;
}

// =================================================================== velocidad

$('#btn-speed').addEventListener('click', () => {
  const body = el('<div></div>');
  const big = el('<div class="big-value"></div>');
  const wpm = el('<p class="muted small" style="text-align:center;margin:0 0 8px"></p>');
  const refresh = () => {
    big.textContent = `${settings.rate.toFixed(2)}×`;
    wpm.textContent = `≈ ${Math.round((player.cps * settings.rate * 60) / 6)} palabras por minuto`;
    updateSpeedChip();
  };
  body.appendChild(big);
  body.appendChild(wpm);
  const sliderRow = el(`<div class="row"><button class="btn small secondary" data-d="-0.05">−</button><input type="range" min="0.5" max="3" step="0.05"><button class="btn small secondary" data-d="0.05">+</button></div>`);
  const slider = $('input', sliderRow);
  slider.value = settings.rate;
  let rateTimer = null;
  const setRate = (r) => {
    settings.rate = Math.round(Math.min(3, Math.max(0.5, r)) * 100) / 100;
    slider.value = settings.rate;
    refresh();
    saveSettings();
    clearTimeout(rateTimer);
    rateTimer = setTimeout(() => player.setRate(settings.rate), 250);
    $$('.seg button', body).forEach((b) => b.classList.toggle('on', parseFloat(b.textContent) === settings.rate));
  };
  slider.addEventListener('input', () => setRate(parseFloat(slider.value)));
  $$('button[data-d]', sliderRow).forEach((b) => b.addEventListener('click', () => setRate(settings.rate + parseFloat(b.dataset.d))));
  body.appendChild(sliderRow);
  const presets = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  body.appendChild(segRow(presets.map((p) => [p, `${p}×`]), settings.rate, (v) => setRate(v)));
  body.appendChild(sectionTitle('Tono'));
  body.appendChild(rangeRow('Tono de voz', {
    min: 0.5, max: 1.6, step: 0.05, value: settings.pitch,
    format: (v) => v.toFixed(2),
    onInput: (v) => { settings.pitch = v; saveSettings(); clearTimeout(rateTimer); rateTimer = setTimeout(() => player.setPitch(v), 300); }
  }));
  body.appendChild(el('<p class="muted small">Consejo: muchas voces suenan naturales hasta 1.5×–2×. Por encima de eso depende del motor de voz del dispositivo.</p>'));
  refresh();
  openSheet('Velocidad', body);
});

// =================================================================== temporizador de sueño

$('#btn-sleep').addEventListener('click', () => {
  const body = el('<div></div>');
  const s = player.sleep;
  if (s) {
    const info = el('<div class="note"></div>');
    info.textContent = s.type === 'chapter' ? 'La lectura se detendrá al final del capítulo.' : `Se detendrá en ${fmtClock(s.until - Date.now())} (al terminar la frase).`;
    body.appendChild(info);
  }
  const opts = [[5, '5 min'], [10, '10 min'], [15, '15 min'], [20, '20 min'], [30, '30 min'], [45, '45 min'], [60, '1 hora'], [90, '1 h 30']];
  for (const [m, label] of opts) {
    const b = el('<button class="list-item"><svg class="ic"><use href="#i-moon"/></svg><div class="grow"></div></button>');
    $('.grow', b).textContent = label;
    b.onclick = () => { player.setSleep(m); closeSheet(); toast(`Temporizador: ${label}`); };
    body.appendChild(b);
  }
  const ch = el('<button class="list-item"><svg class="ic"><use href="#i-list"/></svg><div class="grow">Al final del capítulo</div></button>');
  ch.onclick = () => { player.setSleep('chapter'); closeSheet(); toast('Se detendrá al final del capítulo'); };
  body.appendChild(ch);
  if (s) {
    const off = el('<div class="btn-row"><button class="btn danger">Desactivar temporizador</button></div>');
    $('button', off).onclick = () => { player.setSleep(null); closeSheet(); };
    body.appendChild(off);
  }
  openSheet('Temporizador de sueño', body);
});

function fmtClock(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function updateSleepChip() {
  const s = player.sleep;
  const chip = $('#btn-sleep');
  chip.classList.toggle('active', !!s);
  clearInterval(sleepInterval);
  if (!s) { $('#sleep-label').textContent = 'Dormir'; return; }
  if (s.type === 'chapter') { $('#sleep-label').textContent = 'Fin cap.'; return; }
  const tick = () => {
    const left = s.until - Date.now();
    $('#sleep-label').textContent = left > 0 ? fmtClock(left) : 'Fin frase';
    // Si está en pausa cuando vence, se cancela
    if (left <= 0 && !player.playing) player.setSleep(null);
  };
  tick();
  sleepInterval = setInterval(tick, 1000);
}

// =================================================================== índice

function openToc() {
  if (!current) return;
  const chs = current.content.chapters || [];
  const body = el('<div></div>');
  const curP = player.sentences[player.idx]?.p ?? 0;
  const ci = chapterIndexFor(curP);
  const total = player.cum[player.sentences.length] || 1;
  if (chs.length) {
    chs.forEach((c, i) => {
      const b = el('<button class="list-item"><div class="grow"><div class="t"></div><div class="sub"></div></div></button>');
      if (c.depth) b.classList.add('depth-' + Math.min(2, c.depth));
      b.classList.toggle('current', i === ci);
      $('.t', b).textContent = c.title;
      const si = player.paraFirst[c.p] ?? 0;
      const pg = current.content.paragraphs[c.p]?.pg;
      $('.sub', b).textContent = `${Math.floor((player.cum[si] / total) * 100)}%` + (pg ? ` · pág. ${pg}` : '');
      b.onclick = () => { closeSheet(); jumpToParagraph(c.p); };
      body.appendChild(b);
    });
  } else {
    body.appendChild(el('<p class="muted">Este documento no tiene índice de capítulos.</p>'));
  }
  if (current.meta.pages) {
    const go = el(`<div class="field"><label>Ir a la página (1–${current.meta.pages})</label>
      <div class="row" style="border:none;padding:0"><input type="number" min="1" max="${current.meta.pages}" inputmode="numeric" style="flex:1"><button class="btn primary small">Ir</button></div></div>`);
    $('button', go).onclick = () => {
      const n = parseInt($('input', go).value, 10);
      const paras = current.content.paragraphs;
      const p = paras.findIndex((x) => (x.pg || 0) >= n);
      if (p >= 0) { closeSheet(); jumpToParagraph(p); } else toast('Página sin texto');
    };
    body.insertBefore(go, body.firstChild);
  }
  openSheet('Índice', body);
  const cur = $('.list-item.current', body);
  if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center' }), 50);
}

function jumpToParagraph(p) {
  const i = player.paraFirst[p] ?? 0;
  followSuspended = false;
  $('#btn-follow').classList.add('hidden');
  player.seek(i);
  highlightSentence(i, { force: true, instant: true });
}

$('#btn-toc').addEventListener('click', openToc);
$('#r-heading').addEventListener('click', openToc);

// =================================================================== búsqueda

$('#btn-search').addEventListener('click', () => {
  const body = el(`<div><div class="field"><input type="search" placeholder="Buscar palabra o frase" enterkeyhint="search"></div><div class="results"></div></div>`);
  const input = $('input', body);
  const results = $('.results', body);
  let t = null;
  const run = () => {
    const q = normalizeSearch(input.value.trim());
    results.innerHTML = '';
    if (q.length < 2) return;
    const paras = current.content.paragraphs;
    let count = 0;
    for (let p = 0; p < paras.length && count < 150; p++) {
      const norm = normalizeSearch(paras[p].x);
      let from = 0;
      let at;
      while ((at = norm.indexOf(q, from)) !== -1 && count < 150) {
        count++;
        const x = paras[p].x;
        const a = Math.max(0, at - 50);
        const b = Math.min(x.length, at + q.length + 70);
        const item = el('<button class="list-item result"><div class="grow"><div class="t"></div><div class="sub"></div></div></button>');
        $('.t', item).innerHTML = (a > 0 ? '…' : '') + escapeHtml(x.slice(a, at)) + '<mark>' + escapeHtml(x.slice(at, at + q.length)) + '</mark>' + escapeHtml(x.slice(at + q.length, b)) + (b < x.length ? '…' : '');
        const pg = paras[p].pg;
        $('.sub', item).textContent = [chapterTitleFor(p), pg ? `pág. ${pg}` : ''].filter(Boolean).join(' · ');
        const offset = at;
        const para = p;
        item.onclick = () => {
          closeSheet();
          const i = player.findSentence(para, offset);
          followSuspended = false;
          player.seek(i);
          highlightSentence(i, { force: true, instant: true });
        };
        results.appendChild(item);
        from = at + q.length;
      }
    }
    if (!count) results.appendChild(el('<p class="muted">Sin resultados.</p>'));
    else if (count >= 150) results.appendChild(el('<p class="muted small">Mostrando los primeros 150 resultados.</p>'));
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
  openSheet('Buscar en el texto', body);
  setTimeout(() => input.focus(), 100);
});

// =================================================================== marcadores

$('#btn-bookmarks').addEventListener('click', openBookmarks);
$('#btn-add-bm').addEventListener('click', () => addBookmark(''));

async function addBookmark(note) {
  if (!current) return;
  const meta = current.meta;
  const pos = player.position();
  const excerpt = player.sentenceText(player.idx).slice(0, 140);
  meta.bookmarks = meta.bookmarks || [];
  meta.bookmarks.push({ id: uid(), p: pos.p, c: pos.c, note, excerpt, at: Date.now() });
  meta.bookmarks.sort((a, b) => a.p - b.p || a.c - b.c);
  await db.updateDoc(meta.id, { bookmarks: meta.bookmarks });
  const pe = content.querySelector(`[data-p="${pos.p}"]`);
  if (pe) pe.classList.add('bookmarked');
  toast('Marcador agregado', { action: 'Ver', onAction: openBookmarks });
}

function openBookmarks() {
  if (!current) return;
  const meta = current.meta;
  const body = el('<div></div>');
  const add = el(`<div><div class="field"><label>Nota (opcional)</label><input placeholder="Ej.: cita para el trabajo"></div>
    <div class="btn-row"><button class="btn primary"><svg class="ic"><use href="#i-bookmark"/></svg> Agregar marcador aquí</button></div></div>`);
  $('button', add).onclick = async () => {
    await addBookmark($('input', add).value.trim());
    openBookmarks();
  };
  body.appendChild(add);
  const list = meta.bookmarks || [];
  body.appendChild(sectionTitle(list.length ? `Marcadores (${list.length})` : 'Sin marcadores todavía'));
  for (const bm of list) {
    const item = el(`<div class="list-item"><svg class="ic"><use href="#i-bookmark"/></svg><div class="grow"><div class="t"></div><div class="sub"></div></div>
      <button class="icon-btn" aria-label="Eliminar marcador"><svg class="ic"><use href="#i-trash"/></svg></button></div>`);
    $('.t', item).textContent = bm.note ? `${bm.note} — «${bm.excerpt}»` : `«${bm.excerpt}»`;
    const pg = current.content.paragraphs[bm.p]?.pg;
    $('.sub', item).textContent = [chapterTitleFor(bm.p), pg ? `pág. ${pg}` : '', new Date(bm.at).toLocaleDateString('es')].filter(Boolean).join(' · ');
    item.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      closeSheet();
      const i = player.findSentence(bm.p, bm.c);
      player.seek(i);
      highlightSentence(i, { force: true, instant: true });
    });
    $('button', item).onclick = async () => {
      meta.bookmarks = meta.bookmarks.filter((b) => b.id !== bm.id);
      await db.updateDoc(meta.id, { bookmarks: meta.bookmarks });
      if (!meta.bookmarks.some((b) => b.p === bm.p)) content.querySelector(`[data-p="${bm.p}"]`)?.classList.remove('bookmarked');
      openBookmarks();
    };
    body.appendChild(item);
  }
  if (list.length) {
    const exp = el('<div class="btn-row"><button class="btn secondary"><svg class="ic"><use href="#i-download"/></svg> Exportar marcadores</button></div>');
    $('button', exp).onclick = () => {
      const txt = `${meta.title}\n${meta.author || ''}\n\n` + list.map((b) => `• ${b.note ? b.note + ': ' : ''}«${b.excerpt}» (${chapterTitleFor(b.p) || 'pág. ' + (current.content.paragraphs[b.p]?.pg || '')})`).join('\n');
      download(`Marcadores - ${meta.title}.txt`, txt, 'text/plain;charset=utf-8');
    };
    body.appendChild(exp);
  }
  openSheet('Marcadores', body);
}

// =================================================================== apariencia

$('#btn-appearance').addEventListener('click', () => {
  const body = el('<div></div>');
  body.appendChild(sectionTitle('Texto'));
  body.appendChild(rangeRow('Tamaño', { min: 14, max: 34, step: 1, value: settings.fontSize, format: (v) => `${v}px`, onInput: (v) => { settings.fontSize = v; applyAppearance(); saveSettings(); } }));
  body.appendChild(rangeRow('Interlineado', { min: 1.2, max: 2.4, step: 0.05, value: settings.lineHeight, format: (v) => v.toFixed(2), onInput: (v) => { settings.lineHeight = v; applyAppearance(); saveSettings(); } }));
  body.appendChild(segRow([['serif', 'Serif'], ['sans', 'Sans'], ['readable', 'Legible'], ['mono', 'Mono']], settings.font, (v) => { settings.font = v; applyAppearance(); saveSettings(); }));
  body.appendChild(el('<div style="height:8px"></div>'));
  body.appendChild(segRow([['left', 'Izquierda'], ['justify', 'Justificado']], settings.align, (v) => { settings.align = v; applyAppearance(); saveSettings(); }));
  body.appendChild(sectionTitle('Tema'));
  body.appendChild(segRow([['auto', 'Auto'], ['light', 'Claro'], ['sepia', 'Sepia'], ['dark', 'Oscuro'], ['black', 'Negro']], settings.theme, (v) => { settings.theme = v; applyAppearance(); saveSettings(); }));
  body.appendChild(sectionTitle('Seguimiento'));
  body.appendChild(switchRow('Seguir la lectura', 'Desplaza el texto automáticamente hasta la frase que se está leyendo.', settings.follow, (v) => { settings.follow = v; saveSettings(); }));
  body.appendChild(switchRow('Resaltar frase y palabra', null, settings.highlight, (v) => { settings.highlight = v; applyAppearance(); saveSettings(); }));
  const wh = el('<div class="row"><div class="grow"><div class="label">Resaltado de palabra</div><div class="desc"></div></div></div>');
  $('.desc', wh).textContent = engine.boundarySeen
    ? 'Tu motor de voz informa la palabra exacta.'
    : 'En Android el motor de voz no informa cada palabra; «Estimado» la aproxima por tiempo.';
  body.appendChild(wh);
  body.appendChild(segRow([['auto', 'Exacto'], ['estimate', 'Estimado'], ['off', 'No']], settings.wordHighlight, (v) => { settings.wordHighlight = v; saveSettings(); }));
  body.appendChild(switchRow('Mostrar números de página', 'Para documentos PDF.', settings.showPages, (v) => { settings.showPages = v; applyAppearance(); saveSettings(); }));
  openSheet('Apariencia', body);
});

// =================================================================== ajustes generales

$('#btn-settings').addEventListener('click', openSettings);

async function openSettings() {
  const body = el('<div></div>');
  body.appendChild(sectionTitle('Pausas y puntuación'));
  body.appendChild(rangeRow('Entre párrafos', { min: 0, max: 2000, step: 50, value: settings.paraPause, format: (v) => `${(v / 1000).toFixed(2)} s`, onInput: (v) => { settings.paraPause = v; saveSettings(); } }));
  body.appendChild(rangeRow('En títulos', { min: 0, max: 3000, step: 50, value: settings.headingPause, format: (v) => `${(v / 1000).toFixed(2)} s`, onInput: (v) => { settings.headingPause = v; saveSettings(); } }));
  body.appendChild(rangeRow('Extra entre frases', { min: 0, max: 1000, step: 50, value: settings.sentencePause, format: (v) => `${(v / 1000).toFixed(2)} s`, onInput: (v) => { settings.sentencePause = v; saveSettings(); } }));
  body.appendChild(switchRow('Expandir abreviaturas', '«Sr.» → señor, «pág.» → página, «EE. UU.» → Estados Unidos…', settings.expandAbbr, (v) => { settings.expandAbbr = v; saveSettings(); }));
  body.appendChild(switchRow('Omitir llamadas de nota', 'No leer marcas como [12] o superíndices.', settings.skipRefs, (v) => { settings.skipRefs = v; saveSettings(); }));
  body.appendChild(switchRow('Omitir direcciones web', 'Lee «enlace» en lugar de la URL completa.', settings.skipUrls, (v) => { settings.skipUrls = v; saveSettings(); }));
  const dictBtn = el('<button class="list-item"><svg class="ic"><use href="#i-voice"/></svg><div class="grow"><div class="t">Diccionario de pronunciación</div><div class="sub"></div></div><svg class="ic"><use href="#i-chev-right"/></svg></button>');
  $('.sub', dictBtn).textContent = `${(settings.dictionary || []).length} regla(s) · corrige cómo se leen nombres, siglas o palabras`;
  dictBtn.onclick = openDictionary;
  body.appendChild(dictBtn);

  body.appendChild(sectionTitle('Reproducción'));
  const unitRow = el('<div class="row"><div class="grow"><div class="label">Botones ⏮ ⏭ del auricular y pantalla de bloqueo</div></div></div>');
  body.appendChild(unitRow);
  body.appendChild(segRow([['sentence', 'Saltan frase'], ['paragraph', 'Saltan párrafo']], settings.skipUnit, (v) => { settings.skipUnit = v; saveSettings(); }));
  body.appendChild(switchRow('Controles en pantalla de bloqueo', 'Muestra la notificación multimedia y ayuda a seguir leyendo con la pantalla apagada.', settings.mediaSession, (v) => { settings.mediaSession = v; applyAppearance(); saveSettings(); }));
  body.appendChild(switchRow('Mantener la pantalla encendida', 'Mientras se lee en voz alta.', settings.keepScreenOn, (v) => { settings.keepScreenOn = v; applyAppearance(); saveSettings(); }));
  body.appendChild(switchRow('Leer al abrir un documento', 'Empieza automáticamente donde te quedaste.', settings.autoPlay, (v) => { settings.autoPlay = v; saveSettings(); }));

  body.appendChild(sectionTitle('Importación'));
  body.appendChild(switchRow('Limpiar PDF', 'Quita encabezados, pies y números de página repetidos y une las líneas cortadas.', settings.pdfCleanup, (v) => { settings.pdfCleanup = v; saveSettings(); }));

  body.appendChild(sectionTitle('Datos'));
  const storage = el('<p class="muted small">Calculando espacio…</p>');
  body.appendChild(storage);
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(async (est) => {
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      storage.textContent = `Espacio usado: ${(est.usage / 1048576).toFixed(1)} MB${persisted ? ' · almacenamiento persistente activado' : ''}`;
    });
  } else storage.remove();
  const dataBtns = el(`<div class="btn-row">
    <button class="btn secondary" id="st-export"><svg class="ic"><use href="#i-download"/></svg> Exportar respaldo</button>
    <button class="btn secondary" id="st-import"><svg class="ic"><use href="#i-upload"/></svg> Importar respaldo</button></div>`);
  body.appendChild(dataBtns);
  body.appendChild(el('<p class="muted small">El respaldo incluye textos, progreso, marcadores, ajustes y diccionario. Úsalo para pasar tu biblioteca a otro teléfono.</p>'));
  const wipe = el('<div class="btn-row"><button class="btn danger">Borrar todos los datos</button></div>');
  body.appendChild(wipe);

  body.appendChild(sectionTitle('Ayuda'));
  body.appendChild(el(voiceHelpHtml()));
  body.appendChild(el(`<div class="note"><b>Instalar la app</b><br>
    Android (Chrome): menú ⋮ → <i>Instalar aplicación</i> o <i>Agregar a pantalla principal</i>.<br>
    iPhone (Safari): botón Compartir → <i>Agregar a inicio</i>.<br>
    Una vez instalada funciona sin conexión. En Android también puedes <i>Compartir</i> un PDF o EPUB desde otra app hacia «En Voz Alta».</div>`));
  body.appendChild(el(`<div class="note"><b>Limitaciones conocidas</b><ul>
    <li>Con la pantalla apagada la lectura depende del navegador; si se detiene, activa «Mantener la pantalla encendida».</li>
    <li>Los PDF escaneados (sólo imagen) no tienen texto y no pueden leerse.</li>
    <li>La calidad de la voz depende de las voces instaladas en el dispositivo.</li></ul></div>`));
  body.appendChild(el(`<p class="muted small" style="text-align:center">En Voz Alta ${VERSION} · Tus archivos nunca salen de este dispositivo.</p>`));

  openSheet('Ajustes', body);
  $('#st-export').onclick = exportBackup;
  $('#st-import').onclick = () => $('#backup-input').click();
  $('button', wipe).onclick = async () => {
    if (!confirm('¿Borrar toda la biblioteca, el progreso y los ajustes? Esta acción no se puede deshacer.')) return;
    const docs = await db.listDocs();
    for (const d of docs) await db.deleteDocument(d.id);
    await db.del('settings');
    settings = { ...DEFAULTS, voices: {}, dictionary: [] };
    applyAppearance();
    closeSheet();
    renderLibrary();
    toast('Datos borrados');
  };
}

// ------------------------------------------------------------ diccionario

function openDictionary() {
  const body = el('<div></div>');
  body.appendChild(el('<p class="muted small">Reemplaza palabras al leer en voz alta (no cambia el texto mostrado). Deja «Se lee como» vacío para omitir una palabra.</p>'));
  const form = el(`<div>
    <div class="field"><label>Texto original</label><input id="dc-from" placeholder="Ej.: Hermione"></div>
    <div class="field"><label>Se lee como</label><input id="dc-to" placeholder="Ej.: Hermáioni"></div>
    <label class="row"><div class="grow"><div class="label">Expresión regular</div><div class="desc">Para usuarios avanzados.</div></div><span class="switch"><input type="checkbox" id="dc-re"><span></span></span></label>
    <label class="row"><div class="grow"><div class="label">Distinguir mayúsculas</div></div><span class="switch"><input type="checkbox" id="dc-case"><span></span></span></label>
    <div class="btn-row"><button class="btn secondary" id="dc-test">Probar</button><button class="btn primary" id="dc-add">Agregar regla</button></div>
  </div>`);
  body.appendChild(form);
  const list = el('<div></div>');
  const renderRules = () => {
    list.innerHTML = '';
    const rules = settings.dictionary || [];
    list.appendChild(sectionTitle(rules.length ? `Reglas (${rules.length})` : 'Sin reglas'));
    rules.forEach((r, i) => {
      const row = el(`<div class="dict-rule"><code></code><span>→</span><code></code><button class="icon-btn" aria-label="Eliminar"><svg class="ic"><use href="#i-trash"/></svg></button></div>`);
      const codes = $$('code', row);
      codes[0].textContent = r.from + (r.regex ? '  (regex)' : '');
      codes[1].textContent = r.to || '(omitir)';
      $('button', row).onclick = () => {
        settings.dictionary = rules.filter((_, j) => j !== i);
        saveSettings();
        renderRules();
      };
      list.appendChild(row);
    });
  };
  body.appendChild(list);
  renderRules();
  openSheet('Diccionario de pronunciación', body);
  $('#dc-add').onclick = () => {
    const from = $('#dc-from').value.trim();
    if (!from) return toast('Escribe el texto original');
    const rule = { from, to: $('#dc-to').value.trim(), regex: $('#dc-re').checked, caseSensitive: $('#dc-case').checked, enabled: true };
    if (rule.regex) {
      try { new RegExp(rule.from, 'u'); } catch (e) { return toast('Expresión regular inválida'); }
    }
    settings.dictionary = [...(settings.dictionary || []), rule];
    saveSettings();
    $('#dc-from').value = '';
    $('#dc-to').value = '';
    renderRules();
    toast('Regla agregada');
  };
  $('#dc-test').onclick = () => {
    const from = $('#dc-from').value.trim();
    if (!from) return;
    const rule = { from, to: $('#dc-to').value.trim(), regex: $('#dc-re').checked, caseSensitive: $('#dc-case').checked };
    const spoken = toSpeech(from, { lang: current?.meta?.lang || 'es', dict: compileDictionary([rule]) });
    engine.cancel();
    const v = player.voice || engine.pickVoice(current?.meta?.lang || 'es', settings.voices[current?.meta?.lang || 'es']);
    engine.speak(spoken || '(se omite)', { voice: v, rate: settings.rate, pitch: settings.pitch });
  };
}

// ------------------------------------------------------------ respaldo

async function exportBackup() {
  busy('Preparando respaldo…');
  try {
    const docs = await db.listDocs();
    const contents = [];
    for (const d of docs) contents.push(await db.getContent(d.id));
    const data = { app: 'en-voz-alta', version: 1, exportedAt: new Date().toISOString(), settings, docs, contents };
    const date = new Date().toISOString().slice(0, 10);
    download(`en-voz-alta-respaldo-${date}.json`, JSON.stringify(data), 'application/json');
  } finally {
    busy(false);
  }
}

$('#backup-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  busy('Importando respaldo…');
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'en-voz-alta') throw new Error('El archivo no es un respaldo de En Voz Alta.');
    const byId = new Map((data.contents || []).filter(Boolean).map((c) => [c.id, c]));
    let n = 0;
    for (const d of data.docs || []) {
      const c = byId.get(d.id);
      if (!c) continue;
      await db.addDocument(d, c);
      n++;
    }
    if (data.settings && confirm('¿Restaurar también los ajustes y el diccionario del respaldo?')) {
      settings = { ...DEFAULTS, ...data.settings };
      await db.set('settings', settings);
      applyAppearance();
      player.configure(settings);
    }
    closeSheet();
    await renderLibrary();
    toast(`${n} documento(s) restaurado(s)`);
  } catch (err) {
    alert('No se pudo importar el respaldo: ' + err.message);
  } finally {
    busy(false);
  }
});

// =================================================================== instalación y service worker

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $('#install-banner').classList.remove('hidden');
});
$('#btn-install').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  $('#install-banner').classList.add('hidden');
});
window.addEventListener('appinstalled', () => $('#install-banner').classList.add('hidden'));

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const onWaiting = (w) => {
      swWaiting = w;
      $('#update-banner').classList.remove('hidden');
    };
    if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) onWaiting(nw);
      });
    });
  }).catch((e) => console.warn('SW', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !swWaiting) return;
    reloading = true;
    location.reload();
  });
}
$('#btn-update').addEventListener('click', () => {
  if (player.playing) player.pause();
  saveProgress(true);
  if (swWaiting) swWaiting.postMessage({ type: 'SKIP_WAITING' });
});

// =================================================================== archivos compartidos

async function handleShared() {
  const params = new URLSearchParams(location.search);
  if (!params.has('share')) return;
  history.replaceState(null, '', location.pathname);
  let items = [];
  try { items = await takeSharedItems(); } catch {}
  const files = [];
  for (const it of items) {
    if (it.file) files.push(new File([it.file], it.name || 'documento', { type: it.type || it.file.type }));
    else if (it.text || it.url) {
      const text = [it.text, it.url].filter(Boolean).join('\n\n');
      try {
        const res = parsePlainText(text);
        res.title = it.title || res.paragraphs[0].x.slice(0, 60);
        res.format = 'texto';
        await saveParsed(res);
      } catch {}
    }
  }
  if (files.length) await importFiles(files);
  else await renderLibrary();
}

// =================================================================== inicio

async function init() {
  try {
    const saved = await db.get('settings');
    if (saved) settings = { ...DEFAULTS, ...saved, voices: { ...(saved.voices || {}) } };
  } catch {}
  $('#lib-sort').value = settings.sort;
  applyAppearance();
  player.configure(settings);
  history.replaceState({ root: true }, '');
  await renderLibrary();
  registerServiceWorker();
  engine.loadVoices();
  await handleShared();
  if (!engine.supported) toast('Este navegador no tiene síntesis de voz. Usa Chrome (Android) o Safari (iPhone).', { duration: 8000 });
  if (IS_IOS && !navigator.standalone && !localStorage.getItem('evz-ios-hint')) {
    try { localStorage.setItem('evz-ios-hint', '1'); } catch {}
    toast('Consejo: en Safari usa Compartir → «Agregar a inicio» para instalar la app.', { duration: 7000 });
  }
  if (IS_ANDROID) document.body.classList.add('android');
  // Abrir archivos con la app instalada (escritorio / ChromeOS)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      importFiles(files);
    });
  }
}

init();

// Exponer para depuración y pruebas automatizadas
window.__evz = { player, engine, db, settings: () => settings, importFiles };
