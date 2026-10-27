import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { extractPdfText } from './lib/pdf.js';
import {
  loadEngine, isModelSaved, synthesize, chunkForSpeech, encodeWav, DEFAULT_VOICE,
  TIERS, resolveTier, deviceProfile, voicesFor, defaultVoice, unloadEngine, lanes,
} from './lib/tts.js';
import { saveAudio } from './lib/save.js';
import {
  listBooks, getText, addBook, saveBook, deleteBook,
  putAudio, getAudio, listAudio, deleteAudio, pruneAudio, clearAllAudio, clearLibrary,
} from './lib/library.js';
import { TabBar, MiniPlayer, Toast } from './components/ui.jsx';
import Library from './pages/Library.jsx';
import Player from './pages/Player.jsx';
import Settings from './pages/Settings.jsx';
import Storage from './pages/Storage.jsx';
import { clearModel } from './lib/modelCache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUFFER_TARGET = 240;        // a (re)buffer aims for this many seconds of non-stop listening
const MAX_AHEAD_SEC = 45 * 60;    // stop preparing this far ahead of the playhead (disk space)
const KEEP_BEHIND = 40;           // chunks kept behind it (~10 min) for skip-back + WAV export

/* localStorage holds small prefs only — books live in IndexedDB (lib/library.js) */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('vox:' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('vox:' + k, JSON.stringify(v)); } catch { /* prefs just won't persist */ }
  },
  del(k) {
    try { localStorage.removeItem('vox:' + k); } catch { /* ignore */ }
  },
};

/*
 * How fast this device speaks, learned as it goes and remembered across launches — per tier,
 * since Kitten on the CPU and Kokoro on the GPU are very different speeds:
 *   rtf — seconds of work per second of audio (2.5 = makes speech 2.5× slower than it plays)
 *   spc — seconds of audio per character of text (for estimating what isn't made yet)
 */
const perf = { tier: null, rtf: 1, spc: 0.062, known: false };
function perfFor(tier) {
  if (perf.tier === tier) return;
  perf.tier = tier;
  const rtf = store.get('rtf:' + tier, null);
  perf.rtf = rtf === null ? 1 : rtf;
  perf.known = rtf !== null;
  perf.spc = store.get('spc:' + tier, 0.062);
}
function learnSpeed(workSec, audioSec, chars) {
  if (!(audioSec > 0)) return;
  const r = workSec / audioSec;
  perf.rtf = perf.known ? perf.rtf * 0.6 + r * 0.4 : r;   // first real measurement replaces the guess
  perf.known = true;
  perf.spc = perf.spc * 0.8 + (audioSec / Math.max(1, chars)) * 0.2;
  store.set('rtf:' + perf.tier, perf.rtf);
  store.set('spc:' + perf.tier, perf.spc);
}

const errMsg = (e) => (e && e.message ? e.message : String(e));
const countWords = (t) => (t.match(/\S+/g) || []).length;

