// Pestaña «Explorar»: catálogo de libros gratuitos y legales (dominio público).
import { SOURCES } from './catalog/index.js';

const $ = (sel, root = document) => root.querySelector(sel);

const LANG_CHIPS = [
  ['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'],
  ['it', 'Italiano'], ['de', 'Alemán'], ['', 'Todos']
];

let deps = null;
let state = null;
let ticket = 0;
let downloadingId = null;
let directBlocked = false; // el sitio no permite descargas directas (CORS)

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function chip(label, on, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (on ? ' on' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function source() {
  return SOURCES.find((s) => s.id === state.source) || SOURCES[0];
}

function saveState() {
  try { localStorage.setItem('evz-explore', JSON.stringify({ source: state.source, lang: state.lang, cat: state.cat, sort: state.sort })); } catch {}
}

function loadState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('evz-explore') || '{}'); } catch {}
  const nav = (navigator.language || 'es').slice(0, 2);
  return {
    source: saved.source || SOURCES[0].id,
    lang: saved.lang ?? (LANG_CHIPS.some(([c]) => c === nav) ? nav : 'es'),
    cat: saved.cat || '',
    sort: saved.sort || '',
    q: '',
    page: 1,
    next: null,
    items: [],
    loading: false
  };
}

function renderFilters() {
  const src = source();
  const sources = $('#ex-sources');
  sources.innerHTML = '';
  if (SOURCES.length > 1) {
    for (const s of SOURCES) sources.appendChild(chip(s.name, s.id === src.id, () => {
      state.source = s.id;
      state.cat = '';
      state.sort = '';
      saveState();
      renderFilters();
      search();
    }));
  } else sources.classList.add('hidden');

  const langs = $('#ex-langs');
  langs.innerHTML = '';
  for (const [code, label] of LANG_CHIPS) {
    if (src.languages && !src.languages.includes(code)) continue;
    langs.appendChild(chip(label, state.lang === code, () => { state.lang = code; saveState(); renderFilters(); search(); }));
  }

  const cats = $('#ex-cats');
  cats.innerHTML = '';
  cats.appendChild(chip('Todas las categorías', !state.cat, () => { state.cat = ''; saveState(); renderFilters(); search(); }));
  for (const c of src.categories) {
    cats.appendChild(chip(c.label, state.cat === c.id, () => { state.cat = c.id; saveState(); renderFilters(); search(); }));
  }

  const sort = $('#ex-sort');
  sort.innerHTML = '';
  for (const s of src.sorts) sort.appendChild(new Option(s.label, s.id));
  if (!src.sorts.some((s) => s.id === state.sort)) state.sort = src.sorts[0].id;
  sort.value = state.sort;
  $('#ex-note').textContent = src.note || '';
}

function setStatus(text) {
  $('#ex-status').textContent = text || '';
}

async function search({ append = false } = {}) {
  const my = ++ticket;
  const src = source();
  if (!append) {
    state.page = 1;
    state.items = [];
    $('#ex-list').innerHTML = '';
  }
  $('#ex-more').classList.add('hidden');
  if (navigator.onLine === false) {
    setStatus('Necesitas conexión a internet para explorar el catálogo. Los libros que agregues sí funcionan sin conexión.');
    return;
  }
  state.loading = true;
  setStatus(append ? 'Cargando más…' : 'Buscando…');
  try {
    if (!append) {
      const docs = await deps.listDocs();
      state.owned = new Map(docs.filter((d) => d.sourceId).map((d) => [d.sourceId, d.id]));
    }
    const res = await src.search({ q: state.q, lang: state.lang, cat: state.cat, sort: state.sort, page: state.page });
    if (my !== ticket) return;
    state.items.push(...res.items);
    state.next = res.next;
    const list = $('#ex-list');
    for (const b of res.items) list.appendChild(bookCard(b, src));
    if (!state.items.length) setStatus('No se encontraron libros con esos filtros.');
    else setStatus(res.total ? `${res.total.toLocaleString('es')} libros encontrados` : '');
    $('#ex-more').classList.toggle('hidden', !res.next);
  } catch (e) {
    if (my !== ticket) return;
    console.error(e);
    setStatus(`No se pudo consultar ${src.name}. Revisa tu conexión e inténtalo de nuevo.`);
  } finally {
    if (my === ticket) state.loading = false;
  }
}

function coverFor(b) {
  const cover = el('<div class="cover"></div>');
  const fallback = () => {
    cover.innerHTML = '';
    cover.classList.add('fallback');
    cover.style.background = deps.hashColor(b.title);
    cover.textContent = deps.initials(b.title);
  };
  if (b.cover) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = fallback;
    img.src = b.cover;
    cover.appendChild(img);
  } else fallback();
  return cover;
}

