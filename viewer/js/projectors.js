// Pixel2Pixel — video projectors: library, optics and the multi-projector blend planner.
// Pure maths (no three.js): the 3D view, the inspector and the wizard share these functions.
//
// Optics conventions
//   throw ratio tr = distance / image width (perpendicular, at the image plane)
//   lens shift shiftH / shiftV (stored) = image centre offset in % of the FULL image width / height (+ = right / up),
//     in the projector's own frame (lens mount). Manufacturers differ: Panasonic / Epson express shift against the full
//     image (100 % = one image), Barco against half the image ("100 % shift = centre moved by half the screen size").
//     The library and the inspector convert: shiftConv 'full' | 'half' only changes how values are entered / shown.
//   a projector looks along its local −Z (Euler YXZ like screens): same rotation as a screen = facing it
import * as M from './model.js';
import * as LIB from './projlib.js';

/**
 * Library = projector models + a shared lens catalogue (one lens fits several models of a brand). Each model lists its
 * lenses with the throw ratios published FOR THAT MODEL; joined here into model.lenses = [{ id, name, partNos, trMin,
 * trMax, shiftV, shiftH, … }]. Older single-list libraries (PROJECTOR_LIBRARY) are still accepted.
 */
function buildLibrary(models = LIB.PROJECTOR_MODELS, catalog = LIB.LENS_CATALOG) {
  if (!models) return LIB.PROJECTOR_LIBRARY || [];
  const cat = new Map((catalog || []).map((l) => [l.id, l]));
  return models.map((m) => ({
    ...m,
    lenses: (m.lenses || []).map((r) => {
      const l = cat.get(r.lens) || {};
      const o = { id: r.lens, name: l.name || r.lens, partNos: l.partNos || [], family: l.family || '', fixed: !!l.fixed, notes: l.notes || '', aliases: l.aliases || [],
        trMin: +r.trMin, trMax: r.trMax != null ? +r.trMax : +r.trMin };
      if (Array.isArray(r.shiftV)) o.shiftV = r.shiftV;
      if (Array.isArray(r.shiftH)) o.shiftH = r.shiftH;
      return o;
    })
  }));
}
export const PROJECTOR_LIBRARY = buildLibrary();
export const LENS_CATALOG = (LIB.LENS_CATALOG || []).slice();
const finishLibrary = () => { for (const m of PROJECTOR_LIBRARY) m.shiftConv = m.shiftConv || (m.brand === 'Barco' ? 'half' : 'full'); };
let dbSource = null;
/**
 * Replace the projector / lens library in place (every importer keeps the same arrays) by the shared database
 * { models, lenses } in the stored format (models[].lenses = [{ lens, trMin, trMax, shiftV?, shiftH? }]); null = built-in.
 */
export function setDatabase(db) {
  const ok = db && Array.isArray(db.models) && db.models.length && Array.isArray(db.lenses);
  const lib = ok ? buildLibrary(db.models, db.lenses) : buildLibrary();
  PROJECTOR_LIBRARY.length = 0; PROJECTOR_LIBRARY.push(...lib);
  LENS_CATALOG.length = 0; LENS_CATALOG.push(...(ok ? db.lenses : LIB.LENS_CATALOG || []));
  dbSource = ok ? db : null;
  finishLibrary();
}
export const databaseActive = () => !!dbSource;
/** Built-in data in the stored format (template of the shared workbook, fallback of a missing tab). */
export const builtInProjectors = () => ({ models: LIB.PROJECTOR_MODELS || [], lenses: LIB.LENS_CATALOG || [] });
// manufacturer shift convention (Barco: % of half the image, documented in its manuals; others: % of the full image)
finishLibrary();   // null in the data = not stated by the maker: Barco half, others full (flagged in notes)
export const shiftConvOf = (pj) => pj.shiftConv || 'full';
export const shiftShow = (v, conv) => (conv === 'half' ? v * 2 : v);
export const shiftStore = (v, conv) => (conv === 'half' ? v / 2 : v);
const convRange = (r, conv) => (Array.isArray(r) ? (conv === 'half' ? [r[0] / 2, r[1] / 2] : [r[0], r[1]]) : null);
/** Shift ranges (stored convention) of a lens on a model; generic ±50 % V / ±30 % H when the maker publishes none. */
export function shiftRanges(lib, lens) {
  const conv = lib ? lib.shiftConv : 'full';
  return { V: convRange(lens && lens.shiftV, conv) || convRange(lib && lib.shiftV, conv) || [-50, 50], H: convRange(lens && lens.shiftH, conv) || convRange(lib && lib.shiftH, conv) || [-30, 30],
    published: !!((lens && (lens.shiftV || lens.shiftH)) || (lib && (lib.shiftV || lib.shiftH))), conv };
}
/** Zoom position in % of the lens range (0 = widest = shortest throw). */
export const zoomPct = (pj) => (pj.trMax > pj.trMin ? (pj.tr - pj.trMin) / (pj.trMax - pj.trMin) * 100 : 0);
export const libModel = (id) => (id ? PROJECTOR_LIBRARY.find((m) => m.id === id || (m.aliases || []).includes(id)) || null : null);
export const libLens = (model, id) => (id ? (model && model.lenses || []).find((l) => l.id === id || (l.aliases || []).includes(id)) || null : null);

