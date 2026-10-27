/*
 * vox/src/lib/library.js — the bookshelf, in IndexedDB.
 *
 * Two stores so a bookmark update never rewrites a whole novel:
 *   books — small metadata rows  { id, title, pages, words, total, idx, added, opened, finished }
 *   texts — the full text, keyed by book id
 *
 * Plus the spoken audio, so nothing is synthesized twice (slow phones need hours of prep):
 *   audio     — "<bookId>|<voice>|<speed>|<idx>" → { samples: Int16Array, rate }
 *   audioMeta — same key → seconds of audio (cheap to list without loading samples)
 */
const DB_NAME = 'vox';
const DB_VERSION = 2;

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts');
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
        if (!d.objectStoreNames.contains('audioMeta')) d.createObjectStore('audioMeta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

function run(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function listBooks() {
  const rows = await run('books', 'readonly', (t) => t.objectStore('books').getAll());
  return (rows || []).sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
}

export function getText(id) {
  return run('texts', 'readonly', (t) => t.objectStore('texts').get(id));
}

export async function addBook({ title, text, pages = null, words = 0, total = 0 }) {
  const now = Date.now();
  const meta = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 7),
    title: title || 'Untitled', pages, words, total, idx: 0, added: now, opened: now, finished: false,
  };
  await run(['books', 'texts'], 'readwrite', (t) => {
    t.objectStore('texts').put(text, meta.id);
    t.objectStore('books').put(meta);
  });
  return meta;
}

export function saveBook(meta) {
  return run('books', 'readwrite', (t) => t.objectStore('books').put(meta));
}

export async function deleteBook(id) {
  await run(['books', 'texts'], 'readwrite', (t) => {
    t.objectStore('books').delete(id);
    t.objectStore('texts').delete(id);
  });
  await deleteAudio(id + '|');
}

/* ---------- spoken audio ---------- */

const prefixRange = (prefix) => IDBKeyRange.bound(prefix, prefix + '￿');

export function putAudio(key, { samples, rate }) {
  return run(['audio', 'audioMeta'], 'readwrite', (t) => {
    t.objectStore('audio').put({ samples, rate }, key);
    t.objectStore('audioMeta').put(samples.length / rate, key);
  });
}

export function getAudio(key) {
  return run('audio', 'readonly', (t) => t.objectStore('audio').get(key));
}

/* idx → seconds for every chunk already made under this "<bookId>|<voice>|<speed>|" prefix */
export function listAudio(prefix) {
  return db().then((d) => new Promise((resolve, reject) => {
    const out = new Map();
    const req = d.transaction('audioMeta', 'readonly').objectStore('audioMeta').openCursor(prefixRange(prefix));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.set(Number(String(c.key).slice(prefix.length)), c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

/* delete one key, or everything under a prefix (key ending in "|") */
export function deleteAudio(keyOrPrefix) {
  const target = keyOrPrefix.endsWith('|') ? prefixRange(keyOrPrefix) : keyOrPrefix;
  return run(['audio', 'audioMeta'], 'readwrite', (t) => {
    t.objectStore('audio').delete(target);
    t.objectStore('audioMeta').delete(target);
  });
}

/* a book keeps audio for one voice+speed only — drop the rest */
export async function pruneAudio(bookId, keepPrefix) {
  const d = await db();
  const keys = await new Promise((resolve, reject) => {
    const req = d.transaction('audioMeta', 'readonly').objectStore('audioMeta').getAllKeys(prefixRange(bookId + '|'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const stale = keys.filter((k) => !String(k).startsWith(keepPrefix));
  if (!stale.length) return;
  await run(['audio', 'audioMeta'], 'readwrite', (t) => {
    for (const k of stale) { t.objectStore('audio').delete(k); t.objectStore('audioMeta').delete(k); }
  });
}

/* ---------- storage report + cleanup ---------- */

const BYTES_PER_SEC = 24000 * 2;   // Int16 mono @ 24 kHz

/* per book: text size, prepared audio size/length. Audio whose book is gone shows as an orphan row. */
export async function storageReport() {
  const d = await db();
  const books = await listBooks();
  const byBook = new Map(books.map((b) => [b.id, { id: b.id, title: b.title, textBytes: 0, audioSec: 0 }]));
  await new Promise((resolve, reject) => {
    const t = d.transaction(['texts', 'audioMeta'], 'readonly');
    t.objectStore('texts').openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      const row = byBook.get(c.key);
      if (row) row.textBytes = typeof c.value === 'string' ? c.value.length : 0;
      c.continue();
    };
    t.objectStore('audioMeta').openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      const id = String(c.key).split('|')[0];
      if (!byBook.has(id)) byBook.set(id, { id, title: null, textBytes: 0, audioSec: 0 });
      byBook.get(id).audioSec += c.value || 0;
      c.continue();
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  return [...byBook.values()].map((r) => ({ ...r, audioBytes: Math.round(r.audioSec * BYTES_PER_SEC) }));
}

export function clearAllAudio() {
  return run(['audio', 'audioMeta'], 'readwrite', (t) => {
    t.objectStore('audio').clear();
    t.objectStore('audioMeta').clear();
  });
}

export function clearLibrary() {
  return run(['books', 'texts', 'audio', 'audioMeta'], 'readwrite', (t) => {
    for (const name of ['books', 'texts', 'audio', 'audioMeta']) t.objectStore(name).clear();
  });
}
