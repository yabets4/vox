import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Cover, Icon, Sheet } from '../components/ui.jsx';
import { storageReport } from '../lib/library.js';
import { modelReport } from '../lib/modelCache.js';

const MB = 1e6;

export default function Storage({ onBack, onClearBookAudio, onClearAllAudio, onDeleteModel, onResetAll, onRegisterBack }) {
  const [report, setReport] = useState(null);
  const [confirm, setConfirm] = useState(null);   // { title, body, label, run }
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!onRegisterBack) return;
    return onRegisterBack(() => {
      if (confirm) { setConfirm(null); return true; }
      return false;
    });
  }, [onRegisterBack, confirm]);


  const load = useCallback(async () => {
    const [books, model, est] = await Promise.all([
      storageReport().catch(() => []),
      modelReport().catch(() => []),
      !Capacitor.isNativePlatform() && navigator.storage && navigator.storage.estimate
        ? navigator.storage.estimate().catch(() => null) : null,
    ]);
    setReport({ books, model, est });
  }, []);
  useEffect(() => { load(); }, [load]);

  const ask = (c) => setConfirm(c);
  const doIt = async () => {
    const c = confirm;
    setConfirm(null);
    setBusy(true);
    try { await c.run(); } finally { setBusy(false); load(); }
  };

  if (!report) {
    return (
      <div className="page">
        <StorageHead onBack={onBack} />
        <div className="card center muted">Measuring…</div>
      </div>
    );
  }

  const modelBytes = report.model.reduce((t, f) => t + f.bytes, 0);
  const audioBytes = report.books.reduce((t, b) => t + b.audioBytes, 0);
  const textBytes = report.books.reduce((t, b) => t + b.textBytes, 0);
  const total = modelBytes + audioBytes + textBytes;
  const withAudio = report.books.filter((b) => b.audioBytes > 0).sort((a, b) => b.audioBytes - a.audioBytes);
  const share = (x) => (total ? `${Math.max(x ? 1.5 : 0, (x / total) * 100)}%` : '0%');
  const free = report.est && report.est.quota ? report.est.quota - report.est.usage : null;

  return (
    <div className="page">
      <StorageHead onBack={onBack} />

      <div className="card storageTotal">
        <span className="muted small">VOX is using</span>
        <b className="bigNum">{size(total)}</b>
        <div className="stackBar">
          <i className="sModel" style={{ width: share(modelBytes) }} />
          <i className="sAudio" style={{ width: share(audioBytes) }} />
          <i className="sText" style={{ width: share(textBytes) }} />
        </div>
        <div className="legend">
          <span><i className="sModel" />Voice {size(modelBytes)}</span>
          <span><i className="sAudio" />Prepared audio {size(audioBytes)}</span>
          <span><i className="sText" />Books {size(textBytes)}</span>
        </div>
        {free != null && <p className="muted small">{size(free)} more available to VOX on this device</p>}
      </div>

      <h3 className="sectionTitle">Voice model</h3>
      <div className="card">
        <div className="kv"><span>Downloaded files</span><b>{report.model.length ? size(modelBytes) : 'None'}</b></div>
        {report.model.map((f) => (
          <div className="kv sub" key={f.name}><span>{f.name}</span><b>{size(f.bytes)}</b></div>
        ))}
        <button className="dangerBtn" disabled={!report.model.length || busy} onClick={() => ask({
          title: 'Delete the voice model?',
          body: 'Frees ' + size(modelBytes) + '. The next time you press play, VOX needs internet to download it again.',
          label: 'Delete voice model',
          run: onDeleteModel,
        })}>
          <Icon.trash size={17} /> Delete voice model
        </button>
      </div>

      <h3 className="sectionTitle">Prepared audio</h3>
      <div className="card list">
        {!withAudio.length && <p className="muted small emptyRow">No prepared audio yet. It's made while you listen.</p>}
        {withAudio.map((b) => (
          <div className="listRow static" key={b.id}>
            <Cover title={b.title || 'Deleted book'} size="xs" />
            <span className="listText">
              <b>{b.title || 'Deleted book'}</b>
              <em>{minutes(b.audioSec)} of listening · {size(b.audioBytes)}</em>
            </span>
            <button className="chipBtn" disabled={busy} onClick={() => ask({
              title: `Clear audio for “${b.title || 'deleted book'}”?`,
              body: `Frees ${size(b.audioBytes)}. The book and your bookmark stay — the audio is made again when you listen.`,
              label: 'Clear audio',
              run: () => onClearBookAudio(b.id),
            })}>Clear</button>
          </div>
        ))}
        {withAudio.length > 1 && (
          <button className="dangerBtn inList" disabled={busy} onClick={() => ask({
            title: 'Clear all prepared audio?',
            body: `Frees ${size(audioBytes)}. Books and bookmarks stay — audio is made again as you listen.`,
            label: 'Clear all audio',
            run: onClearAllAudio,
          })}>
            <Icon.trash size={17} /> Clear all prepared audio
          </button>
        )}
      </div>

      <h3 className="sectionTitle">Books</h3>
      <div className="card">
        <div className="kv"><span>{report.books.filter((b) => b.title).length} books · text</span><b>{size(textBytes)}</b></div>
        <p className="muted small">Remove single books from the Library with the ⋯ button on a cover.</p>
      </div>

      <h3 className="sectionTitle">Start over</h3>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>Deletes every book, bookmark, prepared audio, the voice model and your settings.</p>
        <button className="dangerBtn solid" disabled={busy} onClick={() => ask({
          title: 'Reset VOX?',
          body: `Deletes everything VOX stored (${size(total)}) — all books, bookmarks, audio, the voice model and settings. This cannot be undone.`,
          label: 'Delete everything',
          run: onResetAll,
        })}>
          Reset VOX
        </button>
      </div>

      <Sheet open={!!confirm} onClose={() => setConfirm(null)} title={confirm ? confirm.title : ''}>
        {confirm && (
          <>
            <p className="sheetText">{confirm.body}</p>
            <button className="dangerBtn solid" onClick={doIt}>{confirm.label}</button>
            <button className="textBtn" onClick={() => setConfirm(null)}>Cancel</button>
          </>
        )}
      </Sheet>
    </div>
  );
}

function StorageHead({ onBack }) {
  return (
    <header className="topBar">
      <button className="iconBtn" onClick={onBack} aria-label="Back to settings"><Icon.back /></button>
      <span className="topTitle">Storage</span>
      <span style={{ width: 42 }} />
    </header>
  );
}

function size(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 10 * MB) return Math.round(bytes / MB) + ' MB';
  if (bytes >= 0.1 * MB) return (bytes / MB).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}

function minutes(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m < 1 ? 'under 1 min' : `${m} min`;
}
