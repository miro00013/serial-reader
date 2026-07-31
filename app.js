// offline support: cache everything on first visit so the app works with no
// network at all (users can verify nothing is transmitted by using airplane mode)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';
let worker = null;
let workerReady = null;
const items = []; // {id, file, bitmap, serial, status, quality, el}
let nextId = 1;

const $ = id => document.getElementById(id);
const statusEl = $('status');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), 2000);
}

function getWorker() {
  if (!workerReady) {
    statusEl.textContent = 'OCRエンジンを準備中…（初回のみ数秒かかります）';
    // fully offline: worker/core/language data are bundled under vendor/
    workerReady = Tesseract.createWorker('eng', 1, {
      workerPath: new URL('vendor/worker.min.js', location.href).href,
      corePath: new URL('vendor/', location.href).href,
      langPath: new URL('vendor/lang', location.href).href
    }).then(w => { worker = w; return w; });
  }
  return workerReady;
}

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// letters-only serials exist in the wild (e.g. umxhboyno), so 9 alphanumeric
// characters is the only requirement
const isSerial = t => /^[a-z0-9]{9}$/.test(t);

/* ================= image analysis ================= */

// draw bitmap region to canvas at given scale
function regionToCanvas(bitmap, sx, sy, sw, sh, outW, outH) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(outW));
  c.height = Math.max(1, Math.round(outH));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function grayOf(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const g = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < g.length; i++) {
    g[i] = (d[i*4] * 77 + d[i*4+1] * 150 + d[i*4+2] * 29) >> 8;
  }
  return g;
}

// adaptive (local mean) threshold — robust against shadows across the photo.
// returns Uint8Array, 1 = ink (dark)
function adaptiveBinarize(gray, w, h, win, C) {
  // small window keeps the false-ink halo along sharp shadow edges narrow
  win = win || Math.max(21, (Math.min(w, h) / 60) | 0);
  if (win % 2 === 0) win++;
  C = C === undefined ? 12 : C;
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const bin = new Uint8Array(w * h);
  const r = win >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integ[(y1 + 1) * (w + 1) + (x1 + 1)] - integ[y0 * (w + 1) + (x1 + 1)]
                - integ[(y1 + 1) * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      bin[y * w + x] = (gray[y * w + x] * area < sum - C * area) ? 1 : 0;
    }
  }
  return bin;
}

// histogram-valley threshold for cropped regions: text / shadowed paper / lit
// paper form distinct modes, and splitting at the first valley isolates the
// text with no halo along sharp shadow edges. Returns null if no clear valley.
function valleyBinarize(gray, w, h) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const sm = hist.map((_, i) => {
    let s = 0, n = 0;
    for (let j = -3; j <= 3; j++) { const k = i + j; if (k >= 0 && k < 256) { s += hist[k]; n++; } }
    return s / n;
  });
  const total = gray.length;
  const peaks = [];
  for (let i = 1; i < 255; i++)
    if (sm[i] >= sm[i - 1] && sm[i] > sm[i + 1] && sm[i] > total * 0.0008) peaks.push(i);
  if (!peaks.length) return null;
  const p0 = peaks[0];
  const p1 = peaks.find(p => p > p0 + 25);
  if (!p1) return null;
  let t = p0, vv = Infinity;
  for (let i = p0; i <= p1; i++) if (sm[i] < vv) { vv = sm[i]; t = i; }
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) bin[i] = gray[i] < t ? 1 : 0;
  return bin;
}

// connected components (4-neighbor flood fill), returns bounding boxes
function findComponents(bin, w, h) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let nextLabel = 1;
  for (let i = 0; i < w * h; i++) {
    if (bin[i] !== 1 || labels[i] !== 0) continue;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = nextLabel;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p / w) | 0;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && bin[p-1] === 1 && labels[p-1] === 0) { labels[p-1] = nextLabel; stack[sp++] = p-1; }
      if (px < w-1 && bin[p+1] === 1 && labels[p+1] === 0) { labels[p+1] = nextLabel; stack[sp++] = p+1; }
      if (py > 0 && bin[p-w] === 1 && labels[p-w] === 0) { labels[p-w] = nextLabel; stack[sp++] = p-w; }
      if (py < h-1 && bin[p+w] === 1 && labels[p+w] === 0) { labels[p+w] = nextLabel; stack[sp++] = p+w; }
    }
    comps.push({ x0, y0, x1, y1, area, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    nextLabel++;
  }
  return comps;
}