/** Local axes of a projector: right, up, fwd (viewing direction, = −local Z). */
export function projAxes(pj) {
  const a = M.stageAxes(pj);
  const r = a.right, u = a.up;
  const z = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
  return { right: r, up: u, fwd: [-z[0], -z[1], -z[2]], back: z };
}

/** Frustum per unit of depth: { l, r, b, t } (image plane at depth 1), aspect, centre offsets. */
export function frustum(pj) {
  const tr = Math.max(0.05, +pj.tr || 1);
  const aspect = (pj.resW || 16) / (pj.resH || 9);
  const hw = 1 / (2 * tr), hh = hw / aspect;
  const cx = (+pj.shiftH || 0) / 100 * (1 / tr), cy = (+pj.shiftV || 0) / 100 * (1 / tr) / aspect;
  return { l: cx - hw, r: cx + hw, b: cy - hh, t: cy + hh, cx, cy, aspect, tr };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Direction of the image centre (lens shift included). */
export function centreRay(pj) {
  const ax = projAxes(pj), f = frustum(pj);
  return { o: [pj.x, pj.y, pj.z], d: norm(add(add(ax.fwd, ax.right, f.cx), ax.up, f.cy)), ax, f };
}

/**
 * Nearest flat projection screen hit by the image centre: { s, t (distance along the ray), depth (along the axis),
 * cosI (incidence) } or null. Curved screens are approximated by their chord plane.
 */
export function hitScreen(p, pj) {
  const { o, d, ax } = centreRay(pj);
  let best = null;
  for (const s of p.surfaces) {
    if (s.kind !== 'proj' || !s.stage.placed || s.visible === false || s.stage.rail) continue;
    const sa = M.stageAxes(s.stage);
    const n = [sa.right[1] * sa.up[2] - sa.right[2] * sa.up[1], sa.right[2] * sa.up[0] - sa.right[0] * sa.up[2], sa.right[0] * sa.up[1] - sa.right[1] * sa.up[0]];
    const den = dot(d, n);
    if (Math.abs(den) < 1e-6) continue;
    const c = [s.stage.x, s.stage.y, s.stage.z];
    const t = dot([c[0] - o[0], c[1] - o[1], c[2] - o[2]], n) / den;
    if (t <= 0.05) continue;
    const q = add(o, d, t), rel = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
    const m = M.surfaceMeters(p, s);
    if (Math.abs(dot(rel, sa.right)) > m.w / 2 + 1e-3 || Math.abs(dot(rel, sa.up)) > m.h / 2 + 1e-3) continue;
    if (!best || t < best.t) best = { s, t, depth: t * dot(d, ax.fwd), cosI: Math.abs(den) };
  }
  return best;
}

/** Image size, brightness and pixel size at a given axial depth (m). */
export function imageAt(pj, depth, { gain = 1, cosI = 1, axial = 1 } = {}) {
  const f = frustum(pj);
  const W = depth / f.tr, H = W / f.aspect;
  const lm = (+pj.lumens || 0) * Math.max(1, +pj.stack || 1);
  const lux = W > 0 && H > 0 ? lm / (W * H) * cosI / Math.max(0.2, axial) : 0;
  return { W, H, lux, nits: lux * gain / Math.PI, pxmm: W / (pj.resW || 1) * 1000, dist: depth };
}

/** Full report for the inspector: hit screen + image + throw check against the lens range. */
export function report(p, pj) {
  const hit = hitScreen(p, pj);
  const { d, ax } = centreRay(pj);
  const r = { hit, trOk: (+pj.tr >= (+pj.trMin || 0) - 1e-6) && (+pj.tr <= (+pj.trMax || 99) + 1e-6) };
  if (hit) Object.assign(r, imageAt(pj, hit.depth, { gain: hit.s.gain || 1, cosI: hit.cosI, axial: dot(d, ax.fwd) }), { dist: hit.t });
  return r;
}

/** Throw ratio a lens needs to fill width W (m) from distance D (m), and the library lenses that can do it. */
export function throwFor(D, W) { return W > 0 ? D / W : 0; }
export function lensesFor(model, tr) { return (model && model.lenses || []).filter((l) => tr >= l.trMin - 1e-6 && tr <= (l.trMax || l.trMin) + 1e-6); }

/**
 * Blend plan for cols × rows projectors filling a screen of physW × physH metres, pixel for pixel (no scaling).
 * overlap / overlapV = fraction of the projector width / height shared with the neighbour.
 * Returns the screen content size, overlaps (px), each cell's slice and its 3D offset, plus optics (image size, distance, lux).
 */
export function planBlend(o) {
  const cols = Math.max(1, Math.round(o.cols || 1)), rows = Math.max(1, Math.round(o.rows || 1));
  const resW = Math.max(16, Math.round(o.resW)), resH = Math.max(16, Math.round(o.resH));
  const ox = cols > 1 ? Math.round(resW * M.clamp(+o.overlap || 0, 0, 0.5)) : 0;
  const oy = rows > 1 ? Math.round(resH * M.clamp(o.overlapV != null ? +o.overlapV : (+o.overlap || 0), 0, 0.5)) : 0;
  const physW = Math.max(0.1, +o.physW || 1), physH = Math.max(0.1, +o.physH || 1);
  const W = cols * resW - (cols - 1) * ox;                 // content width = covered width
  const H = Math.max(1, Math.round(W * physH / physW));    // screen content height (square pixels)
  const Hc = rows * resH - (rows - 1) * oy;               // covered height
  const offY = Math.round((Hc - H) / 2);                   // > 0: image spills above / below the screen, < 0: not covered
  const mx = physW / W;                                    // metres per pixel on the screen
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = c * (resW - ox), y0 = r * (resH - oy) - offY;   // raster origin in screen px
    const sy0 = Math.max(0, y0), sy1 = Math.min(H, y0 + resH);
    if (sy1 <= sy0) continue;
    cells.push({
      c, r, src: { x: x0, y: sy0, w: resW, h: sy1 - sy0 }, out: { x: 0, y: sy0 - y0 },
      blend: { l: c > 0 ? ox : 0, r: c < cols - 1 ? ox : 0, t: r > 0 && y0 >= 0 ? oy : 0, b: r < rows - 1 && y0 + resH <= H ? oy : 0 },
      dx: (x0 + resW / 2 - W / 2) * mx, dy: -(y0 + resH / 2 - H / 2) * mx
    });
  }
  const imgW = resW * mx, imgH = resH * mx;
  const tr = o.tr > 0 ? +o.tr : (o.dist > 0 ? o.dist / imgW : 1.5);
  const dist = tr * imgW;
  const lm = (+o.lumens || 0) * Math.max(1, +o.stack || 1);
  // overlaps receive two (four in corners) projectors: report the single-projector level, the blend evens it out
  const lux = lm / (imgW * imgH);
  return { cols, rows, resW, resH, ox, oy, W, H, Hc, offY, mx, imgW, imgH, tr, dist, lux, nits: lux * (+o.gain || 1) / Math.PI, cells, physW, physH,
    underCover: offY < 0, spillPx: Math.max(0, offY) };
}

