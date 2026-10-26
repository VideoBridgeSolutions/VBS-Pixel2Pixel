// Pixel2Pixel — exports: PNG, MP4 (WebCodecs H.264 + mp4-muxer), PDF tech sheet (HTML → printToPDF)
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import {
  getOutput, tileInfo, physicalSize, surfaceStats, cablingSummary, viewingDistance, kva,
  slicesOfSurface, sliceName, PROCESSORS, dataChain, powerChain, portLabels, portUsage, circuitStarts, circuitPhase,
  powerSummary, multiOf, MAINS
} from './model.js';

export function safeName(s) {
  return String(s || 'pixelmap').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'pixelmap';
}

export function viewSize(p, view) {
  if (view === 'comp') return { w: p.composition.w, h: p.composition.h, name: 'COMPOSITION' };
  const o = getOutput(p, view);
  return { w: o.w, h: o.h, name: o.name };
}

export function renderView(R, p, view, { time = 0, anim = false, canvas = null } = {}) {
  const pp = anim ? p : { ...p, style: { ...p.style, anim: { ...p.style.anim, enabled: false } } };
  const { w, h } = viewSize(p, view);
  const c = canvas || document.createElement('canvas');
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (view === 'comp') R.drawComposition(ctx, pp, { time });
  else R.drawOutput(ctx, pp, getOutput(p, view), { time });
  return c;
}

export function canvasBytes(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (b) => {
      if (!b) return reject(new Error('toBlob failed'));
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, type, quality);
  });
}

export function viewFileName(p, view, ext) {
  const { w, h, name } = viewSize(p, view);
  return safeName(`${p.name} - ${name} - ${w}x${h}`) + '.' + ext;
}

// ------------------------------------------------------------------ MP4
const AVC_CANDIDATES = ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0034', 'avc1.4d0033', 'avc1.42003e', 'avc1.42002a'];

async function pickAvcConfig(w, h, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  const bitrate = Math.min(80e6, Math.max(8e6, Math.round(w * h * fps * 0.16)));
  for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software']) {
    for (const codec of AVC_CANDIDATES) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration: hw, avc: { format: 'avc' }, latencyMode: 'quality' };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return r.config;
      } catch (_) { /* try next */ }
    }
  }
  return null;
}

export async function exportMp4(R, p, view, { duration = 8, fps = 30, onProgress = () => {} } = {}) {
  const { w, h } = viewSize(p, view);
  if (w % 2 || h % 2) { const e = new Error('odd'); e.code = 'ODD'; throw e; }
  const cfg = await pickAvcConfig(w, h, fps);
  if (!cfg) { const e = new Error('unsupported'); e.code = 'UNSUPPORTED'; throw e; }

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
  let encErr = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  enc.configure(cfg);

  const canvas = document.createElement('canvas');
  const total = Math.max(1, Math.round(duration * fps));
  for (let i = 0; i < total; i++) {
    if (encErr) throw encErr;
    renderView(R, p, view, { time: i / fps, anim: true, canvas });
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 4));
    if (i % 3 === 0) { onProgress(i / total); await new Promise((r) => setTimeout(r, 0)); }
  }
  await enc.flush();
  enc.close();
  if (encErr) throw encErr;
  muxer.finalize();
  onProgress(1);
  return new Uint8Array(muxer.target.buffer);
}

// ------------------------------------------------------------------ PDF « dossier visuel » (technical sheet)
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (u) => Math.round(u * 100) + ' %';
const tileRef = (tl) => tl ? `C${tl.c + 1}·R${tl.r + 1}` : '—';