// merge components whose x-ranges overlap (i/j dots with their stems)
function mergeVertical(comps) {
  comps.sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const c of comps) {
    let target = null;
    for (const m of merged) {
      const ovl = Math.min(m.x1, c.x1) - Math.max(m.x0, c.x0);
      const minW = Math.min(m.w, c.w);
      if (ovl > minW * 0.5) { target = m; break; }
    }
    if (target) {
      // record when a small detached blob above a taller stem merges in —
      // in this charset only i and j carry a dot
      const small = target.h <= c.h ? target : c;
      const big = target.h <= c.h ? c : target;
      if (small.h < big.h * 0.6 && small.y1 <= big.y0 + small.h * 0.5) target.dot = true;
      target.x0 = Math.min(target.x0, c.x0); target.x1 = Math.max(target.x1, c.x1);
      target.y0 = Math.min(target.y0, c.y0); target.y1 = Math.max(target.y1, c.y1);
      target.w = target.x1 - target.x0 + 1; target.h = target.y1 - target.y0 + 1;
      target.area += c.area;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

// group char-like components into horizontal text lines, score them,
// return candidate serial lines (best first) with char boxes
function findSerialLines(comps, imgW, imgH, opts) {
  // keep plausible character shapes; size bounds are overridable because a
  // manual crop contains characters much larger relative to the image
  const minH = (opts && opts.minH) || Math.max(8, imgH * 0.008);
  const maxH = (opts && opts.maxH) || imgH * 0.12;
  const chars = comps.filter(c =>
    c.h >= minH && c.h <= maxH &&
    c.w <= c.h * 2.2 && c.w >= 2 &&
    c.area >= c.w * c.h * 0.1
  );
  // cluster into lines by vertical overlap
  const lines = [];
  const sorted = [...chars].sort((a, b) => a.y0 - b.y0);
  for (const c of sorted) {
    let best = null, bestOvl = 0;
    for (const line of lines) {
      const ovl = Math.min(line.y1, c.y1) - Math.max(line.y0, c.y0);
      const minH = Math.min(line.y1 - line.y0, c.h);
      if (ovl > minH * 0.5 && ovl > bestOvl) { best = line; bestOvl = ovl; }
    }
    if (best) {
      best.members.push(c);
      best.y0 = Math.min(best.y0, c.y0);
      best.y1 = Math.max(best.y1, c.y1);
    } else {
      lines.push({ y0: c.y0, y1: c.y1, members: [c] });
    }
  }
  const scored = [];
  for (const line of lines) {
    let ms = mergeVertical(line.members);
    // drop tiny noise specks relative to the line's median height
    const medH = median(ms.map(m => m.h));
    ms = ms.filter(m => m.h > medH * 0.35);
    // the ticket prints a small label in the same horizontal band as the
    // serial — keep only the tallest height cluster (serial glyphs are all
    // ≥ ~0.58× the tallest one; label glyphs are ≤ ~0.45×)
    const tallest = Math.max(...ms.map(m => m.h));
    ms = ms.filter(m => m.h >= tallest * 0.5).sort((a, b) => a.x0 - b.x0);
    // dot rescue: i/j dots are too small for the character filter above, so
    // pull them back in from the raw component list — any small blob sitting
    // directly above a box belongs to it
    for (const m of ms) {
      for (const c of comps) {
        if (c.h >= m.h * 0.35 || c.h < 2 || c === m) continue;
        const xOvl = Math.min(m.x1, c.x1) - Math.max(m.x0, c.x0);
        if (xOvl < Math.min(m.w, c.w) * 0.5) continue;
        if (c.y1 <= m.y0 && m.y0 - c.y1 < m.h * 0.45) {
          m.y0 = Math.min(m.y0, c.y0);
          m.h = m.y1 - m.y0 + 1;
          m.dot = true;
        }
      }
    }
    if (!ms.length) continue;
    // split at large horizontal gaps — side-by-side tickets in one photo put
    // several serials into the same horizontal band. Threshold keys off the
    // median inter-character gap: within one serial gaps are uniform (even
    // with wide letter-spacing), between tickets they are several times larger.
    const medW = median(ms.map(m => m.w));
    const gapsAll = [];
    for (let i = 1; i < ms.length; i++) gapsAll.push(ms[i].x0 - ms[i - 1].x1);
    const medGap = gapsAll.length ? Math.max(0, median(gapsAll)) : 0;
    const splitAt = Math.max(medGap * 3, medW * 4, 12);
    const runs = [];
    let cur = [ms[0]];
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].x0 - ms[i - 1].x1 > splitAt) { runs.push(cur); cur = []; }
      cur.push(ms[i]);
    }
    runs.push(cur);
    for (const run of runs) {
      const n = run.length;
      if (n < 7 || n > 11) continue;
      // serials are printed with wide letter-spacing; URLs and body text are
      // tightly packed. Require the median inter-character gap to be a decent
      // fraction of the character width, or this "line" is ordinary text.
      const runMedW = median(run.map(m => m.w));
      const edgeGaps = [];
      for (let i = 1; i < n; i++) edgeGaps.push(run[i].x0 - run[i - 1].x1);
      if (median(edgeGaps) < runMedW * 0.22) continue;
      const heights = run.map(m => m.h);
      const hMean = avg(heights);
      const hCv = Math.sqrt(avg(heights.map(v => (v - hMean) ** 2))) / hMean;
      if (hCv > 0.45) continue;
      const centers = run.map(m => (m.x0 + m.x1) / 2);
      const gaps = [];
      for (let i = 1; i < n; i++) gaps.push(centers[i] - centers[i - 1]);
      const gMean = avg(gaps);
      const gCv = gaps.length > 1 ? Math.sqrt(avg(gaps.map(v => (v - gMean) ** 2))) / gMean : 1;
      if (gCv > 0.5) continue;
      let score = 0;
      score -= Math.abs(n - 9) * 12;           // want exactly 9 characters
      score += (1 - hCv) * 10;                 // uniform heights
      score += (1 - gCv) * 10;                 // uniform spacing
      score += Math.min(hMean / imgH, 0.06) * 300; // serial is printed large
      scored.push({ score, boxes: run,
        x0: run[0].x0, x1: run[n-1].x1,
        y0: Math.min(...run.map(m => m.y0)), y1: Math.max(...run.map(m => m.y1)) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 15);
}

const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[(s.length / 2) | 0];
}

/* ================= OCR core ================= */

// render binarized region (black ink on white) to a canvas for tesseract
function binToCanvas(bin, w, h, x0, y0, x1, y1, pad, targetH) {
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const p = Math.round(bh * pad);
  const tmp = document.createElement('canvas');
  tmp.width = bw + p * 2; tmp.height = bh + p * 2;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = '#fff';
  tctx.fillRect(0, 0, tmp.width, tmp.height);
  const img = tctx.getImageData(0, 0, tmp.width, tmp.height);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (bin[(y0 + y) * w + (x0 + x)] === 1) {
        const idx = ((y + p) * tmp.width + (x + p)) * 4;
        img.data[idx] = img.data[idx+1] = img.data[idx+2] = 0;
      }
    }
  }
  tctx.putImageData(img, 0, 0);
  const scale = targetH / tmp.height;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(tmp.width * scale));
  out.height = Math.max(1, Math.round(tmp.height * scale));
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(tmp, 0, 0, out.width, out.height);
  return out;
}

async function ocrWith(canvas, psm) {
  const w = await getWorker();
  await w.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: CHARSET });
  const { data } = await w.recognize(canvas);
  return data;
}

