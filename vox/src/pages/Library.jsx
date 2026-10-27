import { useRef, useState } from 'react';
import { Cover, Icon, Sheet } from '../components/ui.jsx';
import { voiceName as nameOf } from '../lib/tts.js';

const pct = (b) => (b.finished ? 1 : b.total ? Math.min(1, b.idx / b.total) : 0);

export default function Library({
  books, current, loaded, importing, onOpen, onPlay, onImportFile, onPaste, onDelete,
  prep, queued, onSave, onUnsave,
}) {
  /* where a book stands on "save for offline": saving | queued | saved | partial | none */
  const saveState = (b) => {
    if (prep && prep.id === b.id) return { kind: 'saving', pct: prep.total ? prep.done / prep.total : 0, eta: prep.eta };
    if (queued.includes(b.id)) return { kind: 'queued' };
    const sv = b.saved;
    if (sv && sv.complete) return { kind: 'saved' };
    if (sv && sv.done) return { kind: 'partial', pct: sv.total ? sv.done / sv.total : 0 };
    return { kind: 'none' };
  };
  const fileRef = useRef(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [menuBook, setMenuBook] = useState(null);
  const [draft, setDraft] = useState({ title: '', text: '' });

  const others = books.filter((b) => !current || b.id !== current.id);
  const pickFile = () => { setAddOpen(false); fileRef.current && fileRef.current.click(); };

  return (
    <div className="page">
      <header className="pageHead">
        <div>
          <p className="eyebrow">{greeting()}</p>
          <h1 className="pageTitle">Library</h1>
        </div>
        <button className="iconBtn accent" onClick={() => setAddOpen(true)} aria-label="Add book">
          <Icon.plus size={22} />
        </button>
      </header>

      <input
        ref={fileRef} className="hiddenInput" type="file"
        accept=".pdf,.txt,application/pdf,text/plain"
        onChange={(e) => { onImportFile(e.target.files[0]); e.target.value = ''; }}
      />

      {importing && (
        <div className="card importing">
          <div className="spinner" />
          <div>
            <b>Adding book…</b>
            <span>{importing.label}</span>
            <div className="meter"><i style={{ width: `${importing.pct}%` }} /></div>
          </div>
        </div>
      )}

      {current && (
        <section className="hero" onClick={() => onOpen(current.id)}>
          <Cover title={current.title} size="md" />
          <div className="heroBody">
            <p className="eyebrow">Continue listening</p>
            <h2>{current.title}</h2>
            <span className="muted">{bookMeta(current)}</span>
            <div className="meter"><i style={{ width: `${pct(current) * 100}%` }} /></div>
            <div className="heroBtns">
              <button className="pill" onClick={(e) => { e.stopPropagation(); onPlay(current.id); }}>
                <Icon.play size={14} /> {current.idx > 0 && !current.finished ? 'Resume' : 'Play'}
              </button>
              <SaveButton st={saveState(current)} wide onClick={(e) => { e.stopPropagation(); onSave(current.id); }} />
            </div>
            <SaveLine st={saveState(current)} />
          </div>
        </section>
      )}

      {loaded && !books.length && !importing && (
        <div className="empty">
          <div className="emptyArt">
            <Cover title="Your first book" size="md" />
          </div>
          <h2>Your shelf is empty</h2>
          <p>Add a PDF or paste some text. VOX will read it to you in a natural voice — even offline.</p>
          <button className="primaryBtn" onClick={pickFile}><Icon.file size={18} /> Import a PDF</button>
          <button className="textBtn" onClick={() => setPasteOpen(true)}>or paste text</button>
        </div>
      )}

      {others.length > 0 && (
        <>
          <h3 className="sectionTitle">{current ? 'On your shelf' : 'All books'}</h3>
          <div className="shelf">
            {others.map((b) => (
              <div key={b.id} className="shelfItem" onClick={() => onOpen(b.id)}>
                <div className="shelfCover">
                  <Cover title={b.title} size="sm" />
                  <button className="moreBtn" aria-label="Book options"
                    onClick={(e) => { e.stopPropagation(); setMenuBook(b); }}>
                    <Icon.more size={16} />
                  </button>
                  <SaveButton st={saveState(b)} onClick={(e) => { e.stopPropagation(); onSave(b.id); }} />
                  {pct(b) > 0 && <div className="coverProgress"><i style={{ width: `${pct(b) * 100}%` }} /></div>}
                </div>
                <b>{b.title}</b>
                <span>{b.finished ? 'Finished' : pct(b) > 0 ? `${Math.round(pct(b) * 100)}% listened` : bookMeta(b)}</span>
                <SaveLine st={saveState(b)} />
              </div>
            ))}
          </div>
        </>
      )}

      {current && (
        <button className="textBtn danger small" onClick={() => setMenuBook(current)}>Manage “{current.title}”</button>
      )}

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add a book">
        <button className="sheetRow" onClick={pickFile}>
          <span className="sheetIcon"><Icon.file /></span>
          <span><b>Import PDF or TXT</b><em>Text is extracted on your phone</em></span>
        </button>
        <button className="sheetRow" onClick={() => { setAddOpen(false); setPasteOpen(true); }}>
          <span className="sheetIcon"><Icon.paste /></span>
          <span><b>Paste text</b><em>An article, a chapter, anything</em></span>
        </button>
      </Sheet>

      <Sheet open={pasteOpen} onClose={() => setPasteOpen(false)} title="Paste text">
        <input className="field" placeholder="Title" value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
        <textarea className="field area" placeholder="Paste or type what you want to hear…" value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} />
        <button className="primaryBtn" disabled={!draft.text.trim()}
          onClick={() => { onPaste(draft.title.trim() || 'Untitled', draft.text); setDraft({ title: '', text: '' }); setPasteOpen(false); }}>
          Add to library
        </button>
      </Sheet>

      <Sheet open={!!menuBook} onClose={() => setMenuBook(null)} title={menuBook ? menuBook.title : ''}>
        {menuBook && (
          <>
            <button className="sheetRow" onClick={() => { const id = menuBook.id; setMenuBook(null); onOpen(id); }}>
              <span className="sheetIcon"><Icon.player /></span>
              <span><b>Open</b><em>{bookMeta(menuBook)}</em></span>
            </button>
            {(() => {
              const st = saveState(menuBook);
              const label = { saving: 'Pause saving', queued: 'Remove from queue', saved: 'Saved for offline', partial: 'Continue saving', none: 'Save for offline listening' }[st.kind];
              const sub = {
                saving: `${Math.round(st.pct * 100)}% done${st.eta ? ` · about ${dur(st.eta)} left` : ''}`,
                queued: 'Starts after the book being saved now',
                saved: `Plays without making audio · ${voiceOf(menuBook)}`,
                partial: `${Math.round((st.pct || 0) * 100)}% saved · picks up where it stopped`,
                none: 'Makes the whole audiobook now, plays it later',
              }[st.kind];
              return (
                <button className="sheetRow" disabled={st.kind === 'saved'} onClick={() => { onSave(menuBook.id); setMenuBook(null); }}>
                  <span className="sheetIcon">{st.kind === 'saved' ? <Icon.check /> : <Icon.download />}</span>
                  <span><b>{label}</b><em>{sub}</em></span>
                </button>
              );
            })()}
            {(menuBook.saved || (prep && prep.id === menuBook.id)) && (
              <button className="sheetRow danger" onClick={() => {
                if (window.confirm(`Delete the saved audio of “${menuBook.title}”? The book and bookmark stay.`)) onUnsave(menuBook.id);
                setMenuBook(null);
              }}>
                <span className="sheetIcon"><Icon.storage /></span>
                <span><b>Delete saved audio</b><em>Frees space · it's made again when you listen</em></span>
              </button>
            )}
            <button className="sheetRow danger" onClick={() => {
              if (window.confirm(`Delete “${menuBook.title}” from this phone? This cannot be undone.`)) onDelete(menuBook.id);
              setMenuBook(null);
            }}>
              <span className="sheetIcon"><Icon.trash /></span>
              <span><b>Delete book</b><em>Removes the text and your bookmark</em></span>
            </button>
          </>
        )}
      </Sheet>
    </div>
  );
}