function bookCard(b, src) {
  const card = el(`<div class="card ex-card">
    <div class="card-main">
      <div class="card-title"></div>
      <div class="card-author"></div>
      <div class="subjects"></div>
      <div class="card-meta"></div>
      <div class="ex-actions"></div>
    </div></div>`);
  card.insertBefore(coverFor(b), card.firstChild);
  card.dataset.key = `${b.source}:${b.id}`;
  $('.card-title', card).textContent = b.title;
  const author = $('.card-author', card);
  if (b.authors.length) {
    const a = document.createElement('button');
    a.className = 'linklike';
    a.textContent = b.authors.join(', ');
    a.title = 'Ver más libros de este autor';
    a.addEventListener('click', () => {
      const name = b.authorQuery || b.authors[0];
      $('#ex-search').value = name;
      state.q = name;
      search();
      $('#explore').scrollTop = 0;
    });
    author.appendChild(a);
  }
  $('.subjects', card).textContent = (b.subjects || []).slice(0, 4).join(' · ');
  const meta = $('.card-meta', card);
  const badge = el('<span class="badge"></span>');
  badge.textContent = b.format || '';
  meta.appendChild(badge);
  const span = (t) => { const x = document.createElement('span'); x.textContent = t; meta.appendChild(x); };
  if (b.lang) span((b.lang || '').toUpperCase());
  if (b.year) span(String(b.year));
  if (b.downloads) span(`${b.downloads.toLocaleString('es')} descargas`);
  if (b.size) span(deps.fmtSize(b.size));
  const actions = $('.ex-actions', card);
  const add = el('<button class="btn primary ex-add"><svg class="ic"><use href="#i-download"/></svg> Agregar a mi biblioteca</button>');
  add.addEventListener('click', () => addBook(b, src, add));
  actions.appendChild(add);
  const web = el('<a class="btn secondary icon-only" target="_blank" rel="noopener" aria-label="Ver la ficha del libro" title="Ver la ficha del libro"><svg class="ic"><use href="#i-external"/></svg></a>');
  web.href = b.pageUrl;
  actions.appendChild(web);
  const owned = state.owned && state.owned.get(`${b.source}:${b.id}`);
  if (owned) add.replaceWith(openButton(owned));
  return card;
}

/** Actualiza las tarjetas con los libros que ya están en la biblioteca. */
async function refreshOwned() {
  const docs = await deps.listDocs();
  state.owned = new Map(docs.filter((d) => d.sourceId).map((d) => [d.sourceId, d.id]));
  for (const card of document.querySelectorAll('#ex-list .ex-card')) {
    const id = state.owned.get(card.dataset.key);
    const add = card.querySelector('.ex-add');
    const open = card.querySelector('.ex-open');
    if (id && add) add.replaceWith(openButton(id));
    if (!id && open) {
      const b = state.items.find((x) => `${x.source}:${x.id}` === card.dataset.key);
      if (b) {
        const btn = el('<button class="btn primary ex-add"><svg class="ic"><use href="#i-download"/></svg> Agregar a mi biblioteca</button>');
        btn.addEventListener('click', () => addBook(b, source(), btn));
        open.replaceWith(btn);
      }
    }
  }
}

function openButton(docId) {
  const open = el('<button class="btn secondary ex-open"><svg class="ic"><use href="#i-check"/></svg> En tu biblioteca · Abrir</button>');
  open.addEventListener('click', () => deps.openReader(docId));
  return open;
}