// re-render the 9 detected character boxes side by side with normal spacing
// (the serial is printed with very wide letter-spacing, which makes tesseract
// hallucinate extra characters — tight re-composition fixes that).
// keeps each glyph's true vertical offset so baselines/descenders survive.
function compose(cand, srcFn) {
  const boxes = cand.boxes;
  const lineH = cand.y1 - cand.y0 + 1;
  const chH = Math.max(...boxes.map(b => b.h));
  const gap = Math.round(chH * 0.25);
  const totalW = boxes.reduce((s, b) => s + b.w, 0) + gap * (boxes.length + 1);
  const tc = document.createElement('canvas');
  tc.width = totalW; tc.height = lineH + gap * 2;
  const tctx = tc.getContext('2d');
  tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, tc.width, tc.height);
  let cx = gap; const xmap = [];
  for (const b of boxes) {
    tctx.drawImage(srcFn(b), cx, gap + (b.y0 - cand.y0));
    xmap.push({ x0: cx, x1: cx + b.w });
    cx += b.w + gap;
  }
  const sc = 120 / tc.height;
  const up = document.createElement('canvas');
  up.width = Math.max(1, Math.round(tc.width * sc)); up.height = 120;
  const uctx = up.getContext('2d');
  uctx.imageSmoothingQuality = 'high';
  uctx.fillStyle = '#fff'; uctx.fillRect(0, 0, up.width, up.height);
  uctx.drawImage(tc, 0, 0, up.width, up.height);
  return { canvas: up, xmap: xmap.map(m => ({ x0: m.x0 * sc, x1: m.x1 * sc })) };
}

const isDigit = ch => ch >= '0' && ch <= '9';
// visually near-identical pairs — flag for manual verification when they compete
const CONFUSABLE = [['0','o'], ['1','l'], ['1','i'], ['5','s'], ['2','z'], ['7','z'], ['6','0'], ['9','q'], ['9','g'], ['j','y'], ['j','i'], ['4','d']];

