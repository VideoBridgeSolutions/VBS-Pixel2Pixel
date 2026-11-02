// Pixel2Pixel — exports: PNG, MP4 (WebCodecs H.264 + mp4-muxer), PDF tech sheet (HTML → printToPDF)
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import {
  getOutput, tileInfo, physicalSize, surfaceStats, cablingSummary, viewingDistance, kva,
  slicesOfSurface, sliceName, PROCESSORS, dataChain, powerChain, portLabels, portUsage, circuitStarts, circuitNumbers, circuitPhase, circuitWay, hasDistros,
  powerSummary, multiOf, MAINS, brandSig, getBrand, scopeProject
} from './model.js';
import { projectorRows, screenProjection } from './projectors.js';

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
  // a port shared with another screen is listed once, on the screen where it starts, with all its cabinets
  return dc.ports.map((pt, k) => { const lb = labs[k] || {}; const n = lb.total || pt.length; return lb.cont ? null : { main: lb.main || '', backup: lb.backup || null, proc: lb.g ? procOf(p, lb.g) : 0,
    tiles: n, px: n * dc.tilePx, load: lb.total ? n * dc.tilePx / Math.max(1, dc.portPx) : (use[k] || 0), from: pt[0], to: pt[pt.length - 1], shared: !!lb.next }; }).filter(Boolean);
}
/** Power circuits of a surface: [{ n, phase, tiles, W, A, load, multi, way, from, to }]. */
export function circuitRows(p, s) {
  if (s.kind === 'proj') return [];
  const pw = p.power || {}, ch = powerChain(s, pw, p.cabling);
  const V = Math.max(1, Number(pw.voltage) || 230), A = Math.max(1, Number(pw.amps) || 16);
  const w = Number(pw.basis === 'avg' ? (s.power.wattsAvg || s.power.wattsMax) : s.power.wattsMax) || 0;
  const nums = circuitNumbers(p, s), mu = pw.autoNumber !== false && !hasDistros(pw) ? multiOf(pw) : null;
  // a circuit shared with another screen is listed once, where it starts, with all its cabinets
  return ch.circuits.map((c, k) => {
    const nb = nums[k] || { n: k + 1 }; if (nb.cont) return null;
    const tiles = nb.total || c.length, n = nb.n, W = tiles * w;
    const wy = hasDistros(pw) ? circuitWay(pw, n, p) : null;
    return { n, phase: circuitPhase(pw, n, p), tiles, W, A: W / V, load: W / V / A, multi: mu ? Math.ceil(n / mu.circuits) : 0, way: mu ? ((n - 1) % mu.circuits) + 1 : 0, from: c[0], to: c[c.length - 1], shared: nb.next,
      outlet: hasDistros(pw) ? (wy ? `${wy.name} · ${wy.short} ${wy.conn}·${wy.way}` : '—') : '',
      di: wy ? wy.di : null, oi: wy ? wy.oi : 0, conn: wy ? wy.conn : 0, short: wy ? wy.short : '', way2: wy ? wy.way : 0 };
  }).filter(Boolean);
}

/** Default options of the technical file (saved with the project in p.docExport; the export wizard edits them). */
export function defaultDocExport() {
  return {
    preset: 'full',
    sections: { summary: true, toc: true, checks: true, material: true, screens: true, outputs: true, data: true, power: true, proj: true },
    scope: 'all',                                            // mixed scene: 'all' | 'led' | 'proj'
    screensSort: 'output', screensWeight: true, screensVision: false,
    outputs: [], outputsPos: true,
    powerBy: 'distro', powerMaps: true, powerAnnex: false,
    layout: { company: '', logo: '', contact: '', client: '', clientLogo: '', venue: '', dates: '', revision: '', color: '#15171a', cover: 'plain', format: 'A4L', lang: '' }
  };
}
/** Project options merged over the defaults (older projects have none). */
export function docOptions(p) {
  const d = defaultDocExport(), o = (p && p.docExport) || {};
  return { ...d, ...o, sections: { ...d.sections, ...(o.sections || {}) }, layout: { ...d.layout, ...(o.layout || {}) }, outputs: Array.isArray(o.outputs) ? o.outputs : [] };
}
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/**
 * Technical file (HTML printed to PDF). images: { comp, cover, outputs: [{ id, map, data, power }] }.
 * opts: docOptions(p). ctx: { checks: [{ level, text }], preview } — preview = on-screen sheets for the export wizard.
 * Media-server specifics (Resolume screens / slices / input coordinates) are not part of the document.
 */