async function addBook(b, src, btn) {
  if (downloadingId) return deps.toast('Espera a que termine la descarga en curso');
  const proxy = deps.getProxy();
  // Sin servidor de descarga, Gutenberg no deja descargar desde la app: se guía al usuario
  if (!proxy && directBlocked) return browserDownload(b);
  downloadingId = b.id;
  const ctrl = new AbortController();
  deps.busy(`Descargando «${b.title}»…`, 0, { onCancel: () => ctrl.abort() });
  try {
    const file = await src.download(b, {
      proxy,
      signal: ctrl.signal,
      onProgress: (f) => deps.busy(`Descargando «${b.title}»…`, f, { onCancel: () => ctrl.abort() })
    });
    deps.busy(`Preparando «${b.title}»…`);
    const meta = await deps.importDownloaded(file, {
      title: b.title,
      author: b.authors.join(', '),
      lang: b.lang,
      sourceId: `${b.source}:${b.id}`,
      sourceUrl: b.pageUrl,
      coverUrl: b.cover && proxy ? src.viaProxy(b.cover, proxy) : b.cover
    });
    deps.busy(false);
    if (state.owned) state.owned.set(`${b.source}:${b.id}`, meta.id);
    btn.replaceWith(openButton(meta.id));
    deps.toast(`«${b.title}» está en tu biblioteca`, { action: 'Abrir', onAction: () => deps.openReader(meta.id), duration: 6000 });
  } catch (e) {
    deps.busy(false);
    if (e.name === 'AbortError') deps.toast('Descarga cancelada');
    else if (e.code === 'CORS' || e.name === 'TypeError') {
      if (proxy) {
        deps.toast('El servidor de descarga no respondió. Revisa su dirección en Ajustes.', { duration: 7000 });
      } else {
        directBlocked = true;
        browserDownload(b);
      }
    } else {
      const bad = /zip|central directory|no se encontró texto|formato no soportado/i.test(e.message);
      const msg = bad ? 'El archivo descargado no es un libro válido. Puedes bajarlo en otro formato desde su ficha.' : `No se pudo agregar el libro: ${e.message}`;
      deps.toast(msg, { action: 'Ficha', onAction: () => window.open(b.pageUrl, '_blank', 'noopener'), duration: 10000 });
    }
  } finally {
    downloadingId = null;
  }
}

/** Descarga en dos pasos: el navegador baja el archivo y luego se agrega con «Agregar archivo». */
function browserDownload(b) {
  const body = el(`<div>
    <p style="margin-top:0;line-height:1.5">Project Gutenberg no permite que otras apps descarguen sus libros directamente. Se hace en dos pasos:</p>
    <ol style="line-height:1.6;padding-left:20px">
      <li>Toca <b>Descargar en el navegador</b>. Se bajará el archivo del libro.</li>
      <li>Vuelve aquí, toca <b>Agregar archivo</b> y elige el libro en <i>Descargas</i>.</li>
    </ol>
    <div class="btn-row">
      <a class="btn primary" target="_blank" rel="noopener" id="bd-open"><svg class="ic"><use href="#i-download"/></svg> Descargar en el navegador</a>
    </div>
    <div class="btn-row">
      <button class="btn secondary" id="bd-add"><svg class="ic"><use href="#i-plus"/></svg> Agregar archivo</button>
    </div>
    <p class="muted small">¿Quieres descargar con un solo toque? Configura un servidor de descarga gratuito en <b>Ajustes → Explorar</b>.</p>
  </div>`);
  const a = body.querySelector('#bd-open');
  a.href = b.fileUrl || b.pageUrl;
  a.addEventListener('click', () => deps.toast('Cuando termine la descarga, toca «Agregar archivo».', { duration: 6000 }));
  body.querySelector('#bd-add').addEventListener('click', () => {
    deps.closeSheet();
    document.getElementById('file-input').click();
  });
  deps.openSheet(`«${b.title}»`, body);
}

export function initExplore(d) {
  deps = d;
  state = loadState();
  let started = false;
  const showTab = (tab) => {
    const explore = tab === 'explore';
    $('#tab-mine').classList.toggle('on', !explore);
    $('#tab-explore').classList.toggle('on', explore);
    $('#tab-mine').setAttribute('aria-selected', String(!explore));
    $('#tab-explore').setAttribute('aria-selected', String(explore));
    $('#mine').classList.toggle('hidden', explore);
    $('#explore').classList.toggle('hidden', !explore);
    document.querySelector('.fab-row').classList.toggle('hidden', explore);
    if (explore && !started) {
      started = true;
      renderFilters();
      search();
    } else if (explore) refreshOwned();
    if (!explore) deps.renderLibrary();
  };
  $('#tab-mine').addEventListener('click', () => showTab('mine'));
  $('#tab-explore').addEventListener('click', () => showTab('explore'));
  $('#empty-explore').addEventListener('click', () => showTab('explore'));
  let t = null;
  $('#ex-search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); search(); }, 450);
  });
  $('#ex-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(t); state.q = e.target.value.trim(); search(); e.target.blur(); }
  });
  $('#ex-sort').addEventListener('change', (e) => { state.sort = e.target.value; saveState(); search(); });
  $('#ex-more').addEventListener('click', () => {
    if (!state.next || state.loading) return;
    state.page = state.next;
    search({ append: true });
  });
  // Cargar más al llegar al final
  const body = $('#explore');
  body.addEventListener('scroll', () => {
    if (state.next && !state.loading && body.scrollTop + body.clientHeight > body.scrollHeight - 600) {
      state.page = state.next;
      search({ append: true });
    }
  }, { passive: true });
  return { showTab };
}