// read one detected serial line with an ensemble:
//  - line OCR of tight-composed binary + grayscale images (strong on letters)
//  - per-character OCR of each box (strong on digits)
// then confidence-weighted voting per character position.
async function readLine(srcCanvas, bin, w, h, cand) {
  // URL / body-text gate: OCR the raw region once WITHOUT a character
  // whitelist. Degraded URL fragments can mimic a 9-glyph wide-spaced line,
  // but punctuation and URL keywords give them away here — the whitelisted
  // ensemble below would never see them.
  {
    const lh = cand.y1 - cand.y0 + 1;
    const pad = Math.round(lh * 0.2);
    const sx = Math.max(0, cand.x0 - pad), sy = Math.max(0, cand.y0 - pad);
    const sw = Math.min(w - sx, (cand.x1 - cand.x0 + 1) + pad * 2);
    const sh = Math.min(h - sy, lh + pad * 2);
    const gc = regionToCanvas(srcCanvas, sx, sy, sw, sh, sw * (90 / sh), 90);
    const wk = await getWorker();
    await wk.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
    const raw = (await wk.recognize(gc)).data.text || '';
    const puncts = (raw.match(/[:\/\\.]/g) || []).length;
    if (/https?|www|cdefgah|illit|official|\.net|\.jp|\.com/i.test(raw) || puncts >= 3) return null;
  }

  if (cand.boxes.length !== 9) {
    // segmentation is off — best effort: OCR the raw line region
    const lc = binToCanvas(bin, w, h, cand.x0, cand.y0, cand.x1, cand.y1, 0.35, 100);
    const t = norm((await ocrWith(lc, 7)).text);
    return isSerial(t) ? { serial: t, quality: 'check' } : null;
  }

  const votes = Array.from({ length: 9 }, () => ({}));
  const addVote = (i, ch, wt) => {
    if (i >= 0 && i < 9 && ch && wt > 0) votes[i][ch] = (votes[i][ch] || 0) + wt;
  };

  const binSrc = b => binToCanvas(bin, w, h, b.x0, b.y0, b.x1, b.y1, 0, b.h);
  const graySrc = b => {
    const c = document.createElement('canvas');
    c.width = b.w; c.height = b.h;
    c.getContext('2d').drawImage(srcCanvas, b.x0, b.y0, b.w, b.h, 0, 0, b.w, b.h);
    return c;
  };

  const lineTexts = [];
  for (const srcFn of [binSrc, graySrc]) {
    const comp = compose(cand, srcFn);
    const data = await ocrWith(comp.canvas, 7);
    lineTexts.push(norm(data.text));
    for (const s of (data.symbols || [])) {
      if (!s.bbox) continue;
      const scx = (s.bbox.x0 + s.bbox.x1) / 2;
      let bi = -1, bd = Infinity;
      comp.xmap.forEach((m, i) => {
        const d = Math.abs((m.x0 + m.x1) / 2 - scx);
        if (d < bd) { bd = d; bi = i; }
      });
      addVote(bi, norm(s.text)[0], s.confidence / 100);
    }
  }

  // per-character passes: binary PSM 10 / binary PSM 8 / grayscale PSM 8.
  // digits recognized here are near-certain, while the line LSTM tends to
  // turn them into letters (4→d, 1→l) — but only boost a digit when no
  // per-char pass contradicts it, so a single misread can't hijack a box.
  for (let i = 0; i < 9; i++) {
    const b = cand.boxes[i];
    const reads = [];
    const binCC = binToCanvas(bin, w, h, b.x0, b.y0, b.x1, b.y1, 0.4, 80);
    for (const psm of [10, 8]) {
      const data = await ocrWith(binCC, psm);
      reads.push({ ch: norm(data.text)[0], conf: (data.confidence || 0) / 100 });
    }
    {
      const pad = Math.round(b.h * 0.4);
      const px0 = Math.max(0, b.x0 - pad), py0 = Math.max(0, b.y0 - pad);
      const pw = Math.min(w - px0, b.w + pad * 2), ph = Math.min(h - py0, b.h + pad * 2);
      const gcc = regionToCanvas(srcCanvas, px0, py0, pw, ph, pw * (80 / ph), 80);
      const data = await ocrWith(gcc, 8);
      reads.push({ ch: norm(data.text)[0], conf: (data.confidence || 0) / 100 });
    }
    const nonEmpty = reads.filter(r => r.ch);
    // near-zero-confidence reads are noise — keep them out of the consensus check
    const confident = nonEmpty.filter(r => r.conf >= 0.3);
    const allSame = confident.length >= 2 && confident.every(r => r.ch === confident[0].ch);
    const boost = (allSame && isDigit(confident[0].ch) &&
      Math.max(...confident.map(r => r.conf)) >= 0.7) ? 2.2 : 1.0;
    for (const r of nonEmpty) addVote(i, r.ch, r.conf * 0.9 * (r.ch === (confident[0] && confident[0].ch) ? boost : 1));
  }

  let serial = '', uncertain = [];
  for (let i = 0; i < 9; i++) {
    const es = Object.entries(votes[i]).sort((a, b) => b[1] - a[1]);
    if (!es.length) { serial += '?'; uncertain.push(i); continue; }
    serial += es[0][0];
    const conf2 = es[1] ? es[1][1] / es[0][1] : 0;
    const confusablePair = es[1] && CONFUSABLE.some(([x, y]) =>
      (es[0][0] === x && es[1][0] === y) || (es[0][0] === y && es[1][0] === x));
    if (es[0][1] < 0.6 || conf2 > 0.45 ||
        (confusablePair && (conf2 > 0.2 || es[1][1] > 0.35))) uncertain.push(i);
  }

  // geometric dot rule: only i and j carry a detached dot. A dotted glyph read
  // as anything else gets corrected (i vs j decided by its descender relative
  // to a tilt-tolerant fitted baseline); an undotted i/j reading is suspect.
  {
    const boxes = cand.boxes;
    const lineH = cand.y1 - cand.y0 + 1;
    const pts = boxes.map(b => ({ x: (b.x0 + b.x1) / 2, y: b.y1 }));
    const fit = sub => {
      const slopes = [];
      for (let i = 0; i < sub.length; i++)
        for (let j = i + 1; j < sub.length; j++)
          if (sub[j].x !== sub[i].x) slopes.push((sub[j].y - sub[i].y) / (sub[j].x - sub[i].x));
      const slope = median(slopes);
      return { slope, base: median(sub.map(p => p.y - slope * p.x)) };
    };
    // two-pass: descender boxes distort the first fit, so refit without them
    let { slope, base } = fit(pts);
    const inliers = pts.filter(p => Math.abs(p.y - (slope * p.x + base)) < Math.max(3, lineH * 0.045));
    if (inliers.length >= 4) ({ slope, base } = fit(inliers));
    // gothic descenders are shallow (~5-10% of line height below the baseline);
    // non-descender boxes fit the baseline within ~2% — 5% separates them
    const descThresh = Math.max(3, lineH * 0.05);
    const chars = serial.split('');
    const flag = i => { if (!uncertain.includes(i)) uncertain.push(i); };
    const descFlags = pts.map(p => p.y - (slope * p.x + base) > descThresh);
    for (let i = 0; i < 9; i++) {
      if (boxes[i].dot) {
        const dotChar = descFlags[i] ? 'j' : 'i';
        if (chars[i] !== dotChar) {
          chars[i] = dotChar;
          flag(i);
        }
      } else if (chars[i] === 'i' || chars[i] === 'j') {
        flag(i);
      }
    }
    // descender rule: g/j/p/q/y reach below the baseline, nothing else does.
    // On mismatch, swap to the best-voted character of the right class (q read
    // as a, etc.) — never invent a character the OCR didn't consider.
    const DESC = 'gjpqy';
    for (let i = 0; i < 9; i++) {
      if (boxes[i].dot) continue;
      const wrongClass = descFlags[i] !== DESC.includes(chars[i]);
      if (!wrongClass) continue;
      const alt = Object.entries(votes[i])
        .filter(([c]) => DESC.includes(c) === descFlags[i])
        .sort((a, b) => b[1] - a[1])[0];
      if (alt) chars[i] = alt[0];
      flag(i);
    }
    // height-class rule: o/s/z are x-height glyphs while 0/5/2 are full-height,
    // and OCR alone cannot tell them apart (letters-only serials exist, so
    // digit context is no guarantee). Compare each box against the line's
    // height classes when both classes are present.
    const hs = boxes.map(b => b.h);
    const hMaxAll = Math.max(...hs), hMinAll = Math.min(...hs);
    if (hMaxAll / hMinAll > 1.18) {
      const mid = (hMaxAll + hMinAll) / 2;
      const toLetter = { '0': 'o', '5': 's', '2': 'z', '7': 'z' };
      const toDigit = { 'o': '0', 's': '5', 'z': '2' };
      for (let i = 0; i < 9; i++) {
        if (boxes[i].dot) continue;
        const tall = hs[i] > mid;
        if (toLetter[chars[i]] && !tall) { chars[i] = toLetter[chars[i]]; flag(i); }
        else if (toDigit[chars[i]] && tall) { chars[i] = toDigit[chars[i]]; flag(i); }
      }
    }
    serial = chars.join('');
    uncertain.sort((a, b) => a - b);
  }
  if (!isSerial(serial)) {
    // voting produced something invalid; fall back to a valid line reading if any
    const valid = lineTexts.find(isSerial);
    if (valid) return { serial: valid, quality: 'check' };
    return null;
  }
  // every actual misread in testing was caught by the per-position uncertainty
  // flags, so an all-clear vote is trustworthy on its own
  const quality = uncertain.length === 0 ? 'high' : 'check';
  return { serial, quality, uncertain, ensemble: true };
}

