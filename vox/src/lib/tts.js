/*
 * vox/src/lib/tts.js — on-device voice engines, in three tiers.
 *
 *  studio   Kokoro-82M fp32 on the GPU (WebGPU)   326 MB  best voice, needs a real GPU
 *  standard Kokoro-82M q8 on the CPU (WASM)         92 MB  same voices, most phones
 *  lite     KittenTTS nano int8 on the CPU          28 MB  smaller + faster, plainer voice
 *
 * Each downloads once and stays on the device (lib/modelCache.js) → offline after that.
 */
import { KokoroTTS } from 'kokoro-js';
import { Capacitor } from '@capacitor/core';
import { env } from '@huggingface/transformers';
import { installModelCache, isCached } from './modelCache.js';
import { loadKitten, KITTEN_MODEL_URL } from './kitten/engine.js';

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
  lite:     { id: 'lite',     name: 'Lite',     engine: 'kitten', device: 'wasm', dtype: 'int8', mb: 28,
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

/* ---------- loading ---------- */

let active = null;   // { tier, promise } — one engine in memory at a time

/* onProgress({ pct, label, phase }) — phase: 'download' | 'load' | 'save' */
export function loadEngine(tier, onProgress) {
  if (active && active.tier === tier) return active.promise;
  if (active) active.promise.then((e) => e.release && e.release()).catch(() => {});
  installModelCache();
  const t = TIERS[tier];
  const report = (saved, loaded, total) => {
    if (!onProgress || !total) return;
    const pct = (loaded / total) * 100;
    onProgress(saved
      ? { phase: 'load', pct, label: 'from this phone' }
      : pct >= 100
        ? { phase: 'save', pct: 100, label: 'saving for offline use…' }
        : { phase: 'download', pct, label: `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` });
  };

  const promise = isModelSaved(tier).then((saved) => {
    if (t.engine === 'kitten') return loadKitten((l, tot, dev) => report(saved || dev, l, tot));
    if (t.device === 'webgpu' && env.backends && env.backends.onnx && env.backends.onnx.webgpu) {
      /* laptops with two GPUs: ask for the discrete one (Windows Chrome also needs the OS setting) */
      env.backends.onnx.webgpu.powerPreference = 'high-performance';
    }
    return KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: t.dtype,
      device: t.device,
      progress_callback: (p) => {
        if (!/\.onnx$/.test(p.file || '')) return;   // the json files are tiny noise
        if (p.status === 'progress') report(saved, p.loaded, p.total);
      },
    });
  }).then(async (tts) => {
    /* one tiny warm-up run: GPU shader compile / WASM JIT happens here, not inside the first
       real passage — so the device-speed measurement isn't skewed and playback starts sooner */
    if (onProgress) onProgress({ phase: 'load', pct: 100, label: 'warming up' });
    try { await tts.generate('Ready.', { voice: engineVoice(defaultVoice(tier)) }); } catch { /* voice file offline — fine */ }
    return tts;
  }).catch((err) => {
    if (active && active.promise === promise) active = null;   // allow retry after a failed download
    throw err;
  });
  active = { tier, promise };
  return promise;
}

const engineVoice = (id) => id.replace(/^kitten_/, '');

/* one inference at a time — a skip/restart may fire while the old producer is mid-chunk */
let synthLock = Promise.resolve();

export async function synthesize(text, { voice, speed, onProgress }) {
  if (!active) throw new Error('voice engine not loaded');
  const tts = await active.promise;
  const run = synthLock.then(() => tts.generate(text, { voice: engineVoice(voice), speed }));
  synthLock = run.catch(() => {});
  const audio = await run;
  onProgress && onProgress();
  /* { audio: Float32Array, sampling_rate } — 24 kHz from both engines.
     Kept as Int16 — half the RAM, and a phone holds many chunks for skip-back + export. */
  return { samples: toInt16(audio.audio), rate: audio.sampling_rate };
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
