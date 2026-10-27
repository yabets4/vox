/*
 * vox/src/lib/tts.js — on-device voice engines, in three tiers.
 *
 *  studio   Kokoro-82M fp32 on the GPU (WebGPU)   326 MB  best voice, needs a real GPU
 *  standard Kokoro-82M q8 on the CPU (WASM)         92 MB  same voices, most phones
 *  lite     KittenTTS nano fp32 on the CPU          60 MB  smaller + faster, plainer voice
 *
 * Each downloads once and stays on the device (lib/modelCache.js) → offline after that.
 */
import { Capacitor } from '@capacitor/core';
import { installModelCache, isCached, locateFile, storeFile } from './modelCache.js';

/* the voice engines themselves run in tts.worker.js — this file is the screen-side half */
const KITTEN_MODEL_URL = 'https://huggingface.co/KittenML/kitten-tts-nano-0.8-fp32/resolve/main/kitten_tts_nano_v0_8.onnx';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/* Kokoro: curated from the official quality grades — only B- or better. */
const KOKORO_VOICES = [
  { id: 'af_heart',   label: 'Heart    · female · US · A' },
  { id: 'af_bella',   label: 'Bella    · female · US · A-' },
  { id: 'af_nicole',  label: 'Nicole   · female · US · B-' },
  { id: 'bf_emma',    label: 'Emma     · female · UK · B-' },
  { id: 'am_michael', label: 'Michael  · male   · US · C+' },
  { id: 'am_fenrir',  label: 'Fenrir   · male   · US · C+' },
  { id: 'am_puck',    label: 'Puck     · male   · US · C+' },
  { id: 'bm_fable',   label: 'Fable    · male   · UK · C' },
  { id: 'bm_george',  label: 'George   · male   · UK · C' },
];
/* Kitten: ids are prefixed so their prepared audio never mixes with Kokoro's */
const KITTEN_VOICES = [
  ['Bella', 'female'], ['Luna', 'female'], ['Rosie', 'female'], ['Kiki', 'female'],
  ['Leo', 'male'], ['Jasper', 'male'], ['Bruno', 'male'], ['Hugo', 'male'],
].map(([n, g]) => ({ id: 'kitten_' + n, label: `${n} · ${g} · US · lite` }));

export const TIERS = {
  studio:   { id: 'studio',   name: 'Studio',   engine: 'kokoro', device: 'webgpu', dtype: 'fp32', mb: 326,
              file: 'onnx/model.onnx', runsOn: 'Graphics chip (WebGPU)', blurb: 'Best voice. Needs a strong graphics chip.' },
  standard: { id: 'standard', name: 'Standard', engine: 'kokoro', device: 'wasm', dtype: 'q8', mb: 92,
              file: 'onnx/model_quantized.onnx', runsOn: 'Processor (WASM)', blurb: 'Same voices, compressed. Good for most phones.' },
  lite:     { id: 'lite',     name: 'Lite',     engine: 'kitten', device: 'wasm', dtype: 'fp32', mb: 60,
              runsOn: 'Processor (WASM)', blurb: 'Small and quick. Plainer voice, for older phones.' },
};
export const TIER_ORDER = ['studio', 'standard', 'lite'];

export const voicesFor = (tier) => (TIERS[tier].engine === 'kitten' ? KITTEN_VOICES : KOKORO_VOICES);
export const defaultVoice = (tier) => (TIERS[tier].engine === 'kitten' ? 'kitten_Bella' : 'af_heart');
export const DEFAULT_VOICE = 'af_heart';
export const voiceName = (id) => ([...KOKORO_VOICES, ...KITTEN_VOICES].find((v) => v.id === id) || KOKORO_VOICES[0]).label.split('·')[0].trim();

/* ---------- what this device can do ---------- */

let profilePromise = null;
/* { gpu, gpuName, memGB, cores, phone, recommended, why } — measured once per launch */
export function deviceProfile() {
  if (profilePromise) return profilePromise;
  profilePromise = (async () => {
    const phone = Capacitor.isNativePlatform() || /Android|iPhone|iPad/i.test(navigator.userAgent || '');
    const memGB = navigator.deviceMemory || null;   // bucketed (0.5…8) and missing on some browsers
    const cores = navigator.hardwareConcurrency || 4;
    let gpu = false, name = null;
    if (navigator.gpu) {
      try {
        const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        const i = (a && a.info) || {};
        if (a && !(a.isFallbackAdapter || i.isFallbackAdapter)) {   // a software GPU is no use
          gpu = true;
          const vendor = { nvidia: 'NVIDIA', intel: 'Intel', amd: 'AMD', qualcomm: 'Qualcomm', arm: 'ARM', apple: 'Apple' }[i.vendor] || i.vendor || 'GPU';
          name = [vendor, i.description || i.architecture].filter(Boolean).join(' ');
        }
      } catch { /* no adapter */ }
    }
    /* the fp32 file briefly needs ~2× its size in RAM while it is saved — phones need room */
    const mem = memGB || (phone ? 4 : 8);
    let recommended, why;
    if (gpu && mem >= (phone ? 6 : 4)) {
      recommended = 'studio';
      why = `${name || 'A graphics chip'}${memGB ? ` and ${memGB} GB memory` : ''}`;
    } else if (mem >= 4 && cores >= 4) {
      recommended = 'standard';
      why = gpu ? 'Not enough memory for Studio' : 'No usable graphics chip — runs on the processor';
    } else {
      recommended = 'lite';
      why = `${memGB ? memGB + ' GB memory' : 'Little memory'}, ${cores} cores — Kokoro would be slow here`;
    }
    return { gpu, gpuName: name, memGB, cores, phone, recommended, why };
  })();
  return profilePromise;
}