/**
 * Apply a blend plan to the project: projection screen size, one output + one projector per cell, slices with soft edges,
 * projectors placed in front of the screen (screen placed at the origin if it was not in 3D yet). Previous projectors /
 * outputs generated for this screen are replaced. Returns the created projector ids.
 */
export function applyBlend(p, surfaceId, plan, o) {
  const s = M.getSurface(p, surfaceId);
  if (!s) return [];
  s.kind = 'proj'; s.phys = { w: plan.physW, h: plan.physH }; s.w = plan.W; s.h = plan.H; s.wholeTiles = false; s.panel = null; s.pitch = 0;
  s.gain = +o.gain || 1;
  const cell = Math.max(32, Math.round(plan.resW / 8));
  s.tile = { mode: 'px', tw: cell, th: cell, cols: 1, rows: 1 };
  if (!s.stage.placed) s.stage = { ...s.stage, placed: true, x: 0, y: Math.round((plan.physH / 2 + (+o.base || 0.5)) * 1000) / 1000, z: 0, rx: 0, ry: 0, rz: 0, rail: '' };
  // remove what a previous run generated for this screen
  const old = p.projectors.filter((x) => x.surf === surfaceId);
  const oldOuts = new Set(old.map((x) => x.out).filter(Boolean));
  p.projectors = p.projectors.filter((x) => x.surf !== surfaceId);
  p.slices = p.slices.filter((sl) => sl.surfaceId !== surfaceId);
  for (const id of oldOuts) if (!p.slices.some((sl) => sl.out === id)) p.outputs = p.outputs.filter((x) => x.id !== id);
  const lib = libModel(o.lib), lens = libLens(lib, o.lens);
  const sa = M.stageAxes(s.stage);
  const n = [sa.right[1] * sa.up[2] - sa.right[2] * sa.up[1], sa.right[2] * sa.up[0] - sa.right[0] * sa.up[2], sa.right[0] * sa.up[1] - sa.right[1] * sa.up[0]];
  const base = (o.prefix || 'PROJ').trim() || 'PROJ';
  const startN = p.projectors.length + 1;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const ids = [];
  plan.cells.forEach((cl, i) => {
    const name = `${base} ${startN + i}`;
    const out = M.newOutput({ name, w: plan.resW, h: plan.resH, proj: true });
    p.outputs.push(out);
    p.slices.push(M.newSlice(s, out.id, { src: cl.src, x: cl.out.x, y: cl.out.y, blend: cl.blend }));
    const sv = +o.shiftV || 0;
    const dy = cl.dy - sv / 100 * plan.imgH;              // lens shift up = projector lower, image unchanged
    const pos = [s.stage.x + sa.right[0] * cl.dx + sa.up[0] * dy + n[0] * plan.dist, s.stage.y + sa.right[1] * cl.dx + sa.up[1] * dy + n[1] * plan.dist, s.stage.z + sa.right[2] * cl.dx + sa.up[2] * dy + n[2] * plan.dist];
    const pj = M.newProjector({
      name, surf: surfaceId, out: out.id, lib: lib ? lib.id : '', brand: lib ? lib.brand : '', model: lib ? lib.model : (o.modelName || ''),
      resW: plan.resW, resH: plan.resH, lumens: +o.lumens || (lib && lib.lumens) || 0, stack: Math.max(1, +o.stack || 1),
      lens: lens ? lens.id : '', trMin: lens ? lens.trMin : plan.tr, trMax: lens ? (lens.trMax || lens.trMin) : plan.tr, tr: r3(plan.tr),
      shiftH: 0, shiftV: sv, shiftRangeH: shiftRanges(lib, lens).H, shiftRangeV: shiftRanges(lib, lens).V, shiftConv: lib ? lib.shiftConv : 'full',
      x: r3(pos[0]), y: r3(pos[1]), z: r3(pos[2]), rx: s.stage.rx || 0, ry: s.stage.ry || 0, rz: s.stage.rz || 0,
      kg: (lib && lib.kg) || 0, watts: (lib && lib.watts) || 0, color: PROJ_COLORS[i % PROJ_COLORS.length]
    });
    p.projectors.push(pj);
    ids.push(pj.id);
  });
  return ids;
}