export function buildPdfHtml(p, images, t, appVersion, opts = null, ctx = {}) {
  const O = opts || docOptions(p), SEC = O.sections, LY = O.layout;
  p = scopeProject(p, O.scope);                              // LED only / projection only
  const L = (k, v) => t('pdf.' + k, v);
  const B = getBrand();
  const company = LY.company || B.name || '', logo = LY.logo || B.logo || '';
  const accent = /^#[0-9a-f]{6}$/i.test(LY.color || '') ? LY.color : '#15171a';
  const sum = cablingSummary(p);
  const ps = powerSummary(p);
  const pwr = p.power || {};
  const mu = hasDistros(pwr) ? null : multiOf(pwr);
  const proc = PROCESSORS[p.processor.type] ? PROCESSORS[p.processor.type].label : p.processor.type;
  const withCab = (images.outputs || []).some((x) => x.data || x.power);
  const date = new Date().toLocaleDateString(t('pdf.locale') === 'en' ? 'en-GB' : 'fr-FR');
  const surf = (id) => p.surfaces.find((x) => x.id === id);
  const red = p.processor.redundancy || 'none';
  const ppp = Math.max(1, Number(p.processor.portsPerProc) || 16);
  const isProj = (s) => s && s.kind === 'proj';
  const leds = p.surfaces.filter((s) => !isProj(s));
  const hasLed = leds.length > 0, projScreens = p.surfaces.filter(isProj);
  const PR = projectorRows(p), hasProj = projScreens.length > 0 || PR.length > 0;
  const pjBodies = PR.reduce((a, x) => a + Math.max(1, +x.pj.stack || 1), 0), pjLm = PR.reduce((a, x) => a + x.lm, 0);
  const pjW = PR.reduce((a, x) => a + (+x.pj.watts || 0) * Math.max(1, +x.pj.stack || 1), 0), pjKg = PR.reduce((a, x) => a + (+x.pj.kg || 0) * Math.max(1, +x.pj.stack || 1), 0);
  const blendsOf = (sl) => (sl.blend ? ['l', 'r', 't', 'b'].filter((k) => +sl.blend[k] > 0).map((k) => L('bl_' + k) + ' ' + sl.blend[k]).join(' · ') : '');
  const info = [LY.client, LY.venue, LY.dates, LY.revision ? L('revision') + ' ' + LY.revision : ''].filter(Boolean).map(escHtml).join(' · ');
  const run = (sec) => `<div class="run"><span><b>${escHtml(p.name)}</b>${LY.client ? ' · ' + escHtml(LY.client) : ''}</span><span class="rs">${escHtml(sec)}</span>${logo ? `<img src="${logo}" alt="">` : ''}</div>`;
  const page = (cls, sec, body) => `<section class="pg ${cls || ''}">${sec ? run(sec) : ''}${body}</section>`;
  const outsSel = (images.outputs || []).filter((im) => (!O.outputs.length || O.outputs.includes(im.id)) && p.outputs.some((o) => o.id === im.id));
  const procLine = `${escHtml(proc)} — ${fmt(sum.effPortPx)} px/port · ${p.processor.fps} Hz · ${p.processor.bitDepth} bit · ${L('headroom')} ${Math.round(p.processor.headroom ?? 100)} % · ${p.processor.portsPerProc} ${L('portsPerProc')} · ${L('redundancy')} : ${L('red_' + red)}`;
  const mains = MAINS.find((m) => m.a === Number(pwr.mainsA) && m.ph === ((Number(pwr.phases) || 1) >= 3 ? 3 : 1));
  const powerLine = `${pwr.voltage} V · ${L('circuit')} ${pwr.amps} A${pwr.linkAmps ? ` (${L('link')} ${pwr.linkAmps} A)` : ''} · ${(Number(pwr.phases) || 1) >= 3 ? L('tri') : L('mono')} · ${L('basis')} ${pwr.basis === 'avg' ? L('avgLong') : L('maxLong')}${pwr.rcd ? ` · ${L('rcd')} ${pwr.rcd} mA` : ''}`;
  const stats = (s) => sum.per[s.id] || surfaceStats(p, s);
  const outNames = (s) => [...new Set(slicesOfSurface(p, s.id).map((sl) => (p.outputs.find((o) => o.id === sl.out) || {}).name).filter(Boolean))];
  const allCirc = withCab && ps.circuits ? leds.flatMap((s) => circuitRows(p, s).map((r) => ({ s, r }))).sort((a, b) => a.r.n - b.r.n) : [];
  const tocList = [];

  // ---------- cover + summary
  const kpi = (!hasLed ? [
    [p.surfaces.length, L('surfaces')], [pjBodies || '—', L('projectors')], [pjLm ? fmt(pjLm) : '—', L('lumens')], [p.outputs.length, L('videoOuts')],
    [projScreens.reduce((a, s) => a + screenProjection(p, s).blends, 0) || '—', L('blends')], [pjW ? fmt(pjW / 1000, 1) : '—', L('kwProj')], [pjKg ? fmt(pjKg) : '—', 'kg'], [p.slices.length, 'Slices']
  ] : [
    [leds.length, L('screens')], [fmt(sum.tiles), L('tiles')],
    [withCab ? sum.mainPorts + (sum.backupPorts ? ' + ' + sum.backupPorts : '') : '—', L('ports') + ' · ' + (sum.mainProcs + (sum.backupProcs ? ' + ' + sum.backupProcs : '')) + ' ' + L('procShort')],
    [withCab && ps.circuits ? ps.circuits : '—', L('circuits') + ' ' + (pwr.amps || 16) + ' A'],
    [ps.Wmax ? fmt(ps.Wmax / 1000, 1) : '—', L('kwMax') + (ps.Wavg && ps.Wavg !== ps.Wmax ? ` · ${fmt(ps.Wavg / 1000, 1)} ${L('avg')}` : '')],
    [ps.Wmax ? fmt(kva(ps.W, pwr.pf), 1) : '—', `kVA (PF ${pwr.pf})`], [sum.kg ? fmt(sum.kg) : '—', 'kg'], [p.outputs.length, L('videoOuts')]
  ]).map(([v, k]) => `<div><b>${v}</b><span>${escHtml(k)}</span></div>`).join('');
  const brandBlock = `${logo ? `<img class="blogo" src="${logo}" alt="">` : ''}${company ? `<b>${escHtml(company)}</b><br>` : ''}${LY.contact ? escHtml(LY.contact) + '<br>' : ''}${date} · Pixel2Pixel ${escHtml(appVersion || '')}`;
  const subtitle = L(hasLed ? (hasProj ? 'subtitleMix' : 'subtitle') : 'subtitleProj');
  const titleBlock = LY.cover === 'band'
    ? `<div class="band" style="background:${accent}"><div><div class="kick">${escHtml(subtitle)}</div><h1>${escHtml(p.name)}</h1>${info ? `<div class="inf">${info}</div>` : ''}</div><div class="bside">${logo ? `<span class="lw"><img src="${logo}" alt=""></span>` : ''}${LY.clientLogo ? `<span class="lw"><img src="${LY.clientLogo}" alt=""></span>` : ''}<div>${company ? escHtml(company) + ' · ' : ''}${date}</div></div></div>`
    : `<header style="border-color:${accent}"><div><h1>${escHtml(p.name)}</h1><div class="sub">${escHtml(subtitle)}</div>${info ? `<div class="inf">${info}</div>` : ''}</div><div class="brand">${LY.clientLogo ? `<img class="blogo" src="${LY.clientLogo}" alt="">` : ''}${brandBlock}</div></header>`;
  const sections = [];
  const mark = (k, label) => { tocList.push(label); return label; };
  const tocKeys = [];
  if (SEC.material && hasLed) tocKeys.push(L('material'));
  if (SEC.screens) tocKeys.push(L('screensTitle'));
  if (SEC.proj && hasProj) tocKeys.push(L('projTitle'));
  if (SEC.outputs && outsSel.length) tocKeys.push(L('outputsTitle') + ' — ' + outsSel.map((im) => (p.outputs.find((o) => o.id === im.id) || {}).name).filter(Boolean).join(', '));
  if (SEC.data && withCab && hasLed) tocKeys.push(L('dataTitle'));
  if (SEC.power && withCab && ps.circuits) tocKeys.push(L('powerTitle'));
  if (SEC.power && O.powerAnnex && allCirc.length) tocKeys.push(L('annexTitle'));
  const checks = (ctx.checks || []);
  const right = (SEC.toc || SEC.checks) ? `<div class="side">
    ${SEC.toc ? `<h3>${L('toc')}</h3><div class="toc">${[L('summary'), ...tocKeys].map((x, i) => `<div><span>${i + 1}</span><span>${escHtml(x)}</span></div>`).join('')}</div>` : ''}
    ${SEC.checks ? `<h3>${L('checks')}</h3>${checks.length ? `<div class="warn"><ul>${checks.map((c) => `<li class="lv-${c.level || 'warn'}">${c.text}</li>`).join('')}</ul></div>` : `<div class="okbox">✓ ${L('noChecks')}</div>`}` : ''}
    <div class="note">${L('powerNoteShort')}</div></div>` : '';
  const sumBody = `<div class="sumg${right ? '' : ' one'}"><div>
    <div class="tot">${kpi}</div>
    ${images.comp ? `<div class="comp"><img src="${images.comp}"><div class="note c">${L('comp')} — ${p.composition.w} × ${p.composition.h} px</div></div>` : ''}
    ${hasLed ? `<div class="lines"><div class="sub"><b>${L('processing')}</b> · ${procLine}</div>${withCab ? `<div class="sub pw"><b>${L('powerTitle')}</b> · ${powerLine}${mains ? ' · ' + L('mains') + ' ' + (mains.ph === 3 ? L('tetraA', { a: mains.a }) : L('monoA', { a: mains.a })) : ''}</div>` : ''}</div>` : ''}
    </div>${right}</div>`;
  if (LY.cover === 'image' && (images.cover || images.comp)) {
    sections.push(`<section class="pg cover-img"><img class="bg" src="${images.cover || images.comp}"><div class="cv-t"><div class="kick">${escHtml(subtitle)}</div><h1>${escHtml(p.name)}</h1>${info ? `<div class="inf">${info}</div>` : ''}<div class="inf">${company ? escHtml(company) + ' · ' : ''}${date}</div></div>${logo ? `<span class="cv-logo"><img src="${logo}" alt=""></span>` : ''}</section>`);
    if (SEC.summary || SEC.toc || SEC.checks) sections.push(page('', L('summary'), `<h2>${L('summary')}</h2>${SEC.summary ? sumBody : right}`));
  } else {
    sections.push(`<section class="pg first">${titleBlock}${SEC.summary ? sumBody : (right ? `<div class="sumg one">${right}</div>` : '')}</section>`);
  }

  // ---------- material list
  if (SEC.material && hasLed) {
    const models = new Map();
    for (const s of leds) {
      const k = s.panel ? `${s.panel.brand} ${s.panel.model}` : L('noModel') + (s.pitch ? ` · ${s.pitch} mm` : '');
      const ti = tileInfo(s), st = stats(s), full = Math.max(1, ti.cols * ti.rows);
      const m2 = s.pitch ? (s.w * s.pitch / 1000) * (s.h * s.pitch / 1000) * (st.tiles / full) : 0;
      const M = models.get(k) || { k, tiles: 0, m2: 0, kg: 0, W: 0, det: s.pitch ? `${Math.round(ti.tw * s.pitch)} × ${Math.round(ti.th * s.pitch)} mm · ${Math.round(ti.tw)} × ${Math.round(ti.th)} px · ${s.pitch} mm` : '' };
      M.tiles += st.tiles; M.m2 += m2; M.kg += st.kg || 0; M.W += st.wattsMax || 0; models.set(k, M);
    }
    const ml = [...models.values()].sort((a, b) => b.tiles - a.tiles);
    const T = ml.reduce((a, x) => ({ tiles: a.tiles + x.tiles, m2: a.m2 + x.m2, kg: a.kg + x.kg, W: a.W + x.W }), { tiles: 0, m2: 0, kg: 0, W: 0 });
    const procsN = sum.mainProcs + (sum.backupProcs || 0), portsAll = sum.mainPorts + (sum.backupPorts || 0);
    const cRows = allCirc.map((x) => x.r);
    const perPh = [1, 2, 3].map((n) => cRows.filter((r) => String(r.phase).endsWith(String(n))).length);
    const socas = ps.distros ? ps.distros.reduce((a, D) => a + D.conns.length, 0) : 0;
    const procTab = `<h3>${L('matProc')}</h3><table><tbody>
      <tr><td>${escHtml(proc)}</td><td class="m r">${procsN}</td></tr>
      ${withCab ? `<tr><td>${L('matPorts')}</td><td class="m r">${portsAll} / ${procsN * ppp}</td></tr><tr><td>${L('matDataCables')}</td><td class="m r">${Math.ceil(portsAll * 1.1)}</td></tr><tr><td>${L('matDataJumpers')}</td><td class="m r">${fmt(Math.max(0, sum.tiles - sum.mainPorts))}</td></tr>` : ''}
      <tr><td>${L('videoOuts')} (${[...new Set(p.outputs.map((o) => o.w + ' × ' + o.h))].join(', ')})</td><td class="m r">${p.outputs.length}</td></tr></tbody></table>`;
    const pwTab = withCab && ps.circuits ? `<h3>${L('matPower')}</h3><table><thead><tr><th>${L('item')}</th><th class="r">${L('qty')}</th><th>${L('detail')}</th></tr></thead><tbody>
      ${mains ? `<tr><td>${L('mains')} ${mains.ph === 3 ? L('tetraA', { a: mains.a }) : L('monoA', { a: mains.a })}</td><td class="m r">1</td><td class="small">${escHtml(mains.conn || '')}</td></tr>` : ''}
      ${ps.distros ? `<tr><td>${L('distroUnit')}</td><td class="m r">${ps.distros.length}</td><td class="small">${ps.distros.map((D) => escHtml(D.name) + ' ' + D.a + ' A' + (D.tri ? ' tri' : '')).join(' · ')}</td></tr>
        <tr><td>${L('outletsUsed')}</td><td class="m r">${socas}</td><td class="small">${ps.distros.map((D) => escHtml(D.name) + ' : ' + D.conns.length).join(' · ')}</td></tr>` : mu ? `<tr><td>${escHtml(mu.label)}</td><td class="m r">${ps.multi.count}</td><td></td></tr>` : ''}
      <tr><td>${L('circuits')} ${pwr.amps} A</td><td class="m r">${ps.circuits}</td><td class="small">${ps.tri ? perPh.map((n, i) => 'L' + (i + 1) + ' ' + n).join(' · ') : ''}</td></tr>
      <tr><td>${L('matPowerJumpers')}</td><td class="m r">${fmt(Math.max(0, sum.tiles - ps.circuits))}</td><td class="small">${L('matJumpersHint')}</td></tr></tbody></table>` : '';
    const heavy = leds.map((s) => ({ s, kg: stats(s).kg || 0, wm: s.pitch ? s.w * s.pitch / 1000 : 0 })).filter((x) => x.kg).sort((a, b) => b.kg - a.kg).slice(0, 8);
    sections.push(page('', L('material'), `<h2>${L('material')}</h2><div class="g2"><div>
      <h3>${L('matPanels')}</h3><table><thead><tr><th>${L('model')}</th><th class="r">${L('tiles')}</th><th class="r">m²</th><th class="r">kg</th><th class="r">kW max</th></tr></thead><tbody>
      ${ml.map((x) => `<tr><td><b>${escHtml(x.k)}</b>${x.det ? `<br><small>${escHtml(x.det)}</small>` : ''}</td><td class="m r">${fmt(x.tiles)}</td><td class="m r">${x.m2 ? fmt(x.m2, 1) : '—'}</td><td class="m r">${x.kg ? fmt(x.kg) : '—'}</td><td class="m r">${x.W ? fmt(x.W / 1000, 1) : '—'}</td></tr>`).join('')}
      ${ml.length > 1 ? `<tr class="totr"><td><b>${L('total')}</b></td><td class="m r"><b>${fmt(T.tiles)}</b></td><td class="m r"><b>${T.m2 ? fmt(T.m2, 1) : '—'}</b></td><td class="m r"><b>${T.kg ? fmt(T.kg) : '—'}</b></td><td class="m r"><b>${T.W ? fmt(T.W / 1000, 1) : '—'}</b></td></tr>` : ''}</tbody></table>
      ${procTab}</div><div>${pwTab}
      ${heavy.length ? `<h3>${L('matWeights')}</h3><table><thead><tr><th>${L('surface')}</th><th class="r">kg</th><th class="r">kg/m</th></tr></thead><tbody>${heavy.map((x) => `<tr><td>${escHtml(x.s.name)}</td><td class="m r">${fmt(x.kg)}</td><td class="m r">${x.wm ? fmt(x.kg / x.wm, 1) : '—'}</td></tr>`).join('')}</tbody></table>` : ''}
      ${hasProj && PR.length ? `<h3>${L('projectors')}</h3><table><tbody>${[...new Map(PR.map((x) => [x.model, 0])).keys()].map((m) => `<tr><td>${escHtml(m)}</td><td class="m r">${PR.filter((x) => x.model === m).reduce((a, x) => a + Math.max(1, +x.pj.stack || 1), 0)}</td></tr>`).join('')}</tbody></table>` : ''}
      </div></div><div class="note">${L('matNote')}</div>`));
  }

  // ---------- screens
  if (SEC.screens) {
    const firstOut = (s) => { const sl = slicesOfSurface(p, s.id)[0]; const i = sl ? p.outputs.findIndex((o) => o.id === sl.out) : -1; return i < 0 ? 1e9 : i; };
    let groups;
    if (O.screensSort === 'output') {
      const m = new Map();
      for (const s of p.surfaces) { const k = firstOut(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
      groups = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, list]) => { const o = p.outputs[k]; return { title: o ? `${o.name} · ${o.w} × ${o.h} · ${list.length} ${L('screensShort')}` : L('unmapped'), list: list.sort((a, b) => natCmp(a.name, b.name)) }; });
    } else if (O.screensSort === 'group') {
      const m = new Map();
      for (const s of p.surfaces) { const k = (s.group || '').trim(); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
      groups = [...m.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || natCmp(a[0], b[0])).map(([k, list]) => ({ title: (k || L('noGroup')) + ` · ${list.length} ${L('screensShort')}`, list: list.sort((a, b) => natCmp(a.name, b.name)) }));
    } else groups = [{ title: '', list: p.surfaces.slice() }];
    const W = O.screensWeight !== false, V = !!O.screensVision;
    const cols = 6 + (hasLed ? 3 : 0) + (W ? 2 : 0) + (V ? 1 : 0) + (withCab && hasLed ? 2 : 0);
    let n = 0;
    const row = (s) => {
      n++;
      if (isProj(s)) { const P = screenProjection(p, s);
        return `<tr><td class="n">${n}</td><td><b>${escHtml(s.name)}</b><br><small>${L('projScreen')}</small></td><td class="m">${s.w} × ${s.h}</td>${hasLed ? `<td class="m" colspan="3">${escHtml(physicalSize(s) || '—')}${P.pxmm ? ` · ${fmt(P.pxmm, 2)} mm/px` : ''}</td>` : `<td class="m">${escHtml(physicalSize(s) || '—')}</td>`}${W ? `<td class="m r">${P.kg ? fmt(P.kg) : '—'}</td><td class="m r">${P.watts ? fmt(P.watts / 1000, 2) : '—'}</td>` : ''}${V ? '<td></td>' : ''}${withCab && hasLed ? '<td></td><td></td>' : ''}<td class="small">${outNames(s).map(escHtml).join(', ') || '—'}</td></tr>`; }
      const ti = tileInfo(s), st = stats(s), vd = viewingDistance(s.pitch), pr = withCab ? portRows(p, s) : [], cr = withCab ? circuitRows(p, s) : [];
      const noW = withCab && ps.circuits >= 0 && !(s.power && +s.power.wattsMax);
      return `<tr><td class="n">${n}</td><td><b>${escHtml(s.name)}</b>${s.panel ? '<br><small>' + escHtml(s.panel.brand + ' ' + s.panel.model) + '</small>' : ''}</td>
        <td class="m">${s.w} × ${s.h}</td><td class="m">${ti.cols} × ${ti.rows} = ${st.tiles}${ti.partial ? ' <span class="w">⚠</span>' : ''}</td>
        <td class="m">${escHtml(physicalSize(s) || '—')}</td><td class="m">${s.pitch ? fmt(s.pitch, s.pitch < 10 ? 2 : 1) + ' mm' : '—'}</td>
        ${W ? `<td class="m r">${st.kg ? fmt(st.kg) : '—'}</td><td class="m r">${st.wattsMax ? fmt(st.wattsMax / 1000, 2) : '<span class="w">?</span>'}</td>` : ''}
        ${V ? `<td class="m">${vd ? vd.min + ' / ' + vd.opt + ' m' : '—'}</td>` : ''}
        ${withCab ? `<td class="m">${pr.length ? escHtml(pr[0].main) + (pr.length > 1 ? ' → ' + escHtml(pr[pr.length - 1].main) : '') : '—'}</td><td class="m">${cr.length ? 'C' + cr[0].n + (cr.length > 1 ? ' → C' + cr[cr.length - 1].n : '') : (noW ? `<span class="w">${L('noWattsShort')}</span>` : '—')}</td>` : ''}
        <td class="small">${outNames(s).map(escHtml).join(', ') || '<span class="w">—</span>'}</td></tr>`;
    };
    const sortTxt = { output: L('sortOutput'), group: L('sortGroup'), list: L('sortList') }[O.screensSort] || '';
    sections.push(page('', L('screensTitle'), `<h2>${L('screensTitle')} <small>${p.surfaces.length} ${L('screensShort')} · ${escHtml(sortTxt)}</small></h2>
      <table class="scr"><thead><tr><th></th><th>${L('surface')}</th><th>Pixels</th>${hasLed ? `<th>${L('tiles')}</th><th>${L('sizeM')}</th><th>Pitch</th>` : `<th>${L('phys')}</th>`}${W ? `<th class="r">kg</th><th class="r">kW</th>` : ''}${V ? `<th>${L('vision')}</th>` : ''}${withCab && hasLed ? `<th>Data</th><th>${L('powerShort')}</th>` : ''}<th>${L('outputShort')}</th></tr></thead>
      <tbody>${groups.map((g) => (g.title ? `<tr class="grp"><td colspan="${cols}">${escHtml(g.title)}</td></tr>` : '') + g.list.map(row).join('')).join('')}</tbody></table>
      <div class="note">${withCab ? L('screensNote') + ' ' : ''}${V ? L('footer') : L('weightsNote')}</div>`));
  }

  // ---------- projection
  if (SEC.proj && hasProj) {
    const pjRows = PR.map((x) => `<tr><td><b>${escHtml(x.pj.name)}</b>${+x.pj.stack > 1 ? `<br><small>× ${x.pj.stack} ${L('stacked')}</small>` : ''}</td><td>${escHtml(x.model)}<br><small>${x.pj.resW} × ${x.pj.resH}</small></td>
      <td class="small">${escHtml(x.lens || '—')}<br><small>${L('throwR')} ${fmt(+x.pj.tr || 0, 2)} (${fmt(+x.pj.trMin || 0, 2)}–${fmt(+x.pj.trMax || 0, 2)})${x.r.trOk === false ? ' <span class="bad">⚠</span>' : ''}</small></td>
      <td class="m">${fmt(x.lm)}</td><td class="m">${x.r.dist ? fmt(x.r.dist, 1) + ' m' : '—'}</td><td class="m">${x.r.W ? fmt(x.r.W, 2) + ' × ' + fmt(x.r.H, 2) + ' m' : '—'}</td>
      <td class="m">${x.r.nits ? fmt(x.r.nits) + '<br><small>' + fmt(x.r.lux) + ' lux</small>' : '—'}</td><td>${x.screen ? escHtml(x.screen.name) : '<span class="w">—</span>'}</td>
      <td>${x.out ? escHtml(x.out.name) : `<span class="w">${L('noOutput')}</span>`}</td><td class="m">${+x.pj.watts ? fmt((+x.pj.watts) * Math.max(1, +x.pj.stack || 1)) : '—'}</td></tr>`).join('');
    const scRows = projScreens.map((s) => {
      const P = screenProjection(p, s);
      return `<tr><td><b>${escHtml(s.name)}</b></td><td class="m">${s.w} × ${s.h}</td><td class="m">${escHtml(physicalSize(s) || '—')}</td><td class="m">${fmt(P.gain, 1)}</td><td class="m">${P.rows.length || '—'}</td>
        <td class="m">${P.lm ? fmt(P.lm) : '—'}</td><td class="m">${P.lm ? fmt(P.nits) : '—'}</td><td class="m">${P.pxmm ? fmt(P.pxmm, 2) : '—'}</td>
        <td class="small">${P.slices.map((sl) => { const o = p.outputs.find((x) => x.id === sl.out); const b = blendsOf(sl); return `${escHtml(o ? o.name : '?')}${b ? ' : ' + escHtml(b) + ' px' : ''}`; }).join('<br>') || '—'}</td></tr>`;
    }).join('');
    sections.push(page('', L('projTitle'), `<h2>${L('projTitle')}</h2>
      <div class="sub">${PR.length ? `${pjBodies} ${L('projectorsShort')} · ${fmt(pjLm)} lm${pjW ? ' · ' + fmt(pjW / 1000, 2) + ' kW' : ''}${pjKg ? ' · ' + fmt(pjKg) + ' kg' : ''}` : L('noProjectors')}</div>
      ${projScreens.length ? `<table><thead><tr><th>${L('projScreen')}</th><th>Pixels</th><th>${L('phys')}</th><th>Gain</th><th>${L('projectorsShort')}</th><th>lm</th><th>nits</th><th>mm/px</th><th>${L('blendCol')}</th></tr></thead><tbody>${scRows}</tbody></table>` : ''}
      ${PR.length ? `<h3>${L('projectors')}</h3><table><thead><tr><th>${L('name')}</th><th>${L('model')}</th><th>${L('lens')}</th><th>lm</th><th>${L('distance')}</th><th>${L('image')}</th><th>nits</th><th>${L('projScreen')}</th><th>Output</th><th>W</th></tr></thead><tbody>${pjRows}</tbody></table>` : ''}
      <div class="note">${L('projNote')}</div>`));
  }

  // ---------- one page per output: image + table beside it (or below for wide outputs), tightened to stay on the page
  const outPage = (o, kind, img, rowsHtml, nRows, extra = '', headCells = '') => {
    const portrait = LY.format === 'A4P';
    const wide = portrait || o.w / Math.max(1, o.h) > 2.2;          // very wide outputs (or portrait pages): plan above, table below
    const dens = nRows > (wide ? 22 : 42) ? ' dense2' : nRows > (wide ? 12 : 30) ? ' dense' : '';
    const imgH = wide ? (nRows <= 8 ? 105 : nRows <= 16 ? 85 : 62) * (portrait ? 1 : 1) : 0;
    return page(`out ${wide ? 'wide' : 'side'}`, o.name + ' — ' + L('k_' + kind), `<h2>${escHtml(o.name)} <span class="chip ${kind}">${L('k_' + kind)}</span> <small>${o.w} × ${o.h}</small></h2>
      <div class="lay"><div class="pic"><img src="${img}"${wide ? ` style="max-height:${imgH}mm"` : ''}></div><div class="tab">${extra}<table class="c${dens}"><thead><tr>${headCells}</tr></thead><tbody>${rowsHtml}</tbody></table></div></div>`);
  };
  const outLabel = (o) => o.name;
  if (SEC.outputs) for (const im of outsSel) {
    const o = p.outputs.find((x) => x.id === im.id); if (!o) continue;
    const sls = p.slices.filter((x) => x.out === o.id).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const pos = O.outputsPos !== false;
    const rows = sls.map((sl) => {
      const s = surf(sl.surfaceId); if (!s) return '';
      const ti = tileInfo(s);
      if (isProj(s)) { const b = blendsOf(sl); return `<tr><td><b>${escHtml(sliceName(p, sl))}</b><br><small>${L('projScreen')}</small></td><td class="m">${sl.src.w} × ${sl.src.h}</td>${pos ? `<td class="m">${sl.x}, ${sl.y}${sl.rot ? ' ↻' + sl.rot + '°' : ''}</td>` : ''}<td class="small">${escHtml(b || '—')}</td></tr>`; }
      return `<tr><td><b>${escHtml(sliceName(p, sl))}</b>${s.panel ? '<br><small>' + escHtml(s.panel.brand + ' ' + s.panel.model) + '</small>' : ''}</td><td class="m">${sl.src.w} × ${sl.src.h}</td>${pos ? `<td class="m">${sl.x}, ${sl.y}${sl.rot ? ' ↻' + sl.rot + '°' : ''}${sl.flip ? ' ⇋' : ''}</td>` : ''}<td class="m">${ti.cols} × ${ti.rows}</td></tr>`;
    }).join('');
    sections.push(outPage(o, 'map', im.map, rows, sls.length, `<div class="mini">${sls.length} ${L('screensShort')} · ${L('sortedPos')}</div>`,
      `<th>${L('surface')}</th><th>${L('sizePx')}</th>${pos ? `<th>${L('posXY')}</th>` : ''}<th>${L('tiles')}</th>`));
  }

  // ---------- data: processors, then each output with its ports grouped by processor
  if (SEC.data && withCab && hasLed) {
    const procs = {};
    for (const s of leds) for (const r of portRows(p, s)) {
      const P = procs[r.proc] = procs[r.proc] || { ports: 0, tiles: 0, px: 0, list: [] };
      P.ports++; P.tiles += r.tiles; P.px += r.px;
      const last = P.list[P.list.length - 1];
      if (last && last.s === s) { last.to = r.main; last.n++; } else P.list.push({ s, from: r.main, to: r.main, n: 1 });
    }
    const cap = red === 'pair' || red === 'port' ? Math.floor(ppp / 2) : ppp;
    const procRows = Object.keys(procs).map(Number).sort((a, b) => a - b).map((k) => {
      const P = procs[k];
      return `<tr><td class="m"><b>${red === 'processor' ? 'A' + k + ' / B' + k : k}</b></td><td class="m">${P.ports} / ${cap}${P.ports >= cap ? ' <span class="w">●</span>' : ''}</td><td class="m r">${fmt(P.tiles)}</td><td class="m r">${fmt(P.px)}</td>
        <td class="small">${P.list.map((x) => `<b>${escHtml(x.s.name)}</b> ${escHtml(x.from)}${x.n > 1 ? '→' + escHtml(x.to) : ''}`).join(' · ')}</td></tr>`;
    }).join('');
    sections.push(page('', L('dataTitle'), `<h2>${L('dataTitle')}</h2><div class="sub">${procLine}</div>
      <table><thead><tr><th>${L('proc')}</th><th>${L('portsUsed')}</th><th class="r">${L('tiles')}</th><th class="r">Pixels</th><th>${L('feeds')}</th></tr></thead><tbody>${procRows}</tbody></table>
      <div class="note">${L('dataNote')}</div>`));
    for (const im of outsSel) {
      const o = p.outputs.find((x) => x.id === im.id); if (!o || !im.data) continue;
      const ids = [...new Set(p.slices.filter((x) => x.out === o.id).map((x) => x.surfaceId))].map(surf).filter((s) => s && !isProj(s));
      if (!ids.length) continue;
      const rs = ids.flatMap((s) => portRows(p, s).map((r) => ({ s, r }))).sort((a, b) => a.r.proc - b.r.proc || natCmp(a.r.main, b.r.main));
      if (!rs.length) continue;
      const tot = { t: rs.reduce((a, x) => a + x.r.tiles, 0), px: rs.reduce((a, x) => a + x.r.px, 0) };
      let lastP = null, html = '', nRows = 0;
      const ncol = 5 + (red !== 'none' ? 1 : 0);
      for (const { s, r } of rs) {
        if (r.proc !== lastP) { lastP = r.proc; const used = (procs[r.proc] || {}).ports || 0; html += `<tr class="grp"><td colspan="${ncol}">${L('procLong')} ${red === 'processor' ? 'A' + r.proc + ' / B' + r.proc : r.proc} · ${used} / ${cap} ${L('portsShort').toLowerCase()}</td></tr>`; nRows++; }
        html += `<tr><td class="m"><b>${escHtml(r.main)}</b></td>${red !== 'none' ? `<td class="m">${escHtml(r.backup || '')}</td>` : ''}<td>${escHtml(s.name)}</td><td class="m r">${r.tiles}</td><td class="m r">${pct(r.load)}</td><td class="m">${tileRef(r.from)} → ${tileRef(r.to)}</td></tr>`; nRows++;
      }
      sections.push(outPage(o, 'data', im.data, html, nRows, `<div class="mini"><b>${rs.length}</b> ${L('portsShort')} · <b>${fmt(tot.t)}</b> ${L('tiles').toLowerCase()} · <b>${fmt(tot.px)}</b> px</div>`,
        `<th>${L('port')}</th>${red !== 'none' ? `<th>${L('backup')}</th>` : ''}<th>${L('surface')}</th><th class="r">${L('tiles')}</th><th class="r">${L('load')}</th><th>${L('fromTo')}</th>`));
    }
  }

  // ---------- power: overview, then by distro (distro → outlet → circuits) or by screen, then plans per output
  if (SEC.power && withCab && ps.circuits) {
    const maxA = Math.max(1, ...ps.ampsPhase);
    const bars = (amps, cap2, count) => (ps.tri ? [0, 1, 2] : [0]).map((i) => `<div class="ph"><span>${ps.tri ? 'L' + (i + 1) : L('mono')}</span><i><u style="width:${Math.min(100, Math.round(amps[i] / Math.max(1, cap2) * 100))}%"></u></i><b>${fmt(amps[i], 1)} A${count ? ' · ' + count[i] + ' ' + L('circuitsShort') : ''}</b></div>`).join('');
    const cnt = [1, 2, 3].map((n) => allCirc.filter((x) => String(x.r.phase).endsWith(String(n))).length);
    const adv = ps.distros ? '' : ps.mains ? `${L('mainsLoad', { a: ps.mains.a, pct: Math.round(ps.mains.load * 100) })}${ps.mains.over ? ' — ' + L('mainsOver', { n: ps.mains.feeds }) : ps.mains.ok ? '' : ' — ' + L('mainsTight')}`
      : ps.advice.size ? L('advice', { a: ps.advice.size }) : ps.advice.need ? L('adviceMulti', { n: Math.ceil(ps.advice.need / 400) }) : '';
    const perSurf = leds.map((s) => {
      const cr = circuitRows(p, s), ch = powerChain(s, pwr, p.cabling);
      if (!cr.length) return `<tr><td><b>${escHtml(s.name)}</b></td><td colspan="6" class="w small">${L('noWatts')}</td></tr>`;
      const W = cr.reduce((a, c) => a + c.W, 0);
      const byPh = {}; cr.forEach((c) => { if (c.phase) byPh[c.phase] = (byPh[c.phase] || 0) + 1; });
      return `<tr><td><b>${escHtml(s.name)}</b></td><td class="m">C${cr[0].n}${cr.length > 1 ? ' → C' + cr[cr.length - 1].n : ''}</td><td class="m">${cr.length} × ≤${ch.per}</td>
        <td class="small">${escHtml(t('pw.by_' + (Number(s.power.perCircuit) > 0 ? 'manual' : ch.limits.by || 'watts')))}</td>
        <td class="small">${escHtml(t('cab.f_' + (ch.path.flow || 'rows')))} · ${escHtml(t('cab.p_' + (ch.path.pattern || 'serpentine')))}</td>
        <td class="m">${Object.keys(byPh).sort().map((k) => k + '×' + byPh[k]).join(' ') || '—'}</td><td class="m r">${fmt(W / 1000, 2)}</td></tr>`;
    }).join('');
    const surfTab = `<table><thead><tr><th>${L('surface')}</th><th>${L('circuits')}</th><th>${L('perCircuit')}</th><th>${L('limitBy')}</th><th>${L('path')}</th><th>${L('phases')}</th><th class="r">kW</th></tr></thead><tbody>${perSurf}</tbody></table>`;
    const byDistro = O.powerBy !== 'screen' && ps.distros;
    sections.push(page('', L('powerTitle'), `<h2>${L('powerTitle')}</h2><div class="sub">${powerLine}</div>
      <div class="tot t4">
        <div><b>${mains ? (mains.ph === 3 ? L('tetraA', { a: mains.a }) : L('monoA', { a: mains.a })) : '—'}</b><span>${L('mains')}${mains ? ' · ' + escHtml(mains.conn) : ''}</span></div>
        <div><b>${ps.distros ? ps.distros.length + ' × distri' : mu ? ps.multi.count + ' × ' + escHtml(mu.label) : L('direct', { a: pwr.amps })}</b><span>${L('distro')}${ps.distros ? ' · ' + ps.distros.reduce((a, D) => a + D.used, 0) + ' / ' + ps.distros.reduce((a, D) => a + D.ways, 0) : ''}</span></div>
        <div><b>${fmt(ps.tri ? Math.max(...ps.ampsPhase) : ps.ampsPhase[0], 0)} A</b><span>${ps.tri ? L('worstPhase') + (ps.imbalance > 0.1 ? ' · ' + L('imbalance', { pct: Math.round(ps.imbalance * 100) }) : '') : L('total')}</span></div>
        <div><b>${ps.circuits}</b><span>${L('circuits')} ${pwr.amps} A</span></div></div>
      <div class="phases">${bars(ps.ampsPhase, maxA, cnt)}</div>
      ${adv ? `<div class="callout${ps.mains && !ps.mains.ok ? ' bad' : ''}">${escHtml(adv)}</div>` : ''}
      ${ps.noWatts.length ? `<div class="callout bad">${L('missingW', { list: ps.noWatts.map((s) => s.name).join(', ') })}</div>` : ''}
      ${ps.unplugged && ps.unplugged.length ? `<div class="callout bad">${L('unplugged', { list: ps.unplugged.map((n) => 'C' + n).join(', ') })}</div>` : ''}
      ${ps.distros ? `<table><thead><tr><th>Distri</th><th>${L('mains')}</th><th>${L('circuits')}</th><th class="r">A (L1 / L2 / L3)</th><th class="r">%</th><th>${L('screens')}</th></tr></thead><tbody>${ps.distros.map((D) => `<tr><td><b>${escHtml(D.name)}</b></td><td class="m">${D.a} A ${D.tri ? 'tri' : 'mono'}</td><td class="m">${D.used} / ${D.ways}</td><td class="m r">${D.ampsPhase.slice(0, D.tri ? 3 : 1).map((a) => fmt(a, 0)).join(' / ')}</td><td class="m r${D.over ? ' bad' : ''}">${Math.round(D.load * 100)} %</td><td class="small">${escHtml([...new Set(D.screens)].join(' · '))}</td></tr>`).join('')}</tbody></table>` : ''}
      ${byDistro ? '' : surfTab}
      <div class="note">${L('powerNote')}</div>`));
    if (byDistro) for (const D of ps.distros) {
      const rows = allCirc.filter((x) => x.r.di === D.di).sort((a, b) => a.r.oi - b.r.oi || a.r.conn - b.r.conn || a.r.way2 - b.r.way2 || a.r.n - b.r.n);
      if (!rows.length) continue;
      let lastK = null, html = '';
      for (const { s, r } of rows) {
        const k = r.oi + ':' + r.conn;
        if (k !== lastK) { lastK = k; const scr = [...new Set(rows.filter((x) => x.r.oi + ':' + x.r.conn === k).map((x) => x.s.name))]; html += `<tr class="grp"><td colspan="6">${escHtml(r.short)} ${r.conn} · ${escHtml(scr.join(' · '))}</td></tr>`; }
        html += `<tr><td class="m">${r.conn}·${r.way2}</td><td class="m"><b>C${r.n}</b></td><td class="m">${r.phase || ''}</td><td>${escHtml(s.name)}</td><td class="m r">${r.tiles}</td><td class="m r${r.load > 1 ? ' bad' : r.load > 0.8 ? ' w' : ''}">${fmt(r.A, 1)}</td></tr>`;
      }
      const conns = D.conns.map((c) => { const rr = rows.filter((x) => x.r.oi === c.oi && x.r.conn === c.conn); return `<tr><td class="m"><b>${escHtml(c.short)} ${c.conn}</b></td><td class="m small">${escHtml(c.txt)}</td><td class="small">${escHtml([...new Set(rr.map((x) => x.s.name))].join(' · '))}</td><td class="m r">${rr.length ? fmt(Math.max(...rr.map((x) => x.r.A)), 1) : '—'}</td></tr>`; }).join('');
      sections.push(page('', L('powerTitle') + ' — ' + D.name, `<h2>${L('powerTitle')} <span class="chip power">${escHtml(D.name)}</span> <small>${D.a} A ${D.tri ? 'tri' : 'mono'} · ${D.used} / ${D.ways} ${L('circuitsShort')} · ${Math.round(D.load * 100)} %</small></h2>
        <div class="g2"><div><div class="phases">${bars(D.ampsPhase, D.a || maxA, [1, 2, 3].map((n) => rows.filter((x) => String(x.r.phase).endsWith(String(n))).length))}</div>
        <table class="c${rows.length > 40 ? ' dense2' : rows.length > 28 ? ' dense' : ''}"><thead><tr><th>${L('outletWay')}</th><th>${L('circuit')}</th><th>${L('phase')}</th><th>${L('surface')}</th><th class="r">${L('tiles')}</th><th class="r">A</th></tr></thead><tbody>${html}</tbody></table></div>
        <div><table><thead><tr><th>${L('outlet')}</th><th>${L('circuits')}</th><th>${L('screens')}</th><th class="r">A max</th></tr></thead><tbody>${conns}</tbody></table>
        <div class="note">${L('distroNote')}</div></div></div>`));
    }
    if (byDistro && O.powerBy !== 'screen') { /* per-screen summary stays available with « par écran » */ }
    if (O.powerMaps !== false) for (const im of outsSel) {
      const o = p.outputs.find((x) => x.id === im.id); if (!o || !im.power) continue;
      const ids = [...new Set(p.slices.filter((x) => x.out === o.id).map((x) => x.surfaceId))].map(surf).filter((s) => s && !isProj(s));
      const rs = ids.flatMap((s) => circuitRows(p, s).map((r) => ({ s, r }))).sort((a, b) => a.r.n - b.r.n);
      if (!rs.length) continue;
      const Wt = rs.reduce((a, x) => a + x.r.W, 0), dst = !!ps.distros;
      let lastS = null, html = '', nRows = 0;
      const ncol = 5 + (ps.tri ? 1 : 0) + (mu ? 1 : 0) + (dst ? 1 : 0);
      for (const { s, r } of rs.sort((a, b) => natCmp(a.s.name, b.s.name) || a.r.n - b.r.n)) {
        if (s !== lastS) { lastS = s; html += `<tr class="grp"><td colspan="${ncol}">${escHtml(s.name)}</td></tr>`; nRows++; }
        html += `<tr><td class="m"><b>C${r.n}</b></td>${ps.tri ? `<td class="m">${r.phase}</td>` : ''}${mu ? `<td class="m">${r.multi ? r.multi + '·' + r.way : ''}</td>` : ''}${dst ? `<td class="small">${escHtml(r.outlet)}</td>` : ''}<td class="m r">${r.tiles}</td><td class="m r">${fmt(r.W)}</td><td class="m r${r.load > 1 ? ' bad' : r.load > 0.8 ? ' w' : ''}">${fmt(r.A, 1)}</td><td class="m">${tileRef(r.from)} → ${tileRef(r.to)}</td></tr>`; nRows++;
      }
      sections.push(outPage(o, 'power', im.power, html, nRows, `<div class="mini"><b>${rs.length}</b> ${L('circuitsShort')} · <b>${fmt(Wt / 1000, 2)}</b> kW · ${pwr.voltage} V / ${pwr.amps} A</div>`,
        `<th>${L('circuit')}</th>${ps.tri ? `<th>${L('phase')}</th>` : ''}${mu ? '<th>Multi</th>' : ''}${dst ? `<th>${L('distro')}</th>` : ''}<th class="r">${L('tiles')}</th><th class="r">W</th><th class="r">A</th><th>${L('fromTo')}</th>`));
    }
    if (O.powerAnnex && allCirc.length) {
      const half = Math.ceil(allCirc.length / 2);
      const tab = (list) => `<table class="c dense2"><thead><tr><th>${L('circuit')}</th>${ps.tri ? `<th>${L('phase')}</th>` : ''}${ps.distros ? `<th>${L('distro')}</th>` : ''}<th>${L('surface')}</th><th class="r">${L('tiles')}</th><th class="r">A</th></tr></thead><tbody>${list.map(({ s, r }) => `<tr><td class="m"><b>C${r.n}</b></td>${ps.tri ? `<td class="m">${r.phase}</td>` : ''}${ps.distros ? `<td class="small">${escHtml(r.outlet)}</td>` : ''}<td class="small">${escHtml(s.name)}</td><td class="m r">${r.tiles}</td><td class="m r">${fmt(r.A, 1)}</td></tr>`).join('')}</tbody></table>`;
      sections.push(page('annex', L('annexTitle'), `<h2>${L('annexTitle')} <small>${allCirc.length} ${L('circuitsShort')}</small></h2><div class="g2">${tab(allCirc.slice(0, half))}${tab(allCirc.slice(half))}</div>`));
    }
  }

  // ---------- document
  const fmtCss = { A4L: ['A4 landscape', '297mm', '210mm'], A4P: ['A4 portrait', '210mm', '297mm'], A3L: ['A3 landscape', '420mm', '297mm'] }[LY.format] || ['A4 landscape', '297mm', '210mm'];
  return `<!doctype html><html lang="${t('pdf.locale')}"><head><meta charset="utf-8"><style>
    @page { size: ${fmtCss[0]}; margin: 10mm 11mm 13mm; }
    :root { --acc: ${accent}; }
    * { box-sizing: border-box; }
    body { font: 8.8pt/1.35 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #15171a; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .pg + .pg { break-before: page; }
    header { display: flex; justify-content: space-between; align-items: flex-end; gap: 16pt; border-bottom: 2.5pt solid var(--acc); padding-bottom: 7pt; margin-bottom: 9pt; }
    h1 { font-size: 22pt; margin: 0; letter-spacing: .2pt; line-height: 1.05; }
    .sub { color: #555; font-size: 8.5pt; margin: 2pt 0 6pt; } .inf { color: #333; font-size: 8.4pt; margin-top: 3pt; }
    .brand { text-align: right; font-size: 8pt; color: #555; line-height: 1.4; } .brand b { color: #15171a; }
    .blogo { display: block; max-height: 30pt; max-width: 130pt; object-fit: contain; margin: 0 0 4pt auto; }
    .band { display: flex; justify-content: space-between; align-items: flex-end; gap: 14pt; color: #fff; padding: 14pt 16pt 12pt; margin: -2pt 0 10pt; border-radius: 4pt; }
    .band h1 { font-size: 24pt; } .band .kick, .cover-img .kick { font-size: 7.5pt; letter-spacing: 1.2pt; text-transform: uppercase; opacity: .9; } .band .inf { color: #fff; opacity: .92; }
    .band .bside { text-align: right; font-size: 7.6pt; display: flex; flex-direction: column; align-items: flex-end; gap: 4pt; }
    .lw { background: #fff; border-radius: 4pt; padding: 3pt 6pt; display: inline-block; } .lw img { max-height: 24pt; max-width: 110pt; display: block; }
    .cover-img { position: relative; height: calc(${fmtCss[2]} - 23mm); overflow: hidden; background: #000; border-radius: 3pt; }
    .cover-img img.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .62; }
    .cover-img .cv-t { position: absolute; left: 0; right: 0; bottom: 0; padding: 22pt 24pt; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.88)); }
    .cover-img h1 { font-size: 30pt; } .cover-img .inf { color: #fff; opacity: .9; font-size: 9pt; }
    .cover-img .cv-logo { position: absolute; top: 14pt; right: 16pt; background: #fff; border-radius: 4pt; padding: 4pt 7pt; } .cover-img .cv-logo img { max-height: 28pt; max-width: 130pt; display: block; }
    h2 { font-size: 11.5pt; margin: 4pt 0 7pt; text-transform: uppercase; letter-spacing: .6pt; display: flex; align-items: center; gap: 8pt; flex-wrap: wrap; }
    h2 small { font: 500 8.3pt Menlo, Consolas, monospace; color: #666; text-transform: none; letter-spacing: 0; }
    h3 { font-size: 7.6pt; text-transform: uppercase; letter-spacing: .5pt; color: #555; margin: 9pt 0 4pt; }
    .run { display: flex; align-items: center; gap: 10pt; font-size: 7.5pt; color: #777; border-bottom: .5pt solid #ccc; padding-bottom: 3pt; margin-bottom: 6pt; text-transform: uppercase; letter-spacing: .5pt; }
    .run b { color: #15171a; } .run .rs { margin-left: auto; } .run img { max-height: 11pt; max-width: 60pt; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 6.9pt; text-transform: uppercase; letter-spacing: .4pt; color: #555; border-bottom: 1pt solid #15171a; padding: 3pt 4pt; white-space: nowrap; }
    td { border-bottom: .5pt solid #dadce0; padding: 3pt 4pt; vertical-align: top; }
    thead { display: table-header-group; } tr { break-inside: avoid; }
    td.m { font-family: Menlo, Consolas, monospace; font-size: 7.6pt; white-space: nowrap; } .r { text-align: right; }
    td.n { color: #999; width: 14pt; font-size: 7pt; }
    .small, td.small { font-size: 7pt; } small { color: #666; font-size: 6.9pt; }
    .w { color: #b86e00; } .bad { color: #c8102e; font-weight: 600; }
    tr.grp td { background: #f1f3f6; font-weight: 700; font-size: 7.3pt; text-transform: uppercase; letter-spacing: .4pt; border-bottom: .8pt solid #c4c7cd; padding-top: 3.5pt; }
    tr.totr td { border-top: 1pt solid #15171a; }
    .tot { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5pt; margin: 2pt 0 6pt; }
    .tot div { border: 1pt solid #15171a; border-radius: 4pt; padding: 5pt 7pt; } .tot b { display: block; font-size: 14pt; line-height: 1.12; }
    .tot span { font-size: 6.6pt; text-transform: uppercase; color: #555; letter-spacing: .4pt; }
    .sumg { display: grid; grid-template-columns: 1.5fr 1fr; gap: 16pt; } .sumg.one { grid-template-columns: 1fr; }
    .side .toc div { display: flex; gap: 6pt; padding: 2.5pt 0; border-bottom: .5pt dotted #bbb; font-size: 8.4pt; } .side .toc div span:first-child { color: #999; width: 12pt; }
    .warn { border: 1pt solid #e7b54a; background: #fff8e8; border-radius: 5pt; padding: 6pt 8pt; font-size: 8pt; } .warn ul { margin: 0; padding-left: 12pt; } .warn li { margin: 2pt 0; } .warn li.lv-bad { color: #8a0b20; }
    .okbox { border: 1pt solid #9ad3b4; background: #f0faf4; border-radius: 5pt; padding: 6pt 8pt; font-size: 8pt; color: #1d6b43; }
    .lines { display: grid; grid-template-columns: 1fr 1fr; gap: 8pt; margin-top: 7pt; }
    .lines .sub { margin: 0; padding: 5pt 7pt; border-left: 2.5pt solid #4f8bff; background: #f3f5f8; } .lines .sub.pw { border-left-color: #e0a100; }
    .comp { margin-top: 6pt; text-align: center; } .comp img { max-width: 100%; max-height: 92mm; border: .5pt solid #999; background: #000; }
    .note { margin-top: 7pt; color: #777; font-size: 7.2pt; } .note.c { margin-top: 2pt; }
    .callout { margin: 6pt 0; padding: 5pt 8pt; border-left: 3pt solid #2f9e6b; background: #f2f8f5; font-size: 8.2pt; }
    .callout.bad { border-left-color: #c8102e; background: #fcf1f2; color: #8a0b20; }
    .phases { display: grid; gap: 4pt; margin: 6pt 0; }
    .ph { display: grid; grid-template-columns: 30pt 1fr 150pt; gap: 8pt; align-items: center; font-size: 8pt; }
    .ph i { display: block; height: 7pt; background: #e9ebef; border-radius: 2pt; overflow: hidden; } .ph u { display: block; height: 100%; background: #e0a100; }
    .ph b { font: 500 7.6pt Menlo, Consolas, monospace; text-align: right; }
    .chip { font-size: 7.4pt; letter-spacing: .5pt; padding: 2pt 6pt; border-radius: 3pt; color: #fff; background: #555; text-transform: uppercase; }
    .chip.data { background: #2f6fe0; } .chip.power { background: #c98a00; } .chip.map { background: #15171a; }
    .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16pt; align-items: start; }
    .lay { display: grid; gap: 10pt; } .out.side .lay { grid-template-columns: 1.55fr 1fr; align-items: start; } .out.wide .lay { grid-template-columns: 1fr; }
    .pic { text-align: center; } .pic img { max-width: 100%; max-height: 165mm; border: .5pt solid #999; background: #000; display: block; margin: 0 auto; }
    .mini { font-size: 7.8pt; margin-bottom: 4pt; color: #333; }
    table.c td, table.c th { padding: 2.2pt 3pt; } table.c td.m { font-size: 7.2pt; }
    table.c.dense td, table.c.dense th { padding: 1.4pt 3pt; } table.c.dense td, table.c.dense td.m { font-size: 6.6pt; }
    table.c.dense2 td, table.c.dense2 th { padding: .9pt 2.5pt; } table.c.dense2 td, table.c.dense2 td.m, table.c.dense2 small { font-size: 6pt; } table.c.dense2 tr.grp td { font-size: 6.2pt; padding-top: 1.5pt; }
    @media screen {
      html { background: #3a3e45; } body { padding: 18px 0; }
      .pg { width: ${fmtCss[1]}; min-height: ${fmtCss[2]}; margin: 0 auto 18px; background: #fff; padding: 10mm 11mm 13mm; box-shadow: 0 6px 24px rgba(0,0,0,.45); position: relative; }
      .pg.cover-img { height: ${fmtCss[2]}; min-height: 0; padding: 0; border-radius: 0; }
    }
  </style></head><body>${sections.join('')}</body></html>`;
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