/* which GPU the browser actually hands out — on Windows the OS decides, not the page */
export async function gpuName() {
  return (await deviceProfile()).gpuName;
}

/* the chosen tier, made safe: Studio without a GPU falls back to Standard */
export async function resolveTier(choice) {
  const p = await deviceProfile();
  const t = choice && choice !== 'auto' && TIERS[choice] ? choice : p.recommended;
  return t === 'studio' && !p.gpu ? 'standard' : t;
}

/* measured speed says this tier can't keep up → the next lighter one, or null */
export function lighterTier(tier, rtf) {
  if (!(rtf > 2.5)) return null;
  return TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] || null;
}

export function enginePlan(tier) {
  const t = TIERS[tier];
  return t ? `${t.engine === 'kitten' ? 'Kitten nano' : 'Kokoro-82M'} · ${t.device === 'webgpu' ? 'WebGPU' : 'WASM'} · ${t.dtype} · ${t.mb} MB` : '';
}

/* the big file — the one that decides "download" vs "load from phone" */
export function modelUrl(tier) {
  const t = TIERS[tier];
  return t.engine === 'kitten' ? KITTEN_MODEL_URL : `https://huggingface.co/${MODEL_ID}/resolve/main/${t.file}`;
}

export function isModelSaved(tier) {
  installModelCache();
  return isCached(modelUrl(tier));
}

/* ---------- loading: everything heavy happens in workers ---------- */
/*
 * A pool of engine workers, one CPU core each, each with its own copy of the model. Several
 * passages are made at once (see lanes()), and the screen's thread never runs the model.
 * (One worker with several onnxruntime threads would be neater, but those threads never start
 *  inside a worker in this setup — the load just hangs.)
 */

let pool = [];       // [{ w, busy }]
let seqId = 0;
const pending = new Map();   // id → { resolve, reject, onProgress, slot }

function spawn() {
  const slot = { w: new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' }), busy: 0 };
  slot.w.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'cache') {   // the worker asks for / hands over a model file
      let value = null, error = null;
      try {
        value = m.op === 'locate' ? await locateFile(m.key) : await storeFile(m.key, m.buf);
      } catch (err) { error = (err && err.message) || String(err); }
      slot.w.postMessage({ type: 'cache-reply', id: m.id, value: value || null, error });
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); return; }
    pending.delete(m.id);
    slot.busy--;
    m.ok ? p.resolve(m) : p.reject(new Error(m.error));
  };
  slot.w.onerror = (e) => {
    const err = new Error('voice engine crashed: ' + (e.message || 'unknown'));
    for (const [id, p] of pending) if (p.slot === slot) { pending.delete(id); p.reject(err); }
    killPool();   // start clean next time
  };
  return slot;
}

function killPool() {
  for (const s of pool) s.w.terminate();
  pool = [];
  active = null;
}

function call(slot, msg, onProgress) {
  const id = ++seqId;
  slot.busy++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress, slot });
    slot.w.postMessage({ ...msg, id });
  });
}

let active = null;   // { tier, promise, size } — one tier in memory at a time

/* how many passages can be made at once right now (the producers run this many lanes) */
export const lanes = () => (active ? active.size : 1);

/* drop the engines from memory (their files were deleted) — the next load downloads again */
export function unloadEngine() {
  killPool();
}

/*
 * how many cores to give the voice. A page can't read CPU load, so measure it: run one tiny
 * busy-loop worker per core at the same time and see how many keep their solo speed. A core that
 * is busy (or a slow "little" core) falls behind. All idle → use them all; otherwise the idle
 * ones, never fewer than 3. Low battery → 3. Takes ~0.5 s, once per launch.
 */