export const PROJ_COLORS = ['#4F8BFF', '#FFB020', '#2EE6A8', '#FF5DA2', '#B98CFF', '#5FD3FF', '#FF7A45', '#C6F432'];

/** Projector from a library model (+ lens), at a position. */
export function projectorFrom(libId, lensId, props = {}) {
  const lib = libModel(libId), lens = libLens(lib, lensId) || (lib && lib.lenses && lib.lenses[0]) || null;
  const trMin = lens ? lens.trMin : 1.2, trMax = lens ? (lens.trMax || lens.trMin) : 2.4;
  return M.newProjector({
    lib: lib ? lib.id : '', brand: lib ? lib.brand : '', model: lib ? lib.model : '',
    resW: lib ? lib.resW : 1920, resH: lib ? lib.resH : 1200, lumens: lib ? lib.lumens : 10000,
    lens: lens ? lens.id : '', trMin, trMax, tr: Math.round((trMin + trMax) / 2 * 100) / 100,
    shiftRangeH: shiftRanges(lib, lens).H, shiftRangeV: shiftRanges(lib, lens).V, shiftConv: lib ? lib.shiftConv : 'full',
    kg: (lib && lib.kg) || 0, watts: (lib && lib.watts) || 0, ...props
  });
}

/** Change model / lens of an existing projector, keeping its place; throw ratio clamped into the new lens range. */
export function setModel(pj, libId, lensId) {
  const lib = libModel(libId);
  if (!lib) { pj.lib = ''; return; }
  const lens = libLens(lib, lensId) || lib.lenses.find((l) => pj.tr >= l.trMin && pj.tr <= (l.trMax || l.trMin)) || lib.lenses[0] || null;
  Object.assign(pj, { lib: lib.id, brand: lib.brand, model: lib.model, resW: lib.resW, resH: lib.resH, lumens: lib.lumens, kg: lib.kg || 0, watts: lib.watts || 0 });
  setLens(pj, lib, lens);
}
export function setLens(pj, lib, lens) {
  if (!lens) { pj.lens = ''; return; }
  pj.lens = lens.id; pj.trMin = lens.trMin; pj.trMax = lens.trMax || lens.trMin;
  pj.tr = Math.round(M.clamp(pj.tr, pj.trMin, pj.trMax) * 1000) / 1000;
  const sr = shiftRanges(lib, lens);
  pj.shiftRangeH = sr.H; pj.shiftRangeV = sr.V; pj.shiftConv = lib.shiftConv;
  pj.shiftH = M.clamp(pj.shiftH, pj.shiftRangeH[0], pj.shiftRangeH[1]); pj.shiftV = M.clamp(pj.shiftV, pj.shiftRangeV[0], pj.shiftRangeV[1]);
}


