/*
 * vox/src/lib/modelCache.js — keep the voice model on the phone for good.
 *
 * transformers.js caches downloads with the browser Cache API, but Chrome fails a single
 * 92–326 MB put() ("Failed to execute 'put' on 'Cache': Unexpected internal error") and
 * transformers.js only logs it — the model would download again on every launch. So:
 *
 *  - Android (Capacitor): model files are written as plain files in the app's private
 *    data folder (no browser quota, survives restarts, removed only on uninstall) and
 *    read back through Capacitor's local file server, so nothing big crosses the bridge
 *    on load.
 *  - Browser: store model files as Blobs in IndexedDB (handles 330 MB fine), and ask for
 *    persistent storage so the browser doesn't evict them.
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { env } from '@huggingface/transformers';

const DIR = 'vox-models';
const CHUNK = 3 * 1024 * 1024;   // write in 3 MB slices — base64 of a whole model would OOM a phone

const native = () => Capacitor.isNativePlatform();

function fileFor(key) {
  /* https://huggingface.co/<repo>/resolve/main/onnx/model.onnx → onnx__model.onnx (+ short hash for uniqueness) */
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const tail = key.split('/resolve/').pop().replace(/[^\w.-]+/g, '__').slice(-80);
  return `${DIR}/${(h >>> 0).toString(36)}-${tail}`;
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function nativeSize(path) {
  try {
    const st = await Filesystem.stat({ path, directory: Directory.Data });
    return st.size || 0;
  } catch { return 0; }
}
const nativeExists = async (path) => (await nativeSize(path)) > 0;

/* transformers.js reads into one preallocated buffer when it knows the size — without
   Content-Length it grows the buffer piece by piece, which crawls on a 326 MB file */
const sized = (body, size) => new Response(body, { headers: { 'Content-Length': String(size) } });

const nativeCache = {
  async match(key) {
    const path = fileFor(String(key));
    const size = await nativeSize(path);
    if (!size) return undefined;
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
    const res = await fetch(Capacitor.convertFileSrc(uri));
    return res.ok ? sized(res.body, size) : undefined;
  },
  async put(key, response) {
    const path = fileFor(String(key));
    const tmp = path + '.part';   // renamed only when complete — a killed app never leaves a broken model
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      await Filesystem.mkdir({ path: DIR, directory: Directory.Data, recursive: true });
    } catch { /* already exists */ }
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const data = toBase64(bytes.subarray(off, off + CHUNK));
      if (off === 0) await Filesystem.writeFile({ path: tmp, data, directory: Directory.Data });
      else await Filesystem.appendFile({ path: tmp, data, directory: Directory.Data });
    }
    try { await Filesystem.deleteFile({ path, directory: Directory.Data }); } catch { /* none yet */ }
    await Filesystem.rename({ from: tmp, to: path, directory: Directory.Data, toDirectory: Directory.Data });
  },
};

/* ---------- browser: IndexedDB ---------- */

let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('vox-models', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { idbPromise = null; reject(req.error); };
    });
  }
  return idbPromise;
}

function idbReq(mode, fn) {
  return idb().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('files', mode);
    const req = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const idbCache = {
  async match(key) {
    const blob = await idbReq('readonly', (st) => st.get(String(key)));
    return blob ? sized(blob, blob.size) : undefined;
  },
  async put(key, response) {
    const blob = await response.blob();
    await idbReq('readwrite', (st) => st.put(blob, String(key)));
  },
};

let installed = false;

/* call before the first from_pretrained() */
export function installModelCache() {
  if (installed) return;
  installed = true;
  if (native()) {
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = nativeCache;
  } else if (typeof indexedDB !== 'undefined') {
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = idbCache;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
}

/* is this exact model file already on the device? */
export async function isCached(url) {
  try {
    if (native()) return await nativeExists(fileFor(url));
    if (typeof indexedDB === 'undefined') return false;
    return (await idbReq('readonly', (st) => st.count(url))) > 0;
  } catch { return false; }
}

/*
 * for engines that don't go through transformers.js (Kitten): same store, same offline rule.
 * onProgress(loaded, total, fromDevice)
 */
export async function fetchModelFile(url, onProgress) {
  installModelCache();
  const store = native() ? nativeCache : typeof indexedDB !== 'undefined' ? idbCache : null;
  const hit = store && await store.match(url).catch(() => undefined);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if (onProgress) onProgress(buf.byteLength, buf.byteLength, true);
    return buf;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop()}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  let buf;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const parts = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      onProgress(loaded, total || loaded, false);
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    buf = out.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  if (store) await store.put(url, new Response(buf)).catch(() => { /* plays now, downloads again next time */ });
  return buf;
}

/* ---------- storage report + cleanup ---------- */

const prettyName = (name) => name.replace(/^[a-z0-9]+-/, '').replace(/^main__/, '').replace(/__/g, '/');

/* every voice-model file kept on this device: [{ name, bytes }] */
export async function modelReport() {
  const files = [];
  try {
    if (native()) {
      const { files: list } = await Filesystem.readdir({ path: DIR, directory: Directory.Data });
      for (const f of list) files.push({ name: prettyName(f.name), bytes: f.size || 0 });
    } else if (typeof indexedDB !== 'undefined') {
      await idb().then((d) => new Promise((resolve, reject) => {
        const t = d.transaction('files', 'readonly');
        t.objectStore('files').openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return;
          files.push({ name: String(c.key).split('/resolve/main/').pop(), bytes: (c.value && c.value.size) || 0 });
          c.continue();
        };
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      }));
    }
  } catch { /* nothing saved yet */ }
  /* the narrator voices (~0.5 MB each) live in kokoro-js's own Cache API store */
  try {
    if (typeof caches !== 'undefined') {
      const c = await caches.open('kokoro-voices');
      for (const req of await c.keys()) {
        const res = await c.match(req);
        files.push({ name: 'voices/' + req.url.split('/').pop(), bytes: res ? (await res.blob()).size : 0 });
      }
    }
  } catch { /* no voices cached */ }
  return files;
}

/* remove the model + voices; the next play downloads them again */
export async function clearModel() {
  try {
    if (native()) await Filesystem.rmdir({ path: DIR, directory: Directory.Data, recursive: true });
    else if (typeof indexedDB !== 'undefined') await idbReq('readwrite', (st) => st.clear());
  } catch { /* already gone */ }
  try {
    if (typeof caches !== 'undefined') {
      await caches.delete('kokoro-voices');
      await caches.delete('transformers-cache');   // small leftovers from before the model store existed
    }
  } catch { /* ignore */ }
}
