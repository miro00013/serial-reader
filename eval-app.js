// accuracy evaluation for the automatic reader (eval.html). Reuses app.js's
// pipeline as-is: autoReadAll / getWorker / norm / isSerial are its globals.
// File name ends in "app.js" on purpose: sw.js serves *app.js network-first,
// so edits here are never masked by the cache-first rule for other files.
(() => {
  const byId = id => document.getElementById(id);
  const PREV_KEY = 'serial-reader-eval-prev'; // aggregate numbers only, never serials

  let images = [];      // File[]
  let answers = null;   // Map lowercase basename -> string[] (empty = no serial expected)
  let report = null;
  let stopRequested = false;

  /* ---------- loading ---------- */

  function parseCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  // "ファイル名,シリアル" rows, header optional, several rows per photo allowed;
  // a cell may also hold several serials separated by spaces or semicolons
  function parseAnswers(text) {
    const map = new Map();
    for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const [name, serials = ''] = parseCsvLine(raw).map(s => s.trim());
      if (!name || /ファイル名|filename/i.test(name)) continue;
      const key = name.split(/[\\/]/).pop().toLowerCase();
      if (!map.has(key)) map.set(key, []);
      for (const s of serials.split(/[\s;]+/).map(norm).filter(Boolean)) map.get(key).push(s);
    }
    return map;
  }

  async function loadFiles(fileList) {
    const files = [...fileList];
    images = files.filter(f => f.type.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
    const csvs = files.filter(f => /\.(csv|txt)$/i.test(f.name));
    answers = new Map();
    for (const f of csvs) for (const [k, v] of parseAnswers(await f.text())) {
      answers.set(k, (answers.get(k) || []).concat(v));
    }
    const labeled = images.filter(f => answers.has(f.name.toLowerCase())).length;
    const expected = images.reduce((s, f) => s + (answers.get(f.name.toLowerCase()) || []).length, 0);
    byId('loadInfo').textContent = `写真${images.length}枚（正解あり${labeled}枚・シリアル${expected}件）` +
      (csvs.length ? '' : ' ※正解ファイル(.csv)が見つかりません') +
      (labeled < images.length ? ` ※正解なしの${images.length - labeled}枚は集計対象外` : '');
    byId('runBtn').disabled = !images.length;
  }

  byId('dirInput').onchange = e => loadFiles(e.target.files);
  byId('filesInput').onchange = e => loadFiles(e.target.files);

  /* ---------- matching ---------- */

  function levenshtein(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // pair each expected serial with a read: exact matches first, then the
  // closest remaining read (edit distance ≤ 4 counts as a misread of it)
  function matchFile(expected, reads) {
    const used = new Set();
    const pairs = expected.map(exp => ({ exp, read: null }));
    for (const p of pairs) {
      const i = reads.findIndex((r, k) => !used.has(k) && r.serial === p.exp);
      if (i >= 0) { used.add(i); p.read = reads[i]; }
    }
    const cands = [];
    pairs.forEach((p, pi) => {
      if (p.read) return;
      reads.forEach((r, k) => {
        if (used.has(k)) return;
        const dist = levenshtein(p.exp, r.serial || '');
        if (dist <= 4) cands.push({ pi, k, dist });
      });
    });
    cands.sort((a, b) => a.dist - b.dist);
    for (const c of cands) {
      if (pairs[c.pi].read || used.has(c.k)) continue;
      pairs[c.pi].read = reads[c.k];
      used.add(c.k);
    }
    const extras = reads.filter((_, k) => !used.has(k));
    return { pairs, extras };
  }

  // verdict for one expected serial
  function judge(p) {
    if (!p.read) return { kind: 'miss' };
    const r = p.read, got = r.serial || '';
    const flagged = new Set(r.uncertain || []);
    const isHigh = r.quality === 'high';
    if (got === p.exp) return { kind: isHigh ? 'ok' : 'okFlagged', wrongPos: [] };
    const wrongPos = [];
    if (got.length === p.exp.length) {
      for (let i = 0; i < got.length; i++) if (got[i] !== p.exp[i]) wrongPos.push(i);
    }
    if (isHigh) return { kind: 'danger', wrongPos };
    // misread caught only when every wrong character carries a 要確認 flag
    const caught = wrongPos.length > 0 && wrongPos.every(i => flagged.has(i));
    return { kind: caught ? 'caught' : 'flaggedElsewhere', wrongPos };
  }

  /* ---------- run ---------- */

  byId('runBtn').onclick = async () => {
    stopRequested = false;
    byId('runBtn').disabled = byId('saveBtn').disabled = true;
    byId('stopBtn').disabled = false;
    byId('files').innerHTML = '';
    byId('summaryPanel').hidden = true;
    report = { startedAt: new Date().toISOString(), files: [] };
    await getWorker();
    for (let n = 0; n < images.length && !stopRequested; n++) {
      const file = images[n];
      byId('progress').textContent = `${n + 1} / ${images.length} 枚目を読み取り中… (${file.name})`;
      const expected = answers.get(file.name.toLowerCase());
      const entry = { name: file.name, labeled: !!expected, expected: expected || [] };
      let bitmap = null;
      const t0 = performance.now();
      try {
        bitmap = await createImageBitmap(file);
        const res = await autoReadAll(bitmap);
        entry.reads = res.map(r => ({ serial: r.serial, quality: r.quality,
          uncertain: r.uncertain || [], region: r.region || null }));
      } catch (e) {
        console.error(e);
        entry.error = String(e && e.message || e);
        entry.reads = [];
      }
      entry.ms = Math.round(performance.now() - t0);
      if (entry.labeled) {
        const { pairs, extras } = matchFile(entry.expected, entry.reads);
        entry.pairs = pairs.map(p => ({ exp: p.exp, read: p.read, ...judge(p) }));
        entry.extras = extras;
      }
      report.files.push(entry);
      renderFile(entry, bitmap);
      renderSummary(false);
      if (bitmap) bitmap.close();
    }
    byId('progress').textContent = stopRequested ? '中止しました（ここまでの結果を集計）' : '完了しました';
    report.finishedAt = new Date().toISOString();
    renderSummary(!stopRequested);
    byId('runBtn').disabled = false;
    byId('stopBtn').disabled = true;
    byId('saveBtn').disabled = false;
  };
  byId('stopBtn').onclick = () => {
    stopRequested = true;
    byId('stopBtn').disabled = true;
    byId('progress').textContent = '現在の写真が終わりしだい中止します…';
  };
  byId('saveBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    a.download = `eval-${report.startedAt.replace(/[:.]/g, '-')}.json`;
    a.click();
  };

  /* ---------- aggregate ---------- */

  function aggregate() {
    const m = { expected: 0, ok: 0, okFlagged: 0, caught: 0, flaggedElsewhere: 0, danger: 0,
                miss: 0, fp: 0, charsRight: 0, ms: 0, photos: 0, errors: 0 };
    const confusion = new Map();
    for (const f of report.files) {
      m.photos++; m.ms += f.ms;
      if (f.error) m.errors++;
      if (!f.labeled) continue;
      m.fp += f.extras.length;
      for (const p of f.pairs) {
        m.expected++;
        m[p.kind]++;
        if (!p.read) continue;
        const got = p.read.serial || '';
        if (got.length === p.exp.length) {
          for (let i = 0; i < got.length; i++) {
            if (got[i] === p.exp[i]) m.charsRight++;
            else {
              const key = `${p.exp[i]} → ${got[i]}`;
              confusion.set(key, (confusion.get(key) || 0) + 1);
            }
          }
        } else {
          m.charsRight += Math.max(0, p.exp.length - levenshtein(p.exp, got));
        }
      }
    }
    // null (shown as "—") when there is nothing to divide by, e.g. no-serial photos only
    const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
    const totalChars = report.files.filter(f => f.labeled)
      .reduce((s, f) => s + f.expected.reduce((t, e) => t + e.length, 0), 0);
    return {
      m, confusion,
      exactRate: pct(m.ok + m.okFlagged, m.expected),
      detectRate: pct(m.expected - m.miss, m.expected),
      charRate: pct(m.charsRight, totalChars),
      autoOkRate: pct(m.ok, m.expected),
      avgSec: m.photos ? Math.round(m.ms / m.photos / 100) / 10 : 0
    };
  }

  function loadPrev() {
    try { return JSON.parse(localStorage.getItem(PREV_KEY) || 'null'); } catch (_) { return null; }
  }

  function renderSummary(final) {
    const a = aggregate(), m = a.m;
    const prev = loadPrev();
    const cards = [
      // [label, value, prevKey, higherIsBetter, unit, bad?]
      ['完全一致率', a.exactRate, 'exactRate', true, '%'],
      ['検出率', a.detectRate, 'detectRate', true, '%'],
      ['文字正解率', a.charRate, 'charRate', true, '%'],
      ['確認不要で正解（OK表示）', a.autoOkRate, 'autoOkRate', true, '%'],
      ['OKなのに誤り', m.danger, 'danger', false, '件', m.danger > 0],
      ['誤読（要確認で検知）', m.caught, 'caught', false, '件'],
      ['誤読（要確認の位置ずれ）', m.flaggedElsewhere, 'flaggedElsewhere', false, '件', m.flaggedElsewhere > 0],
      ['正解だが要確認', m.okFlagged, 'okFlagged', false, '件'],
      ['見逃し', m.miss, 'miss', false, '件'],
      ['余計な検出', m.fp, 'fp', false, '件', m.fp > 0],
      ['平均処理時間', a.avgSec, 'avgSec', false, '秒/枚']
    ];
    const cur = { exactRate: a.exactRate, detectRate: a.detectRate, charRate: a.charRate,
      autoOkRate: a.autoOkRate, danger: m.danger, caught: m.caught,
      flaggedElsewhere: m.flaggedElsewhere, okFlagged: m.okFlagged, miss: m.miss, fp: m.fp,
      avgSec: a.avgSec };
    byId('metrics').innerHTML = cards.map(([label, v, key, up, unit, bad]) => {
      let delta = '';
      if (v === null) v = '—';
      else if (final && prev && prev[key] !== undefined && prev[key] !== null) {
        const diff = Math.round((v - prev[key]) * 10) / 10;
        const cls = diff === 0 ? 'same' : ((diff > 0) === up ? 'up' : 'down');
        delta = `<div class="d ${cls}">前回比 ${diff > 0 ? '+' : ''}${diff}</div>`;
      }
      return `<div class="metric${bad ? ' bad' : ''}"><div class="k">${label}</div>` +
        `<div class="v">${v}<small style="font-size:12px;font-weight:400"> ${unit}</small></div>${delta}</div>`;
    }).join('') +
      `<div class="metric"><div class="k">対象</div><div class="v">${m.expected}<small style="font-size:12px;font-weight:400"> 件</small></div>` +
      `<div class="d same">写真${m.photos}枚${m.errors ? `・エラー${m.errors}` : ''}${prev && final ? `・前回 ${prev.expected}件` : ''}</div></div>`;
    const conf = [...a.confusion].sort((x, y) => y[1] - x[1]);
    byId('confusionWrap').innerHTML = conf.length
      ? '<div style="font-size:13px;color:#666;margin-bottom:4px">読み間違えた文字（正解 → 読み取り）</div>' +
        conf.map(([k, n]) => `<span class="tag t-fp mono" style="margin:2px">${k} ×${n}</span>`).join('')
      : '';
    byId('summaryPanel').hidden = false;
    // store this run as the baseline for the next comparison (full runs only)
    if (final && m.expected) {
      try { localStorage.setItem(PREV_KEY, JSON.stringify({ ...cur, expected: m.expected })); } catch (_) {}
    }
  }

  /* ---------- per-file view ---------- */

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function serialHtml(got, exp, uncertain) {
    const flagged = new Set(uncertain || []);
    return [...got].map((ch, i) => {
      const cls = [];
      if (exp && got.length === exp.length && ch !== exp[i]) cls.push('wrong');
      if (flagged.has(i)) cls.push('flag');
      return cls.length ? `<span class="${cls.join(' ')}">${esc(ch)}</span>` : esc(ch);
    }).join('');
  }

  const VERDICT = {
    ok: ['t-ok', '正解'],
    okFlagged: ['t-check', '正解（要確認つき）'],
    caught: ['t-check', '誤読・要確認で検知'],
    flaggedElsewhere: ['t-danger', '誤読・要確認の位置ずれ'],
    danger: ['t-danger', 'OKなのに誤り'],
    miss: ['t-miss', '見逃し']
  };

  function thumbnail(bitmap, entry) {
    if (!bitmap) return '';
    const W = 240, s = W / bitmap.width;
    const c = document.createElement('canvas');
    c.width = W; c.height = Math.max(1, Math.round(bitmap.height * s));
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    ctx.lineWidth = 3;
    const box = (r, color) => {
      if (!r || !r.region) return;
      ctx.strokeStyle = color;
      ctx.strokeRect(r.region.x0 * s - 4, r.region.y0 * s - 4,
        (r.region.x1 - r.region.x0) * s + 8, (r.region.y1 - r.region.y0) * s + 8);
    };
    if (entry.labeled) {
      for (const p of entry.pairs) box(p.read, p.kind === 'ok' || p.kind === 'okFlagged' ? '#1e9e50' : '#e53935');
      for (const r of entry.extras) box(r, '#ff9800');
    } else {
      for (const r of entry.reads) box(r, '#4f6ef7');
    }
    return c.toDataURL('image/jpeg', 0.8);
  }

  function renderFile(entry, bitmap) {
    const div = document.createElement('div');
    div.className = 'panel file';
    let rows = '';
    if (entry.labeled) {
      for (const p of entry.pairs) {
        const [cls, label] = VERDICT[p.kind];
        rows += `<tr><td class="mono">${esc(p.exp)}</td>` +
          `<td class="mono">${p.read ? serialHtml(p.read.serial || '', p.exp, p.read.uncertain) : '—'}</td>` +
          `<td><span class="tag ${cls}">${label}</span></td></tr>`;
      }
      for (const r of entry.extras) {
        rows += `<tr><td class="mono">—</td><td class="mono">${serialHtml(r.serial || '', null, r.uncertain)}</td>` +
          `<td><span class="tag t-fp">余計な検出</span></td></tr>`;
      }
      if (!entry.pairs.length && !entry.extras.length) {
        rows = '<tr><td colspan="3"><span class="tag t-ok">シリアルなし・検出なし（正解）</span></td></tr>';
      }
    } else {
      for (const r of entry.reads) {
        rows += `<tr><td class="mono">（正解なし）</td><td class="mono">${serialHtml(r.serial || '', null, r.uncertain)}</td>` +
          `<td><span class="tag t-miss">${r.quality === 'high' ? 'OK表示' : '要確認表示'}</span></td></tr>`;
      }
      if (!rows) rows = '<tr><td colspan="3">（正解なし・検出なし）</td></tr>';
    }
    const img = thumbnail(bitmap, entry);
    div.innerHTML = `${img ? `<img src="${img}" alt="">` : '<div></div>'}<div>` +
      `<h3>${esc(entry.name)} <span class="time">${(entry.ms / 1000).toFixed(1)}秒` +
      `${entry.error ? ` ・エラー: ${esc(entry.error)}` : ''}</span></h3>` +
      `<table><tr><th>正解</th><th>読み取り</th><th>判定</th></tr>${rows}</table></div>`;
    byId('files').appendChild(div);
  }
})();