function stripDataUrl(bitmap, sx, sy, sw, sh) {
  const padX = sw * 0.04, padY = sh * 0.3;
  sx = Math.max(0, sx - padX); sy = Math.max(0, sy - padY);
  sw = Math.min(bitmap.width - sx, sw + padX * 2);
  sh = Math.min(bitmap.height - sy, sh + padY * 2);
  const c = regionToCanvas(bitmap, sx, sy, sw, sh, Math.min(560, sw), Math.min(560, sw) * sh / sw);
  return c.toDataURL('image/jpeg', 0.8);
}

// automatic: analyze the whole photo and read EVERY serial found (a photo can
// hold several tickets). Sweeps binarization sensitivity, then falls back to
// reading inside detected serial-box outlines for tickets the line detector
// missed. Returns an array of results in reading order.
function regionsOverlap(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const amin = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return ix * iy > amin * 0.4;
}

// auto-detection accepts only ensemble-validated reads with few uncertain
// positions — Japanese label text and background texture can structurally look
// like a 9-glyph line, but they come out of the ensemble covered in flags.
// (Manual crop keeps showing raw fallback results; the user judges those.)
const isAutoAcceptable = r =>
  r && isSerial(r.serial) && r.ensemble && (r.uncertain || []).length <= 3;

// re-read a detected line region as a tight high-resolution crop — coarse-scale
// sweep hits often clean up completely on the second, tighter pass
async function refineRegion(bitmap, region) {
  const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
  const padX = rw * 0.06 + 8, padY = rh * 0.7 + 8;
  const sx = Math.max(0, region.x0 - padX), sy = Math.max(0, region.y0 - padY);
  const sw = Math.min(bitmap.width - sx, rw + padX * 2);
  const sh = Math.min(bitmap.height - sy, rh + padY * 2);
  if (sw < 30 || sh < 10) return null;
  return cropRead(bitmap, sx, sy, sw, sh);
}

async function autoReadAll(bitmap) {
  const scale = Math.min(1, 2200 / bitmap.width);
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = regionToCanvas(bitmap, 0, 0, bitmap.width, bitmap.height, w, h);
  const gray = grayOf(canvas);
  const found = []; // {res, region} in bitmap coords
  const boxCands = [];

  for (const C of [12, 6, 20, 3]) {
    const bin = adaptiveBinarize(gray, w, h, undefined, C);
    const comps = findComponents(bin, w, h);
    for (const cand of findSerialLines(comps, w, h)) {
      const region = { x0: cand.x0 / scale, y0: cand.y0 / scale,
                       x1: cand.x1 / scale, y1: cand.y1 / scale };
      if (found.some(f => regionsOverlap(f.region, region))) continue;
      let res = null;
      if (scale < 1) {
        // refine: re-read the detected line region at full photo resolution
        const padX = (cand.x1 - cand.x0) * 0.05 + 8;
        const padY = (cand.y1 - cand.y0) * 0.7 + 8;
        const sx = Math.max(0, (cand.x0 - padX) / scale);
        const sy = Math.max(0, (cand.y0 - padY) / scale);
        const sw = Math.min(bitmap.width - sx, (cand.x1 - cand.x0 + 1 + padX * 2) / scale);
        const sh = Math.min(bitmap.height - sy, (cand.y1 - cand.y0 + 1 + padY * 2) / scale);
        const r = await cropRead(bitmap, sx, sy, sw, sh);
        if (isAutoAcceptable(r)) { res = r; if (r.region) Object.assign(region, r.region); }
      }
      if (!res) {
        const r = await readLine(canvas, bin, w, h, cand);
        if (isAutoAcceptable(r)) {
          r.strip = stripDataUrl(bitmap, region.x0, region.y0,
            region.x1 - region.x0 + 1, region.y1 - region.y0 + 1);
          res = r;
        }
      }
      if (res) found.push({ res, region });
    }
    // collect serial-box outline candidates: wide, hollow rectangles
    for (const c of comps) {
      if (c.w > w * 0.15 && c.w / c.h >= 3 &&
          c.h > h * 0.01 && c.h < h * 0.25 &&
          c.area < c.w * c.h * 0.4) boxCands.push(c);
    }
  }

  // fallback: read inside box outlines that no detected line covers
  boxCands.sort((a, b) => a.area / (a.w * a.h) - b.area / (b.w * b.h)); // hollow first
  for (const bx of boxCands.slice(0, 15)) {
    const region = { x0: bx.x0 / scale, y0: bx.y0 / scale, x1: bx.x1 / scale, y1: bx.y1 / scale };
    if (found.some(f => regionsOverlap(f.region, region))) continue;
    const inset = 4 / scale;
    const sw = (region.x1 - region.x0) - inset * 2, sh = (region.y1 - region.y0) - inset * 2;
    if (sw < 40 || sh < 15) continue;
    const res = await cropRead(bitmap, region.x0 + inset, region.y0 + inset, sw, sh, { quick: true });
    if (isAutoAcceptable(res)) found.push({ res, region: res.region || region });
  }

  // last resort: sweep overlapping tiles over areas without a serial yet,
  // giving missed tickets (glare, unusual contrast) the same treatment as a
  // manual crop. Tile size follows the serials already found when possible.
  {
    const regW = found.length
      ? median(found.map(f => f.region.x1 - f.region.x0)) : bitmap.width / 2.5;
    const regH = found.length
      ? median(found.map(f => f.region.y1 - f.region.y0)) : bitmap.height / 25;
    const tileW = Math.min(bitmap.width, Math.max(regW * 2.2, bitmap.width * 0.3));
    const tileH = Math.min(bitmap.height, Math.max(regH * 12, bitmap.height * 0.1));
    for (let ty = 0; ty < bitmap.height - tileH * 0.25; ty += tileH * 0.5) {
      for (let tx = 0; tx < bitmap.width - tileW * 0.25; tx += tileW * 0.5) {
        const tile = { x0: tx, y0: ty,
          x1: Math.min(tx + tileW, bitmap.width), y1: Math.min(ty + tileH, bitmap.height) };
        if (found.some(f => regionsOverlap(f.region, tile))) continue;
        let res = await cropRead(bitmap, tile.x0, tile.y0,
          tile.x1 - tile.x0, tile.y1 - tile.y0, { quick: true });
        if (isAutoAcceptable(res)) {
          let region = res.region || tile;
          if ((res.uncertain || []).length && res.region) {
            const r2 = await refineRegion(bitmap, res.region);
            if (isAutoAcceptable(r2) &&
                (r2.uncertain || []).length < res.uncertain.length) {
              res = r2;
              region = r2.region || region;
            }
          }
          if (!found.some(f => regionsOverlap(f.region, region))) found.push({ res, region });
        }
      }
    }
  }

  // reading order: top→bottom in loose bands, then left→right
  const band = bitmap.height * 0.06;
  found.sort((f, g) =>
    (Math.round(f.region.y0 / band) - Math.round(g.region.y0 / band)) ||
    (f.region.x0 - g.region.x0));
  return found.map(f => { f.res.region = f.res.region || f.region; return f.res; });
}

