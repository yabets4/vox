import { useEffect, useState } from 'react';
import { Icon } from '../components/ui.jsx';
import { TIERS, TIER_ORDER, enginePlan, isModelSaved, lighterTier, voicesFor } from '../lib/tts.js';

export default function Settings({
  voice, onVoice, speed, onSpeed, engine, engineReady, onPreload, bookCount, rtf, onStorage,
  tier, tierChoice, onTier, profile,
}) {
  /* which models are already on the device — switching to one of those needs no internet */
  const [saved, setSaved] = useState({});
  useEffect(() => {
    let alive = true;
    Promise.all(TIER_ORDER.map((t) => isModelSaved(t).then((v) => [t, v])))
      .then((pairs) => { if (alive) setSaved(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [engine.saved, tier]);

  const rec = profile && profile.recommended;
  const slower = tier && rtf != null ? lighterTier(tier, rtf) : null;
  const gpu = profile && profile.gpuName;
  return (
    <div className="page">
      <header className="pageHead"><h1 className="pageTitle">Settings</h1></header>

      <h3 className="sectionTitle">Voice model</h3>
      <div className="card list">
        <button className={'listRow' + (tierChoice === 'auto' ? ' on' : '')} onClick={() => onTier('auto')}>
          <span className="avatar">✦</span>
          <span className="listText">
            <b>Automatic</b>
            <em>{rec ? `Picks ${TIERS[rec].name} for this device — ${profile.why}` : 'Checking this device…'}</em>
          </span>
          {tierChoice === 'auto' && <Icon.check size={20} />}
        </button>
        {TIER_ORDER.map((id) => {
          const t = TIERS[id];
          const blocked = id === 'studio' && profile && !profile.gpu;
          const picked = tierChoice === id;
          return (
            <button key={id} className={'listRow' + (picked ? ' on' : '') + (blocked ? ' off' : '')}
              disabled={blocked} onClick={() => onTier(id)}>
              <span className="avatar">{t.name[0]}</span>
              <span className="listText">
                <b>{t.name}{id === rec && <span className="recTag">Recommended</span>}{id === tier && <span className="useTag">In use</span>}</b>
                <em>{blocked ? 'Needs a WebGPU graphics chip — not available here' : t.blurb}</em>
                <em className="tierMeta">{t.mb} MB · {t.runsOn}{saved[id] ? ' · on this device' : ''}</em>
              </span>
              {picked && <Icon.check size={20} />}
            </button>
          );
        })}
        {slower && (
          <div className="tierHint">
            <b>Voice is slow on this device</b>
            <span>{TIERS[tier].name} makes speech {rtf.toFixed(1)}× slower than it plays. {TIERS[slower].name} ({TIERS[slower].mb} MB) should keep up better.</span>
            <button className="secondaryBtn" onClick={() => onTier(slower)}>Switch to {TIERS[slower].name}</button>
          </div>
        )}
      </div>

      <h3 className="sectionTitle">Narrator</h3>
      <div className="card list">
        {(tier ? voicesFor(tier) : []).map((v) => {
          const [name, gender, accent, grade] = v.label.split('·').map((s) => s.trim());
          return (
            <button key={v.id} className={'listRow' + (v.id === voice ? ' on' : '')} onClick={() => onVoice(v.id)}>
              <span className="avatar">{name[0]}</span>
              <span className="listText"><b>{name}</b><em>{gender} · {accent} English · quality {grade}</em></span>
              {v.id === voice && <Icon.check size={20} />}
            </button>
          );
        })}
      </div>

      <h3 className="sectionTitle">Reading speed</h3>
      <div className="card">
        <div className="sliderRow">
          <span className="muted">Slower</span>
          <input type="range" min="0.7" max="1.35" step="0.05" value={speed}
            onChange={(e) => onSpeed(parseFloat(e.target.value))} />
          <span className="muted">Faster</span>
        </div>
        <p className="center speedBig">{speed.toFixed(2)}×</p>
        <p className="muted small center">Applies from the next time you press play.</p>
      </div>

      <h3 className="sectionTitle">Voice engine</h3>
      <div className="card">
        <div className="kv"><span>Model</span><b>{tier ? TIERS[tier].name : '…'}</b></div>
        <div className="kv"><span>Runs on</span><b>{tier ? enginePlan(tier) : '…'}</b></div>
        {profile && <div className="kv"><span>This device</span><b>{profile.memGB ? `${profile.memGB} GB · ` : ''}{profile.cores} cores</b></div>}
        {gpu && <div className="kv"><span>Graphics chip</span><b className={/nvidia|amd/i.test(gpu) ? 'ok' : ''}>{gpu}</b></div>}
        <div className="kv"><span>Status</span><b className={engineReady ? 'ok' : ''}>
          {engineReady ? 'Loaded'
            : engine.status === 'loading'
              ? engine.phase === 'download' ? `Downloading ${engine.pct}%` : engine.phase === 'save' ? 'Saving…' : 'Loading…'
              : 'Not loaded'}
        </b></div>
        <div className="kv"><span>Speech speed here</span><b className={rtf && rtf <= 1 ? 'ok' : ''}>
          {rtf == null ? 'Measured on first play' : rtf <= 1 ? `Real time (${(1 / rtf).toFixed(1)}× faster)` : `${rtf.toFixed(1)}× slower than real time`}
        </b></div>
        <div className="kv"><span>Saved on this phone</span><b className={engine.saved ? 'ok' : ''}>{engine.saved ? 'Yes — works offline' : 'Not yet'}</b></div>
        {engine.status === 'loading' && <div className="meter"><i style={{ width: `${engine.pct}%` }} /></div>}
        <button className="secondaryBtn" onClick={onPreload} disabled={engineReady || engine.status === 'loading'}>
          {engineReady ? 'Voice ready'
            : engine.status === 'loading' ? (engine.phase === 'download' ? 'Downloading…' : 'Loading…')
            : engine.saved ? 'Load voice' : 'Download voice now'}
        </button>
        <p className="muted small">Downloaded once over the internet, then cached. After that VOX works fully offline.</p>
      </div>

      <h3 className="sectionTitle">Storage</h3>
      <button className="card navRow" onClick={onStorage}>
        <span className="sheetIcon"><Icon.storage /></span>
        <span className="listText"><b>Manage storage</b><em>Voice model, prepared audio, books</em></span>
        <Icon.chevron size={20} />
      </button>

      <h3 className="sectionTitle">About</h3>
      <div className="card">
        <div className="kv"><span>Books on this phone</span><b>{bookCount}</b></div>
        <div className="kv"><span>Privacy</span><b>Everything stays on device</b></div>
        <p className="muted small">
          Voice models: <a href="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX" target="_blank" rel="noreferrer">Kokoro-82M</a> and{' '}
          <a href="https://huggingface.co/KittenML/kitten-tts-nano-0.8-fp32" target="_blank" rel="noreferrer">KittenTTS nano</a> (both Apache-2.0).
          Scanned PDFs without a text layer can't be read yet.
        </p>
      </div>
      <p className="muted small center version">VOX 1.0</p>
    </div>
  );
}
