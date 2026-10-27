import { useEffect, useState } from 'react';

/* ---------- icons (24px line set) ---------- */
const svg = (children, filled) => function Icon({ size = 22, ...p }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      {children}
    </svg>
  );
};

export const Icon = {
  library: svg(<><path d="M4 19.5V5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-1.5Z" /><path d="M9 3h4v18H9z" /><path d="m15 4.2 3.6-.9 3.2 16.6-3.6.8z" /></>),
  player: svg(<><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5.5 3.5-5.5 3.5z" /></>),
  settings: svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>),
  play: svg(<path d="M7 4.8v14.4a1 1 0 0 0 1.5.9l11.2-7.2a1 1 0 0 0 0-1.8L8.5 3.9A1 1 0 0 0 7 4.8Z" />, true),
  pause: svg(<><rect x="6" y="4.5" width="4.2" height="15" rx="1.2" /><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" /></>, true),
  prev: svg(<><path d="M11 18 4 12l7-6v12Z" /><path d="M20 18l-7-6 7-6v12Z" /></>, true),
  next: svg(<><path d="m13 6 7 6-7 6V6Z" /><path d="m4 6 7 6-7 6V6Z" /></>, true),
  back: svg(<path d="m15 18-6-6 6-6" />),
  plus: svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  more: svg(<><circle cx="12" cy="5.5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="18.5" r="1.4" /></>, true),
  close: svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>),
  file: svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>),
  paste: svg(<><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /></>),
  share: svg(<><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" /></>),
  stop: svg(<rect x="6" y="6" width="12" height="12" rx="2" />, true),
  trash: svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>),
  check: svg(<path d="M20 6 9 17l-5-5" />),
  storage: svg(<><ellipse cx="12" cy="5.5" rx="8" ry="2.8" /><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13" /><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8" /></>),
  download: svg(<><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>),
  chevron: svg(<path d="m9 18 6-6-6-6" />),
  wave: svg(<><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0" /></>),
};

/* ---------- generated book covers ---------- */
const PALETTES = [
  ['#c0643c', '#e8a67c'], ['#6f8462', '#b5c49d'], ['#3f5a6e', '#8fa9bb'],
  ['#8a4f6a', '#d2a0b5'], ['#b38a2e', '#e6cb83'], ['#4f7a74', '#9fc6bd'], ['#6b5847', '#c4ab91'],
];

function hash(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Cover({ title = 'Untitled', size = 'md' }) {
  const h = hash(title);
  const [a, b] = PALETTES[h % PALETTES.length];
  const pattern = h % 3;
  return (
    <div className={`cover cover-${size} pattern-${pattern}`} style={{ '--c1': a, '--c2': b }}>
      <span className="coverTitle">{title}</span>
      <span className="coverMark">VOX</span>
    </div>
  );
}

/* ---------- live VU meter: owns its animation so the app doesn't rerender at 60 fps ---------- */
export function VuMeter({ seqRef, active, bars = 32 }) {
  const [vu, setVu] = useState(() => new Array(bars).fill(0));
  useEffect(() => {
    if (!active) { setVu(new Array(bars).fill(0)); return; }
    let raf;
    const data = new Uint8Array(64);
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = seqRef.current;
      if (!s || !s.analyser) return;
      s.analyser.getByteFrequencyData(data);
      const out = new Array(bars);
      for (let i = 0; i < bars; i++) out[i] = Math.pow(data[Math.floor(i * 48 / bars)] / 255, 0.8);
      setVu(out);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [active, seqRef, bars]);
  return (
    <div className="vumeter">
      {vu.map((v, i) => <span key={i} style={{ transform: `scaleY(${0.12 + v * 0.88})` }} />)}
    </div>
  );
}

/* ---------- bottom navigation ---------- */
const TABS = [
  { id: 'library', label: 'Library', icon: Icon.library },
  { id: 'player', label: 'Listen', icon: Icon.player },
  { id: 'settings', label: 'Settings', icon: Icon.settings },
];

export function TabBar({ tab, onTab }) {
  return (
    <nav className="tabbar">
      {TABS.map((t) => (
        <button key={t.id} className={'tab' + (tab === t.id ? ' on' : '')} onClick={() => onTab(t.id)}>
          <t.icon size={23} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function MiniPlayer({ book, playing, preparing, progress, onOpen, onToggle }) {
  return (
    <div className="mini" onClick={onOpen}>
      <Cover title={book.title} size="xs" />
      <div className="miniText">
        <b>{book.title}</b>
        <span>{preparing ? 'Preparing' : playing ? 'Playing' : 'Paused'} · {Math.round(progress * 100)}%</span>
      </div>
      <button className="miniBtn" aria-label={playing ? 'Pause' : 'Play'}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}>
        {playing ? <Icon.pause size={20} /> : <Icon.play size={20} />}
      </button>
      <i className="miniProgress" style={{ width: `${progress * 100}%` }} />
    </div>
  );
}

export function Toast({ message, onClose }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, 7000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  if (!message) return null;
  return (
    <div className="toast" role="alert" onClick={onClose}>
      <span>{message}</span>
      <Icon.close size={16} />
    </div>
  );
}

export function Sheet({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetGrip" />
        {title && <h3 className="sheetTitle">{title}</h3>}
        {children}
      </div>
    </div>
  );
}