// crop pipeline, used by manual selection, auto refine, and the tile sweep.
// opts.quick: fewer binarize variants and no raw-OCR fallback (for sweeps).
async function cropRead(bitmap, sx, sy, sw, sh, opts) {
  opts = opts || {};
  const scale = Math.min(4, Math.max(1, 900 / sw));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const canvas = regionToCanvas(bitmap, sx, sy, sw, sh, w, h);
  const gray = grayOf(canvas);
  if (opts.quick) {
    // sweep tiles with no dark ink (bare background) aren't worth binarizing
    let mean = 0;
    for (let i = 0; i < gray.length; i++) mean += gray[i];
    mean /= gray.length;
    let dark = 0;
    const thr = mean - 55;
    for (let i = 0; i < gray.length; i++) if (gray[i] < thr) dark++;
    if (dark < gray.length * 0.002) return null;
  }
  const strip = opts.quick ? null : stripDataUrl(bitmap, sx, sy, sw, sh);
  let lastBin = null;
  const variants = [
    () => valleyBinarize(gray, w, h),
    () => adaptiveBinarize(gray, w, h, undefined, 12),
    () => adaptiveBinarize(gray, w, h, undefined, 6),
    () => adaptiveBinarize(gray, w, h, undefined, 20),
    () => adaptiveBinarize(gray, w, h, undefined, 3)];
  for (const make of variants) {
    const bin = make();
    if (!bin) continue;
    lastBin = lastBin || bin;
    const comps = findComponents(bin, w, h);
    const cands = findSerialLines(comps, w, h, { minH: Math.max(8, h * 0.04), maxH: h * 0.95 });
    for (const cand of cands) {
      const res = await readLine(canvas, bin, w, h, cand);
      if (res) {
        res.region = { x0: sx + cand.x0 / scale, y0: sy + cand.y0 / scale,
                       x1: sx + cand.x1 / scale, y1: sy + cand.y1 / scale };
        res.strip = strip || stripDataUrl(bitmap, res.region.x0, res.region.y0,
          res.region.x1 - res.region.x0 + 1, res.region.y1 - res.region.y0 + 1);
        return res;
      }
    }
  }
  if (opts.quick || !lastBin) return null;
  // fall back: OCR the whole selection as one line
  const t = norm((await ocrWith(binToCanvas(lastBin, w, h, 0, 0, w - 1, h - 1, 0.1, 100), 7)).text);
  return { serial: t, quality: isSerial(t) ? 'check' : 'low', strip,
           region: { x0: sx, y0: sy, x1: sx + sw, y1: sy + sh } };
}

/* ================= UI ================= */

function makeCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <img class="thumb" title="クリックで範囲指定" alt="">
    <div class="info">
      <div class="fname"></div>
      <div class="rows"></div>
      <div class="cardStatus">順番待ち…</div>
    </div>
    <div class="btns">
      <button class="reCrop">範囲指定で追加</button>
    </div>`;
  card.querySelector('.fname').textContent = item.file.name;
  const img = card.querySelector('.thumb');
  img.src = URL.createObjectURL(item.file);
  img.onclick = () => openCrop(item);
  card.querySelector('.reCrop').onclick = () => openCrop(item);
  $('list').appendChild(card);
  item.el = card;
  return card;
}

function addRow(item, res) {
  const row = { serial: res.serial || '', quality: res.quality || 'check',
                uncertain: res.uncertain || [], region: res.region || null, el: null };
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = `
    <img class="strip" alt="">
    <input class="serial" spellcheck="false" autocomplete="off">
    <span class="badge"></span>
    <span class="rowBtns">
      <button class="rowCopy">コピー</button>
      <button class="rowDel" title="このシリアル行を削除">削除</button>
    </span>`;
  const strip = el.querySelector('.strip');
  if (res.strip) strip.src = res.strip; else strip.style.display = 'none';
  const input = el.querySelector('.serial');
  input.value = row.serial;
  input.addEventListener('input', e => {
    row.serial = e.target.value.trim();
    row.quality = 'manual';
    refreshBadges();
  });
  el.querySelector('.rowCopy').onclick = () => {
    const v = input.value.trim();
    if (v) { navigator.clipboard.writeText(v); toast('コピーしました: ' + v); }
  };
  el.querySelector('.rowDel').onclick = () => {
    item.rows = item.rows.filter(r => r !== row);
    el.remove();
    updateThumb(item);
    refreshBadges();
  };
  row.el = el;
  item.rows.push(row);
  item.el.querySelector('.rows').appendChild(el);
  return row;
}

// redraw the card thumbnail with green boxes around every serial already read,
// so tickets that were missed stand out at a glance
function updateThumb(item) {
  if (!item.bitmap) return;
  const bmp = item.bitmap;
  const scale = 200 / bmp.width;
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  ctx.strokeStyle = '#1e9e50';
  ctx.lineWidth = 3;
  for (const r of item.rows) {
    if (!r.region) continue;
    const pad = 5;
    ctx.strokeRect(
      r.region.x0 * scale - pad, r.region.y0 * scale - pad,
      (r.region.x1 - r.region.x0) * scale + pad * 2,
      (r.region.y1 - r.region.y0) * scale + pad * 2);
  }
  item.el.querySelector('.thumb').src = c.toDataURL();
}

function setCardStatus(item, text, isErr, busy) {
  const s = item.el.querySelector('.cardStatus');
  s.textContent = text || '';
  s.style.display = text ? '' : 'none';
  s.classList.toggle('err', !!isErr);
  s.classList.toggle('busy', !!busy);
}

function allRows() {
  return items.flatMap(it => it.rows);
}

function refreshBadges() {
  const counts = {};
  for (const r of allRows()) if (r.serial) counts[r.serial] = (counts[r.serial] || 0) + 1;
  let okCount = 0;
  for (const r of allRows()) {
    const input = r.el.querySelector('.serial');
    const badge = r.el.querySelector('.badge');
    input.classList.remove('ok', 'warn', 'ng', 'dup');
    badge.classList.remove('ok', 'warn', 'ng', 'dup', 'wait');
    if (!r.serial || !isSerial(r.serial)) {
      input.classList.add('ng'); badge.classList.add('ng');
      badge.textContent = r.serial ? '9桁の英数字ではありません' : '未入力';
    } else if (counts[r.serial] > 1) {
      input.classList.add('dup'); badge.classList.add('dup');
      badge.textContent = '重複しています';
      okCount++;
    } else if (r.quality === 'high' || r.quality === 'manual') {
      input.classList.add('ok'); badge.classList.add('ok');
      badge.textContent = 'OK';
      okCount++;
    } else {
      input.classList.add('warn'); badge.classList.add('warn');
      badge.textContent = (r.uncertain && r.uncertain.length)
        ? `要確認: ${r.uncertain.map(i => i + 1).join(',')}文字目`
        : '要確認（画像と見比べてください）';
      okCount++;
    }
  }
  const total = allRows().length;
  $('count').textContent = `写真${items.length}枚 / シリアル${total}件（うち${okCount}件OK）`;
  $('summary').classList.toggle('show', items.length > 0);
}

/* ---- processing queue ---- */
let queue = Promise.resolve();
function enqueue(item) {
  queue = queue.then(async () => {
    try {
      item.status = 'processing';
      statusEl.textContent = `読み取り中… (${item.file.name})`;
      setCardStatus(item, '読み取り中…（写真1枚あたり10〜30秒ほどかかります）', false, true);
      if (!item.bitmap) item.bitmap = await createImageBitmap(item.file);
      await getWorker();
      const results = await autoReadAll(item.bitmap);
      item.status = 'done';
      for (const res of results) addRow(item, res);
      updateThumb(item);
      setCardStatus(item,
        results.length
          ? '読み取れた場所はサムネイルに緑枠で表示されます。枠のないチケットは「範囲指定で追加」から読み取ってください'
          : '自動検出できませんでした。「範囲指定で追加」から読み取ってください',
        !results.length);
      refreshBadges();
    } catch (e) {
      console.error(e);
      item.status = 'done';
      setCardStatus(item, 'エラーが発生しました。範囲指定をお試しください', true);
      refreshBadges();
    } finally {
      if (items.every(i => i.status === 'done')) statusEl.textContent = '';
    }
  });
}

function addFiles(files) {
  let added = 0;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const item = { id: nextId++, file, bitmap: null, rows: [], status: 'pending' };
    items.push(item);
    makeCard(item);
    enqueue(item);
    added++;
  }
  if (added) toast(`${added}枚の写真を受け付けました。読み取りを開始します`);
  refreshBadges();
}

/* ---- drop zone ---- */
const drop = $('drop');
drop.onclick = () => $('fileInput').click();
$('fileInput').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
document.addEventListener('paste', e => {
  const files = [...e.clipboardData.items].map(i => i.getAsFile()).filter(Boolean);
  if (files.length) addFiles(files);
});

/* ---- crop modal (pinch-zoom + pan + selection) ---- */
const modal = $('modal');
const cropCanvas = $('cropCanvas');
const cctx = cropCanvas.getContext('2d');
let cropItem = null, cropScale = 1, zoom = 1, panX = 0, panY = 0;
let sel = null; // in IMAGE coordinates
let dragging = false, selBlocked = false, pinch = null;
const cropPointers = new Map();

const viewK = () => cropScale * zoom;
function clampView() {
  zoom = Math.min(12, Math.max(1, zoom));
  const w = cropCanvas.width, h = cropCanvas.height;
  const iw = cropItem.bitmap.width * viewK(), ih = cropItem.bitmap.height * viewK();
  panX = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, panX));
  panY = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, panY));
}
const toImg = p => ({ x: (p.x - panX) / viewK(), y: (p.y - panY) / viewK() });
const toCan = (x, y) => ({ x: x * viewK() + panX, y: y * viewK() + panY });

async function openCrop(item) {
  cropItem = item;
  if (!item.bitmap) item.bitmap = await createImageBitmap(item.file);
  const bmp = item.bitmap;
  const maxW = Math.min(window.innerWidth - 40, 900);
  const maxH = window.innerHeight * 0.7;
  cropScale = Math.min(maxW / bmp.width, maxH / bmp.height, 1);
  cropCanvas.width = Math.round(bmp.width * cropScale);
  cropCanvas.height = Math.round(bmp.height * cropScale);
  zoom = 1; panX = 0; panY = 0;
  sel = null; dragging = false; selBlocked = false; pinch = null;
  cropPointers.clear();
  $('cropOk').disabled = true;
  drawCrop();
  modal.classList.add('show');
}

function drawCrop() {
  const W = cropCanvas.width, H = cropCanvas.height;
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.fillStyle = '#222';
  cctx.fillRect(0, 0, W, H);
  cctx.setTransform(viewK(), 0, 0, viewK(), panX, panY);
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(cropItem.bitmap, 0, 0);
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  // show what's already been read (green), so the user can target the rest
  cctx.strokeStyle = 'rgba(30,158,80,0.9)';
  cctx.lineWidth = 2;
  for (const r of (cropItem.rows || [])) {
    if (!r.region) continue;
    const a = toCan(r.region.x0, r.region.y0), b = toCan(r.region.x1, r.region.y1);
    cctx.strokeRect(a.x - 3, a.y - 3, b.x - a.x + 6, b.y - a.y + 6);
  }
  if (sel) {
    const s = normSel();
    const a = toCan(s.x, s.y), b = toCan(s.x + s.w, s.y + s.h);
    cctx.fillStyle = 'rgba(0,0,0,0.45)';
    cctx.fillRect(0, 0, W, a.y);
    cctx.fillRect(0, b.y, W, H - b.y);
    cctx.fillRect(0, a.y, a.x, b.y - a.y);
    cctx.fillRect(b.x, a.y, W - b.x, b.y - a.y);
    cctx.strokeStyle = '#4f6ef7';
    cctx.lineWidth = 2;
    cctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
}

function normSel() {
  return {
    x: Math.min(sel.x0, sel.x1), y: Math.min(sel.y0, sel.y1),
    w: Math.abs(sel.x1 - sel.x0), h: Math.abs(sel.y1 - sel.y0)
  };
}

function canvasPos(e) {
  const r = cropCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (cropCanvas.width / r.width),
    y: (e.clientY - r.top) * (cropCanvas.height / r.height)
  };
}

function updateOkState() {
  const s = sel && normSel();
  $('cropOk').disabled = !s || s.w * viewK() < 10 || s.h * viewK() < 5;
}

cropCanvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  try { cropCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  cropPointers.set(e.pointerId, canvasPos(e));
  if (cropPointers.size === 2) {
    // two fingers: switch to pinch-zoom/pan, drop any half-drawn selection
    sel = null; dragging = false; selBlocked = true;
    const [a, b] = [...cropPointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = { dist0: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom0: zoom, imgMid: toImg(mid) };
    drawCrop();
    updateOkState();
  } else if (cropPointers.size === 1 && !selBlocked) {
    const p = toImg(canvasPos(e));
    sel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    dragging = true;
    drawCrop();
  }
});
cropCanvas.addEventListener('pointermove', e => {
  if (!cropPointers.has(e.pointerId)) return;
  cropPointers.set(e.pointerId, canvasPos(e));
  if (cropPointers.size >= 2 && pinch) {
    const [a, b] = [...cropPointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    zoom = pinch.zoom0 * dist / pinch.dist0;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    clampView();
    panX = mid.x - pinch.imgMid.x * viewK();
    panY = mid.y - pinch.imgMid.y * viewK();
    clampView();
    drawCrop();
  } else if (dragging && sel) {
    const bmp = cropItem.bitmap;
    const p = toImg(canvasPos(e));
    sel.x1 = Math.max(0, Math.min(bmp.width, p.x));
    sel.y1 = Math.max(0, Math.min(bmp.height, p.y));
    drawCrop();
  }
});
function cropPointerEnd(e) {
  cropPointers.delete(e.pointerId);
  if (cropPointers.size < 2) pinch = null;
  if (cropPointers.size === 0) {
    dragging = false;
    selBlocked = false;
    updateOkState();
  }
}
cropCanvas.addEventListener('pointerup', cropPointerEnd);
cropCanvas.addEventListener('pointercancel', cropPointerEnd);

// desktop: wheel zoom anchored at the cursor
cropCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = canvasPos(e);
  const img = toImg(p);
  zoom *= e.deltaY < 0 ? 1.2 : 1 / 1.2;
  clampView();
  panX = p.x - img.x * viewK();
  panY = p.y - img.y * viewK();
  clampView();
  drawCrop();
  updateOkState();
}, { passive: false });

function zoomAtCenter(factor) {
  const c = { x: cropCanvas.width / 2, y: cropCanvas.height / 2 };
  const img = toImg(c);
  zoom *= factor;
  clampView();
  panX = c.x - img.x * viewK();
  panY = c.y - img.y * viewK();
  clampView();
  drawCrop();
  updateOkState();
}
// null-guarded so an html/js version mismatch can never kill the whole script
if ($('zoomIn')) $('zoomIn').onclick = () => zoomAtCenter(1.5);
if ($('zoomOut')) $('zoomOut').onclick = () => zoomAtCenter(1 / 1.5);
if ($('zoomReset')) $('zoomReset').onclick = () => { zoom = 1; clampView(); drawCrop(); updateOkState(); };

$('cropCancel').onclick = () => { modal.classList.remove('show'); cropItem = null; };
$('cropOk').onclick = async () => {
  const s = normSel();
  const item = cropItem;
  modal.classList.remove('show');
  setCardStatus(item, '範囲を読み取り中…', false, true);
  try {
    await getWorker();
    const res = await cropRead(item.bitmap, s.x, s.y, s.w, s.h);
    setCardStatus(item, '');
    addRow(item, res || { serial: '', quality: 'check' });
    updateThumb(item);
    refreshBadges();
  } catch (e) {
    console.error(e);
    setCardStatus(item, '読み取りに失敗しました', true);
  }
};

/* ---- summary actions ---- */
$('copyAll').onclick = () => {
  const list = allRows().map(r => r.serial).filter(Boolean);
  if (!list.length) { toast('コピーできるシリアルがありません'); return; }
  navigator.clipboard.writeText(list.join('\n'));
  toast(`${list.length}件コピーしました`);
};
$('downloadCsv').onclick = () => {
  const rows = [['ファイル名', 'シリアルナンバー'],
    ...items.flatMap(i => i.rows.map(r => [i.file.name, r.serial]))];
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'serials.csv';
  a.click();
};
$('clearAll').onclick = () => {
  items.length = 0;
  $('list').innerHTML = '';
  refreshBadges();
};
