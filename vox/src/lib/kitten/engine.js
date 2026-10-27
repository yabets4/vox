/*
 * vox/src/lib/kitten/engine.js — KittenTTS nano (fp32, ~60 MB — on WASM it runs ~1.7× faster than the int8 build) for phones too slow for Kokoro.
 *
 * Model: KittenML/kitten-tts-nano-0.8-fp32 (Apache-2.0). Text cleaning, phonemes and the symbol
 * table are adapted from kitten-tts-js (see NOTICE). Runs on the same onnxruntime-web that
 * transformers.js already loaded, and keeps its files in VOX's model store (lib/modelCache.js).
 */
import * as ort from 'onnxruntime-web';
import { fetchModelFile } from '../modelCache.js';
import { TextCleaner, basic_english_tokenize } from './text-cleaner.js';
import { TextPreprocessor } from './preprocess.js';
import { phonemize } from './phonemizer.js';

export const KITTEN_REPO = 'KittenML/kitten-tts-nano-0.8-fp32';
const BASE = `https://huggingface.co/${KITTEN_REPO}/resolve/main/`;
export const KITTEN_MODEL_URL = BASE + 'kitten_tts_nano_v0_8.onnx';
const VOICES_URL = BASE + 'voices.npz';
const CONFIG_URL = BASE + 'config.json';

const SAMPLE_RATE = 24000;
const AUDIO_TRIM = 5000;   // the model leaves a short tail of noise at the end of every clip
const MAX_PIECE = 400;     // characters per inference — VOX passages (≤ 260) normally fit in one

/* onProgress(loaded, total, fromDevice) covers the big .onnx file only */
export async function loadKitten(onProgress) {
  const [modelBuf, voicesBuf, configBuf] = await Promise.all([
    fetchModelFile(KITTEN_MODEL_URL, onProgress),
    fetchModelFile(VOICES_URL),
    fetchModelFile(CONFIG_URL),
  ]);
  const config = JSON.parse(new TextDecoder().decode(configBuf));
  const session = await ort.InferenceSession.create(new Uint8Array(modelBuf), { executionProviders: ['wasm'] });
  return new Kitten(session, readNpz(voicesBuf), config);
}

class Kitten {
  constructor(session, voices, config) {
    this.session = session;
    this.voices = voices;
    this.aliases = config.voice_aliases || {};
    this.priors = config.speed_priors || {};
    this.cleaner = new TextCleaner();
    this.pre = new TextPreprocessor({ remove_punctuation: false });
  }

  /* same shape as kokoro-js: { audio: Float32Array, sampling_rate } */
  async generate(text, { voice = 'Leo', speed = 1 } = {}) {
    const key = this.aliases[voice] || voice;
    const v = this.voices[key] || Object.values(this.voices)[0];
    const parts = [];
    for (const piece of pieces(text)) parts.push(await this.run(piece, key, v, speed));
    const out = new Float32Array(parts.reduce((t, p) => t + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return { audio: out, sampling_rate: SAMPLE_RATE };
  }

  async run(piece, key, v, speed) {
    const phon = basic_english_tokenize(await phonemize(this.pre.process(piece))).join(' ');
    const ids = this.cleaner.clean(phon);
    const [rows, dim] = v.shape;
    const ref = Math.min(ids.length, rows - 1);   // style row picked by text length, as upstream does
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      style: new ort.Tensor('float32', v.data.slice(ref * dim, (ref + 1) * dim), [1, dim]),
      speed: new ort.Tensor('float32', new Float32Array([speed * (this.priors[key] || 1)]), [1]),
    };
    const res = await this.session.run(feeds);
    const data = res[Object.keys(res)[0]].data;
    return data.slice(0, Math.max(0, data.length - AUDIO_TRIM));
  }

  release() { try { this.session.release(); } catch { /* already gone */ } }
}

/* split on sentence ends, keep pieces under MAX_PIECE, end each with punctuation (the model wants it) */
function pieces(text) {
  const end = (s) => (/[.!?,;:]$/.test(s) ? s : s + ',');
  const out = [];
  for (const raw of text.match(/[^.!?]+[.!?]*/g) || []) {
    let s = raw.trim();
    if (!s) continue;
    while (s.length > MAX_PIECE) {
      let cut = s.lastIndexOf(' ', MAX_PIECE);
      if (cut < MAX_PIECE / 2) cut = MAX_PIECE;
      out.push(end(s.slice(0, cut).trim()));
      s = s.slice(cut).trim();
    }
    if (s) out.push(end(s));
  }
  return out;
}

/* voices.npz: an uncompressed zip of float32 .npy arrays, (400, 256) each */
function readNpz(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('voices.npz is damaged');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = {};
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (method !== 0 || !name.endsWith('.npy')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out[name.replace(/\.npy$/, '')] = readNpy(buf.slice(start, start + size));
  }
  return out;
}

function readNpy(buf) {
  const v = new DataView(buf);
  const major = v.getUint8(6);
  const hlen = major >= 2 ? v.getUint32(8, true) : v.getUint16(8, true);
  const hoff = major >= 2 ? 12 : 10;
  const header = new TextDecoder().decode(new Uint8Array(buf, hoff, hlen));
  if (!/'descr':\s*'<f4'/.test(header)) throw new Error('unexpected voice format');
  const shape = (header.match(/'shape':\s*\(([^)]*)\)/)[1].match(/\d+/g) || []).map(Number);
  return { data: new Float32Array(buf, hoff + hlen), shape };
}