/** Processor index (1-based) of a global port number, redundancy aware. */
function procOf(p, g) {
  const ppp = Math.max(1, Number(p.processor.portsPerProc) || 16);
  const red = p.processor.redundancy || 'none';
  return red === 'pair' ? Math.ceil((2 * g - 1) / ppp) : Math.ceil(g / ppp);
}
/** Data ports of a surface: [{ main, backup, proc, tiles, px, load, from, to }]. */
export function portRows(p, s) {
  if (s.kind === 'proj') return [];
  const dc = dataChain(s, p.processor), labs = portLabels(p, s), use = portUsage(s, p.processor);
  return dc.ports.map((pt, k) => ({ main: labs[k] ? labs[k].main : '', backup: labs[k] ? labs[k].backup : null, proc: labs[k] ? procOf(p, labs[k].g) : 0,
    tiles: pt.length, px: pt.length * dc.tilePx, load: use[k] || 0, from: pt[0], to: pt[pt.length - 1] }));
}
/** Power circuits of a surface: [{ n, phase, tiles, W, A, load, multi, way, from, to }]. */
export function circuitRows(p, s) {
  if (s.kind === 'proj') return [];
  const pw = p.power || {}, ch = powerChain(s, pw, p.cabling);
  const V = Math.max(1, Number(pw.voltage) || 230), A = Math.max(1, Number(pw.amps) || 16);
  const w = Number(pw.basis === 'avg' ? (s.power.wattsAvg || s.power.wattsMax) : s.power.wattsMax) || 0;
  const c0 = circuitStarts(p)[s.id] || 1, mu = pw.autoNumber !== false ? multiOf(pw) : null;
  return ch.circuits.map((c, k) => {
    const n = c0 + k, W = c.length * w;
    return { n, phase: circuitPhase(pw, n), tiles: c.length, W, A: W / V, load: W / V / A, multi: mu ? Math.ceil(n / mu.circuits) : 0, way: mu ? ((n - 1) % mu.circuits) + 1 : 0, from: c[0], to: c[c.length - 1] };
  });
}

/**
 * images: { comp: dataUrl|null, outputs: [{ id, map, data, power }] } — data / power only when cabling is available (Pro).
 * t: i18n function (labels follow the app language).
 */