// ==================================================================== precise geometry on a flat screen
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function screenFrame(p, s) {
  const sa = M.stageAxes(s.stage);
  return { c: [s.stage.x, s.stage.y, s.stage.z], r: sa.right, u: sa.up, n: cross(sa.right, sa.up), m: M.surfaceMeters(p, s) };
}
/** Ray (per unit depth offsets x, y in the image plane) ∩ screen plane → { u, v (m from the screen centre), t, q }. */
function rayOnScreen(pj, ax, F, x, y) {
  const d = add(add(ax.fwd, ax.right, x), ax.up, y);
  const den = dot(d, F.n);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(sub(F.c, [pj.x, pj.y, pj.z]), F.n) / den;
  if (t <= 0) return null;
  const q = add([pj.x, pj.y, pj.z], d, t), rel = sub(q, F.c);
  return { u: dot(rel, F.r), v: dot(rel, F.u), q, t, d };
}

/**
 * Exact image footprint of a projector on a flat screen (curved screens: chord plane): the 4 corners and the centre in
 * screen coordinates (m, from the screen centre, + = right / up), edge overshoot against the screen, keystone, pixel size
 * and illuminance at the centre and the corners. Null when the image does not reach the screen plane.
 */
export function footprint(p, pj, s) {
  const ax = projAxes(pj), f = frustum(pj), F = screenFrame(p, s);
  const pts = { tl: [f.l, f.t], tr: [f.r, f.t], br: [f.r, f.b], bl: [f.l, f.b], c: [f.cx, f.cy] };
  const out = {};
  for (const [k, [x, y]] of Object.entries(pts)) { const h = rayOnScreen(pj, ax, F, x, y); if (!h) return null; out[k] = h; }
  const pxStep = (f.r - f.l) / (pj.resW || 1);
  const lm = (+pj.lumens || 0) * Math.max(1, +pj.stack || 1);
  const A1 = (f.r - f.l) * (f.t - f.b);                       // image area at depth 1
  const at = (k) => {
    const [x, y] = pts[k], h = out[k];
    const h2 = rayOnScreen(pj, ax, F, x + (k === 'tr' || k === 'br' ? -pxStep : pxStep), y);
    const px = h2 ? Math.hypot(h2.u - h.u, h2.v - h.v) * 1000 : 0;
    const z = h.t * dot(h.d, ax.fwd);                           // axial depth (d is not normalised: t·d·fwd)
    const dist = h.t * Math.hypot(h.d[0], h.d[1], h.d[2]);
    const cosT = z / dist;
    const L = norm(sub([pj.x, pj.y, pj.z], h.q));
    const cosI = Math.abs(dot(L, F.n));
    const lux = lm / (A1 * z * z) * cosI / Math.max(1e-3, cosT);
    return { px, lux, nits: lux * (s.gain || 1) / Math.PI, dist };
  };
  const pc = {}; for (const k of Object.keys(pts)) pc[k] = at(k);
  const W2 = F.m.w / 2, H2 = F.m.h / 2;
  const us = ['tl', 'tr', 'br', 'bl'].map((k) => out[k].u), vs = ['tl', 'tr', 'br', 'bl'].map((k) => out[k].v);
  const topW = Math.hypot(out.tr.u - out.tl.u, out.tr.v - out.tl.v), botW = Math.hypot(out.br.u - out.bl.u, out.br.v - out.bl.v);
  const leftH = Math.hypot(out.tl.u - out.bl.u, out.tl.v - out.bl.v), rightH = Math.hypot(out.tr.u - out.br.u, out.tr.v - out.br.v);
  const luxes = ['tl', 'tr', 'br', 'bl', 'c'].map((k) => pc[k].lux);
  return {
    s, corners: out, centre: out.c, per: pc,
    // overshoot (> 0) or gap (< 0) of the image beyond each screen edge, in metres (worst corner)
    over: { l: -W2 - Math.min(...us), r: Math.max(...us) - W2, t: Math.max(...vs) - H2, b: -H2 - Math.min(...vs) },
    size: { topW, botW, leftH, rightH, w: (topW + botW) / 2, h: (leftH + rightH) / 2 },
    keyH: (topW - botW) / Math.max(topW, botW) * 100,       // + = wider at the top
    keyV: (rightH - leftH) / Math.max(rightH, leftH) * 100,   // + = taller on the right
    pxMin: Math.min(...['tl', 'tr', 'br', 'bl', 'c'].map((k) => pc[k].px)), pxMax: Math.max(...['tl', 'tr', 'br', 'bl', 'c'].map((k) => pc[k].px)),
    uniformity: Math.min(...luxes) / Math.max(...luxes) * 100,
    distAxis: out.c.t * dot(out.c.d, ax.fwd)
  };
}

