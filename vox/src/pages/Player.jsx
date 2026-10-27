import { useEffect, useRef, useState } from 'react';
import { Cover, Icon, VuMeter } from '../components/ui.jsx';
import { voiceName as nameOf } from '../lib/tts.js';

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.35];

export default function Player({
  book, chunks, curIdx, playback, engine, readyAhead, rtf, speed, voice, seqRef,
  onMain, onSkip, onSeek, onStop, onSave, onSpeed, onLibrary, onVoice,
}) {
  const listRef = useRef(null);
  const [showText, setShowText] = useState(false);   // cover ⇄ follow-along text, like lyrics
  const [follow, setFollow] = useState(true);        // auto-scroll with the voice until the user scrolls

  /* keep the spoken passage centred — scrolls only the text box, never the page around it */
  const centreNow = (smooth) => {
    const box = listRef.current;
    const el = box && box.querySelector('.passage.now');
    if (!el) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    if (showText && follow) centreNow(true);
  }, [curIdx, showText, follow]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (showText) { setFollow(true); requestAnimationFrame(() => centreNow(false)); } }, [showText]);
  /* a real finger/wheel scroll (not our own scrollTo) hands control to the reader */
  const userScrolled = () => { if (follow) setFollow(false); };

  if (!book) {
    return (
      <div className="page">
        <header className="pageHead"><h1 className="pageTitle">Listen</h1></header>
        <div className="empty">
          <div className="emptyArt"><Cover title="Nothing playing" size="md" /></div>
          <h2>Nothing playing</h2>
          <p>Pick a book from your library to start listening.</p>
          <button className="primaryBtn" onClick={onLibrary}><Icon.library size={18} /> Go to library</button>
        </div>
      </div>
    );
  }

  const total = chunks.length;
  const buffering = playback.state === 'buffering';
  const busy = playback.state === 'speaking' || playback.state === 'preparing';
  const waiting = playback.state === 'preparing' || buffering || engine.status === 'loading';
  const done = playback.state === 'done';
  const progress = total ? (done ? 1 : (curIdx + (busy ? 0.5 : 0)) / total) : 0;
  const wordsLeft = Math.round((book.words || 0) * (1 - progress));
  const minsLeft = Math.max(0, Math.round(wordsLeft / 155 / speed));
  const voiceName = nameOf(voice);

  /* whole book is scrollable; very long ones get a wide window around the playhead */
  const from = total > 2500 ? Math.max(0, curIdx - 1000) : 0;
  const to = total > 2500 ? Math.min(total, curIdx + 1500) : total;

  return (
    <div className={'page playerPage' + (showText ? ' reading' : '')}>
      <header className="topBar">
        <button className="iconBtn" onClick={onLibrary} aria-label="Back to library"><Icon.back /></button>
        <span className="topTitle">Now playing</span>
        <div className="topActions">
          <button className={'iconBtn' + (showText ? ' on' : '')} onClick={() => setShowText((v) => !v)}
            aria-label={showText ? 'Show cover' : 'Show text'} aria-pressed={showText}>
            <Icon.file size={19} />
          </button>
          <button className="iconBtn" onClick={onSave} disabled={!readyAhead && !busy} aria-label="Export audio"><Icon.share size={19} /></button>
        </div>
      </header>

      <div className="playerBody">
        <div className={'stage' + (busy ? ' live' : '') + (showText ? ' text' : '')}>
          {showText ? (
            <>
            <div className="passages" ref={listRef}
              onWheel={userScrolled} onTouchMove={userScrolled} onMouseDown={userScrolled} onKeyDown={userScrolled}>
              {from > 0 && <button className="textBtn small" onClick={() => onSeek(Math.max(0, from - 1))}>↑ earlier passages</button>}
              {chunks.slice(from, to).map((c, k) => {
                const i = from + k;
                return (
                  <p key={i} className={'passage' + (i === curIdx && !done ? ' now' : '') + (i < curIdx ? ' past' : '')}
                    onClick={() => onSeek(i)}>
                    {c}
                  </p>
                );
              })}
              {to < total && <p className="muted center small">… {total - to} more passages</p>}
            </div>
            {!follow && (
              <button className="followBtn" onClick={() => setFollow(true)}>
                <Icon.player size={15} /> Back to reading
              </button>
            )}
            </>
          ) : (
            <button className="coverBtn" onClick={() => setShowText(true)} aria-label="Show text">
              <Cover title={book.title} size="lg" />
            </button>
          )}
        </div>

        <div className="deck">
          <div className="nowMeta">
            <h2>{book.title}</h2>
            <button className="byline" onClick={onVoice}>Read by <b>{voiceName}</b> · change</button>
          </div>

          <VuMeter seqRef={seqRef} active={playback.state === 'speaking'} />

          <div className="scrub" onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(Math.floor(((e.clientX - r.left) / r.width) * total));
          }}>
            <div className="scrubTrack"><i style={{ width: `${progress * 100}%` }} /><b style={{ left: `${progress * 100}%` }} /></div>
          </div>
          <div className="scrubLabels">
            <span>{total ? `Passage ${Math.min(curIdx + 1, total)} of ${total}` : '—'}</span>
            <span>{done ? 'Finished' : minsLeft < 1 ? 'under 1 min left' : `${minsLeft} min left`}</span>
          </div>

          <div className="controls">
            <button className="ctrl" onClick={() => onSpeed(nextSpeed(speed))} aria-label="Playback speed">
              <span className="speedTxt">{speed.toFixed(speed % 0.1 ? 2 : 1)}×</span>
            </button>
            <button className="ctrl" onClick={() => onSkip(-1)} aria-label="Previous passage"><Icon.prev size={26} /></button>
            <button className={'playBtn' + (waiting ? ' waiting' : '')} onClick={onMain} aria-label={busy ? 'Pause' : buffering ? 'Play now' : 'Play'}>
              {busy ? <Icon.pause size={30} /> : <Icon.play size={30} style={{ marginLeft: 3 }} />}
            </button>
            <button className="ctrl" onClick={() => onSkip(1)} aria-label="Next passage"><Icon.next size={26} /></button>
            <button className="ctrl" onClick={onStop} disabled={playback.state === 'idle'} aria-label="Stop"><Icon.stop size={18} /></button>
          </div>

          {buffering ? <Preparing playback={playback} rtf={rtf} onPlayNow={onMain} /> : (
            <p className="statusLine">
              {engine.status === 'loading' && engine.phase === 'download' ? (
                <>Downloading voice · <b>{engine.pct}%</b> · <small>{engine.label} · one time only</small></>
              ) : engine.status === 'loading' && engine.phase === 'save' ? 'Saving voice on this device…'
                : engine.status === 'loading' ? 'Loading voice…'
                : playback.state === 'preparing' ? 'Waking the voice…'
                : playback.state === 'paused' ? 'Paused'
                : done ? 'You reached the end'
                : playback.state === 'speaking' ? (readyAhead > 90 ? `${fmt(readyAhead)} ready ahead` : 'Making the next part…')
                : curIdx > 0 ? `Bookmarked at passage ${curIdx + 1}` : 'Tap play to begin'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* the "getting ahead" card: shown until enough audio is made to listen without stops */
function Preparing({ playback, rtf, onPlayNow }) {
  const { have = 0, need = 1, eta = 0 } = playback;
  const pct = Math.min(1, have / need);
  const R = 34, C = 2 * Math.PI * R;
  return (
    <div className="prep">
      <svg className="prepRing" viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r={R} className="track" />
        <circle cx="40" cy="40" r={R} className="fill" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />
        <text x="40" y="45" textAnchor="middle">{Math.round(pct * 100)}%</text>
      </svg>
      <div className="prepBody">
        <b>Getting ahead of you…</b>
        <span>{fmt(have)} of {fmt(need)} ready{eta > 5 ? ` · starts in about ${eta >= 90 ? Math.round(eta / 60) + ' min' : eta + ' s'}` : ''}</span>
        <small>
          {rtf == null
            ? 'Measuring how fast this device makes speech…'
            : `This device makes speech ${rtf > 1 ? `${rtf.toFixed(1)}× slower than it plays` : 'about as fast as it plays'} — VOX gets ahead first, then keeps going while you listen.`}
        </small>
        <button className="textBtn small" onClick={onPlayNow}>Play now anyway</button>
      </div>
    </div>
  );
}

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(sec % 60).padStart(2, '0')}`;
}

function nextSpeed(s) {
  const i = SPEEDS.findIndex((v) => Math.abs(v - s) < 0.01);
  return SPEEDS[(i + 1) % SPEEDS.length];
}