export default function App() {
  /* ---------- navigation & hardware back button ---------- */
  const [history, setHistory] = useState(['library']);
  const historyRef = useRef(history);
  historyRef.current = history;
  const tab = history[history.length - 1] || 'library';

  const backInterceptors = useRef([]);
  const registerBack = useCallback((fn) => {
    backInterceptors.current.unshift(fn);
    return () => {
      backInterceptors.current = backInterceptors.current.filter((f) => f !== fn);
    };
  }, []);

  const go = useCallback((t) => {
    const cur = historyRef.current;
    if (cur[cur.length - 1] === t) return;
    const next = t === 'library' ? ['library'] : [...cur, t];
    historyRef.current = next;
    setHistory(next);
    try { window.history.pushState({ tab: t }, ''); } catch { /* sandboxed */ }
    window.scrollTo(0, 0);
  }, []);

  const goBack = useCallback(() => {
    // 1. Check registered modal/sheet interceptors
    for (const fn of backInterceptors.current) {
      try {
        if (fn()) return true;
      } catch { /* continue */ }
    }

    // 2. Pop navigation stack
    const cur = historyRef.current;
    if (cur.length > 1) {
      const next = cur.slice(0, -1);
      historyRef.current = next;
      setHistory(next);
      window.scrollTo(0, 0);
      return true;
    }

    if (cur[0] !== 'library') {
      const next = ['library'];
      historyRef.current = next;
      setHistory(next);
      window.scrollTo(0, 0);
      return true;
    }

    return false;
  }, []);

  useEffect(() => {
    try { window.history.replaceState({ tab: 'library' }, ''); } catch { /* sandboxed */ }

    let backListener;
    try {
      CapApp.addListener('backButton', () => {
        const handled = goBack();
        if (!handled) {
          CapApp.exitApp().catch(() => {});
        }
      }).then((handle) => {
        backListener = handle;
      }).catch(() => {});
    } catch { /* not native */ }

    const onPop = (e) => {
      const targetTab = (e.state && e.state.tab) || 'library';
      setHistory((cur) => {
        if (cur[cur.length - 1] === targetTab) return cur;
        if (cur.includes(targetTab)) {
          const idx = cur.lastIndexOf(targetTab);
          const next = cur.slice(0, idx + 1);
          historyRef.current = next;
          return next;
        }
        const next = [...cur, targetTab];
        historyRef.current = next;
        return next;
      });
    };
    window.addEventListener('popstate', onPop);

    return () => {
      if (backListener && backListener.remove) backListener.remove();
      window.removeEventListener('popstate', onPop);
    };
  }, [goBack]);

  /* ---------- library ---------- */
  const [books, setBooks] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [currentId, setCurrentId] = useState(null);
  const [currentText, setCurrentText] = useState('');
  const [importing, setImporting] = useState(null);
  const current = books.find((b) => b.id === currentId) || null;

  /* ---------- playback ---------- */
  const [engine, setEngine] = useState({ status: 'idle', label: '', pct: 0 });
  const [playback, setPlayback] = useState({ state: 'idle', idx: 0, count: 0 });
  const [voice, setVoice] = useState(() => store.get('voice', DEFAULT_VOICE));
  const [tierChoice, setTierChoice] = useState(() => store.get('tier', 'auto'));   // 'auto' | tier id
  const [tier, setTier] = useState(null);         // what actually runs, once the device is checked
  const [profile, setProfile] = useState(null);   // deviceProfile(): GPU, memory, recommendation
  const [speed, setSpeed] = useState(() => store.get('speed', 1));
  const [readyAhead, setReadyAhead] = useState(0);   // seconds of audio made ahead of the playhead
  const [error, setError] = useState('');

  const seq = useRef(null);          // { running, stop, failed, idx, total, el, url, analyser, actx, cancelChunk }
  const engineRef = useRef(null);
  const sigRef = useRef('');   // "<bookId>|<voice>|<speed>|" of the audio being played
  const actions = useRef({});
  const booted = useRef(false);
  const [prep, setPrep] = useState(null);     // { id, done, total, eta } of the book being saved
  const [queued, setQueued] = useState([]);   // book ids waiting their turn
  const prepRef = useRef(null);               // { id, stop } of the running job
  const prepQueue = useRef([]);
  const prepRun = useRef(null);

  const chunks = useMemo(() => chunkForSpeech(currentText), [currentText]);
  const savedIdx = current ? Math.max(0, Math.min(chunks.length - 1, current.idx || 0)) : 0;

  useEffect(() => { store.set('voice', voice); }, [voice]);
  useEffect(() => { store.set('tier', tierChoice); }, [tierChoice]);
  useEffect(() => { deviceProfile().then(setProfile); }, []);
  useEffect(() => {
    let alive = true;
    resolveTier(tierChoice).then((t) => { if (alive) setTier(t); });
    return () => { alive = false; };
  }, [tierChoice]);
  if (tier) perfFor(tier);
  const tierRef = useRef(tier);
  tierRef.current = tier;

  /* a saved book plays the voice + speed it was saved with, so its audio is used as-is */
  const playChoice = useCallback((b) => {
    const sv = b && b.saved;
    if (sv && (sv.complete || (tier && voicesFor(tier).some((v) => v.id === sv.voice)))) {
      return { voice: sv.voice, speed: sv.speed };
    }
    return { voice, speed };
  }, [voice, speed, tier]);

  /* each engine has its own narrators — remember the pick per engine, swap when the tier does */
  useEffect(() => {
    if (!tier) return;
    const eng = TIERS[tier].engine;
    if (voicesFor(tier).some((v) => v.id === voice)) store.set('voice:' + eng, voice);
    else setVoice(store.get('voice:' + eng, defaultVoice(tier)));
  }, [tier, voice]);
  useEffect(() => { store.set('speed', speed); }, [speed]);

  const patchBook = useCallback((id, patch) => {
    setBooks((bs) => bs.map((b) => {
      if (b.id !== id) return b;
      const nb = { ...b, ...patch };
      saveBook(nb).catch(() => {});
      return nb;
    }));
  }, []);

  const bookmark = useCallback((idx, extra) => {
    if (currentId) patchBook(currentId, { idx, opened: Date.now(), ...extra });
  }, [currentId, patchBook]);

  /* ---------- boot: load shelf, migrate the single-text era ---------- */
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      try {
        let bs = await listBooks();
        const legacy = store.get('text', '');
        if (legacy && legacy.trim() && !bs.length) {
          bs = [await addBook({
            title: store.get('title', '') || 'My first book', text: legacy,
            words: countWords(legacy), total: chunkForSpeech(legacy).length,
          })];
        }
        ['text', 'title', 'pos'].forEach(store.del);
        setBooks(bs);
        const cid = store.get('current', null);
        if (cid && bs.some((b) => b.id === cid)) {
          setCurrentText((await getText(cid)) || '');
          setCurrentId(cid);
        }
      } catch (e) {
        setError('Could not open your library: ' + errMsg(e));
      }
      setLoaded(true);
    })();
  }, []);

  /* ---------- debug / test hooks (harmless in production) ---------- */
  useEffect(() => {
    window.__vox = {
      synth: (text, v) => synthesize(text, { voice: v || voice, speed: 1 }),
      state: () => ({
        engine: engineRef.current, playback, tab, currentId,
        readyAhead, rtf: perf.rtf, tier, tierChoice, profile, prep, queued: prepQueue.current,
        seq: seq.current ? {
          running: seq.current.running, stop: seq.current.stop, idx: seq.current.idx, total: seq.current.total, sig: seq.current.sig,
          playing: !!seq.current.el && !seq.current.el.paused && !seq.current.el.ended,
          duration: seq.current.el ? seq.current.el.duration : 0,
          currentTime: seq.current.el ? seq.current.el.currentTime : 0,
        } : null,
      }),
    };
  });

  /* ---------- engine ---------- */
  const ensureEngine = useCallback(async () => {
    let t = tierRef.current || await resolveTier(tierChoice);
    for (;;) {
      if (engineRef.current && engineRef.current.tier === t) return engineRef.current.tts;
      engineRef.current = null;
      setEngine({ status: 'loading', phase: 'load', label: 'starting…', pct: 0 });
      const tts = await loadEngine(t, (p) => {
        if (tierRef.current && tierRef.current !== t) return;   // superseded — don't show its progress
        setEngine({ status: 'loading', phase: p.phase, label: p.label, pct: Math.round(p.pct) });
      });
      /* another tier was picked while this one loaded → load that one instead */
      if (tierRef.current && tierRef.current !== t) { t = tierRef.current; continue; }
      engineRef.current = { tier: t, tts };
      setEngine({ status: 'ready', label: 'ready', pct: 100, saved: true });
      return tts;
    }
  }, [tierChoice]);

  const warmUp = useCallback(async () => {
    try {
      await ensureEngine();
    } catch (e) {
      setEngine({ status: 'idle', label: '', pct: 0 });
      setError('Voice download failed — check your connection. ' + errMsg(e));
    }
  }, [ensureEngine]);

  /* voice already on the phone → load it quietly at launch so play starts fast, no network needed */
  useEffect(() => {
    if (!tier) return undefined;
    let alive = true;
    if (engineRef.current && engineRef.current.tier !== tier) {
      engineRef.current = null;          // another tier was picked — the old one is dropped
      setEngine({ status: 'idle', label: '', pct: 0 });
    }
    isModelSaved(tier).then((saved) => {
      if (alive) setEngine((e) => ({ ...e, saved }));
      if (alive && saved && !engineRef.current) warmUp();
    });
    return () => { alive = false; };
  }, [tier, warmUp]);

  /* ---------- audio graph ---------- */
  const teardown = useCallback((s) => {
    if (!s) return;
    s.stop = true;
    if (s.cancelChunk) s.cancelChunk();   // release the consumer's pending chunk promise
    if (s.el) { s.el.onended = null; s.el.onerror = null; s.el.pause(); s.el.removeAttribute('src'); }
    if (s.url) URL.revokeObjectURL(s.url);
    if (s.actx) s.actx.close().catch(() => {});
  }, []);

  /* one <audio> per listening session, routed through the analyser once */
  const ensureAudio = useCallback((s) => {
    s.el = new Audio();
    try {
      s.actx = new (window.AudioContext || window.webkitAudioContext)();
      s.analyser = s.actx.createAnalyser();
      s.analyser.fftSize = 128;
      s.actx.createMediaElementSource(s.el).connect(s.analyser);
      s.analyser.connect(s.actx.destination);
      if (s.actx.state === 'suspended') s.actx.resume();
    } catch { s.actx = null; s.analyser = null; /* analyser is cosmetic — plain playback */ }
  }, []);

  /* ---------- the speaking loop: synth-chunk k+1 while chunk k plays ---------- */
  const stopSpeech = useCallback(() => {
    teardown(seq.current);
    seq.current = null;
    setPlayback({ state: 'idle', idx: 0, count: 0 });
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
  }, [teardown]);

  const startSpeaking = useCallback(async (from) => {
    if (!current || !chunks.length) { setError('Nothing to read — pick a book first.'); return; }
    if (seq.current && seq.current.running) return;
    teardown(seq.current);   // a finished session still holds its audio context
    setError('');
    const restart = current.finished && typeof from !== 'number';
    const start = typeof from === 'number' ? Math.max(0, Math.min(chunks.length - 1, from)) : restart ? 0 : savedIdx;

    const pc = playChoice(current);
    const sig = `${current.id}|${pc.voice}|${pc.speed}|`;
    const s = {
      running: true, stop: false, failed: null, idx: start, total: chunks.length, sig,
      ready: new Map(),   // chunk idx → seconds, for everything already made (on disk)
      forceStart: false,
      el: null, url: null, analyser: null, actx: null, cancelChunk: null,
    };
    seq.current = s;
    sigRef.current = sig;
    setPlayback({ state: 'preparing', idx: start, count: chunks.length });
    ensureAudio(s);   // created inside the tap, so autoplay rules stay happy
    try {
      s.ready = await listAudio(sig);
      /* a fully saved book needs no voice engine — it can play on any tier, offline */
      if (s.ready.size < chunks.length) await ensureEngine();
      if (!current.saved) pruneAudio(current.id, sig).catch(() => {});
    } catch (e) {
      stopSpeech();
      setEngine((en) => (engineRef.current ? en : { status: 'idle', label: '', pct: 0 }));
      setError('Voice download failed — check your connection. ' + errMsg(e));
      return;
    }
    if (s.stop) return;
    if (navigator.mediaSession && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: 'VOX', album: 'VOX audiobook' });
    }

    /* seconds of audio ready, back-to-back, from chunk i */
    const aheadFrom = (i) => { let t = 0; for (let k = i; s.ready.has(k); k++) t += s.ready.get(k); return t; };
    const firstMissing = (i) => { let k = i; while (s.ready.has(k)) k++; return k; };
    /* listening time left in the book — made chunks are exact, the rest estimated from text length */
    const remainingFrom = (i) => {
      let t = 0;
      for (let k = i; k < chunks.length; k++) t += s.ready.has(k) ? s.ready.get(k) : chunks[k].length * perf.spc;
      return t;
    };
    const publish = () => setReadyAhead(Math.round(aheadFrom(s.idx)));

    /* producer — keeps making audio ahead of the playhead and saves it; runs while paused too */
    /* several lanes — one per engine worker — make passages side by side, in order of need */
    (async () => {
      let next = start;
      const lane = async (once) => {
        while (!s.stop) {
          const i = next++;
          if (i >= chunks.length) return;
          while (!s.stop && aheadFrom(s.idx) > MAX_AHEAD_SEC) await sleep(1000);
          if (s.stop) return;
          if (s.ready.has(i)) continue;
          await ensureEngine();   // already loaded unless a saved book lost a passage
          const t0 = performance.now();
          const out = await synthesize(chunks[i], pc);
          const secs = out.samples.length / out.rate;
          learnSpeed((performance.now() - t0) / 1000 / lanes(), secs, chunks[i].length);
          await putAudio(sig + i, out);      // keep it even if the user just skipped away
          s.ready.set(i, secs);
          publish();
          if (once) return;
        }
      };
      try {
        if (!s.ready.has(start)) await lane(true);   // first passage alone — loads the engine once
        await Promise.all(Array.from({ length: lanes() }, () => lane(false)));
      } catch (e) {
        s.failed = e;
      }
    })();

    /*
     * buffer gate — if this device makes speech slower than real time (perf.rtf > 1), playing at once
     * would stall at every passage. Instead wait until enough is ready that playback and production
     * together last BUFFER_TARGET seconds without a break: need = listen × (1 − 1/rtf).
     */
    const waitForBuffer = async (i) => {
      while (!s.stop && !s.failed) {
        const have = aheadFrom(i);
        const listen = Math.min(BUFFER_TARGET, remainingFrom(i));
        const need = perf.rtf > 1.05 ? listen * (1 - 1 / perf.rtf) : 0;
        const toEnd = firstMissing(i) >= chunks.length;
        if (s.ready.has(i) && (have >= need || toEnd || s.forceStart)) break;
        setPlayback({
          state: 'buffering', idx: i, count: chunks.length,
          have: Math.round(have), need: Math.max(1, Math.round(need)),
          eta: Math.max(0, Math.round((need - have) * perf.rtf)),
        });
        await sleep(500);
      }
      s.forceStart = false;
    };

    /* consumer — plays chunk after chunk; a missing chunk means rebuffer, not a stutter */
    try {
      let first = true;
      for (let i = start; i < chunks.length; i++) {
        s.idx = i;
        publish();
        if (first || !s.ready.has(i)) await waitForBuffer(i);
        first = false;
        if (s.stop) break;
        if (s.failed) throw s.failed;
        const piece = await getAudio(sig + i);
        if (!piece) { s.ready.delete(i); i--; continue; }   // vanished from disk — make it again
        if (s.url) URL.revokeObjectURL(s.url);
        s.url = URL.createObjectURL(encodeWav([piece.samples], piece.rate));
        bookmark(i, { finished: false });
        for (const k of [...s.ready.keys()]) {
          if (!current.saved && k < i - KEEP_BEHIND) { s.ready.delete(k); deleteAudio(sig + k).catch(() => {}); }
        }
        const el = s.el;
        el.src = s.url;
        await new Promise((resolveChunk) => {
          s.cancelChunk = () => resolveChunk('stopped');
          el.onended = () => resolveChunk('ended');
          el.onerror = () => resolveChunk('error');
          setPlayback({ state: 'speaking', idx: i, count: chunks.length });
          if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
          /* blocked (no user gesture, app backgrounded) → pause and wait for play */
          el.play().catch(() => {
            if (s.stop) return resolveChunk('stopped');
            setPlayback((p) => ({ ...p, state: 'paused' }));
          });
        });
        if (s.stop) break;
      }
      if (!s.stop) {
        setPlayback({ state: 'done', idx: chunks.length, count: chunks.length });
        bookmark(0, { finished: true });
        if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
      }
    } catch (e) {
      setError('Voice error: ' + errMsg(e));
      setPlayback({ state: 'idle', idx: 0, count: 0 });
    }
    s.running = false;
  }, [current, chunks, playChoice, savedIdx, ensureEngine, ensureAudio, teardown, stopSpeech, bookmark]);

  const togglePause = useCallback(() => {
    const s = seq.current;
    if (!s || !s.el || !s.running) { startSpeaking(); return; }
    if (playback.state === 'buffering') { s.forceStart = true; return; }   // "play now anyway"
    if (!s.url) return;   // still preparing — nothing loaded to pause yet
    if (s.el.paused) {
      if (s.actx && s.actx.state === 'suspended') s.actx.resume();
      s.el.play().catch(() => {});
      setPlayback((p) => ({ ...p, state: 'speaking' }));
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
    } else {
      s.el.pause();
      setPlayback((p) => ({ ...p, state: 'paused' }));
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
    }
  }, [startSpeaking, playback.state]);

  /* jump to a chunk: restart the loop there if playing, otherwise just move the bookmark */
  const seekTo = useCallback((target) => {
    if (!chunks.length) return;
    target = Math.max(0, Math.min(chunks.length - 1, target));
    const s = seq.current;
    if (s && s.running) {
      teardown(s);
      seq.current = null;
      startSpeaking(target);
    } else {
      if (playback.state === 'done') setPlayback({ state: 'idle', idx: 0, count: 0 });
      bookmark(target, { finished: false });
    }
  }, [chunks.length, playback.state, teardown, startSpeaking, bookmark]);

  const running = !!(seq.current && seq.current.running);
  const curIdx = running ? playback.idx : savedIdx;
  const skip = useCallback((d) => seekTo(curIdx + d), [seekTo, curIdx]);

  /* new voice or speed while a book is playing → carry on from this passage with the new choice
     (otherwise the running session would keep the voice it started with) */
  const lastChoice = useRef(`${voice}|${speed}|${tier}`);
  useEffect(() => {
    if (!tier || !voicesFor(tier).some((v) => v.id === voice)) return;   // narrator swap pending
    const choice = `${voice}|${speed}|${tier}`;
    if (choice === lastChoice.current) return;
    lastChoice.current = choice;
    const s = seq.current;
    const pc = current && playChoice(current);
    if (s && s.running && pc && s.sig !== `${current.id}|${pc.voice}|${pc.speed}|`) {
      const at = s.idx;
      teardown(s);
      seq.current = null;
      startSpeaking(at);
    }
  }, [voice, speed, tier, current, playChoice, teardown, startSpeaking]);

  /* ---------- lock-screen / headset controls ---------- */
  actions.current = { togglePause, skip, stopSpeech };
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const on = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* unsupported action */ } };
    on('play', () => actions.current.togglePause());
    on('pause', () => actions.current.togglePause());
    on('stop', () => actions.current.stopSpeech());
    on('previoustrack', () => actions.current.skip(-1));
    on('nexttrack', () => actions.current.skip(1));
    on('seekbackward', () => actions.current.skip(-1));
    on('seekforward', () => actions.current.skip(1));
  }, []);

  /* ---------- library actions ---------- */
  const selectBook = useCallback(async (id) => {
    if (id !== currentId) {
      stopSpeech();
      const t = await getText(id);
      setCurrentText(t || '');
      setCurrentId(id);
      store.set('current', id);
    }
    patchBook(id, { opened: Date.now() });
  }, [currentId, stopSpeech, patchBook]);

  const openBook = useCallback(async (id) => {
    await selectBook(id);
    go('player');
  }, [selectBook, go]);

  /* "Play" from the library: start once the new book's text is in state */
  const pendingPlay = useRef(false);
  const [playReq, setPlayReq] = useState(0);   // re-runs the effect below even when the book was already open
  const playBook = useCallback(async (id) => {
    await selectBook(id);
    go('player');
    pendingPlay.current = true;
    setPlayReq((n) => n + 1);
  }, [selectBook, go]);
  useEffect(() => {
    if (pendingPlay.current && current && chunks.length) {
      pendingPlay.current = false;
      if (!(seq.current && seq.current.running)) startSpeaking();
    }
  }, [current, chunks, startSpeaking, playReq]);

  const addAndOpen = useCallback(async (title, text, pages) => {
    const meta = await addBook({ title, text, pages, words: countWords(text), total: chunkForSpeech(text).length });
    setBooks((bs) => [meta, ...bs]);
    stopSpeech();
    setCurrentText(text);
    setCurrentId(meta.id);
    store.set('current', meta.id);
    go('player');
  }, [stopSpeech, go]);

  const importFile = useCallback(async (file) => {
    if (!file) return;
    setError('');
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        setImporting({ label: 'Opening PDF…', pct: 0 });
        const buf = new Uint8Array(await file.arrayBuffer());
        const { pages, text, meta } = await extractPdfText(buf, (i, n) => {
          setImporting({ label: `Reading page ${i} of ${n}`, pct: Math.round((i / n) * 100) });
        });
        setImporting(null);
        if (!text.trim()) {
          setError('That PDF has no selectable text — it is probably a scan. VOX can only read PDFs with real text.');
          return;
        }
        const t = meta && meta.info && meta.info.Title && meta.info.Title.trim();
        await addAndOpen(t && t.length > 2 ? t : name, text, pages);
      } else {
        const text = await file.text();
        if (!text.trim()) { setError('That file is empty.'); return; }
        await addAndOpen(name, text, null);
      }
    } catch (e) {
      setImporting(null);
      setError('Could not read that file: ' + errMsg(e));
    }
  }, [addAndOpen]);

  const pasteBook = useCallback((title, text) => {
    addAndOpen(title, text, null).catch((e) => setError('Could not save: ' + errMsg(e)));
  }, [addAndOpen]);

  const removeBook = useCallback(async (id) => {
    if (id === currentId) {
      stopSpeech();
      setCurrentId(null);
      setCurrentText('');
      store.del('current');
    }
    setBooks((bs) => bs.filter((b) => b.id !== id));
    if (prepRef.current && prepRef.current.id === id) prepRef.current.stop = true;
    prepQueue.current = prepQueue.current.filter((q) => q !== id);
    deleteBook(id).catch((e) => setError('Could not delete: ' + errMsg(e)));
  }, [currentId, stopSpeech]);

  /* ---------- storage cleanup (Settings → Storage) ---------- */
  const stopIfPlaying = useCallback((bookId) => {
    const s = seq.current;
    if (s && (!bookId || (current && current.id === bookId))) stopSpeech();
  }, [current, stopSpeech]);

  const clearBookAudio = useCallback(async (id) => {
    stopIfPlaying(id);
    if (prepRef.current && prepRef.current.id === id) prepRef.current.stop = true;
    await deleteAudio(id + '|');
    patchBook(id, { saved: null });
  }, [stopIfPlaying, patchBook]);

  const clearAudioAll = useCallback(async () => {
    stopIfPlaying();
    if (prepRef.current) prepRef.current.stop = true;
    prepQueue.current = [];
    setQueued([]);
    await clearAllAudio();
    books.filter((b) => b.saved).forEach((b) => patchBook(b.id, { saved: null }));
  }, [stopIfPlaying, books, patchBook]);

  const deleteModel = useCallback(async () => {
    stopIfPlaying();
    if (prepRef.current) prepRef.current.stop = true;
    await clearModel();
    unloadEngine();            // otherwise the app still thinks the voice is ready and won't download
    engineRef.current = null;
    setEngine({ status: 'idle', label: '', pct: 0, saved: false });
  }, [stopIfPlaying]);

  const resetAll = useCallback(async () => {
    stopIfPlaying();
    if (prepRef.current) prepRef.current.stop = true;
    prepQueue.current = [];
    setQueued([]);
    await Promise.all([clearLibrary(), clearModel()]);
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('vox:')).forEach((k) => localStorage.removeItem(k));
    } catch { /* storage blocked */ }
    setBooks([]);
    setCurrentId(null);
    setCurrentText('');
    unloadEngine();
    engineRef.current = null;
    setEngine({ status: 'idle', label: '', pct: 0, saved: false });
    setTierChoice('auto');
    go('library');
  }, [stopIfPlaying, go]);

  /* ---------- export: every passage already made for this book, in order ---------- */
  const saveWav = useCallback(async () => {
    if (!current) return;
    const pc = playChoice(current);
    const sig = `${current.id}|${pc.voice}|${pc.speed}|`;
    const made = await listAudio(sig).catch(() => new Map());
    if (!made.size) { setError('Nothing made yet — press play first.'); return; }
    const idxs = [...made.keys()].sort((a, b) => a - b);
    const parts = (await Promise.all(idxs.map((i) => getAudio(sig + i)))).filter(Boolean);
    if (!parts.length) { setError('Nothing made yet — press play first.'); return; }
    const blob = encodeWav(parts.map((p) => p.samples), parts[0].rate);
    const safe = ((current && current.title) || 'vox').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'vox';
    try {
      await saveAudio(blob, `${safe} ${idxs[0] + 1}-${idxs[idxs.length - 1] + 1}.wav`);
    } catch (e) {
      if (!/cancel/i.test(errMsg(e))) setError('Could not save: ' + errMsg(e));
    }
  }, [current, playChoice]);

  /* ---------- save a whole book ahead of time (Library → Save) ---------- */

  prepRun.current = async (id) => {
    const book = books.find((b) => b.id === id);
    if (!book) return;
    const job = { id, stop: false };
    prepRef.current = job;
    let lock = null;
    try {
      const list = chunkForSpeech(id === currentId ? currentText : (await getText(id)) || '');
      const pc = playChoice(book);   // carries on an earlier save with its own voice
      const sig = `${id}|${pc.voice}|${pc.speed}|`;
      const mark = (done, complete) => patchBook(id, { saved: { ...pc, done, total: list.length, complete } });
      setPrep({ id, done: 0, total: list.length, eta: null });
      await ensureEngine();
      await pruneAudio(id, sig);
      const ready = await listAudio(sig);
      mark(ready.size, ready.size >= list.length);
      const show = () => {
        let left = 0;
        for (let k = 0; k < list.length; k++) if (!ready.has(k)) left += list[k].length * perf.spc;
        setPrep({ id, done: ready.size, total: list.length, eta: perf.known ? Math.round(left * perf.rtf) : null });
      };
      show();
      try { lock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch { /* not allowed */ }
      /* a different book playing with a thin buffer goes first — saving waits its turn */
      const yieldToPlayer = () => {
        const s = seq.current;
        if (!s || !s.running || s.stop || s.sig === sig) return false;
        let t = 0, k = s.idx;
        for (; s.ready.has(k); k++) t += s.ready.get(k);
        return k < s.total && t < BUFFER_TARGET;
      };
      let next = 0;
      const lane = async () => {
        while (!job.stop) {
          const i = next++;
          if (i >= list.length) return;
          if (ready.has(i)) continue;
          while (!job.stop && yieldToPlayer()) await sleep(1000);
          if (job.stop) return;
          const live = seq.current && seq.current.sig === sig ? seq.current : null;
          if (live && live.ready.has(i)) { ready.set(i, live.ready.get(i)); show(); continue; }
          const t0 = performance.now();
          const out = await synthesize(list[i], pc);
          const secs = out.samples.length / out.rate;
          learnSpeed((performance.now() - t0) / 1000 / lanes(), secs, list[i].length);
          await putAudio(sig + i, out);
          ready.set(i, secs);
          if (seq.current && seq.current.sig === sig) seq.current.ready.set(i, secs);   // the player can use it now
          show();
          if (ready.size % 10 === 0) mark(ready.size, false);
        }
      };
      await Promise.all(Array.from({ length: lanes() }, lane));   // one lane per engine worker
      mark(ready.size, ready.size >= list.length);
    } catch (e) {
      setError(`Could not save “${book.title}”: ${errMsg(e)}`);
    } finally {
      if (lock) lock.release().catch(() => {});
      prepRef.current = null;
      setPrep(null);
      const next = prepQueue.current.shift();
      setQueued([...prepQueue.current]);
      if (next) setTimeout(() => prepRun.current(next), 0);
    }
  };

  /* tap once to save, again to pause; other books wait in line */
  const toggleSave = useCallback((id) => {
    if (prepRef.current && prepRef.current.id === id) { prepRef.current.stop = true; return; }
    if (prepQueue.current.includes(id)) {
      prepQueue.current = prepQueue.current.filter((q) => q !== id);
    } else if (prepRef.current) {
      prepQueue.current.push(id);
    } else {
      prepRun.current(id);
    }
    setQueued([...prepQueue.current]);
  }, []);

  const busy = playback.state === 'speaking' || playback.state === 'preparing' || playback.state === 'buffering';
  const progress = current && chunks.length
    ? (playback.state === 'done' || (current.finished && !running) ? 1 : curIdx / chunks.length) : 0;
  const clearError = useCallback(() => setError(''), []);

  return (
    <div className="shell">
      <Toast message={error} onClose={clearError} />

      <main key={tab} className="view">
        {tab === 'library' && (
          <Library
            onRegisterBack={registerBack}
            books={books} current={current} loaded={loaded} importing={importing}
            onOpen={openBook} onPlay={playBook} onImportFile={importFile} onPaste={pasteBook} onDelete={removeBook}
            prep={prep} queued={queued} onSave={toggleSave} onUnsave={clearBookAudio}
          />
        )}
        {tab === 'player' && (
          <Player
            onRegisterBack={registerBack}
            book={current} chunks={chunks} curIdx={curIdx} playback={playback} engine={engine}
            readyAhead={readyAhead} rtf={perf.known ? perf.rtf : null} speed={speed} voice={current ? playChoice(current).voice : voice} seqRef={seq}
            onMain={togglePause} onSkip={skip} onSeek={seekTo} onStop={stopSpeech} onSave={saveWav}
            onSpeed={setSpeed} onLibrary={goBack} onVoice={() => go('settings')}
          />
        )}
        {tab === 'settings' && (
          <Settings
            voice={voice} onVoice={setVoice} speed={speed} onSpeed={setSpeed}
            engine={engine} engineReady={!!engineRef.current} onPreload={warmUp} bookCount={books.length}
            rtf={perf.known ? perf.rtf : null} onStorage={() => go('storage')}
            tier={tier} tierChoice={tierChoice} onTier={setTierChoice} profile={profile}
          />
        )}
        {tab === 'storage' && (
          <Storage
            onBack={goBack}
            onRegisterBack={registerBack} onClearBookAudio={clearBookAudio} onClearAllAudio={clearAudioAll}
            onDeleteModel={deleteModel} onResetAll={resetAll}
          />
        )}
      </main>

      {current && tab !== 'player' && (
        <MiniPlayer
          book={current} playing={busy} preparing={playback.state === 'buffering'} progress={progress}
          onOpen={() => go('player')} onToggle={togglePause}
        />
      )}
      <TabBar tab={tab === 'storage' ? 'settings' : tab} onTab={go} />
    </div>
  );
}
