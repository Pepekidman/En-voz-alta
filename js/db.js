// Almacenamiento local con IndexedDB: biblioteca, contenido y ajustes.

const DB_NAME = 'en-voz-alta';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('content')) db.createObjectStore('content', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transacción abortada'));
      })
  );
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async listDocs() {
    return tx('docs', 'readonly', (s) => reqP(s.getAll()));
  },
  async getDoc(id) {
    return tx('docs', 'readonly', (s) => reqP(s.get(id)));
  },
  async putDoc(doc) {
    return tx('docs', 'readwrite', (s) => { s.put(doc); });
  },
  async updateDoc(id, patch) {
    return tx('docs', 'readwrite', async (s) => {
      const cur = await reqP(s.get(id));
      if (cur) s.put(Object.assign(cur, patch));
    });
  },
  async getContent(id) {
    return tx('content', 'readonly', (s) => reqP(s.get(id)));
  },
  async putContent(content) {
    return tx('content', 'readwrite', (s) => { s.put(content); });
  },
  async addDocument(meta, content) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(['docs', 'content'], 'readwrite');
      t.objectStore('docs').put(meta);
      t.objectStore('content').put(content);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('No se pudo guardar (¿sin espacio?)'));
    });
  },
  async deleteDocument(id) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(['docs', 'content'], 'readwrite');
      t.objectStore('docs').delete(id);
      t.objectStore('content').delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async get(key) {
    return tx('kv', 'readonly', (s) => reqP(s.get(key)));
  },
  async set(key, value) {
    return tx('kv', 'readwrite', (s) => { s.put(value, key); });
  },
  async del(key) {
    return tx('kv', 'readwrite', (s) => { s.delete(key); });
  }
};

// Bandeja compartida con el service worker (archivos recibidos con "Compartir").
const SHARE_DB = 'en-voz-alta-share';

function openShare() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('inbox', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Extrae (y borra) los elementos compartidos pendientes. */
export async function takeSharedItems() {
  const d = await openShare();
  return new Promise((resolve, reject) => {
    const t = d.transaction('inbox', 'readwrite');
    const s = t.objectStore('inbox');
    const req = s.getAll();
    req.onsuccess = () => {
      s.clear();
      t.oncomplete = () => resolve(req.result || []);
    };
    t.onerror = () => reject(t.error);
  });
}