function bookMeta(b) {
  const mins = Math.max(1, Math.round((b.words || 0) / 155));
  const len = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return [b.pages ? `${b.pages} pages` : null, len].filter(Boolean).join(' · ');
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/* round button on a cover (or a pill in the hero): save → progress ring → check */
function SaveButton({ st, onClick, wide }) {
  const label = { saving: 'Pause saving', queued: 'Waiting to save', saved: 'Saved for offline', partial: 'Continue saving', none: 'Save for offline' }[st.kind];
  const ring = st.kind === 'saving' || st.kind === 'partial';
  const r = 12.5, c = 2 * Math.PI * r;
  const icon = (
    <span className={'saveIcon ' + st.kind}>
      {ring && (
        <svg viewBox="0 0 30 30" aria-hidden="true">
          <circle cx="15" cy="15" r={r} className="track" />
          <circle cx="15" cy="15" r={r} className="fill" strokeDasharray={c} strokeDashoffset={c * (1 - (st.pct || 0))} />
        </svg>
      )}
      {st.kind === 'saved' ? <Icon.check size={15} /> : st.kind === 'saving' ? <i className="pauseGlyph" /> : <Icon.download size={15} />}
    </span>
  );
  if (wide) {
    return (
      <button className={'pill savePill ' + st.kind} onClick={onClick} aria-label={label}>
        {icon} {st.kind === 'saving' ? `${Math.round(st.pct * 100)}%` : st.kind === 'saved' ? 'Saved' : st.kind === 'queued' ? 'Queued' : 'Save'}
      </button>
    );
  }
  return <button className={'saveBtn ' + st.kind} onClick={onClick} aria-label={label}>{icon}</button>;
}

function SaveLine({ st }) {
  if (st.kind === 'saving') return <em className="saveLine on">Saving {Math.round(st.pct * 100)}%{st.eta ? ` · ~${dur(st.eta)} left` : ''}</em>;
  if (st.kind === 'queued') return <em className="saveLine">Waiting to save…</em>;
  if (st.kind === 'saved') return <em className="saveLine ok">✓ Saved for offline</em>;
  if (st.kind === 'partial') return <em className="saveLine">Saved {Math.round(st.pct * 100)}% · paused</em>;
  return null;
}

function dur(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function voiceOf(b) {
  return b.saved ? `${nameOf(b.saved.voice)} · ${Number(b.saved.speed).toFixed(2)}×` : '';
}