let probed = null;
export const coreProbe = () => probed;   // { cores, idle, threads } for Settings
async function pickThreads() {
  const cores = navigator.hardwareConcurrency || 4;
  let idle = cores;
  try { idle = await idleCores(cores); } catch { idle = 3; }
  let n = idle >= cores ? cores : Math.max(3, idle);
  try {
    const b = navigator.getBattery ? await navigator.getBattery() : null;
    if (b && !b.charging && b.level < 0.2) n = 3;
  } catch { /* no battery info */ }
  n = Math.min(n, cores);
  probed = { cores, idle, threads: n };
  return n;
}

function spin(ms) {
  const src = `onmessage=(e)=>{const end=performance.now()+e.data;let n=0,x=0;` +
    `while(performance.now()<end){for(let i=0;i<2000;i++)x+=Math.sqrt(i*n);n++}postMessage(n+(x?0:0))}`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return (count) => Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const w = new Worker(url);
    w.onmessage = (e) => { resolve(e.data); w.terminate(); };
    w.onerror = (e) => { reject(e); w.terminate(); };
    w.postMessage(ms);
  }))).finally(() => URL.revokeObjectURL(url));
}

async function idleCores(cores) {
  const [solo] = await spin(150)(1);
  const all = await spin(250)(cores);
  const full = solo * (250 / 150);
  return all.filter((n) => n >= full * 0.7).length;
}

/* onProgress({ pct, label, phase }) — phase: 'download' | 'load' | 'save' */
export function loadEngine(tier, onProgress) {
  if (active && active.tier === tier) return active.promise;
  killPool();
  installModelCache();
  const t = TIERS[tier];
  const promise = Promise.all([pickThreads(), isModelSaved(tier), deviceProfile()]).then(async ([cores, saved, prof]) => {
    /* GPU tier: one worker (the GPU is the parallel part). CPU tiers: one per usable core,
       held back on small-memory phones since every worker keeps its own model copy */
    const mem = prof.memGB || (prof.phone ? 4 : 8);
    const size = t.device === 'webgpu' ? 1 : Math.max(1, Math.min(cores, mem >= 6 ? 6 : mem >= 4 ? 3 : 1));
    if (probed) probed.threads = size;
    const msg = { type: 'load', tier, kind: t.engine, device: t.device, dtype: t.dtype, threads: 1 };
    /* the first worker downloads + stores the model; the rest then load it from the device */
    const first = spawn();
    pool = [first];
    await call(first, { ...msg, saved }, onProgress);
    const rest = Array.from({ length: size - 1 }, spawn);
    pool.push(...rest);
    if (onProgress && rest.length) onProgress({ phase: 'load', pct: 100, label: `starting ${size} voice workers` });
    await Promise.all(rest.map((s) => call(s, { ...msg, saved: true }).catch(() => {
      s.w.terminate();
      pool = pool.filter((x) => x !== s);   // fewer lanes is fine
    })));
    if (active && active.promise === promise) active.size = pool.length;
    return { tier };
  }).catch((err) => {
    if (active && active.promise === promise) killPool();   // allow retry after a failed download
    throw err;
  });
  active = { tier, promise, size: 1 };
  return promise;
}

const engineVoice = (id) => id.replace(/^kitten_/, '');

export async function synthesize(text, { voice, speed, onProgress }) {
  if (!active) throw new Error('voice engine not loaded');
  await active.promise;
  if (!pool.length) throw new Error('voice engine not loaded');
  const slot = pool.reduce((a, b) => (b.busy < a.busy ? b : a));   // least busy worker
  /* Int16 — half the RAM, and a phone holds many chunks for skip-back + export */
  const r = await call(slot, { type: 'synth', text, voice: engineVoice(voice), speed });
  onProgress && onProgress();
  return { samples: r.samples, rate: r.rate };
}

export function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/* ---------- speech chunker: sentence-boundary packing ---------- */

export function chunkForSpeech(text, maxLen = 260) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // split on sentence terminators, keep them attached
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [];
  const chunks = [];
  let cur = '';
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    // pathological mega-sentence: hard-split at word boundaries
    while (s.length > maxLen * 1.6) {
      let cut = s.lastIndexOf(' ', maxLen);
      if (cut < maxLen * 0.5) cut = maxLen;
      chunks.push(s.slice(0, cut));
      s = s.slice(cut).trim();
    }
    if (cur && (cur + ' ' + s).length > maxLen) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? cur + ' ' + s : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* ---------- wav export ---------- */

export function encodeWav(samplesList, rate) {
  let total = 0;
  for (const s of samplesList) total += s.length;
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, total * 2, true);
  let off = 44;
  for (const s of samplesList) {
    if (s instanceof Int16Array) {
      for (let i = 0; i < s.length; i++, off += 2) view.setInt16(off, s[i], true);
      continue;
    }
    for (let i = 0; i < s.length; i++, off += 2) {
      const v = Math.max(-1, Math.min(1, s[i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