export function buildPdfHtml(p, images, t, appVersion) {
  const L = (k, v) => t('pdf.' + k, v);
  const sum = cablingSummary(p);
  const ps = powerSummary(p);
  const pwr = p.power || {};
  const mu = multiOf(pwr);
  const proc = PROCESSORS[p.processor.type] ? PROCESSORS[p.processor.type].label : p.processor.type;
  const withCab = (images.outputs || []).some((x) => x.data || x.power);
  const date = new Date().toLocaleDateString(t('pdf.locale') === 'en' ? 'en-GB' : 'fr-FR');
  const surf = (id) => p.surfaces.find((x) => x.id === id);
  const red = p.processor.redundancy || 'none';
  const head = (sec) => `<div class="run"><b>${escHtml(p.name)}</b><span>${escHtml(sec)}</span></div>`;

  // ---------- summary
  const kpi = [
    [p.surfaces.length, L('surfaces')], [fmt(sum.tiles), L('tiles')],
    [sum.mainPorts + (sum.backupPorts ? ' + ' + sum.backupPorts : ''), L('ports') + (sum.backupPorts ? ' ' + L('mainBackup') : '')],
    [sum.mainProcs + (sum.backupProcs ? ' + ' + sum.backupProcs : ''), L('procs') + (sum.backupProcs ? ' ' + L('mainBackup') : '')],
    [ps.circuits || '—', L('circuits')],
    [ps.Wmax ? fmt(ps.Wmax / 1000, 1) : '—', L('kwMax') + (ps.Wavg && ps.Wavg !== ps.Wmax ? ` · ${fmt(ps.Wavg / 1000, 1)} ${L('avg')}` : '')],
    [ps.Wmax ? fmt(kva(ps.W, pwr.pf), 1) : '—', `kVA (PF ${pwr.pf})`],
    [sum.kg ? fmt(sum.kg) : '—', 'kg']
  ].map(([v, k]) => `<div><b>${v}</b><span>${escHtml(k)}</span></div>`).join('');
  const procLine = `${escHtml(proc)} — ${fmt(sum.effPortPx)} px/port · ${p.processor.fps} Hz · ${p.processor.bitDepth} bit · ${L('headroom')} ${Math.round(p.processor.headroom ?? 100)} % · ${p.processor.portsPerProc} ${L('portsPerProc')} · ${L('redundancy')} : ${L('red_' + red)}`;
  const mains = MAINS.find((m) => m.a === Number(pwr.mainsA) && m.ph === ((Number(pwr.phases) || 1) >= 3 ? 3 : 1));
  const powerLine = `${pwr.voltage} V · ${L('circuit')} ${pwr.amps} A${pwr.linkAmps ? ` (${L('link')} ${pwr.linkAmps} A)` : ''} · ${(Number(pwr.phases) || 1) >= 3 ? L('tri') : L('mono')} · ${L('basis')} ${pwr.basis === 'avg' ? L('avgLong') : L('maxLong')}${Number(pwr.derate) && Number(pwr.derate) < 100 ? ` · ${L('derate')} ${pwr.derate} %` : ''} · ${L('rcd')} ${pwr.rcdMa || 30} mA`;

  const rows = p.surfaces.map((s, i) => {
    const ti = tileInfo(s), st = sum.per[s.id] || surfaceStats(p, s), vd = viewingDistance(s.pitch);
    const outs = slicesOfSurface(p, s.id).map((sl) => { const o = p.outputs.find((x) => x.id === sl.out); return `${escHtml(o ? o.name : '?')} @ ${sl.x},${sl.y}${sl.rot ? ' ↻' + sl.rot + '°' : ''}`; }).join('<br>') || '<span class="w">—</span>';
    const pr = portRows(p, s), cr = circuitRows(p, s);
    return `<tr>
      <td class="n">${i + 1}</td><td><b>${escHtml(s.name)}</b>${s.panel ? '<br><small>' + escHtml(s.panel.brand + ' ' + s.panel.model) + '</small>' : ''}</td>
      <td class="m">${s.w} × ${s.h}</td>
      <td class="m">${ti.cols} × ${ti.rows}${ti.partial ? ' <span class="w">⚠</span>' : ''}<br><small>${st.tiles} · ${Math.round(ti.tw)}×${Math.round(ti.th)} px</small></td>
      <td class="m">${s.pitch ? s.pitch + ' mm' : '—'}<br><small>${escHtml(physicalSize(s) || '')}</small></td>
      <td class="m">${vd ? vd.min + ' / ' + vd.opt + ' m' : '—'}</td>
      <td class="m">${st.ports}${pr.length ? `<br><small>${escHtml(pr[0].main)} → ${escHtml(pr[pr.length - 1].main)}</small>` : ''}</td>
      <td class="m">${st.circuits || '—'}${cr.length ? `<br><small>C${cr[0].n} → C${cr[cr.length - 1].n}</small>` : ''}</td>
      <td class="m">${st.wattsMax ? fmt(st.wattsMax / 1000, 2) : '—'}</td>
      <td class="m">${st.kg ? fmt(st.kg, 0) : '—'}</td>
      <td class="m small">${outs}</td></tr>`;
  }).join('');
  const outRows = p.outputs.map((o) => `<tr><td><b>${escHtml(o.name)}</b></td><td class="m">${o.w} × ${o.h}</td><td class="m">${p.slices.filter((x) => x.out === o.id).length}</td></tr>`).join('');
  const sliceRows = p.slices.map((sl) => {
    const o = p.outputs.find((x) => x.id === sl.out), s = surf(sl.surfaceId);
    return `<tr><td>${escHtml(sliceName(p, sl))}</td><td>${escHtml(o ? o.name : '')}</td><td class="m">${s ? s.comp.x + sl.src.x : ''}, ${s ? s.comp.y + sl.src.y : ''}</td>
      <td class="m">${sl.src.w} × ${sl.src.h}</td><td class="m">${sl.x}, ${sl.y}</td><td class="m">${sl.rot}°${sl.flip ? ' / flip' : ''}</td></tr>`;
  }).join('');

  // ---------- data overview: what each processor feeds
  let dataPage = '';
  if (withCab) {
    const procs = {};
    for (const s of p.surfaces) for (const r of portRows(p, s)) {
      const P = procs[r.proc] = procs[r.proc] || { ports: 0, tiles: 0, px: 0, list: [] };
      P.ports++; P.tiles += r.tiles; P.px += r.px;
      const last = P.list[P.list.length - 1];
      if (last && last.s === s) { last.to = r.main; last.n++; } else P.list.push({ s, from: r.main, to: r.main, n: 1 });
    }
    const ppp = Math.max(1, Number(p.processor.portsPerProc) || 16);
    const procRows = Object.keys(procs).map(Number).sort((a, b) => a - b).map((k) => {
      const P = procs[k];
      return `<tr><td class="m"><b>${red === 'processor' ? 'A' + k + ' / B' + k : k}</b></td><td class="m">${P.ports} / ${red === 'pair' || red === 'port' ? Math.floor(ppp / 2) : ppp}</td><td class="m">${fmt(P.tiles)}</td><td class="m">${fmt(P.px)}</td>
        <td class="small">${P.list.map((x) => `<b>${escHtml(x.s.name)}</b> ${escHtml(x.from)}${x.n > 1 ? '→' + escHtml(x.to) : ''}`).join(' · ')}</td></tr>`;
    }).join('');
    dataPage = `<section class="pb">${head(L('dataTitle'))}<h2>${L('dataTitle')}</h2>
      <div class="sub">${procLine}</div>
      <table><thead><tr><th>${L('proc')}</th><th>${L('portsUsed')}</th><th>${L('tiles')}</th><th>Pixels</th><th>${L('feeds')}</th></tr></thead><tbody>${procRows}</tbody></table>
      <div class="note">${L('dataNote')}</div></section>`;
  }

  // ---------- power overview
  let powerPage = '';
  if (withCab && ps.circuits) {
    const maxA = Math.max(1, ...ps.ampsPhase);
    const phases = (ps.tri ? [0, 1, 2] : [0]).map((i) => `<div class="ph"><span>${ps.tri ? 'L' + (i + 1) : L('mono')}</span><i><u style="width:${Math.round(ps.ampsPhase[i] / maxA * 100)}%"></u></i><b>${fmt(ps.ampsPhase[i], 1)} A · ${ps.circuitsPhase[i]} ${L('circuitsShort')} · ${fmt(ps.perPhase[i] / 1000, 1)} kW</b></div>`).join('');
    const adv = ps.mains ? `${L('mainsLoad', { a: ps.mains.a, pct: Math.round(ps.mains.load * 100) })}${ps.mains.over ? ' — ' + L('mainsOver', { n: ps.mains.feeds }) : ps.mains.ok ? '' : ' — ' + L('mainsTight')}`
      : ps.advice.size ? L('advice', { a: ps.advice.size }) : ps.advice.need ? L('adviceMulti', { n: Math.ceil(ps.advice.need / 400) }) : '';
    const perSurf = p.surfaces.filter((s) => s.kind !== 'proj').map((s) => {
      const cr = circuitRows(p, s), ch = powerChain(s, pwr, p.cabling);
      if (!cr.length) return `<tr><td><b>${escHtml(s.name)}</b></td><td colspan="6" class="w small">${L('noWatts')}</td></tr>`;
      const W = cr.reduce((a, c) => a + c.W, 0);
      const byPh = {}; cr.forEach((c) => { if (c.phase) byPh[c.phase] = (byPh[c.phase] || 0) + 1; });
      return `<tr><td><b>${escHtml(s.name)}</b></td><td class="m">C${cr[0].n} → C${cr[cr.length - 1].n}</td><td class="m">${cr.length} × ≤${ch.per}</td>
        <td class="small">${escHtml(t('pw.by_' + (Number(s.power.perCircuit) > 0 ? 'manual' : ch.limits.by || 'watts')))}</td>
        <td class="small">${escHtml(t('cab.f_' + (ch.path.flow || 'rows')))} · ${escHtml(t('cab.p_' + (ch.path.pattern || 'serpentine')))}</td>
        <td class="m">${Object.keys(byPh).sort().map((k) => k + '×' + byPh[k]).join(' ') || '—'}</td><td class="m">${fmt(W / 1000, 2)}</td></tr>`;
    }).join('');
    powerPage = `<section class="pb">${head(L('powerTitle'))}<h2>${L('powerTitle')}</h2>
      <div class="sub">${powerLine}</div>
      <div class="tot t4">
        <div><b>${mains ? (mains.ph === 3 ? L('tetraA', { a: mains.a }) : L('monoA', { a: mains.a })) : '—'}</b><span>${L('mains')}${mains ? ' · ' + escHtml(mains.conn) : ''}</span></div>
        <div><b>${mu ? ps.multi.count + ' × ' + escHtml(mu.label) : L('direct', { a: pwr.amps })}</b><span>${L('distro')}${mu ? ' · ' + mu.circuits + ' ' + L('circuitsShort') + ' / multi' : ''}</span></div>
        <div><b>${fmt(ps.tri ? Math.max(...ps.ampsPhase) : ps.ampsPhase[0], 0)} A</b><span>${ps.tri ? L('worstPhase') + (ps.imbalance > 0.1 ? ' · ' + L('imbalance', { pct: Math.round(ps.imbalance * 100) }) : '') : L('total')}</span></div>
        <div><b>${ps.circuits}</b><span>${L('circuits')} ${pwr.amps} A</span></div>
      </div>
      <div class="phases">${phases}</div>
      ${adv ? `<div class="callout${ps.mains && !ps.mains.ok ? ' bad' : ''}">${escHtml(adv)}</div>` : ''}
      ${ps.noWatts.length ? `<div class="callout bad">${L('missingW', { list: ps.noWatts.map((s) => s.name).join(', ') })}</div>` : ''}
      <table><thead><tr><th>${L('surface')}</th><th>${L('circuits')}</th><th>${L('perCircuit')}</th><th>${L('limitBy')}</th><th>${L('path')}</th><th>${L('phases')}</th><th>kW</th></tr></thead><tbody>${perSurf}</tbody></table>
      <div class="note">${L('powerNote')}</div></section>`;
  }

  // ---------- per output: pixelmap / data / power
  const outPages = (images.outputs || []).map((im) => {
    const o = p.outputs.find((x) => x.id === im.id);
    if (!o) return '';
    const sls = p.slices.filter((x) => x.out === o.id);
    const ids = [...new Set(sls.map((x) => x.surfaceId))].map(surf).filter(Boolean);
    const wide = o.w / Math.max(1, o.h) > 1.45;
    const page = (kind, img, table, extra = '') => `<section class="pb out ${wide ? 'wide' : 'side'}">${head(o.name + ' — ' + L('k_' + kind))}
      <h2>${escHtml(o.name)} <span class="chip ${kind}">${L('k_' + kind)}</span> <small>${o.w} × ${o.h}</small></h2>
      <div class="lay"><div class="pic"><img src="${img}"></div><div class="tab">${extra}${table}</div></div></section>`;
    const mapTab = `<table class="c"><thead><tr><th>${L('slice')}</th><th>${L('size')}</th><th>${L('outXY')}</th><th>${L('tiles')}</th><th>${L('phys')}</th></tr></thead><tbody>${sls.map((sl) => {
      const s = surf(sl.surfaceId); const ti = s ? tileInfo(s) : null;
      return `<tr><td><b>${escHtml(sliceName(p, sl))}</b>${s && s.panel ? '<br><small>' + escHtml(s.panel.brand + ' ' + s.panel.model) + '</small>' : ''}</td><td class="m">${sl.src.w}×${sl.src.h}</td><td class="m">${sl.x}, ${sl.y}${sl.rot ? ' ↻' + sl.rot + '°' : ''}</td><td class="m">${ti ? ti.cols + '×' + ti.rows : ''}</td><td class="m">${s ? escHtml(physicalSize(s) || '') : ''}${s && s.pitch ? '<br><small>' + s.pitch + ' mm</small>' : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
    let out = page('map', im.map, mapTab);
    if (im.data) {
      const rs = ids.flatMap((s) => portRows(p, s).map((r) => ({ s, r })));
      const tot = { t: rs.reduce((a, x) => a + x.r.tiles, 0), px: rs.reduce((a, x) => a + x.r.px, 0) };
      const tab = `<table class="c${rs.length > 26 ? ' dense' : ''}"><thead><tr><th>${L('port')}</th>${red !== 'none' ? `<th>${L('backup')}</th>` : ''}<th>${L('proc')}</th><th>${L('surface')}</th><th>${L('tiles')}</th><th>${L('load')}</th><th>${L('fromTo')}</th></tr></thead><tbody>${rs.map(({ s, r }) =>
        `<tr><td class="m"><b>${escHtml(r.main)}</b></td>${red !== 'none' ? `<td class="m">${escHtml(r.backup || '')}</td>` : ''}<td class="m">${red === 'processor' ? 'A' + r.proc + '/B' + r.proc : r.proc}</td><td>${escHtml(s.name)}</td><td class="m">${r.tiles}</td><td class="m${r.load > 1 ? ' bad' : r.load > (Number(p.processor.headroom) || 100) / 100 ? ' w' : ''}">${pct(r.load)}</td><td class="m">${tileRef(r.from)} → ${tileRef(r.to)}</td></tr>`).join('')}</tbody></table>`;
      out += page('data', im.data, tab, `<div class="mini"><b>${rs.length}</b> ${L('portsShort')} · <b>${fmt(tot.t)}</b> ${L('tiles').toLowerCase()} · <b>${fmt(tot.px)}</b> px</div>`);
    }
    if (im.power) {
      const rs = ids.flatMap((s) => circuitRows(p, s).map((r) => ({ s, r })));
      const W = rs.reduce((a, x) => a + x.r.W, 0);
      const tab = rs.length ? `<table class="c${rs.length > 26 ? ' dense' : ''}"><thead><tr><th>${L('circuit')}</th>${ps.tri ? `<th>${L('phase')}</th>` : ''}${mu ? '<th>Multi</th>' : ''}<th>${L('surface')}</th><th>${L('tiles')}</th><th>W</th><th>A</th><th>${L('fromTo')}</th></tr></thead><tbody>${rs.map(({ s, r }) =>
        `<tr><td class="m"><b>C${r.n}</b></td>${ps.tri ? `<td class="m">${r.phase}</td>` : ''}${mu ? `<td class="m">${r.multi ? r.multi + '·' + r.way : ''}</td>` : ''}<td>${escHtml(s.name)}</td><td class="m">${r.tiles}</td><td class="m">${fmt(r.W)}</td><td class="m${r.load > 1 ? ' bad' : r.load > 0.8 ? ' w' : ''}">${fmt(r.A, 1)}</td><td class="m">${tileRef(r.from)} → ${tileRef(r.to)}</td></tr>`).join('')}</tbody></table>` : `<div class="callout bad">${L('noWatts')}</div>`;
      out += page('power', im.power, tab, `<div class="mini"><b>${rs.length}</b> ${L('circuitsShort')} · <b>${fmt(W / 1000, 2)}</b> kW · ${pwr.voltage} V / ${pwr.amps} A</div>`);
    }
    return out;
  }).join('');

  return `<!doctype html><html lang="${t('pdf.locale')}"><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 10mm 11mm; }
    * { box-sizing: border-box; }
    body { font: 8.8pt/1.35 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #15171a; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5pt solid #15171a; padding-bottom: 6pt; margin-bottom: 9pt; }
    h1 { font-size: 19pt; margin: 0; letter-spacing: .2pt; }
    .sub { color: #555; font-size: 8.5pt; margin: 2pt 0 6pt; }
    h2 { font-size: 11pt; margin: 10pt 0 6pt; text-transform: uppercase; letter-spacing: .6pt; display: flex; align-items: center; gap: 8pt; }
    h2 small { font: 500 8.5pt Menlo, Consolas, monospace; color: #666; text-transform: none; letter-spacing: 0; }
    .run { display: flex; justify-content: space-between; font-size: 7.5pt; color: #777; border-bottom: .5pt solid #ccc; padding-bottom: 3pt; margin-bottom: 4pt; text-transform: uppercase; letter-spacing: .5pt; }
    .run b { color: #15171a; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: .4pt; color: #555; border-bottom: 1pt solid #15171a; padding: 3pt 4pt; white-space: nowrap; }
    td { border-bottom: .5pt solid #d6d8dc; padding: 3pt 4pt; vertical-align: top; }
    tr { break-inside: avoid; }
    td.m { font-family: Menlo, Consolas, monospace; font-size: 7.8pt; white-space: nowrap; }
    td.n { color: #888; width: 16pt; }
    .small, td.small { font-size: 7pt; }
    small { color: #666; font-size: 7pt; }
    .w { color: #b86e00; } .bad { color: #c8102e; font-weight: 600; }
    .tot { display: grid; grid-template-columns: repeat(8, 1fr); gap: 5pt; margin: 4pt 0 6pt; }
    .tot.t4 { grid-template-columns: repeat(4, 1fr); }
    .tot div { border: 1pt solid #15171a; border-radius: 4pt; padding: 5pt 7pt; }
    .tot b { display: block; font-size: 13pt; line-height: 1.15; }
    .tot span { font-size: 6.8pt; text-transform: uppercase; color: #555; letter-spacing: .4pt; }
    .lines { display: grid; grid-template-columns: 1fr 1fr; gap: 8pt; }
    .lines .sub { margin: 0; padding: 5pt 7pt; border-left: 2.5pt solid #4f8bff; background: #f3f5f8; }
    .lines .sub.pw { border-left-color: #e0a100; }
    .comp { margin-top: 8pt; text-align: center; } .comp img { max-width: 100%; max-height: 64mm; border: .5pt solid #999; background: #000; }
    .pb { break-before: page; }
    .note { margin-top: 8pt; color: #777; font-size: 7.3pt; }
    .callout { margin: 6pt 0; padding: 5pt 8pt; border-left: 3pt solid #2f9e6b; background: #f2f8f5; font-size: 8.3pt; }
    .callout.bad { border-left-color: #c8102e; background: #fcf1f2; color: #8a0b20; }
    .phases { display: grid; gap: 4pt; margin: 6pt 0; }
    .ph { display: grid; grid-template-columns: 34pt 1fr 190pt; gap: 8pt; align-items: center; font-size: 8pt; }
    .ph i { display: block; height: 7pt; background: #e9ebef; border-radius: 2pt; overflow: hidden; } .ph u { display: block; height: 100%; background: #e0a100; }
    .ph b { font: 500 7.8pt Menlo, Consolas, monospace; text-align: right; }
    .chip { font-size: 7.5pt; letter-spacing: .5pt; padding: 2pt 6pt; border-radius: 3pt; color: #fff; background: #555; }
    .chip.data { background: #2f6fe0; } .chip.power { background: #c98a00; } .chip.map { background: #15171a; }
    .lay { display: grid; gap: 8pt; }
    .out.side .lay { grid-template-columns: 1.55fr 1fr; align-items: start; }
    .out.wide .lay { grid-template-columns: 1fr; }
    .pic { text-align: center; } .pic img { max-width: 100%; max-height: 168mm; border: .5pt solid #999; background: #000; display: block; margin: 0 auto; }
    .out.wide .pic img { max-height: 96mm; }
    .mini { font-size: 8pt; margin-bottom: 4pt; color: #333; }
    table.c td, table.c th { padding: 2.2pt 3pt; } table.c td.m { font-size: 7.3pt; }
    table.c.dense td, table.c.dense th { padding: 1.4pt 3pt; } table.c.dense td.m, table.c.dense td { font-size: 6.6pt; }
    footer { margin-top: 10pt; color: #777; font-size: 7.3pt; }
  </style></head><body>
    <header><div><h1>${escHtml(p.name)}</h1><div class="sub">${L('subtitle')}</div></div>
    <div class="sub">${date} · Pixel2Pixel ${escHtml(appVersion || '')} · Video Bridge Solutions</div></header>
    <div class="tot">${kpi}</div>
    <div class="lines"><div class="sub"><b>${L('processing')}</b> · ${procLine}</div><div class="sub pw"><b>${L('powerTitle')}</b> · ${powerLine}${mains ? ' · ' + L('mains') + ' ' + (mains.ph === 3 ? L('tetraA', { a: mains.a }) : L('monoA', { a: mains.a })) : ''}${mu ? ' · ' + ps.multi.count + ' × ' + escHtml(mu.label) : ''}</div></div>
    ${images.comp ? `<div class="comp"><img src="${images.comp}"><div class="note">${L('comp')} — ${p.composition.w} × ${p.composition.h}</div></div>` : ''}
    <section class="pb">${head(L('surfaces'))}<h2>${L('surfaces')}</h2>
    <table><thead><tr><th></th><th>${L('name')}</th><th>Pixels</th><th>${L('tiles')}</th><th>${L('pitchSize')}</th><th>${L('vision')}</th><th>${L('portsShort')}</th><th>${L('circuits')}</th><th>kW</th><th>kg</th><th>Outputs</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Outputs</h2>
    <table><thead><tr><th>${L('outputCol')}</th><th>${L('resolution')}</th><th>Slices</th></tr></thead><tbody>${outRows}</tbody></table>
    <h2>Slices (Resolume)</h2>
    <table><thead><tr><th>Slice</th><th>Output</th><th>Input X,Y</th><th>${L('size')}</th><th>Output X,Y</th><th>${L('rotation')}</th></tr></thead><tbody>${sliceRows}</tbody></table>
    <footer>${L('footer')}</footer></section>
    ${dataPage}${powerPage}${outPages}
  </body></html>`;
}

export async function viewThumbDataUrl(R, p, view, maxW = 2200, style = null) {
  const full = renderView(R, style ? { ...p, style: { ...p.style, ...style } } : p, view, { time: 0, anim: false });
  const k = Math.min(1, maxW / full.width);
  const c = document.createElement('canvas');
  c.width = Math.round(full.width * k); c.height = Math.round(full.height * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}
