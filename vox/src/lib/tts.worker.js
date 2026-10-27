/*
 * vox/src/lib/tts.worker.js — the voice engines run here, never on the screen's thread.
 *
 * A passage takes seconds of solid CPU (or GPU) work; on the main thread that froze every tap.
 * Here it only keeps this worker busy. Storage stays on the main thread (Capacitor's file API
 * lives there), so model files are looked up and saved through messages — see lib/tts.js.
 *
 *   in:  { id, type: 'load', tier, threads } → { id, ok }      progress: { type: 'progress', ... }
 *        { id, type: 'synth', text, voice, speed } → { id, ok, samples (Int16, transferred), rate }
 *        { id, type: 'unload' }
 *   out: { type: 'cache', op: 'locate' | 'store', ... } ← answered by the main thread
 */
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { loadKitten } from './kitten/engine.js';
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import ortMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const onnx = env.backends.onnx;
/* the runtime ships inside the app — transformers.js would fetch it from a CDN, which fails offline */
onnx.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
onnx.wasm.proxy = false;

/* ---------- model files, stored by the main thread ---------- */

let seq = 0;
const waiting = new Map();
function ask(msg, transfer) {
  const id = 'c' + ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    postMessage({ type: 'cache', id, ...msg }, transfer || []);
  });
}

/* the stored file as a Response, or undefined */
async function locate(key) {
  const hit = await ask({ op: 'locate', key });
  if (!hit) return undefined;
  const body = hit.blob || (await fetch(hit.url)).body;
  return new Response(body, { headers: { 'Content-Length': String(hit.size) } });
}
const store = (key, buf) => ask({ op: 'store', key, buf }, [buf]).catch(() => { /* plays now, downloads next time */ });

env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  match: (key) => locate(String(key)),
  async put(key, response) { await store(String(key), await response.arrayBuffer()); },
};

/* Kitten loads its files itself: stored copy, else download (with progress) and store */
async function fetchFile(url, onProgress) {
  const hit = await locate(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if (onProgress) onProgress(buf.byteLength, buf.byteLength, true);
    return buf;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop()}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total || loaded, false);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  await store(url, out.buffer.slice(0));   // a copy goes to storage, this one to the engine
  return out.buffer;
}

/* ---------- engines ---------- */

let engine = null;   // { tier, tts }
let started = false;

async function load({ tier, device, dtype, kind, threads, saved }, progress) {
  if (engine && engine.tier === tier) return;
  if (engine && engine.tts.release) engine.tts.release();
  engine = null;
  if (!started) {
    onnx.wasm.numThreads = 1;   // one core per worker — VOX runs several workers instead
    started = true;
  }
  const report = (fromDevice, loaded, total) => {
    if (!total) return;
    const pct = (loaded / total) * 100;
    progress(fromDevice
      ? { phase: 'load', pct, label: 'from this phone' }
      : pct >= 100
        ? { phase: 'save', pct: 100, label: 'saving for offline use…' }
        : { phase: 'download', pct, label: `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` });
  };
  let tts;
  if (kind === 'kitten') {
    tts = await loadKitten(fetchFile, (l, t, dev) => report(saved || dev, l, t));
  } else {
    if (device === 'webgpu' && onnx.webgpu) onnx.webgpu.powerPreference = 'high-performance';
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype, device,
      progress_callback: (p) => {
        if (/\.onnx$/.test(p.file || '') && p.status === 'progress') report(saved, p.loaded, p.total);
      },
    });
  }
  /* warm-up: GPU shader compile / WASM JIT happens now, not inside the first real passage */
  progress({ phase: 'load', pct: 100, label: 'warming up' });
  try { await tts.generate('Ready.', { voice: kind === 'kitten' ? 'Bella' : 'af_heart' }); } catch { /* voice file offline */ }
  engine = { tier, tts };
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/* one job at a time, in arrival order */
let queue = Promise.resolve();

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cache-reply') {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (w) (m.error ? w.reject(new Error(m.error)) : w.resolve(m.value));
    return;
  }
  queue = queue.then(async () => {
    try {
      if (m.type === 'load') {
        await load(m, (p) => postMessage({ type: 'progress', id: m.id, ...p }));
        postMessage({ id: m.id, ok: true });
      } else if (m.type === 'synth') {
        if (!engine) throw new Error('voice engine not loaded');
        const a = await engine.tts.generate(m.text, { voice: m.voice, speed: m.speed });
        const samples = toInt16(a.audio);
        postMessage({ id: m.id, ok: true, samples, rate: a.sampling_rate }, [samples.buffer]);
      } else if (m.type === 'unload') {
        if (engine && engine.tts.release) engine.tts.release();
        engine = null;
        postMessage({ id: m.id, ok: true });
      }
    } catch (err) {
      postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
    }
  });
};
