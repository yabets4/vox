/*
 * vox/src/lib/pdf.js — PDF → flowing spoken text.
 *
 * Pipeline:
 *   1. pdfjs text items are re-bucketed into visual lines (y-bands, x-joined by gaps).
 *   2. Running headers/footers + bare page numbers are detected across pages and dropped.
 *   3. Paragraph breaks are inferred from line-spacing outliers WITHIN a page, after
 *      stripping — so nothing is decided on the basis of lines we are about to remove.
 *   4. The document is re-flowed as one contiguous row stream: soft-wrapped lines and
 *      mid-sentence cliffs (even across page breaks) are stitched, hyphen-broken words
 *      are reunited, and terminal punctuation closes a paragraph.
 */
import * as pdfjsLib from 'pdfjs-dist';
// Worker as a Vite-managed asset — same path works in dev and in the bundled app.
// (Node has no Worker concept; pdfjs falls back to its in-process fake worker there.)
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
}

/* ---------- line reconstruction: raw items → ordered {y, text} rows ---------- */

function itemsToRows(items) {
  const frags = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    frags.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 });
  }
  if (!frags.length) return [];

  // bucket by y with tolerance (font sizes vary; 3pt is a safe line-band)
  const bands = [];
  frags.sort((a, b) => b.y - a.y || a.x - b.x);
  for (const f of frags) {
    const band = bands[bands.length - 1];
    if (band && Math.abs(band.y - f.y) < 3.2) band.items.push(f);
    else bands.push({ y: f.y, items: [f] });
  }

  const rows = [];
  for (const band of bands) {
    band.items.sort((a, b) => a.x - b.x);
    let out = '';
    let cursor = null;
    for (const it of band.items) {
      if (!out) out = it.s;
      else {
        const gap = it.x - cursor.x - cursor.wTail;
        // synthesize a space when there's a visible horizontal gap;
        // a very large gap usually means a column/label jump
        const lead = /\s$/.test(out) || /^\s/.test(it.s) ? '' : (gap > Math.max(1.1, it.w / Math.max(it.s.length, 4) * 0.55) ? ' ' : '');
        const sep = gap > 22 ? ' · ' : lead;
        out += sep + it.s;
      }
      cursor = { x: it.x, wTail: it.w };
    }
    out = out.replace(/\s+/g, ' ').trim();
    if (out) rows.push({ y: band.y, text: out });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows;
}

/* ---------- strip running headers/footers + page numbers ---------- */

const PAGE_NO = /^[\s\-—–·|]*\d{1,4}\s*[\s\-—–·|]*$/;
const PAGE_OF = /^page\s+\d+(\s*(of|\/)\s*\d+)?$/i;

function normKey(l) {
  return l.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

function edgesIdx(rows) {
  const first = rows.findIndex((r) => r);
  let last = -1;
  for (let k = rows.length - 1; k >= 0; k--) if (rows[k]) { last = k; break; }
  return [first, last];
}

function stripRunning(rows /* {y,text}[] per page */, counters) {
  if (!rows.length) return;
  const seen = new Set();   // per-page dedupe only (first edge may equal last)
  for (const idx of edgesIdx(rows)) {
    if (idx < 0 || !rows[idx]) continue;
    const text = rows[idx].text;
    if (text.length > 80 || PAGE_NO.test(text) || PAGE_OF.test(text)) continue;
    const k = normKey(text);
    if (seen.has(k)) continue;
    seen.add(k);
    counters.count.set(k, (counters.count.get(k) || 0) + 1);
  }
}

function applyStripping(pagesRows) {
  const counters = { count: new Map() };
  for (const rows of pagesRows) stripRunning(rows, counters);
  if (pagesRows.length < 3) return pagesRows;   // not enough evidence to strip
  const thresh = Math.max(3, Math.ceil(pagesRows.length * 0.55));
  for (const rows of pagesRows) {
    for (const idx of edgesIdx(rows)) {
      if (idx < 0 || !rows[idx]) continue;   // blank/image-only page, or first edge == last edge already dropped
      if (counters.count.get(normKey(rows[idx].text)) >= thresh) rows[idx] = null;
    }
  }
  return pagesRows;
}

/* ---------- paragraph-break sentinels + flattened stream ---------- */

function flattenWithBreaks(pagesRows) {
  const stream = [];
  for (const rows of pagesRows) {
    const live = rows.filter(Boolean);
    if (!live.length) continue;
    const deltas = [];
    for (let i = 1; i < live.length; i++) deltas.push(live[i - 1].y - live[i].y);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const spacing = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    for (let i = 0; i < live.length; i++) {
      if (i > 0 && spacing > 0 && (live[i - 1].y - live[i].y) > spacing * 1.6) {
        stream.push({ brk: true });
      }
      stream.push({ text: live[i].text });
    }
    /* page boundary = paragraph break; the soft-wrap rule below may override it */
  }
  return stream;
}

/* ---------- reflow ---------- */

const STITCHABLE = /(‐|‑|–|-|\u00AD)$/;
const SOFT_END = (line) => !/[.!?;""')\]]\s*$/.test(line) || /:$/.test(line);

function reflow(stream) {
  const paras = [];
  let para = '';
  let i = 0;
  while (i < stream.length) {
    const e = stream[i];
    if (e.brk) {
      if (para.trim()) { paras.push(para); para = ''; }
      i++;
      continue;
    }
    let line = e.text;
    let j = i;
    /* 1) stitch a hyphen-split word with the following row */
    while (
      STITCHABLE.test(line) &&
      j + 1 < stream.length && stream[j + 1].text && /^[a-z0-9(]/.test(stream[j + 1].text)
    ) {
      line = line.replace(STITCHABLE, '') + stream[++j].text;
    }
    i = j + 1;
    /* 2) soft-wrapped lines keep flowing when the next row starts lowercase/digit */
    const soft = SOFT_END(line);
    const nxt = stream[i];
    const cont = soft && nxt && nxt.text && /^[a-z0-9(]/.test(nxt.text.trim());
    if (cont) {
      para = para ? para + ' ' + line : line;
      continue;
    }
    para = para ? para + ' ' + line : line;
    paras.push(para);
    para = '';
  }
  if (para.trim()) paras.push(para);
  return paras
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/* ---------- public API ---------- */

export async function extractPdfText(data, onProgress) {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const pagesRows = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const rows = itemsToRows(tc.items).filter((r) => !PAGE_NO.test(r.text) && !PAGE_OF.test(r.text));
    pagesRows.push(rows);
    onProgress && onProgress(i, doc.numPages);
  }
  applyStripping(pagesRows);
  const text = reflow(flattenWithBreaks(pagesRows));
  const meta = await doc.getMetadata().catch(() => ({}));
  return { pages: doc.numPages, text, meta };
}