/**
 * Inverse calculation ("caler l'image"): image of width W (m) centred at (cu, cv) on the screen, projector square to the
 * screen (same rotation; +180° roll when ceiling-mounted). Modes:
 *   'position'    keep where the projector is → zoom (throw ratio) + lens shift
 *   'zoom'        keep zoom and lens shift → projector position
 *   'zoomHeight'  keep zoom, lens shift H and rigging height (world Y) → distance + vertical shift
 * Returns the new values (stored conventions) and range checks; never edits the project.
 */
export function solveFit(p, pj, s, { W, cu = 0, cv = 0, mode = 'position' } = {}) {
  const F = screenFrame(p, s);
  const aspect = (pj.resW || 16) / (pj.resH || 9);
  const H = W / aspect;
  const ceil = !!pj.ceiling;
  const sg = ceil ? -1 : 1;                                   // body frame vs screen frame (180° roll)
  const rot = { rx: s.stage.rx || 0, ry: s.stage.ry || 0, rz: ((s.stage.rz || 0) + (ceil ? 180 : 0) + 540) % 360 - 180 };
  const P = [pj.x, pj.y, pj.z], rel = sub(P, F.c);
  let pu = dot(rel, F.r), pv = dot(rel, F.u), pz = dot(rel, F.n);
  let tr = pj.tr, sh = sg * (pj.shiftH || 0), sv = sg * (pj.shiftV || 0);   // shifts in the screen frame
  if (mode === 'position') {
    if (pz <= 0.01) return { error: 'behind' };
    tr = pz / W; sh = (cu - pu) / W * 100; sv = (cv - pv) / H * 100;
  } else if (mode === 'zoom') {
    pz = tr * W; pu = cu - sh / 100 * W; pv = cv - sv / 100 * H;
  } else {
    // world height fixed: solve along the screen normal / up (works for any screen tilt that keeps up·Y ≠ 0)
    pz = tr * W; pu = cu - sh / 100 * W;
    const base = add(add(F.c, F.r, pu), F.n, pz);          // projector with pv = 0
    if (Math.abs(F.u[1]) < 1e-6) return { error: 'flat' };
    pv = (pj.y - base[1]) / F.u[1];
    sv = (cv - pv) / H * 100;
  }
  const pos = add(add(add(F.c, F.r, pu), F.u, pv), F.n, pz);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const res = { tr: r6(tr), shiftH: r6(sg * sh), shiftV: r6(sg * sv), x: r6(pos[0]), y: r6(pos[1]), z: r6(pos[2]), ...rot, dist: pz, W, H };
  const lib = libModel(pj.lib);
  res.trOk = tr >= (pj.trMin || 0) - 1e-9 && tr <= (pj.trMax || 99) + 1e-9;
  res.svOk = res.shiftV >= pj.shiftRangeV[0] - 1e-9 && res.shiftV <= pj.shiftRangeV[1] + 1e-9;
  res.shOk = res.shiftH >= pj.shiftRangeH[0] - 1e-9 && res.shiftH <= pj.shiftRangeH[1] + 1e-9;
  res.lenses = lib ? lensesFor(lib, tr).map((l) => {
    const r = shiftRanges(lib, l);
    return { id: l.id, name: l.name, shiftOk: res.shiftV >= r.V[0] && res.shiftV <= r.V[1] && res.shiftH >= r.H[0] && res.shiftH <= r.H[1] };
  }) : [];
  return res;
}

// ==================================================================== lens finder
/**
 * Lenses able to put an image on a screen of sW × sH metres from distance D (m, lens front → screen, square to it).
 * fit: 'width' | 'height' | 'cover' (overfill both) | 'contain' (whole image inside the screen).
 * offV / offH: lens position relative to the screen centre (m, + = above / right) → lens shift the image needs.
 * Returns one entry per model (image size, needed throw ratio, brightness) with its fitting lenses, plus the nearest
 * lenses when none fits (and the distance they would need).
 */
export function findLenses({ sW, sH, D, fit = 'width', offV = 0, offH = 0, gain = 1, models = PROJECTOR_LIBRARY, custom = null }) {
  const out = [];
  const list = custom ? [custom, ...models] : models;
  for (const m of list) {
    const aspect = m.resW / m.resH;
    const W = fit === 'height' ? sH * aspect : fit === 'cover' ? Math.max(sW, sH * aspect) : fit === 'contain' ? Math.min(sW, sH * aspect) : sW;
    const H = W / aspect;
    const tr = D / W;
    // image centre = screen centre: the shift moves it from the lens axis by −off
    const shV = -offV / H * 100, shH = -offH / W * 100;           // stored convention (% of the full image)
    const lux = m.lumens / (W * H);
    const lenses = (m.lenses || []).map((l) => {
      const trMax = l.trMax || l.trMin;
      const r = shiftRanges(m, l);
      const inZoom = tr >= l.trMin - 1e-9 && tr <= trMax + 1e-9;
      const shiftOk = shV >= r.V[0] - 1e-9 && shV <= r.V[1] + 1e-9 && shH >= r.H[0] - 1e-9 && shH <= r.H[1] + 1e-9;
      return { lens: l, inZoom, shiftOk, shiftKnown: r.published, zoom: trMax > l.trMin ? (tr - l.trMin) / (trMax - l.trMin) * 100 : null,
        dMin: l.trMin * W, dMax: trMax * W, gap: inZoom ? 0 : (tr < l.trMin ? l.trMin - tr : tr - trMax), rangeV: r.V, rangeH: r.H };
    });
    const fits = lenses.filter((x) => x.inZoom);
    const near = fits.length ? [] : lenses.slice().sort((a, b) => a.gap - b.gap).slice(0, 2);
    out.push({ model: m, W, H, tr, shV, shH, conv: m.shiftConv || 'full', lux, nits: lux * gain / Math.PI, pxmm: W / m.resW * 1000, fits, near });
  }
  return out;
}

/** Projects saved with an older library: model / lens ids → current ids (aliases), lens kept as is when unknown. */
export function migrateLibraryRefs(p) {
  for (const pj of p.projectors || []) {
    const m = libModel(pj.lib);
    if (!m) continue;
    pj.lib = m.id;
    const l = libLens(m, pj.lens);
    if (l) pj.lens = l.id;
  }
}
