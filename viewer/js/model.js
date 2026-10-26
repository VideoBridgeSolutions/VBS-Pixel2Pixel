// Pixel2Pixel — data model, presets, helpers
// Shared by the editor and the live output windows.

export const APP_VERSION = '1.49.3';
export const FILE_FORMAT = 1;

// ------------------------------------------------------------------ colour presets
// 3 shades per family (light / mid / dark) — same families as the DVizion LED Parameters template.
export const COLOR_PRESETS = {
  Red:        ['#FF1A1A', '#B80000', '#6B0F0F'],
  Brown:      ['#C8783C', '#8A4A1E', '#4A2810'],
  Orange:     ['#FFA200', '#FF6A00', '#A33E00'],
  Yellow:     ['#FFF200', '#FFC400', '#A88200'],
  Lime:       ['#C8FF00', '#7FE000', '#3F7A00'],
  Green:      ['#00FF3C', '#00B82B', '#005E16'],
  Aquamarine: ['#4DFFC3', '#00C48F', '#00684B'],
  Teal:       ['#00C4B4', '#008C80', '#004A44'],
  Cyan:       ['#00FFFF', '#00A8FF', '#005E8C'],
  Blue:       ['#2E7BFF', '#0019FF', '#000C80'],
  Purple:     ['#B24DFF', '#8300FF', '#3E0080'],
  Pink:       ['#FF00CE', '#C2009C', '#66004F'],
  Salmon:     ['#FF8C7A', '#E8503C', '#8C2618'],
  RGB:        ['#FF0000', '#00FF00', '#0000FF'],
  Grey:       ['#BFBFBF', '#7F7F7F', '#3A3A3A'],
  Custom:     null
};
export const PRESET_NAMES = Object.keys(COLOR_PRESETS);

export const PATTERNS = ['checker', 'checker3', 'rows', 'cols', 'compgrad', 'soft', 'tone', 'outline', 'gradient', 'solid', 'bars', 'grayramp'];
/** Patterns that read the project-wide composition gradient (bitmap depends on the surface position). */
export const COMP_PATTERNS = ['compgrad'];

// ------------------------------------------------------------------ composition gradient (spans several screens)
// Premium palettes: smooth, saturated enough for LED, never garish.
export const GRADIENT_PRESETS = {
  Aurora:      ['#00E0C6', '#2F6BFF', '#9B3DFF'],
  Nocturne:    ['#0E2A6B', '#2F5BD8', '#9CC0FF'],
  Ember:       ['#FF2E3A', '#FF7A1A', '#FFC85C'],
  Sunset:      ['#5B2A86', '#E0457B', '#FFA062'],
  Ultraviolet: ['#2A0C7A', '#7A1FD1', '#F22FA5'],
  Lagoon:      ['#003F6B', '#008FB3', '#3FE0D0'],
  Champagne:   ['#3B2E22', '#B08D57', '#F3E3C3'],
  Silver:      ['#22262D', '#7E8794', '#E8EBEF'],
  RoseGold:    ['#5E2340', '#D0857F', '#F7D9CB'],
  Emerald:     ['#003D2E', '#00A37A', '#B8F5C8'],
  Neon:        ['#FF00CE', '#7A3DFF', '#00F0FF'],
  Spectrum:    ['#FF2D2D', '#FF9F1C', '#F5F52A', '#2BE36B', '#22B5FF', '#8B3DFF']
};
export function newGradient(props = {}) {
  return deepAssign({
    preset: 'Aurora',
    stops: GRADIENT_PRESETS.Aurora.map((c, i, a) => ({ c, p: a.length > 1 ? i / (a.length - 1) : 0 })),
    type: 'linear',          // linear | radial
    angle: 0,                // degrees, 0 = left → right, 90 = top → bottom
    cx: 0.5, cy: 0.5,        // radial centre (fraction of the extent)
    extent: 'surfaces',      // surfaces (bounding box of the visible screens) | comp (whole composition)
    vary: 18,                // ° of hue spread used by "Répartir" (per-screen offsets inside the gradient)
    sym: false               // symmetry: linear gradient mirrored around the middle of the extent (centre → edges)
  }, props);
}
export function gradientFromPreset(name, g = {}) {
  const cols = GRADIENT_PRESETS[name];
  if (!cols) return g;
  return { ...g, preset: name, stops: cols.map((c, i) => ({ c, p: cols.length > 1 ? i / (cols.length - 1) : 0 })) };
}
/** Sorted stops, at least one. */
export function gradStops(g) {
  const st = ((g && g.stops) || []).filter((x) => x && x.c).map((x) => ({ c: x.c, p: clamp(toNum(x.p, 0), 0, 1) })).sort((a, b) => a.p - b.p);
  return st.length ? st : [{ c: '#FFFFFF', p: 0 }];
}
/** Colour of the gradient at t (0..1). */
export function gradColor(g, t, hue = 0) {
  const st = gradStops(g);
  t = clamp(t, 0, 1);
  let c;
  if (t <= st[0].p) c = st[0].c;
  else if (t >= st[st.length - 1].p) c = st[st.length - 1].c;
  else {
    let i = 0; while (i < st.length - 1 && t > st[i + 1].p) i++;
    const a = st[i], b = st[i + 1];
    c = mix(a.c, b.c, b.p > a.p ? (t - a.p) / (b.p - a.p) : 0);
  }
  return hueShift(c, hue);
}
/** Area the composition gradient is stretched over. */
export function gradExtent(p) {
  const g = p.gradient || newGradient();
  if (g.extent === 'comp') return { x: 0, y: 0, w: p.composition.w, h: p.composition.h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of p.surfaces) {
    if (s.visible === false) continue;
    const r = ((s.comp.rot % 360) + 360) % 360, sw = r === 90 || r === 270;
    const w = sw ? s.h : s.w, h = sw ? s.w : s.h;
    x0 = Math.min(x0, s.comp.x); y0 = Math.min(y0, s.comp.y); x1 = Math.max(x1, s.comp.x + w); y1 = Math.max(y1, s.comp.y + h);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: p.composition.w, h: p.composition.h };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
/** Linear gradient line (two comp points) or radial circle covering the extent. */
export function gradGeometry(g, ext) {
  if (g.type === 'radial') {
    const cx = ext.x + ext.w * toNum(g.cx, 0.5), cy = ext.y + ext.h * toNum(g.cy, 0.5);
    const r = Math.max(...[[ext.x, ext.y], [ext.x + ext.w, ext.y], [ext.x, ext.y + ext.h], [ext.x + ext.w, ext.y + ext.h]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
    return { type: 'radial', cx, cy, r: Math.max(1, r) };
  }
  const a = toNum(g.angle, 0) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
  const cx = ext.x + ext.w / 2, cy = ext.y + ext.h / 2;
  const half = (Math.abs(dx) * ext.w + Math.abs(dy) * ext.h) / 2;
  return { type: 'linear', x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}
/** t (0..1) of a composition point (symmetric gradient: 0 in the middle, 1 at both ends). */
export function gradT(geo, x, y, g = null) {
  if (geo.type === 'radial') return Math.hypot(x - geo.cx, y - geo.cy) / geo.r;
  const vx = geo.x1 - geo.x0, vy = geo.y1 - geo.y0, L2 = vx * vx + vy * vy || 1;
  const t = ((x - geo.x0) * vx + (y - geo.y0) * vy) / L2;
  return g && g.sym ? Math.abs(2 * t - 1) : t;
}
/** Stops along the gradient line (a symmetric gradient is mirrored: stop p → (1 − p) / 2 and (1 + p) / 2). */
export function gradLineStops(g) {
  const st = gradStops(g);
  if (!g || !g.sym || g.type === 'radial') return st;
  return [...st.map((x) => ({ c: x.c, p: (1 - x.p) / 2 })), ...st.map((x) => ({ c: x.c, p: (1 + x.p) / 2 }))].sort((a, b) => a.p - b.p);
}
/**
 * Symmetry groups of screens around the middle axis of their bounding box (axis 'v' = vertical axis, left ↔ right;
 * 'h' = horizontal axis, top ↔ bottom). Screens at the same distance from the axis (and the same height / column)
 * share a group. Groups ordered from the axis outwards.
 */
export function symmetryGroups(surfaces, axis = 'v') {
  const items = surfaces.map((s) => { const [x, y] = surfaceToComp(s, s.w / 2, s.h / 2); const r = ((s.comp.rot % 360) + 360) % 360, sw = r === 90 || r === 270; return { s, x, y, w: sw ? s.h : s.w, h: sw ? s.w : s.h }; });
  if (!items.length) return [];
  const minX = Math.min(...items.map((i) => i.x - i.w / 2)), maxX = Math.max(...items.map((i) => i.x + i.w / 2));
  const minY = Math.min(...items.map((i) => i.y - i.h / 2)), maxY = Math.max(...items.map((i) => i.y + i.h / 2));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const tol = Math.max(8, (axis === 'v' ? maxX - minX : maxY - minY) * 0.03);
  const tolO = Math.max(8, (axis === 'v' ? maxY - minY : maxX - minX) * 0.06);
  const groups = [];
  for (const it of items) {
    const d = axis === 'v' ? Math.abs(it.x - cx) : Math.abs(it.y - cy);
    const o = axis === 'v' ? it.y : it.x;                    // position along the axis must match too
    const gp = groups.find((g) => Math.abs(g.d - d) <= tol && Math.abs(g.o - o) <= tolO);
    if (gp) gp.items.push(it.s); else groups.push({ d, o, items: [it.s] });
  }
  return groups.sort((a, b) => a.d - b.d || a.o - b.o).map((g) => g.items);
}
/** Surface pixel (local) → composition pixel (Input Selection placement, rotation / mirror). */
export function surfaceToComp(s, lx, ly) {
  const r = ((s.comp.rot % 360) + 360) % 360, sw = r === 90 || r === 270;
  const bw = sw ? s.h : s.w, bh = sw ? s.w : s.h;
  let x = lx - s.w / 2, y = ly - s.h / 2;
  if (s.comp.flip) x = -x;
  const a = r * Math.PI / 180, ca = Math.round(Math.cos(a) * 1e6) / 1e6, sa = Math.round(Math.sin(a) * 1e6) / 1e6;
  return [s.comp.x + bw / 2 + x * ca - y * sa, s.comp.y + bh / 2 + x * sa + y * ca];
}

// ------------------------------------------------------------------ "looks": coherent style bundles (applied to the project or a selection)
export const STYLE_LOOKS = {
  technical: {},   // = defaultStyle()
  premium: {
    grid: true, gridOpacity: 0.28, gridColor: '#FFFFFF', gridDashed: false, gridWidth: 1, tileX: false,
    diagonals: false, circle: true, circleSize: 0.92, cornerCircles: false, axis: false,
    border: true, borderColor: '#FFFFFF', borderWidth: 2, cornerMarkers: false,
    guideColor: '#FFFFFF', guideOpacity: 0.35, guideDash: 0, guideWidth: 1,
    labelShape: 'rect', fontFamily: 'Avenir Next', textStroke: false, shapeFill: '#000000', shapeOpacity: 0.5, shapeBorder: '#FFFFFF', shapeBorderWidth: 1,
    numbering: 'none'
  },
  minimal: {
    grid: true, gridOpacity: 0.16, gridDashed: false, gridWidth: 1, tileX: false,
    diagonals: false, circle: false, cornerCircles: false, axis: false, border: true, borderWidth: 1, borderColor: '#FFFFFF', cornerMarkers: false,
    labelShape: 'none', showName: true, showSize: true, showPhysical: false, fontFamily: 'Helvetica', textStroke: false, numbering: 'none'
  },
  duotone: {
    grid: true, gridOpacity: 0.22, gridColor: '#FFFFFF', gridDashed: false, gridWidth: 1, tileX: false, tileMarks: 'plus', tileMarkOpacity: 0.45,
    diagonals: false, circle: true, circleSize: 0.85, cornerCircles: false, axis: false, outerCircles: false,
    border: true, borderColor: '#FFFFFF', borderWidth: 2, cornerMarkers: false,
    guideColor: '#FFFFFF', guideOpacity: 0.3, guideDash: 0, guideWidth: 1,
    labelShape: 'rect', fontFamily: 'Avenir Next', textStroke: false, shapeFill: '#000000', shapeOpacity: 0.45, numbering: 'none'
  },
  bright: {
    grid: true, gridOpacity: 0.9, gridColor: '#000000', gridDashed: false, gridWidth: 2, tileX: false, tileMarks: 'cross', tileMarkOpacity: 0.8,
    diagonals: false, circle: true, circleSize: 0.9, cornerCircles: false, axis: true, outerCircles: false,
    border: true, borderColor: '#000000', borderWidth: 3, cornerMarkers: true, cornerMarkerColor: '#000000',
    guideColor: '#000000', guideOpacity: 0.7, guideDash: 0, guideWidth: 1.5,
    labelShape: 'rect', fontFamily: 'Helvetica', textStroke: false, textColor: '#FFFFFF', shapeFill: '#000000', shapeOpacity: 0.85, numbering: 'colrow', numberingOpacity: 0.7
  },
  blueprint: {
    grid: true, gridOpacity: 0.7, gridColor: '#FFFFFF', gridDashed: false, gridWidth: 1, tileX: false,
    diagonals: true, circle: true, circleSize: 0.9, cornerCircles: true, axis: true, border: true, borderColor: '#FFFFFF', borderWidth: 2,
    tileMarks: 'cross', tileMarkOpacity: 0.5, outerCircles: true,
    cornerMarkers: true, cornerMarkerColor: '#FFFFFF', guideColor: '#FFFFFF', guideOpacity: 0.45, guideDash: 6, guideWidth: 1,
    labelShape: 'rect', fontFamily: 'DIN Alternate', textStroke: false, shapeFill: '#000000', shapeOpacity: 0.6, numbering: 'colrow', numberingOpacity: 0.55
  }
};
/** Style keys a look sets (reset to defaults for the technical look). */
export function lookValues(name) {
  const d = defaultStyle();
  if (name === 'technical') {
    const keys = new Set(Object.values(STYLE_LOOKS).flatMap((o) => Object.keys(o)));
    return Object.fromEntries([...keys].map((k) => [k, d[k]]));
  }
  return { ...(STYLE_LOOKS[name] || {}) };
}

// ------------------------------------------------------------------ logos (library + placements)
export const LOGO_POSITIONS = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
export function newLogoSlot(props = {}) {
  return { id: uid('lgs'), logo: '', pos: 'br', size: 0.16, max: 400, opacity: 0.9, margin: 0.035, offY: 0, mono: false, ...props };   // logo '' = first logo of the library
}
/** Live source of a screen: { key: 'ndi:<name>' | 'dev:<id>', mode: 'full' (own source) | 'comp' (its Input Selection of the composition input) } or null. */
export function liveSourceOf(p, s) {
  const src = (s.stage && s.stage.src) || 'auto';
  if (src.startsWith('ndi:') || src.startsWith('dev:')) return { key: src, mode: 'full' };
  const c = p.stage && p.stage.video && p.stage.video.comp;
  if (src === 'auto' && c) return { key: c.startsWith('ndi:') || c.startsWith('dev:') ? c : 'dev:' + c, mode: 'comp' };
  return null;
}
/** NDI source names the project needs (composition input + per-screen sources). */
export function ndiNamesOf(p) {
  const n = new Set();
  for (const s of p.surfaces) { const l = liveSourceOf(p, s); if (l && l.key.startsWith('ndi:')) n.add(l.key.slice(4)); }
  return [...n];
}

/** Per-screen hue offsets inside the composition gradient: neighbours alternate (+/-), amplitude amp (°). */
export function spreadHues(n, amp) {
  const seq = [0, 1, -1, 0.5, -0.5, 0.75, -0.75, 0.25, -0.25];
  return Array.from({ length: n }, (_, i) => Math.round(seq[i % seq.length] * amp));
}
/** Surfaces ordered as read in the composition (rows top → bottom, then left → right). */
export function compReadingOrder(p, surfaces) {
  const c = (s) => { const [x, y] = surfaceToComp(s, s.w / 2, s.h / 2); return { s, x, y, h: Math.min(s.w, s.h) }; };
  const items = surfaces.map(c).sort((a, b) => a.y - b.y);
  const rows = [];
  for (const it of items) { const r = rows.find((rw) => Math.abs(rw.y - it.y) < Math.max(rw.h, it.h) / 2); if (r) r.items.push(it); else rows.push({ y: it.y, h: it.h, items: [it] }); }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x).map((it) => it.s));
}

// ------------------------------------------------------------------ text zones (per screen or for all)
export const TEXT_TOKENS = ['{name}', '{w}', '{h}', '{size}', '{pitch}', '{group}', '{cols}', '{rows}', '{tiles}', '{project}'];
export function newTextSlot(props = {}) {
  return { id: uid('txt'), text: '{name}', pos: 't', size: 0.08, max: 160, color: '#FFFFFF', font: '', bold: true, opacity: 1, offY: 0,
    bg: false, bgColor: '#000000', bgOpacity: 0.55, stroke: false, ...props };
}
/** Text of a zone with its tokens replaced for this screen. */
export function formatSurfaceText(tpl, p, s) {
  const ti = tileInfo(s);
  const virt = (s.virtual || []).length;
  return String(tpl || '')
    .replace(/\{name\}/g, s.name || '')
    .replace(/\{w\}/g, s.w).replace(/\{h\}/g, s.h)
    .replace(/\{size\}/g, physicalSize(s) || '')
    .replace(/\{pitch\}/g, s.pitch ? String(s.pitch).replace('.', ',') + ' mm' : '')
    .replace(/\{group\}/g, s.group || '')
    .replace(/\{cols\}/g, ti.cols).replace(/\{rows\}/g, ti.rows)
    .replace(/\{tiles\}/g, ti.cols * ti.rows - virt)
    .replace(/\{project\}/g, (p && p.name) || '');
}

/** Logo of a slot ('' = first of the library). */
export function slotLogo(p, slot) {
  const L = p.logos || [];
  return slot.logo ? L.find((l) => l.id === slot.logo) : L[0];
}

// ------------------------------------------------------------------ LED processing / panels (editable defaults)
// portPx = max pixels per 1G port at 60 Hz 8-bit (manufacturer nominal values, adjust per show).
/**
 * Processors: pixels one 1G port carries, by frame rate and bit depth, from the makers' data sheets.
 *  nova  : px = 0.95 Gbit/s ÷ (bits per pixel × fps)  — NovaStar MX20 sheet: 24 (8 bit), 48 (10 bit, Armor cards),
 *          32 (10 bit, A10s Pro). 12 bit is not documented on 1G ports: estimated (×1.2 of 10 bit).
 *  scale : px = base × (fps0 / fps) × bits[bitDepth] — Brompton Tessera table (525k 8 / 420k 10 / 350k 12 bit at 60 fps),
 *          Megapixel HELIOS (485k at 50 Hz 12 bit, other depths estimated), Colorlight (650k at 60 Hz 8 bit).
 *  chain : most cabinets in one data chain (Brompton: 50).  est: which bit depths are estimated.
 */
export const PROCESSORS = {
  NovaStar:     { label: 'NovaStar — cartes Armor (A5s / A7s / A8s / A10s Plus…)', portsPerProc: 16, cap: { kind: 'nova', bpp: { 8: 24, 10: 48, 12: 57.6 } }, est: [12], src: 'NovaStar MX20 Specifications V1.4.1' },
  NovaStarA10sPro: { label: 'NovaStar — A10s Pro (10 bit renforcé)', portsPerProc: 16, cap: { kind: 'nova', bpp: { 8: 24, 10: 32, 12: 38.4 } }, est: [12], src: 'NovaStar MX20 Specifications V1.4.1' },
  Brompton:     { label: 'Brompton Tessera (sortie 1G)', portsPerProc: 40, cap: { kind: 'scale', base: 525000, fps0: 60, bits: { 8: 1, 10: 0.8, 12: 2 / 3 } }, chain: 50, est: [], src: 'Brompton Tessera — High Frame Rate' },
  Megapixel:    { label: 'Megapixel HELIOS (port 1G)', portsPerProc: 48, cap: { kind: 'scale', base: 485000, fps0: 50, bits: { 8: 1.5, 10: 1.2, 12: 1 } }, est: [8, 10], src: 'Megapixel — HELIOS System Capacity Basics' },
  Colorlight:   { label: 'Colorlight (port 1G)', portsPerProc: 16, cap: { kind: 'scale', base: 650000, fps0: 60, bits: { 8: 1, 10: 0.8, 12: 2 / 3 } }, est: [10, 12], src: 'Colorlight (650k px / port à 60 Hz 8 bit)' },
  Generic:      { label: 'Générique (650k px / port, 8 bit 60 Hz)', portsPerProc: 16, cap: { kind: 'scale', base: 655360, fps0: 60, bits: { 8: 1, 10: 0.8, 12: 2 / 3 } }, est: [8, 10, 12], src: '' },
  Custom:       null
};
export const PORT_COLORS = ['#00E5FF', '#FFD400', '#FF3DF2', '#7CFF4F', '#FF8A00', '#4D7CFF', '#FF2E4D', '#B6FF00', '#00FFA8', '#C77DFF', '#FFFFFF', '#FF6FB5'];

export const OUTPUT_PRESETS = [
  [1920, 1080], [2560, 1440], [3840, 2160], [4096, 2160], [7680, 1080], [3840, 1080], [1920, 1200], [2048, 1080]
];

// ------------------------------------------------------------------ ids / misc
export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const toInt = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
export const toNum = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

// ------------------------------------------------------------------ colour helpers
export function hexToRgb(hex) {
  let h = String(hex || '#000').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r, g, b) {
  const c = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return ('#' + c(r) + c(g) + c(b)).toUpperCase();
}
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s, l];
}
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
export function hueShift(hex, deg) {
  if (!deg) return hex;
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  return rgbToHex(...hslToRgb(h + deg, s, l));
}
export function shade(hex, f) { // f<1 darker, f>1 lighter (towards white)
  const [r, g, b] = hexToRgb(hex);
  if (f <= 1) return rgbToHex(r * f, g * f, b * f);
  const k = f - 1;
  return rgbToHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k);
}
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
export function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Resolved palette (array of 2..4 hex colours) for a screen. */
export function surfacePalette(screen) {
  const c = screen.colors || {};
  let base;
  if (c.preset && c.preset !== 'Custom' && COLOR_PRESETS[c.preset]) {
    const p = COLOR_PRESETS[c.preset];
    // a 4th colour for quad mode: complementary-ish mid shade
    base = [p[0], p[2], p[1], shade(p[1], 1.45)];
  } else {
    base = [c.c1 || '#FF00CE', c.c2 || '#FFCC00', c.c3 || '#8300FF', c.c4 || '#00FFCC'];
  }
  const n = clamp(toInt(c.count, 2), 1, 4);
  return base.slice(0, n).map((h) => hueShift(h, toNum(c.hue, 0)));
}

// ------------------------------------------------------------------ factories
export function defaultStyle() {
  return {
    // tile grid
    grid: true, gridOpacity: 0.55, gridColor: '#FFFFFF', gridDashed: false, gridWidth: 1,
    tileX: true, tileXOpacity: 0.18,                 // faint X in each tile
    tileMarks: 'none', tileMarkOpacity: 0.6,         // per-cabinet marks: none | cross (corner crosspoints) | plus (centre) | circle | ring (circle + plus)
    outerCircles: false,                             // concentric circles from the screen centre, one per cabinet height
    numbering: 'none',                               // none | colrow | rowcol | letters | index | snake-h | snake-v
    numberingScale: 1, numberingOpacity: 0.75,
    // screen guides
    diagonals: true, circle: true, circleSize: 0.9, cornerCircles: false,
    axis: true, border: true, borderColor: '#FFFFFF', borderWidth: 2,
    cornerMarkers: true, cornerMarkerColor: '#4DFFE1',
    guideColor: '#FFFFFF', guideOpacity: 0.85, guideDash: 8, guideWidth: 1.5,
    // centre label
    labelShape: 'pill',                              // pill | hexagon | circle | rect | none
    showName: true, showSize: true, sizeFormat: 'wxh', // wxh ("W 2816 X H 2304") | x ("2816 × 2304")
    showPhysical: true,                              // metres if pitch set
    fontFamily: 'Arial',
    labelScale: 1, labelMax: 96, labelPerSlice: true, textColor: '#FFFFFF', textStroke: true, strokeColor: '#000000', strokeWidth: 0.08,
    shapeFill: '#000000', shapeOpacity: 0.35, shapeBorder: '#FFFFFF', shapeBorderWidth: 1.5,
    pillColor: '#D9D9D9', pillTextColor: '#222222',
    // logos placed on every surface / slice (per-surface override = another list)
    logoSlots: [newLogoSlot({ id: 'lgs_default' })],
    // free text zones (per-surface override = another list)
    textSlots: [],
    // info overlay (top-left of each slice, output space)
    info: true, infoScale: 1, infoColor: '#FFFFFF', infoBg: false,
    // output footer
    footer: true, footerTemplate: '{project} - {output} - {w}x{h}', footerScale: 1, footerColor: '#FFFFFF', blendView: 'zones',
    // footer block = logo (left of the text) + text, in a corner of each output; '@app' = Pixel2Pixel logo (forced in Free)
    footerCorner: 'br', footerLogo: true, footerLogoId: '@app',
    // LED cabling overlay
    cabling: false, cablingWidth: 1, cablingLabels: true, cablingDim: 0.35, cablingUsage: true,   // cablingUsage: load % of each port on its line
    powerPath: false,
    // animation
    anim: { enabled: false, type: 'scan', dir: 'lr', width: 0.25, speed: 1, color: '#FFFFFF', counter: true }
  };
}

export function newSurface(props = {}) {
  const s = {
    id: uid('scr'),
    name: 'SURFACE',
    group: '',
    kind: 'led',                                     // 'led' | 'proj' (projection screen: physical size in metres, lit by projectors in 3D)
    phys: { w: 0, h: 0 },                            // proj: physical size (m)
    gain: 1,                                         // proj: screen gain (luminance = lux × gain / π)
    wholeTiles: true,                                // size always a whole number of cabinets
    w: 1920, h: 1080,
    visible: true,
    tile: { mode: 'px', tw: 128, th: 128, cols: 15, rows: 8 },
    pitch: 0,                                        // mm, 0 = unknown
    panel: null,                                     // snapshot of the library cabinet { id, brand, model, pitch, cabW, cabH, pxW, pxH, kg, wMax, wAvg }
    pattern: 'checker',
    colors: { preset: 'Red', count: 2, hue: 0, c1: '#FF00CE', c2: '#FFCC00', c3: '#8300FF', c4: '#00FFCC', gradA: '#FF1A1A', gradB: '#1E1EFF', gradDir: 'v', tone: 0.22, smooth: true },   // tone = darkening of every other cabinet (premium patterns)
    virtual: [],                                      // "c,r" keys of virtual (blank) tiles
    data: { flow: 'rows', pattern: 'serpentine', start: 'tl', portPx: 0, perPort: 0, portStart: 1 },  // LED data chain (portPx 0 = processor default)
    power: { flow: 'rows', pattern: 'serpentine', start: 'bl', balance: false, wholeLines: false, perCircuit: 0, wattsMax: 0, wattsAvg: 0, kg: 0, circuitStart: 1 }, // perCircuit 0 = auto from W
    comp: { x: 0, y: 0, rot: 0, flip: false },    // Input Selection in the composition (Resolume)
    // Stage 3D (metres, Y up). x/y/z = centre of the screen; rotations in degrees (Y = yaw, X = tilt, Z = roll)
    // curve: 'none' | 'h' (columns facet around a vertical axis) | 'v' (rows facet around a horizontal axis); curveDeg = angle between adjacent cabinets, + = concave (towards the audience)
    stage: { placed: false, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, curve: 'none', curveDeg: 0, jh: [], jv: [], rail: '', railOffset: 0, railFlip: false, upside: false, src: 'auto' },   // upside: screen hung upside down on its rail (180° about its normal)
      // src: 'auto' (composition video if set) | 'map' | 'dev:<deviceId>'   // curve 'joints': jh / jv = angle at each column / row joint (deg)
    style: {}                                         // per-surface overrides of project.style (multi-selection editing)
  };
  return deepAssign(s, props);
}

export function newOutput(props = {}) {
  const o = {
    id: uid('out'),
    name: 'OUTPUT1',
    w: 3840, h: 2160,
    bg: '#000000',
    logo: { show: false, x: 3000, y: 60, w: 700, id: '' },   // id '' = first logo of the library
    footer: null   // logo + text block of this output: null = project setting (style.footerCorner / footerLogo / footerLogoId), else { corner, logo, logoId }
  };
  return deepAssign(o, props);
}

export function newSlice(screen, outputId, props = {}) {
  return deepAssign({
    id: uid('slc'),
    surfaceId: screen.id,
    name: '',           // Resolume slice name; '' = surface name
    out: outputId,
    src: { x: 0, y: 0, w: screen.w, h: screen.h },
    x: 0, y: 0,
    rot: 0,             // degrees, clockwise, free (0 / 90 / 180 / 270 keep crop handles)
    flip: false,
    ow: 0, oh: 0,       // size of the content on the output (0 = 1:1 with src). ≠ src = scaled slice (warned)
    blend: { l: 0, r: 0, t: 0, b: 0 }   // soft edge widths (px of the slice content) — projector overlaps
  }, props);
}

export function newRender(props = {}) {
  return deepAssign({
    preset: 'studio', sky: 'solid', skyTop: '#1b2133', skyBottom: '#0a0d16',
    haze: 0, hazeColor: '#20242e',
    ambient: 1, sun: 1, sunColor: '#ffffff',
    bloom: true, bloomStrength: 0.35, bloomRadius: 0.4, bloomThreshold: 0.55,
    reflect: false, reflectAmount: 0.35,
    spill: true, spillIntensity: 1,
    quality: 'normal', fov: 50
  }, props);
}
export function newCrowd(props = {}) {
  return deepAssign({ enabled: false, anchor: 'front', width: 30, depth: 18, dist: 3, x: 0, z: 0, avoid: true, density: 1.2, height: 1.75, arms: 15, bounce: false, color: '#1d2028', seed: 7 }, props);
}
/** Environment presets for the 3D view (values merged into stage.render; crowd toggled where it makes sense). */
export const RENDER_PRESETS = {
  studio:  { sky: 'solid', haze: 0, ambient: 1, sun: 1, sunColor: '#ffffff', bloom: true, bloomStrength: 0.35, bloomRadius: 0.4, bloomThreshold: 0.55, reflect: false, spill: true, spillIntensity: 0.6, _bg: '#14171e', _floor: '#22262f' },
  concert: { sky: 'solid', haze: 0.22, hazeColor: '#0b0d12', ambient: 0.12, sun: 0.04, sunColor: '#8fa6ff', bloom: true, bloomStrength: 0.7, bloomRadius: 0.45, bloomThreshold: 0.45, reflect: true, reflectAmount: 0.3, spill: true, spillIntensity: 1.6, _bg: '#040507', _floor: '#0d0e11' },
  festival:{ sky: 'gradient', skyTop: '#02040c', skyBottom: '#141a33', haze: 0.18, hazeColor: '#0c1020', ambient: 0.25, sun: 0.12, sunColor: '#9fb4ff', bloom: true, bloomStrength: 0.65, bloomRadius: 0.45, bloomThreshold: 0.45, reflect: false, spill: true, spillIntensity: 1.3, _floor: '#121318' },
  sunset:  { sky: 'gradient', skyTop: '#241a3d', skyBottom: '#f0884a', haze: 0.12, hazeColor: '#7a4d52', ambient: 0.65, sun: 0.9, sunColor: '#ffb27a', bloom: true, bloomStrength: 0.45, bloomRadius: 0.4, bloomThreshold: 0.5, reflect: false, spill: true, spillIntensity: 0.8, _floor: '#3a3230' },
  day:     { sky: 'gradient', skyTop: '#5f9ee3', skyBottom: '#dfe9f3', haze: 0.06, hazeColor: '#c9d7e6', ambient: 1.3, sun: 1.8, sunColor: '#fff6e8', bloom: true, bloomStrength: 0.15, bloomRadius: 0.3, bloomThreshold: 0.8, reflect: false, spill: true, spillIntensity: 0.25, _floor: '#6b6f73' },
  venue:   { sky: 'solid', haze: 0.22, hazeColor: '#0a0a0c', ambient: 0.1, sun: 0, sunColor: '#ffffff', bloom: true, bloomStrength: 0.6, bloomRadius: 0.45, bloomThreshold: 0.45, reflect: true, reflectAmount: 0.4, spill: true, spillIntensity: 1.5, _bg: '#09090b', _floor: '#141416' }
};

export function newStage() {
  return {
    pitchDefault: 3.9,          // mm, used when a surface has neither pitch nor cabinet model
    floor: true, grid: true, human: true, backs: true, axes: false,
    bg: '#14171e', floorColor: '#22262f',
    glow: 1,                    // LED brightness multiplier in the 3D view
    views: [],                  // saved cameras { id, name, pos:[x,y,z], target:[x,y,z], fov }
    render: newRender(),        // look of the 3D view (environment, bloom, reflections, LED spill…)
    crowd: newCrowd(),          // instanced audience
    video: { comp: '', compLabel: '', overlay: false },   // live input feeding the composition in 3D (capture card / NDI virtual camera)
    camTransition: 450,         // ms, camera moves between views (0 = cut)
    people: [],                 // performers / crew to check projector beams: { id, name, x, y, z, ry, h, arms, color }
    cues: [],                   // motion cues (motorised surfaces / models): { id, name, fade, wait, pos: { 's:<id>' | 'm:<id>': { axis: value } } }
    motionLoop: false,
    rails: [],                  // plan paths screens follow: { id, name, x, z, ry, closed, segs: [{ t:'line', len } | { t:'arc', r, a }] }
    models: []                  // { id, name, kind:'glb'|'gltf'|'obj', data: dataURL, x,y,z, rx,ry,rz, scale, unit, opacity, visible, color }
  };
}

// ------------------------------------------------------------------ rails (complex curves)
// A rail is a path on the floor plane (X/Z, metres) made of straight lines and arcs, like a cabinet-lock layout.
// Screens attached to a rail follow it from `railOffset` (m along the path) over their physical width; their height is stage.y.
// Arc angle a (deg): + turns towards +Z (the front side: concave for the audience), − turns away (convex). Path bbox is centred on (x, z).
/** Cabinet cut positions (px) used by the 3D facets and the joint angles. No cabinets known: virtual 0.5 m cabinets. */
export function jointCuts(p, s) {
  const ti = tileInfo(s);
  const m = surfaceMeters(p, s);
  let tw = ti.tw, th = ti.th;
  if (s.tile.mode === 'none') { tw = Math.max(1, Math.round(0.5 / m.mx)); th = Math.max(1, Math.round(0.5 / m.my)); }
  const cut = (len, step) => { const c = [0]; for (let v = step; v < len - 1e-6; v += step) c.push(v); c.push(len); return c; };
  return { xc: cut(s.w, tw), yc: cut(s.h, th), virtual: s.tile.mode === 'none' };
}

export function newRail(props = {}) {
  return deepAssign({ id: uid('rail'), name: 'RAIL', x: 0, z: 0, ry: 0, h0: 0, closed: false, segs: [{ t: 'arc', r: 8, a: 40 }] }, props);
}

export function railBuild(rail) {
  // turtle walk: pieces with start point / heading
  const pieces = [];
  let x = 0, z = 0, th = (+rail.h0 || 0) * Math.PI / 180, len = 0;
  for (const sg of rail.segs || []) {
    if (sg.t === 'line') {
      const L = Math.max(0, +sg.len || 0);
      pieces.push({ t: 'line', d0: len, L, x, z, th });
      x += L * Math.cos(th); z += L * Math.sin(th); len += L;
    } else {
      const r = Math.max(0.05, +sg.r || 1), a = (+sg.a || 0) * Math.PI / 180;
      const L = Math.abs(a) * r;
      const sgn = a >= 0 ? 1 : -1;
      const cx = x - sgn * r * Math.sin(th), cz = z + sgn * r * Math.cos(th);
      pieces.push({ t: 'arc', d0: len, L, cx, cz, r, th, sgn });
      th += a;
      x = cx + sgn * r * Math.sin(th); z = cz - sgn * r * Math.cos(th);
      len += L;
    }
  }
  const raw = (d) => {
    if (!pieces.length) return { x: d, z: 0, th: (+rail.h0 || 0) * Math.PI / 180 };
    if (rail.closed && len > 0) d = ((d % len) + len) % len;
    let pc = pieces[pieces.length - 1];
    for (const q of pieces) if (d <= q.d0 + q.L) { pc = q; break; }
    if (d < 0) pc = pieces[0];
    const u = d - pc.d0;
    if (pc.t === 'line') return { x: pc.x + u * Math.cos(pc.th), z: pc.z + u * Math.sin(pc.th), th: pc.th };
    const ph = pc.th + pc.sgn * u / pc.r;
    return { x: pc.cx + pc.sgn * pc.r * Math.sin(ph), z: pc.cz - pc.sgn * pc.r * Math.cos(ph), th: ph };
  };
  // centre the path's bounding box on the rail origin
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const n = Math.max(2, Math.ceil(len / 0.05));
  for (let i = 0; i <= n; i++) { const q = raw(len * i / n); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
  const ox = len ? (x0 + x1) / 2 : 0, oz = len ? (z0 + z1) / 2 : 0;
  const at = (d) => { const q = raw(d); return { x: q.x - ox, z: q.z - oz, th: q.th }; };
  // distances where the path bends: joints + arc subdivisions (≤ 3°)
  const bends = (d0, d1) => {
    const out = [];
    for (const q of pieces) {
      if (q.t !== 'arc') { out.push(q.d0, q.d0 + q.L); continue; }
      const k = Math.max(1, Math.ceil(Math.abs(q.L / q.r) / (3 * Math.PI / 180)));
      for (let i = 0; i <= k; i++) out.push(q.d0 + q.L * i / k);
    }
    if (rail.closed && len > 0) { const base = [...out]; for (const m of [-1, 1, 2]) for (const v of base) out.push(v + m * len); }
    return out.filter((v) => v > d0 + 1e-6 && v < d1 - 1e-6);
  };
  return { len, at, bends, pieces, size: { w: x1 - x0, d: z1 - z0 } };
}

/** Preset rail sized to a total length L (m). kind: arc | circle | half | s | wave | wrap | line */
export function railPreset(kind, L, o = {}) {
  const r2 = (v) => Math.round(v * 1000) / 1000;
  const A = o.angle ?? 60;
  switch (kind) {
    case 'circle': return { closed: true, segs: [{ t: 'arc', r: r2(L / (2 * Math.PI)), a: o.inward ? 360 : -360 }] };
    case 'half': return { closed: false, segs: [{ t: 'arc', r: r2(L / Math.PI), a: o.inward ? 180 : -180 }] };
    case 's': { const r = r2(L / 2 / (A * Math.PI / 180)); return { closed: false, h0: -A / 2, segs: [{ t: 'arc', r, a: A }, { t: 'arc', r, a: -A }] }; }
    case 'wave': { const n = Math.max(2, o.waves || 4); const r = r2(L / n / (A * Math.PI / 180)); return { closed: false, h0: -A / 2, segs: Array.from({ length: n }, (_, i) => ({ t: 'arc', r, a: i % 2 ? -A : A })) }; }
    case 'wrap': { const r = o.radius || 1; const arc = Math.PI / 2 * r; return { closed: false, h0: 90, segs: [{ t: 'arc', r, a: -90 }, { t: 'line', len: r2(Math.max(0.1, L - 2 * arc)) }, { t: 'arc', r, a: -90 }] }; }
    case 'line': return { closed: false, h0: 0, segs: [{ t: 'line', len: r2(L) }] };
    default: return { closed: false, h0: -A / 2, segs: [{ t: 'arc', r: r2(L / (A * Math.PI / 180)), a: A }] };
  }
}

export function newModel3d(props = {}) {
  return deepAssign({ id: uid('m3d'), name: 'MODÈLE', kind: 'glb', data: null, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1, unit: 'm', opacity: 1, visible: true, color: '' }, props);
}

/**
 * Video projector. Placed in metres like screens; looks along its local −Z (Euler YXZ, degrees), so a projector with the
 * same rotation as a screen faces it. tr = throw ratio (distance / image width); shiftH / shiftV = lens shift in % of the
 * image width / height (+ = right / up). Its image comes from output `out` (one Resolume screen per projector).
 */
export function newProjector(props = {}) {
  return deepAssign({
    id: uid('prj'), name: 'PROJ 1', lib: '', brand: '', model: '', resW: 1920, resH: 1200, lumens: 20000, stack: 1,
    lens: '', trMin: 1.2, trMax: 2.4, tr: 1.6, shiftH: 0, shiftV: 0, shiftRangeH: [-30, 30], shiftRangeV: [-50, 50],
    shiftConv: 'full',          // how the maker states lens shift: 'full' (% of the image) | 'half' (% of half the image, Barco)
    ceiling: false, rear: false, // installation menu: ceiling = image turned 180°, rear = image mirrored (rear projection)
    x: 0, y: 2, z: 10, rx: 0, ry: 0, rz: 0, out: '', visible: true, color: '#4F8BFF', kg: 0, watts: 0
  }, props);
}

/** A person standing on stage (feet at y), facing −Z when ry = 0 … i.e. towards the audience for ry = 180. */
export function newPerson(props = {}) {
  return deepAssign({ id: uid('psn'), name: 'PERSONNE 1', x: 0, y: 0, z: 1, ry: 180, h: 1.75, arms: false, color: '#B8BEC9', visible: true }, props);
}

export const UNIT_SCALE = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 };

/** Physical size of a surface in metres. assumed = no pitch / cabinet, default pitch used. */
export function surfaceMeters(p, s) {
  const pn = s.panel;
  let mx, my, assumed = false;
  if (s.kind === 'proj') {
    const pw = toNum(s.phys && s.phys.w, 0), ph = toNum(s.phys && s.phys.h, 0);
    if (pw > 0) { mx = pw / s.w; my = ph > 0 ? ph / s.h : mx; return { w: s.w * mx, h: s.h * my, mx, my, assumed: false }; }
  }
  if (pn && pn.cabW && pn.cabH && pn.pxW && pn.pxH) { mx = pn.cabW / pn.pxW / 1000; my = pn.cabH / pn.pxH / 1000; }
  else if (s.pitch > 0) { mx = my = s.pitch / 1000; }
  else { mx = my = ((p.stage && p.stage.pitchDefault) || 3.9) / 1000; assumed = true; }
  return { w: s.w * mx, h: s.h * my, mx, my, assumed };
}

/** Initial 3D placement from the 2D composition: same relative layout, lowest screen bottom at baseY, centred on X = 0, on the plane Z = z. */
export function stageFromComp(p, ids, baseY = 0, z = 0) {
  const list = p.surfaces.filter((s) => ids.includes(s.id));
  if (!list.length) return;
  const rows = list.map((s) => {
    const m = surfaceMeters(p, s);
    const r = ((s.comp.rot % 360) + 360) % 360, swap = r === 90 || r === 270;
    const bw = swap ? s.h : s.w, bh = swap ? s.w : s.h;
    return { s, m, cx: s.comp.x + bw / 2, cy: s.comp.y + bh / 2, hm: swap ? m.w : m.h, r };
  });
  // composition px -> metres with the median scale, so mixed pitches keep their relative layout
  const ks = rows.map((o) => o.m.mx).sort((a, b) => a - b), k = ks[Math.floor(ks.length / 2)];
  const minX = Math.min(...rows.map((o) => o.cx)), maxX = Math.max(...rows.map((o) => o.cx));
  const midX = (minX + maxX) / 2;
  const bottom = Math.max(...rows.map((o) => o.cy * k + o.hm / 2));
  for (const o of rows) {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    o.s.stage = { ...o.s.stage, placed: true, x: r3((o.cx - midX) * k), y: r3(baseY + bottom - o.cy * k), z, rx: 0, ry: 0, rz: -o.r };
  }
}

/** Local right / up unit vectors of a placed screen (Euler order YXZ, degrees). */
export function stageAxes(st) {
  const d = Math.PI / 180;
  const cx = Math.cos(st.rx * d), sx = Math.sin(st.rx * d), cy = Math.cos(st.ry * d), sy = Math.sin(st.ry * d), cz = Math.cos(st.rz * d), sz = Math.sin(st.rz * d);
  return {
    right: [cz * cy + sz * sx * sy, sz * cx, -cz * sy + sz * sx * cy],
    up: [-sz * cy + cz * sx * sy, cz * cx, sz * sy + cz * sx * cy]
  };
}

/** Move a placed screen along its own axes (metres). */
export function stageOffset(st, alongRight, alongUp) {
  const a = stageAxes(st);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { ...st, x: r3(st.x + a.right[0] * alongRight + a.up[0] * alongUp), y: r3(st.y + a.right[1] * alongRight + a.up[1] * alongUp), z: r3(st.z + a.right[2] * alongRight + a.up[2] * alongUp) };
}

// ---- 3D assemblies: folding a selection edge to edge, mirroring placements
const D2R_ = Math.PI / 180;
const mmul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mvec3 = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const rotX3 = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const rotY3 = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const rotZ3 = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
/** Rotation matrix of a placement (degrees, Euler order YXZ = three.js). */
export function stageMatrix(st) { return mmul3(mmul3(rotY3((+st.ry || 0) * D2R_), rotX3((+st.rx || 0) * D2R_)), rotZ3((+st.rz || 0) * D2R_)); }
/** Back to YXZ Euler degrees (rounded 0.01°). */
export function stageEuler(R) {
  const cl = (v) => Math.max(-1, Math.min(1, v));
  const rx = Math.asin(-cl(R[1][2]));
  let ry, rz;
  if (Math.abs(R[1][2]) < 0.9999999) { ry = Math.atan2(R[0][2], R[2][2]); rz = Math.atan2(R[1][0], R[1][1]); }
  else { ry = Math.atan2(-R[2][0], R[0][0]); rz = 0; }
  const d = (a) => { let v = Math.round(a / D2R_ * 100) / 100; if (v <= -180) v += 360; if (v > 180) v -= 360; return v === 0 ? 0 : v; };   // no -0
  return { rx: d(rx), ry: d(ry), rz: d(rz) };
}
const r3_ = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };

/** Fold presets for a chain of screens (angle = deviation from flat, 90 = right angle). */
export const FOLD_PRESETS = {
  l:     { axis: 'v', angle: 90, dir: 'back', pattern: 'same', anchor: 'first' },
  u:     { axis: 'v', angle: 90, dir: 'front', pattern: 'same', anchor: 'mid' },
  box:   { axis: 'v', angle: 90, dir: 'back', pattern: 'same', anchor: 'first' },
  tri:   { axis: 'v', angle: 120, dir: 'back', pattern: 'same', anchor: 'first' },
  zig:   { axis: 'v', angle: 30, dir: 'back', pattern: 'alt', anchor: 'mid' },
  floor: { axis: 'h', angle: 90, dir: 'front', pattern: 'same', anchor: 'first' },
  roof:  { axis: 'h', angle: 90, dir: 'front', pattern: 'same', anchor: 'last' },
  free:  { axis: 'v', angle: 45, dir: 'back', pattern: 'same', anchor: 'first' }
};

/**
 * Fold a chain of screens edge to edge. items = [{ st, w, h }] in chain order (left→right for axis 'v', top→bottom for 'h').
 * The anchor keeps its placement; every other screen hangs on its neighbour's edge, turned by `angle` (deg) about the shared
 * edge: dir 'back' = the free edge goes away from the audience (salient corner), 'front' = towards it.
 * pattern 'alt' alternates the direction at each joint (zigzag). align = 'start' | 'center' | 'end' across the joint
 * (bottom / centre / top for 'v', left / centre / right for 'h'). gap = metres between edges.
 * Returns [{ x, y, z, rx, ry, rz }] in the same order.
 */
export function stageFold(items, opts = {}) {
  const n = items.length;
  const o = { axis: 'v', angle: 90, dir: 'back', pattern: 'same', anchor: 'first', align: 'start', gap: 0, ...opts };
  const ai = typeof o.anchor === 'number' ? Math.max(0, Math.min(n - 1, o.anchor)) : o.anchor === 'last' ? n - 1 : o.anchor === 'mid' ? Math.floor((n - 1) / 2) : 0;
  const R = new Array(n), C = new Array(n);
  // each screen keeps its own quarter turns of roll (composition rotation): the chain is built on frames without them,
  // with the visible width / height (a screen rolled ±90° stands on its side); a small tilt of the anchor is shared
  const roll = (k) => Math.round((+items[k].st.rz || 0) / 90) * 90;
  const side = (k) => Math.abs(roll(k)) % 180 === 90;
  const W = (k) => (side(k) ? items[k].h : items[k].w), H = (k) => (side(k) ? items[k].w : items[k].h);
  R[ai] = mmul3(stageMatrix(items[ai].st), rotZ3(-roll(ai) * D2R_)); C[ai] = [+items[ai].st.x || 0, +items[ai].st.y || 0, +items[ai].st.z || 0];
  const v = o.axis !== 'h';
  const local = v ? rotY3 : rotX3;
  // joint j sits between k = j and j + 1: rotation of j+1 relative to j
  const sign = (j) => (o.dir === 'front' ? -1 : 1) * (o.pattern === 'alt' && j % 2 ? -1 : 1);
  const th = (+o.angle || 0) * D2R_;
  const along = (a, b) => (v ? [a, b, 0] : [b, a, 0]);       // [along chain, across] -> local xyz ('h': chain runs along -y)
  const cross = (k, other) => {                                  // offset across the joint so the chosen edges line up
    const sa = v ? H(k) : W(k), sb = v ? H(other) : W(other);
    const d = (sb - sa) / 2;
    return o.align === 'center' ? 0 : o.align === 'end' ? -d : d;
  };
  const len = (k) => (v ? W(k) : H(k));
  const dirv = v ? 1 : -1;                                       // chain direction in local axis (x for 'v', -y for 'h')
  const place = (from, to, rel) => {                             // rel = rotation of `to` relative to `from`
    R[to] = mmul3(R[from], rel);
    const s = to > from ? 1 : -1;
    const e = along(dirv * s * (len(from) / 2 + (+o.gap || 0)), 0);
    const f = along(dirv * s * len(to) / 2, 0);
    const c = along(0, cross(from, to));
    const a = mvec3(R[from], [e[0] + c[0], e[1] + c[1], 0]), b = mvec3(R[to], f);
    C[to] = [0, 1, 2].map((i) => C[from][i] + a[i] + b[i]);
  };
  for (let k = ai + 1; k < n; k++) place(k - 1, k, local(sign(k - 1) * th));
  for (let k = ai - 1; k >= 0; k--) place(k + 1, k, local(-sign(k) * th));
  return R.map((m, k) => ({ x: r3_(C[k][0]), y: r3_(C[k][1]), z: r3_(C[k][2]), ...stageEuler(mmul3(m, rotZ3(roll(k) * D2R_))) }));
}

/**
 * Mirror a placement across a vertical plane: plane 'x' = left/right about X = at, 'z' = front/back about Z = at.
 * The copy still faces the mirrored direction with its content reading normally (R' = P · R · Mx), so the
 * mirrored screen's left edge is where the source's right edge was: joint angles along the width are reversed.
 */
export function stageMirror(st, plane = 'x', at = 0) {
  const P = plane === 'z' ? [[1, 0, 0], [0, 1, 0], [0, 0, -1]] : [[-1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const Mx = [[-1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const e = stageEuler(mmul3(mmul3(P, stageMatrix(st)), Mx));
  const x = +st.x || 0, z = +st.z || 0;
  return { x: r3_(plane === 'z' ? x : 2 * at - x), y: r3_(+st.y || 0), z: r3_(plane === 'z' ? 2 * at - z : z), ...e, jh: [...(st.jh || [])].reverse() };
}

/**
 * Cabling method of a project (how this crew builds walls), applied to the surfaces with « Appliquer à toutes les surfaces »
 * and to every new surface. mount: flown (cables arrive from the top) | ground (from the bottom); side: left | right;
 * lowLatency: processor low-latency mode (NovaStar / HELIOS: columns only); followData: power circuits take the data path.
 */
export function newCablingMethod(props = {}) {
  // pFlow / pCorner: own power path when followData is off (power usually starts at the bottom: distribution on the floor)
  return { mount: 'flown', side: 'left', flow: 'rows', pattern: 'serpentine', balance: true, wholeLines: false, lowLatency: false, followData: true, pFlow: 'rows', pCorner: 'bl', ...props };
}
/** Start corner from the method: flown = top, ground = bottom; left / right. */
export function methodStart(m) { return (m.mount === 'ground' ? 'b' : 't') + (m.side === 'right' ? 'r' : 'l'); }
/** Built-in methods (« profils »); users save their own next to these. */
export const CABLING_PRESETS = {
  tour:     { label: 'Tournée — serpentin en lignes, départ en haut à gauche', method: { mount: 'flown', side: 'left', flow: 'rows', pattern: 'serpentine', balance: true, wholeLines: false, lowLatency: false, followData: true } },
  ground:   { label: 'Ground stack — serpentin en lignes, départ en bas à gauche', method: { mount: 'ground', side: 'left', flow: 'rows', pattern: 'serpentine', balance: true, wholeLines: false, lowLatency: false, followData: true } },
  columns:  { label: 'Colonnes entières — un port par colonne(s), départ en haut', method: { mount: 'flown', side: 'left', flow: 'cols', pattern: 'serpentine', balance: true, wholeLines: true, lowLatency: false, followData: true } },
  lowlat:   { label: 'Faible latence (NovaStar / HELIOS) — colonnes obligatoires', method: { mount: 'flown', side: 'left', flow: 'cols', pattern: 'serpentine', balance: true, wholeLines: true, lowLatency: true, followData: true } }
};
/** Data / power settings a method gives to a surface. */
export function methodSurfaceData(m) {
  const start = methodStart(m);
  const flow = m.lowLatency ? 'cols' : m.flow;
  const power = m.followData === false ? { flow: m.pFlow || 'rows', pattern: 'serpentine', start: m.pCorner || 'bl', balance: !!m.balance, wholeLines: !!m.wholeLines } : { flow, pattern: m.pattern === 'straight' ? 'serpentine' : m.pattern, start, balance: !!m.balance, wholeLines: !!m.wholeLines };
  return { data: { flow, pattern: m.pattern, start, balance: !!m.balance, wholeLines: !!m.wholeLines }, power };
}

export function newProject() {
  const out = newOutput({ name: 'OUTPUT1' });
  const p = {
    format: FILE_FORMAT,
    app: 'Pixel2Pixel',
    name: 'NOUVEAU PROJET',
    composition: { w: 3840, h: 2160, bg: '#000000' },   // = Resolume composition size
    grid: { size: 128, show: true, snap: true, smart: true, arrow: 10 },
    processor: { type: 'NovaStar', portPx: 650000, portsPerProc: 16, fps: 60, bitDepth: 8, headroom: 90, redundancy: 'none', portLabel: 'P', autoNumber: true, outPerProc: true, noSplit: true },
    power: { voltage: 230, amps: 16, phases: 1, pf: 0.95, basis: 'max', derate: 100, leakMa: 0, rcdMa: 30, chainMax: 0, linkAmps: 0, autoNumber: true, mainsA: 0, multi: 'direct', multiCircuits: 6, multiAmps: 16 },
    cabling: newCablingMethod(),
    style: defaultStyle(),
    outputs: [out],
    surfaces: [],
    slices: [],
    logos: [],           // [{ id, name, data: dataURL }] (data kept out of undo history)
    gradient: newGradient(),
    stage: newStage(),
    projectors: []       // video projectors (see newProjector) — each one feeds from an output
  };
  const main = newSurface({ name: 'MAIN', w: 1920, h: 1024, comp: { x: 960, y: 568 } });
  p.surfaces.push(main);
  p.slices.push(newSlice(main, out.id, { x: 0, y: 0 }));
  return p;
}

// ------------------------------------------------------------------ queries
export const getSurface = (p, id) => p.surfaces.find((s) => s.id === id);
export const getOutput = (p, id) => p.outputs.find((o) => o.id === id);
export const slicesOfSurface = (p, id) => p.slices.filter((s) => s.surfaceId === id);
export const slicesOfOutput = (p, id) => p.slices.filter((s) => s.out === id);

/** Size of a slice once placed on the output (after rotation). */
export function sliceOut(sl) {
  return { w: sl.ow > 0 ? sl.ow : sl.src.w, h: sl.oh > 0 ? sl.oh : sl.src.h };
}
/** Scale factors output / input (1 = 1:1). */
export function sliceScale(sl) {
  const o = sliceOut(sl);
  return { kx: o.w / sl.src.w, ky: o.h / sl.src.h };
}
export function sliceScaled(sl) {
  const o = sliceOut(sl);
  return Math.abs(o.w - sl.src.w) > 0.5 || Math.abs(o.h - sl.src.h) > 0.5;
}
export const rightAngle = (rot) => Math.abs(((rot % 90) + 90) % 90) < 1e-6 || Math.abs((((rot % 90) + 90) % 90) - 90) < 1e-6;
/** Size of a slice once placed on the output: dw / dh = axis-aligned bounding box of the (scaled, rotated) content. */
export function sliceDims(sl) {
  const o = sliceOut(sl);
  const r = ((sl.rot % 360) + 360) % 360;
  if (r === 90 || r === 270) return { w: sl.src.w, h: sl.src.h, ow: o.w, oh: o.h, dw: o.h, dh: o.w };
  if (r === 0 || r === 180) return { w: sl.src.w, h: sl.src.h, ow: o.w, oh: o.h, dw: o.w, dh: o.h };
  const a = r * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const rd = (v) => Math.round(v * 100) / 100;
  return { w: sl.src.w, h: sl.src.h, ow: o.w, oh: o.h, dw: rd(o.w * c + o.h * s), dh: rd(o.w * s + o.h * c) };
}
/** Resolume-coherent slice name. */
export function sliceName(p, sl) {
  if (sl.name) return sl.name;
  const s = getSurface(p, sl.surfaceId);
  const base = s ? s.name : 'Slice';
  const siblings = slicesOfSurface(p, sl.surfaceId);
  if (siblings.length <= 1) return base;
  return base + ' [' + (siblings.indexOf(sl) + 1) + '/' + siblings.length + ']';
}

/**
 * Split a surface in two along a slice: the slice's band (full height on the left / right edge, or full width on the
 * top / bottom edge) becomes an independent surface, with its own cabinet model, cabling and power; the rest stays.
 * Slices, virtual tiles, composition position and 3D placement follow. Returns { ok, newId } or { error }.
 * error: 'band' (slice is not an edge band), 'whole' (slice covers the whole surface), 'straddle' (another slice
 * of the surface crosses the cut), 'rot' (rotated input selection).
 */
export function detachSlice(p, sliceId, name = '') {
  const sl = p.slices.find((x) => x.id === sliceId);
  const s = sl && getSurface(p, sl.surfaceId);
  if (!sl || !s) return { error: 'none' };
  const r = sl.src;
  if (r.x <= 0 && r.y <= 0 && r.w >= s.w && r.h >= s.h) return { error: 'whole' };
  if (toNum(s.comp && s.comp.rot, 0)) return { error: 'rot' };
  let side = null;
  if (r.y <= 0 && r.h >= s.h) side = r.x <= 0 ? 'l' : r.x + r.w >= s.w ? 'r' : null;
  else if (r.x <= 0 && r.w >= s.w) side = r.y <= 0 ? 't' : r.y + r.h >= s.h ? 'b' : null;
  if (!side) return { error: 'band' };
  const band = { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.w, s.w), h: Math.min(r.h, s.h) };
  if (side === 'l' || side === 'r') { band.y = 0; band.h = s.h; } else { band.x = 0; band.w = s.w; }
  const rest = side === 'l' ? { x: band.w, y: 0, w: s.w - band.w, h: s.h } : side === 'r' ? { x: 0, y: 0, w: s.w - band.w, h: s.h }
    : side === 't' ? { x: 0, y: band.h, w: s.w, h: s.h - band.h } : { x: 0, y: 0, w: s.w, h: s.h - band.h };
  const inside = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
  const sibs = slicesOfSurface(p, s.id);
  for (const x of sibs) if (x !== sl && !inside(x.src, band) && !inside(x.src, rest)) return { error: 'straddle' };
  // tile grid in px so both parts keep the same cabinets (the new part's model can then be changed alone)
  const ti = tileInfo(s);
  const tileMode = s.tile && s.tile.mode === 'count' ? { mode: 'px', tw: ti.tw, th: ti.th } : null;
  // continuous test pattern: both parts remember their place in the original screen (kept through further splits)
  const jo = s.joint && s.joint.w > 0 ? s.joint : null;
  const J0 = jo ? { id: jo.id, x: +jo.x || 0, y: +jo.y || 0, w: jo.w, h: jo.h, name: jo.name || s.name } : { id: uid('jnt'), x: 0, y: 0, w: s.w, h: s.h, name: s.name };
  const ns = JSON.parse(JSON.stringify(s));
  ns.id = uid('scr');
  if (ns.style) for (const k of ['logoSlots', 'textSlots']) if (Array.isArray(ns.style[k])) ns.style[k] = ns.style[k].map((x) => ({ ...x, id: uid(k === 'logoSlots' ? 'lgs' : 'txt') }));
  ns.name = name || (s.name + (side === 'l' || side === 't' ? ' A' : ' B'));
  ns.w = band.w; ns.h = band.h;
  ns.comp = { ...s.comp, x: s.comp.x + band.x, y: s.comp.y + band.y };
  if (tileMode) { ns.tile = { ...ns.tile, ...tileMode }; }
  // virtual tiles: re-index when the cut falls on the cabinet grid, else cleared on both parts
  const vt = s.virtual || [];
  const aligned = ti.integer && band.x % ti.tw === 0 && band.y % ti.th === 0 && rest.x % ti.tw === 0 && rest.y % ti.th === 0 && band.w % ti.tw === 0 && band.h % ti.th === 0;
  const shiftV = (box) => vt.map((k) => k.split(',').map(Number)).filter(([c, rr]) => c * ti.tw >= box.x && c * ti.tw < box.x + box.w && rr * ti.th >= box.y && rr * ti.th < box.y + box.h)
    .map(([c, rr]) => `${c - box.x / ti.tw},${rr - box.y / ti.th}`);
  ns.virtual = aligned ? shiftV(band) : [];
  const restV = aligned ? shiftV(rest) : [];
  // joint angles of curved screens: keep the joints of each part when the cut is on the grid
  const cutJ = (arr, from, count) => (Array.isArray(arr) ? arr.slice(from, from + Math.max(0, count - 1)) : []);
  if (s.stage) {
    const bc = Math.round(band.w / ti.tw), br = Math.round(band.h / ti.th), rc = Math.round(rest.w / ti.tw), rr = Math.round(rest.h / ti.th);
    const bc0 = Math.round(band.x / ti.tw), br0 = Math.round(band.y / ti.th), rc0 = Math.round(rest.x / ti.tw), rr0 = Math.round(rest.y / ti.th);
    ns.stage.jh = aligned ? cutJ(s.stage.jh, bc0, bc) : []; ns.stage.jv = aligned ? cutJ(s.stage.jv, br0, br) : [];
    s.stage.jh = aligned ? cutJ(s.stage.jh, rc0, rc) : []; s.stage.jv = aligned ? cutJ(s.stage.jv, rr0, rr) : [];
    // 3D: each part keeps its place on the original screen plane
    if (s.stage.placed) {
      const m = surfaceMeters(p, s), R = stageMatrix(s.stage);
      const at = (box) => { const d = mvec3(R, [(box.x + box.w / 2 - s.w / 2) * m.mx, -(box.y + box.h / 2 - s.h / 2) * m.my, 0]); return { x: s.stage.x + d[0], y: s.stage.y + d[1], z: s.stage.z + d[2] }; };
      const rd = (v) => Math.round(v * 1000) / 1000;
      const a = at(band), b = at(rest);
      ns.stage.x = rd(a.x); ns.stage.y = rd(a.y); ns.stage.z = rd(a.z);
      s.stage.x = rd(b.x); s.stage.y = rd(b.y); s.stage.z = rd(b.z);
    }
  }
  // slices follow their part
  for (const x of sibs) {
    if (x === sl || inside(x.src, band)) { x.surfaceId = ns.id; x.src = { x: x.src.x - band.x, y: x.src.y - band.y, w: Math.min(x.src.w, band.w), h: Math.min(x.src.h, band.h) }; if (x === sl) x.src = { x: 0, y: 0, w: band.w, h: band.h }; }
    else { x.src = { ...x.src, x: x.src.x - rest.x, y: x.src.y - rest.y }; }
  }
  ns.joint = { id: J0.id, x: J0.x + band.x, y: J0.y + band.y, w: J0.w, h: J0.h, name: J0.name, on: jo ? jo.on !== false : true };
  s.joint = { id: J0.id, x: J0.x + rest.x, y: J0.y + rest.y, w: J0.w, h: J0.h, name: J0.name, on: jo ? jo.on !== false : true };
  s.w = rest.w; s.h = rest.h;
  s.comp = { ...s.comp, x: s.comp.x + rest.x, y: s.comp.y + rest.y };
  if (tileMode) s.tile = { ...s.tile, ...tileMode };
  s.virtual = restV;
  const i = p.surfaces.indexOf(s);
  p.surfaces.splice(side === 'l' || side === 't' ? i : i + 1, 0, ns);   // list order follows the screen (left / top part first)
  return { ok: true, newId: ns.id, side };
}

// ------------------------------------------------------------------ motorisation (servo hoists, tracks, turntables)
/** Axes a motor can drive: translations in metres, rotations in degrees (stage frame, audience at +Z). */
export const MOTION_AXES = ['y', 'x', 'z', 'ry', 'rx', 'rz'];
export const isRotAxis = (a) => a === 'rx' || a === 'ry' || a === 'rz';
/** Axes a motorised item can use: a screen on a rail only goes up / down (hoists) or along the rail (track). */
export const RAIL_MOTION_AXES = ['y', 'railOffset'];
export function motionAxesFor(item) { return item && item.stage && item.stage.rail ? RAIL_MOTION_AXES : MOTION_AXES; }
/** Object holding the placement values of a motorised item: a surface's stage block, or the 3D model itself. */
export function motionHolder(p, key) {
  if (!key) return null;
  const id = key.slice(2);
  if (key.startsWith('s:')) { const s = getSurface(p, id); return s ? s.stage : null; }
  if (key.startsWith('m:')) return ((p.stage && p.stage.models) || []).find((m) => m.id === id) || null;
  return null;
}
export function motionItem(p, key) {
  const id = key.slice(2);
  return key.startsWith('s:') ? getSurface(p, id) : ((p.stage && p.stage.models) || []).find((m) => m.id === id) || null;
}
/** New axis around the current position (butées: −0 / +3 m, or ±0 / +45°). */
export function newMotionAxis(holder, axis = 'y') {
  const v = toNum(holder && holder[axis], 0), rot = isRotAxis(axis);
  const span = rot ? 45 : axis === 'railOffset' ? 2 : 3;
  return { id: uid('ax'), axis, min: Math.round(v * 1000) / 1000, max: Math.round((v + span) * 1000) / 1000, speed: rot ? 10 : 0.2 };
}
/** Every motorised item of the project: [{ key, name, item, holder, axes }]. */
export function motionObjects(p) {
  const out = [];
  for (const s of p.surfaces || []) {
    if (!(s.motion && s.motion.on && (s.motion.axes || []).length)) continue;
    // on a rail, only the hoist height and the position along the rail move
    const axes = s.stage.rail ? s.motion.axes.filter((a) => RAIL_MOTION_AXES.includes(a.axis)) : s.motion.axes;
    if (axes.length) out.push({ key: 's:' + s.id, name: s.name, item: s, holder: s.stage, axes });
  }
  for (const m of (p.stage && p.stage.models) || []) if (m.motion && m.motion.on && (m.motion.axes || []).length) out.push({ key: 'm:' + m.id, name: m.name, item: m, holder: m, axes: m.motion.axes });
  return out;
}
const axLo = (a) => Math.min(toNum(a.min, 0), toNum(a.max, 0)), axHi = (a) => Math.max(toNum(a.min, 0), toNum(a.max, 0));
/** Keep every motorised axis between its virtual limits (butées). Returns the number of values moved. */
export function clampMotion(p) {
  let n = 0;
  for (const o of motionObjects(p)) for (const a of o.axes) {
    const v = toNum(o.holder[a.axis], 0), c = Math.min(axHi(a), Math.max(axLo(a), v));
    if (c !== v) { o.holder[a.axis] = c; n++; }
  }
  return n;
}
/** Current position of every motorised axis: { key: { axis: value } }. */
export function motionSnapshot(p) {
  const res = {};
  for (const o of motionObjects(p)) { res[o.key] = {}; for (const a of o.axes) res[o.key][a.axis] = toNum(o.holder[a.axis], 0); }
  return res;
}
/** Travel time (s) from the current positions to a cue: the fade, or longer when a motor's max speed asks for it. */
export function motionTravel(p, target, fade = 0) {
  let t = Math.max(0, toNum(fade, 0));
  for (const o of motionObjects(p)) {
    const tg = target && target[o.key]; if (!tg) continue;
    for (const a of o.axes) {
      if (!(a.axis in tg)) continue;
      const d = Math.abs(Math.min(axHi(a), Math.max(axLo(a), toNum(tg[a.axis], 0))) - toNum(o.holder[a.axis], 0));
      const v = Math.max(1e-6, toNum(a.speed, 0.2));
      // trapezoid-like S-curve: the average speed is 2/3 of the max speed
      t = Math.max(t, d / v * 1.5);
    }
  }
  return t;
}
/** Smooth acceleration / deceleration of a hoist (0..1 → 0..1). */
export function motionEase(u) { u = Math.min(1, Math.max(0, u)); return u * u * u * (u * (u * 6 - 15) + 10); }

/** Input Selection of a slice in composition space (unrotated surface assumed for axis-aligned export). */
export function sliceInputRect(p, sl) {
  const s = getSurface(p, sl.surfaceId);
  return { x: (s ? s.comp.x : 0) + sl.src.x, y: (s ? s.comp.y : 0) + sl.src.y, w: sl.src.w, h: sl.src.h, rot: s ? s.comp.rot : 0 };
}

/** Corners TL, TR, BR, BL of the slice content on its output (scale + free rotation + mirror). */
export function sliceQuad(sl) {
  const d = sliceDims(sl);
  const cx = sl.x + d.dw / 2, cy = sl.y + d.dh / 2;
  const a = (sl.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([ux, uy]) => {
    let px = ux * d.ow / 2; const py = uy * d.oh / 2;
    if (sl.flip) px = -px;
    return { x: cx + px * c - py * s, y: cy + px * s + py * c };
  });
}
/** Separating-axis overlap depth of two convex quads (px), 0 = no overlap. */
export function quadOverlap(A, B) {
  let depth = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) {
    for (let i = 0; i < P.length; i++) {
      const s0 = P[i], e0 = P[(i + 1) % P.length];
      const len = Math.hypot(e0.x - s0.x, e0.y - s0.y); if (len < 1e-9) continue;
      const nx = (e0.y - s0.y) / len, ny = -(e0.x - s0.x) / len;
      const proj = (pts) => { let lo = Infinity, hi = -Infinity; for (const v of pts) { const dd = v.x * nx + v.y * ny; lo = Math.min(lo, dd); hi = Math.max(hi, dd); } return [lo, hi]; };
      const [p0, p1] = proj(P), [q0, q1] = proj(Q);
      const gap = Math.min(p1, q1) - Math.max(p0, q0);
      if (gap <= 0) return 0;
      depth = Math.min(depth, gap);
    }
  }
  return Number.isFinite(depth) ? depth : 0;
}

export function sliceRect(sl) {
  const d = sliceDims(sl);
  return { x: sl.x, y: sl.y, w: d.dw, h: d.dh };
}

/** Tile geometry of a screen. */
export function tileInfo(s) {
  const t = s.tile || {};
  let tw, th, cols, rows;
  if (t.mode === 'count') {
    cols = Math.max(1, toInt(t.cols, 1)); rows = Math.max(1, toInt(t.rows, 1));
    tw = s.w / cols; th = s.h / rows;
  } else if (t.mode === 'none') {
    cols = 1; rows = 1; tw = s.w; th = s.h;
  } else {
    tw = Math.max(1, toNum(t.tw, 128)); th = Math.max(1, toNum(t.th, 128));
    cols = Math.ceil(s.w / tw - 1e-6); rows = Math.ceil(s.h / th - 1e-6);
  }
  const partial = s.kind !== 'proj' && t.mode === 'px' && (s.w % tw !== 0 || s.h % th !== 0);
  const integer = Number.isInteger(tw) && Number.isInteger(th);
  return { tw, th, cols, rows, partial, integer, total: cols * rows - (s.virtual ? s.virtual.length : 0) };
}

export function physicalSize(s) {
  if (s.kind === 'proj' && s.phys && s.phys.w > 0) { const f = (m) => (Math.round(m * 100) / 100).toString().replace('.', ',') + 'm'; return f(s.phys.w) + ' × ' + f(s.phys.h || s.phys.w * s.h / s.w); }
  const pn = s.panel;
  const useCab = pn && pn.cabW && pn.cabH && pn.pxW && pn.pxH;
  if (!useCab && (!s.pitch || s.pitch <= 0)) return null;
  const fmt = (m) => (Math.round(m * 100) / 100).toString().replace('.', ',') + 'm';
  if (useCab) return fmt(s.w / pn.pxW * pn.cabW / 1000) + ' × ' + fmt(s.h / pn.pxH * pn.cabH / 1000);
  const f = (v) => {
    const m = v * s.pitch / 1000;
    return (Math.round(m * 100) / 100).toString().replace(/\.0+$/, '').replace('.', ',') + 'm';
  };
  return f(s.w) + ' × ' + f(s.h);
}

// ------------------------------------------------------------------ normalisation / migration
function deepAssign(target, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// keys that stay project-wide (output level)
export const GLOBAL_STYLE_KEYS = ['blendView', 'info', 'infoScale', 'infoColor', 'infoBg', 'footer', 'footerTemplate', 'footerScale', 'footerColor', 'footerCorner', 'footerLogo', 'footerLogoId'];

/** Effective style of a surface = project style + surface overrides. */
export function effStyle(p, s) {
  const o = s && s.style;
  if (!o || !Object.keys(o).length) return p.style;
  const r = { ...p.style, ...o };
  for (const k of GLOBAL_STYLE_KEYS) r[k] = p.style[k];
  r.anim = { ...p.style.anim, ...(o.anim || {}) };
  return r;
}

function migrateStyle(st) {
  if (!st) return st;
  delete st.circleMode; delete st.useLogoInLabel;
  for (const k of ['logoCorner', 'logoSize', 'logoMax', 'logoOpacity', 'logoMargin']) delete st[k];
  if (Array.isArray(st.logoSlots)) st.logoSlots = st.logoSlots.map((x) => newLogoSlot(x));
  if (Array.isArray(st.textSlots)) st.textSlots = st.textSlots.map((x) => newTextSlot(x));
  return st;
}

/** Fill missing fields so older / hand-edited files keep working. */
export function normalizeProject(raw) {
  const base = newProject();
  const p = {
    ...base,
    ...raw,
    composition: { ...base.composition, ...(raw.composition || {}) },
    grid: { ...base.grid, ...(raw.grid || {}) },
    processor: { ...base.processor, ...(raw.processor || {}), ...(raw.processor && !('headroom' in raw.processor) ? { headroom: 100 } : {}) },   // older files: no headroom (same ports as before)
    power: { ...base.power, ...(raw.power || {}), ...(raw.power && !('autoNumber' in raw.power) ? { autoNumber: false } : {}) },   // older files: circuits numbered per screen
    cabling: newCablingMethod(raw.cabling || {}),
    style: migrateStyle(deepAssign(defaultStyle(), raw.style || {})),
    outputs: (raw.outputs && raw.outputs.length ? raw.outputs : base.outputs).map((o) => newOutput(o)),
    surfaces: (raw.surfaces || []).map((s) => { const x = newSurface(s); x.style = migrateStyle({ ...(s.style || {}) }); return x; }),
    slices: [],
    logos: (raw.logos || []).filter((l) => l && l.id).map((l) => ({ id: l.id, name: l.name || 'Logo', data: l.data || null })),
    gradient: newGradient(raw.gradient || {}),
    stage: { ...newStage(), ...(raw.stage || {}) },
    projectors: (raw.projectors || []).map((x) => {
      const pj = newProjector(x);
      // ≤ 1.28.0: Barco shift ranges were stored in Barco's own (half-image) convention
      if (!('shiftConv' in x) && /barco/i.test(x.brand || '')) { pj.shiftConv = 'half'; pj.shiftRangeV = pj.shiftRangeV.map((v) => v / 2); pj.shiftRangeH = pj.shiftRangeH.map((v) => v / 2); }
      return pj;
    })
  };
  delete p.logo;
  if (Array.isArray(raw.gradient && raw.gradient.stops)) p.gradient.stops = raw.gradient.stops.map((x) => ({ c: x.c, p: toNum(x.p, 0) }));
  // ≤ 1.10: one logo + logoCorner settings → library + one bottom-right slot
  if (raw.logo && !p.logos.length) p.logos.push({ id: 'logo_main', name: 'Logo', data: raw.logo });
  const oldSlot = (st) => newLogoSlot({ id: 'lgs_default', size: st.logoSize ?? 0.16, max: st.logoMax ?? 400, opacity: st.logoOpacity ?? 0.9, margin: st.logoMargin ?? 0.035 });
  if (raw.style && !raw.style.logoSlots && ('logoCorner' in raw.style || 'logoSize' in raw.style)) p.style.logoSlots = raw.style.logoCorner === false ? [] : [oldSlot(raw.style)];
  p.surfaces.forEach((x, i) => {
    const o = (raw.surfaces[i] || {}).style || {};
    if (!o.logoSlots && ['logoCorner', 'logoSize', 'logoMax', 'logoOpacity', 'logoMargin'].some((k) => k in o)) x.style.logoSlots = o.logoCorner === false ? [] : [oldSlot({ ...(raw.style || {}), ...o })];
  });
  if (!Array.isArray(p.style.logoSlots)) p.style.logoSlots = [newLogoSlot({ id: 'lgs_default' })];
  p.stage.render = newRender((raw.stage || {}).render || {});
  p.stage.crowd = newCrowd((raw.stage || {}).crowd || {});
  p.stage.video = { comp: '', compLabel: '', overlay: false, show2d: true, ...((raw.stage || {}).video || {}) };
  p.stage.models = (p.stage.models || []).map((m) => newModel3d(m));
  p.stage.people = (p.stage.people || []).map((x) => newPerson(x));
  p.stage.rails = (p.stage.rails || []).map((r) => newRail(r));
  p.stage.views = p.stage.views || [];
  const ids = new Set(p.surfaces.map((s) => s.id));
  const outs = new Set(p.outputs.map((o) => o.id));
  p.slices = (raw.slices || []).filter((sl) => ids.has(sl.surfaceId)).map((sl) => {
    const scr = getSurface(p, sl.surfaceId);
    const s = newSlice(scr, outs.has(sl.out) ? sl.out : p.outputs[0].id, sl);
    return s;
  });
  p.projectors.forEach((pj) => { if (pj.out && !outs.has(pj.out)) pj.out = ''; });
  if (!raw.surfaces) { p.surfaces = base.screens; p.slices = base.slices.map((s) => ({ ...s, out: p.outputs[0].id })); }
  return p;
}

/** Simple shelf packing of slices inside an output. Returns true if everything fit. */
export function shelfPack(slices, outW, outH, gap = 0) {
  const items = slices.map((sl) => ({ sl, ...sliceDims(sl) })).sort((a, b) => b.dh - a.dh || b.dw - a.dw);
  let x = 0, y = 0, rowH = 0, ok = true;
  for (const it of items) {
    if (x + it.dw > outW && x > 0) { x = 0; y += rowH + gap; rowH = 0; }
    it.sl.x = x; it.sl.y = y;
    if (y + it.dh > outH || it.dw > outW) ok = false;
    x += it.dw + gap; rowH = Math.max(rowH, it.dh);
  }
  return ok;
}

/** Find a free spot for a w×h rect inside an output among existing rects (grid scan). */
export function findFreeSpot(rects, w, h, outW, outH, step = 64) {
  const hit = (x, y) => rects.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
  for (let y = 0; y + h <= outH; y += step) {
    for (let x = 0; x + w <= outW; x += step) {
      if (!hit(x, y)) return { x, y };
    }
  }
  return null;
}

export function formatFooter(tpl, project, output) {
  return String(tpl || '')
    .replace(/\{project\}/g, project.name || '')
    .replace(/\{output\}/g, output.name || '')
    .replace(/\{w\}/g, output.w)
    .replace(/\{h\}/g, output.h);
}

// ------------------------------------------------------------------ LED data chain
/**
 * Ordered tile chain split into ports.
 * flow: rows | cols ; pattern: serpentine | zigzag | straight ; start: tl | tr | bl | br
 * Returns { ports: [ [ {c,r}, ... ], ... ], tilePx, portPx }
 */
export function dataChain(s, processor) {
  const ti = tileInfo(s);
  const d = s.data || {};
  const cap = portCapacity(processor || {});
  const portPx = toNum(d.portPx, 0) > 0 ? toNum(d.portPx, 0) : cap.px;
  const tilePx = Math.round(ti.tw) * Math.round(ti.th);
  // usable share of the port (« charge max visée ») and the processor's chain limit (Brompton: 50 cabinets)
  let perPort = toInt(d.perPort, 0) > 0 ? toInt(d.perPort, 0) : Math.max(1, Math.floor(portPx * portHeadroom(processor) / Math.max(1, tilePx)));
  if (cap.chain > 0) perPort = Math.min(perPort, cap.chain);
  const userChain = toInt(d.chainMax, 0) > 0 ? toInt(d.chainMax, 0) : toInt((processor || {}).chainMax, 0);   // cabinet maker's limit per data chain (surface, else project)
  if (userChain > 0) perPort = Math.min(perPort, userChain);
  return { ports: buildChain(s, d, perPort), tilePx, portPx, perPort };
}

/** Power circuits: cabinets per circuit = perCircuit, or floor(V*A / Wmax). */
/**
 * Power circuits. Cabinets per circuit = perCircuit (surface), else the smallest of:
 *   watts   — V × A × derate ÷ W per cabinet (basis 'max' or 'avg')
 *   leakage — half of the RCD rating ÷ leakage per cabinet (a 30 mA RCD may trip from 15 mA; ~2–3 mA per cabinet)
 *   chain   — cabinets per powerCON chain (maker's limit)
 * followData: the circuits take the data path (flow / pattern / start of the data cabling).
 */
export function powerChain(s, power, method = null) {
  const pw = s.power || {};
  power = power || {};
  let per = toInt(pw.perCircuit, 0);
  const limits = powerLimits(s, power);
  if (per <= 0) per = limits.per;
  if (per <= 0) return { circuits: [], per: 0, limits };
  // the power path follows the data path only while the surface keeps the project's power path; a surface with its own
  // power settings (sens / motif / départ / équilibrage / lignes entières) is laid out exactly as set
  const path = method && method.followData && s.data && powerFollowsMethod(method, s)
    ? { ...pw, flow: s.data.flow, pattern: s.data.pattern === 'straight' ? 'serpentine' : s.data.pattern, start: s.data.start, balance: !!s.data.balance, wholeLines: !!s.data.wholeLines }
    : pw;
  return { circuits: buildChain(s, path, Math.max(1, per)), per, limits, path };
}
/** Does a surface keep the project's power path (no own sens / motif / départ / équilibrage / lignes entières / dalles par circuit)? */
export function powerFollowsMethod(method, s) {
  const md = methodSurfaceData(method || newCablingMethod()).power, x = s.power || {};
  return x.flow === md.flow && x.pattern === md.pattern && x.start === md.start && !!x.balance === md.balance && !!x.wholeLines === md.wholeLines && !(toInt(x.perCircuit, 0) > 0);
}
/** Cabinets per circuit allowed by each rule: { watts, leak, chain, per, by }. 0 = no limit from that rule. */
export function powerLimits(s, power) {
  const pw = s.power || {};
  const w = toNum(power.basis === 'avg' ? (pw.wattsAvg || pw.wattsMax) : pw.wattsMax, 0);
  const derate = Math.min(1, Math.max(0.5, toNum(power.derate, 100) / 100));
  // the cabinet-to-cabinet link (powerCON TRUE1: 16 A EU / 20 A US) caps a chain even on a bigger circuit
  const amps = toNum(power.linkAmps, 0) > 0 ? Math.min(toNum(power.amps, 16), toNum(power.linkAmps, 0)) : toNum(power.amps, 16);
  const watts = w > 0 ? Math.floor(toNum(power.voltage, 230) * amps * derate / w) : 0;
  const leakMa = toNum(pw.leakMa, 0) > 0 ? toNum(pw.leakMa, 0) : toNum(power.leakMa, 0);          // cabinet data sheet (surface), else project
  const leak = leakMa > 0 ? Math.floor((toNum(power.rcdMa, 30) / 2) / leakMa) : 0;
  const chain = toInt(pw.chainMax, 0) > 0 ? toInt(pw.chainMax, 0) : toInt(power.chainMax, 0);
  const cand = [['watts', watts], ['leak', leak], ['chain', chain]].filter(([, v]) => v > 0);
  if (!cand.length) return { watts, leak, chain, per: 0, by: '' };
  const best = cand.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { watts, leak, chain, per: Math.max(1, best[1]), by: best[0] === 'watts' && toNum(power.linkAmps, 0) > 0 && toNum(power.linkAmps, 0) < toNum(power.amps, 16) ? 'link' : best[0] };
}
/**
 * Main supply (« alimentation générale »): rating per phase and number of phases. a = 0: not set.
 * Multicores (« multis ») of the hire company: a circuit = one way of the multi (its rating caps the circuit).
 * Harting: 6 pins = 3 circuits, 10 = 5, 16 = 6 or 8 (depends on the wiring), 24 = 12; Socapex 19 points = 6 circuits.
 */
export const MAINS = [
  { id: 'm400', a: 400, ph: 3, conn: 'Powerlock / Camlock' }, { id: 'm250', a: 250, ph: 3, conn: 'Powerlock / Camlock' }, { id: 'm125', a: 125, ph: 3, conn: 'P17 125 A' },
  { id: 'm63', a: 63, ph: 3, conn: 'P17 63 A' }, { id: 'm32', a: 32, ph: 3, conn: 'P17 32 A' }, { id: 'm16', a: 16, ph: 3, conn: 'P17 16 A' },
  { id: 'm32m', a: 32, ph: 1, conn: 'P17 32 A mono' }, { id: 'm16m', a: 16, ph: 1, conn: 'P17 16 A / Schuko' }
];
export const MULTIS = {
  direct:    { label: 'Direct (sans multi)', circuits: 0, amps: 0 },
  harting6:  { label: 'Harting 6 broches', circuits: 3, amps: 16 },
  harting10: { label: 'Harting 10 broches', circuits: 5, amps: 16 },
  harting16_6: { label: 'Harting 16 broches — 6 circuits', circuits: 6, amps: 16 },
  harting16_8: { label: 'Harting 16 broches — 8 circuits', circuits: 8, amps: 16 },
  harting24: { label: 'Harting 24 broches', circuits: 12, amps: 16 },
  soca16:    { label: 'Socapex 19 points (EU)', circuits: 6, amps: 16 },
  soca20:    { label: 'Socapex 19 points (USA)', circuits: 6, amps: 20 },
  custom:    { label: 'Autre multi', circuits: 0, amps: 0 }
};
/** Multi in use: { id, label, circuits, amps } (custom = the typed values); null for direct circuits. */
export function multiOf(power) {
  const id = (power && power.multi) || 'direct';
  if (id === 'direct' || !MULTIS[id]) return null;
  if (id === 'custom') return { id, label: MULTIS.custom.label, circuits: Math.max(1, toInt(power.multiCircuits, 6)), amps: Math.max(1, toNum(power.multiAmps, 16)) };
  return { id, ...MULTIS[id] };
}
/** Standard supply ratings (A per phase) and the smallest that carries a load with 20 % headroom. */
export const SUPPLY_SIZES = [16, 32, 63, 125, 250, 400];
export function supplyAdvice(ampsPerPhase) {
  const need = ampsPerPhase / 0.8;
  return { need, size: SUPPLY_SIZES.find((x) => x >= need) || null };
}
/** Power figures of a project: total W (basis), A per phase, circuits per phase, recommended supply, surfaces without W. */
export function powerSummary(p) {
  const pw = p.power || {};
  const V = Math.max(1, toNum(pw.voltage, 230));
  const tri = toInt(pw.phases, 1) >= 3;
  const cs = circuitStarts(p);
  const res = { W: 0, Wmax: 0, Wavg: 0, circuits: 0, perPhase: [0, 0, 0], circuitsPhase: [0, 0, 0], noWatts: [], limits: {}, tri };
  for (const s of p.surfaces) {
    if (s.kind === 'proj') continue;
    const n = Math.max(0, tileInfo(s).total);
    const wm = toNum(s.power.wattsMax, 0), wa = toNum(s.power.wattsAvg, 0) || wm;
    if (!(wm > 0)) { res.noWatts.push(s); continue; }
    res.Wmax += n * wm; res.Wavg += n * wa;
    const w = pw.basis === 'avg' ? wa : wm;
    const ch = powerChain(s, pw, p.cabling);
    res.circuits += ch.circuits.length;
    if (ch.limits && ch.limits.by) res.limits[ch.limits.by] = (res.limits[ch.limits.by] || 0) + 1;
    ch.circuits.forEach((c, k) => { const ph = tri ? (cs[s.id] + k - 1) % 3 : 0; res.perPhase[ph] += c.length * w; res.circuitsPhase[ph]++; });
  }
  res.W = pw.basis === 'avg' ? res.Wavg : res.Wmax;
  res.ampsPhase = res.perPhase.map((w) => w / V);
  const worst = tri ? Math.max(...res.ampsPhase) : res.ampsPhase[0];
  res.advice = supplyAdvice(worst);
  res.imbalance = tri && worst > 0 ? (worst - Math.min(...res.ampsPhase)) / worst : 0;
  // main supply check: load of the worst phase against the rating (80 % = comfortable)
  const mainsA = toNum(pw.mainsA, 0);
  res.mains = mainsA > 0 ? { a: mainsA, load: worst / mainsA, ok: worst <= mainsA * 0.8, over: worst > mainsA, feeds: Math.ceil(worst / (mainsA * 0.8)) || 1 } : null;
  // multicores needed (a multi carries `circuits` circuits; on three phase they are spread over the phases)
  const mu = multiOf(pw);
  res.multi = mu ? { ...mu, count: Math.ceil(res.circuits / mu.circuits) } : null;
  return res;
}
/** Phase of a circuit (1-based global circuit number) on a three-phase supply: L1, L2, L3 in turn; '' on single phase. */
export function circuitPhase(power, g) { return toInt(power && power.phases, 1) >= 3 ? 'L' + (((g - 1) % 3) + 1) : ''; }

/** Tiles of every cabling line, in chain order (virtual tiles removed; empty lines kept so serpentine stays aligned). */
function chainLines(s, d) {
  const ti = tileInfo(s);
  const virt = new Set(s.virtual || []);
  const start = d.start || 'tl';
  const fromRight = start === 'tr' || start === 'br';
  const fromBottom = start === 'bl' || start === 'br';
  const byRows = (d.flow || 'rows') === 'rows';
  const nLines = byRows ? ti.rows : ti.cols;
  const len = byRows ? ti.cols : ti.rows;
  const out = [];
  for (let li = 0; li < nLines; li++) {
    const line = byRows ? (fromBottom ? ti.rows - 1 - li : li) : (fromRight ? ti.cols - 1 - li : li);
    let forward = byRows ? !fromRight : !fromBottom;
    if (d.pattern === 'serpentine' && li % 2 === 1) forward = !forward;
    const tiles = [];
    for (let k = 0; k < len; k++) {
      const q = forward ? k : len - 1 - k;
      const c = byRows ? q : line, r = byRows ? line : q;
      if (!virt.has(c + ',' + r)) tiles.push({ c, r });
    }
    out.push(tiles);
  }
  return out;
}
/** n parts of an array, sizes as equal as possible (larger first). */
function evenParts(arr, n) {
  const out = [], base = Math.floor(arr.length / n), extra = arr.length % n;
  let i = 0;
  for (let k = 0; k < n; k++) { const m = base + (k < extra ? 1 : 0); out.push(arr.slice(i, i + m)); i += m; }
  return out.filter((x) => x.length);
}
/** Contiguous groups of units (each an array of tiles), each ≤ cap tiles, fewest groups; balance = same count of groups
 *  but sizes as even as possible (minimum sum of squares, dynamic programming). */
function packUnits(units, cap, balance) {
  const g = [];
  let cur = [], n = 0;
  for (const u of units) { if (cur.length && n + u.length > cap) { g.push(cur); cur = []; n = 0; } cur.push(u); n += u.length; }
  if (cur.length) g.push(cur);
  if (!balance || g.length < 2 || units.length > 400) return g.map((x) => x.flat());
  const U = units.length, G = g.length, pre = [0];
  for (const u of units) pre.push(pre[pre.length - 1] + u.length);
  const INF = Infinity;
  const cost = Array.from({ length: G + 1 }, () => new Array(U + 1).fill(INF));
  const from = Array.from({ length: G + 1 }, () => new Array(U + 1).fill(-1));
  cost[0][0] = 0;
  for (let k = 1; k <= G; k++) for (let j = 1; j <= U; j++) for (let i = j - 1; i >= 0; i--) {
    const w = pre[j] - pre[i];
    if (w > cap) break;
    if (cost[k - 1][i] === INF) continue;
    const c = cost[k - 1][i] + w * w;
    if (c < cost[k][j]) { cost[k][j] = c; from[k][j] = i; }
  }
  if (cost[G][U] === INF) return g.map((x) => x.flat());
  const out = [];
  for (let k = G, j = U; k > 0; k--) { const i = from[k][j]; out.unshift(units.slice(i, j).flat()); j = i; }
  return out;
}
/**
 * Ports (or circuits) of a surface. Options in d:
 *   balance    — ports of even size (15 tiles on 13-tile ports → 8 + 7, not 13 + 2)
 *   wholeLines — a port only takes whole lines (no restart in the middle of the screen); a line longer than a port is
 *                split in even parts
 * pattern 'straight' = one line per port.
 */
function buildChain(s, d, perPort) {
  const lines = chainLines(s, d).filter((l) => l.length);
  const cap = Math.max(1, perPort);
  const straight = d.pattern === 'straight';
  if (straight || d.wholeLines) {
    const units = [];
    for (const l of lines) {
      if (l.length <= cap) units.push(l);
      else if (d.balance || d.wholeLines) units.push(...evenParts(l, Math.ceil(l.length / cap)));
      else for (let i = 0; i < l.length; i += cap) units.push(l.slice(i, i + cap));
    }
    return straight ? units : packUnits(units, cap, !!d.balance);
  }
  const flat = lines.flat();
  if (!flat.length) return [];
  if (d.balance) return evenParts(flat, Math.ceil(flat.length / cap));
  const ports = [];
  for (let i = 0; i < flat.length; i += cap) ports.push(flat.slice(i, i + cap));
  return ports;
}

/** Cable figures of a chain: jumper length (m, tile centre to tile centre), ports restarting mid-line, load of each port. */
export function chainStats(s, ports, perPort, d = {}) {
  const ti = tileInfo(s);
  const pn = s.panel;
  let mx, my;
  if (pn && pn.cabW && pn.cabH && pn.pxW && pn.pxH) { mx = pn.cabW / pn.pxW / 1000; my = pn.cabH / pn.pxH / 1000; } else mx = my = (s.pitch > 0 ? s.pitch : 3.9) / 1000;
  const tw = ti.tw * mx, th = ti.th * my;
  let len = 0, mid = 0;
  const lines = chainLines(s, d);
  const firstOfLine = new Set(lines.filter((l) => l.length).map((l) => l[0].c + ',' + l[0].r));
  for (const port of ports) {
    for (let i = 1; i < port.length; i++) len += Math.hypot((port[i].c - port[i - 1].c) * tw, (port[i].r - port[i - 1].r) * th);
    if (port.length && !firstOfLine.has(port[0].c + ',' + port[0].r)) mid++;
  }
  const usage = ports.map((pt) => pt.length / Math.max(1, perPort));
  return { length: len, midStarts: mid, usage, minUsage: usage.length ? Math.min(...usage) : 0, maxUsage: usage.length ? Math.max(...usage) : 0 };
}

/** Load of every data port of a surface (0..1 of the port's pixel capacity). */
export function portUsage(s, processor) {
  const { ports, tilePx, portPx } = dataChain(s, processor);
  return ports.map((pt) => (pt.length * tilePx) / Math.max(1, portPx));
}

/**
 * Best data cabling for a surface, keeping its start corner (and « whole lines » when set): fewest ports, then no restart
 * mid-line, then the shortest jumpers, then even loads. Returns { flow, pattern, wholeLines, balance, ports, length, ... }.
 */
export function optimizeData(s, processor) {
  const d0 = s.data || {};
  const keepWhole = !!d0.wholeLines;              // « lignes entières » is the user's rule: kept by the optimiser
  const cands = [];
  for (const flow of ['rows', 'cols']) for (const pattern of ['serpentine', 'zigzag', 'straight']) for (const wholeLines of [true, false]) {
    if (pattern === 'straight' && !wholeLines) continue;
    if (keepWhole && !wholeLines) continue;
    const d = { ...d0, flow, pattern, wholeLines, balance: true };
    const ch = dataChain({ ...s, data: d }, processor);
    const st = chainStats(s, ch.ports, ch.perPort, d);
    const spread = st.maxUsage - st.minUsage;
    cands.push({ flow, pattern, wholeLines, balance: true, ports: ch.ports.length, ...st, spread, same: flow === (d0.flow || 'rows') ? 0 : 1 });
  }
  cands.sort((a, b) => a.ports - b.ports || a.midStarts - b.midStarts || a.length - b.length || a.spread - b.spread || a.same - b.same);
  // lengths within 1 % are a tie: keep the user's flow
  const best = cands[0];
  const tie = cands.find((c) => c.ports === best.ports && c.midStarts === best.midStarts && c.length <= best.length * 1.01 && c.same === 0);
  return tie || best;
}

/** Real capacity of one port: { px, estimated, src, chain }. Custom = the typed px/port at 60 Hz 8 bit, scaled. */
export function portCapacity(proc) {
  proc = proc || {};
  const fps = Math.max(1, toNum(proc.fps, 60));
  const bd = [8, 10, 12].includes(toInt(proc.bitDepth, 8)) ? toInt(proc.bitDepth, 8) : 8;
  const P = PROCESSORS[proc.type];
  if (!P || !P.cap) {
    const base = toNum(proc.portPx, 650000);
    return { px: Math.floor(base * (60 / fps) * (8 / bd)), estimated: bd !== 8 || fps !== 60, src: '', chain: 0, custom: true };
  }
  const c = P.cap;
  const px = c.kind === 'nova' ? 0.95e9 / (c.bpp[bd] * fps) : c.base * (c.fps0 / fps) * c.bits[bd];
  return { px: Math.floor(px), estimated: (P.est || []).includes(bd), src: P.src || '', chain: P.chain || 0 };
}
/** Pixels per port, as the data sheets give them for this frame rate / bit depth. */
export function effPortPx(proc) { return portCapacity(proc).px; }
/** Share of a port the cabling may use (0.5–1): « charge max visée ». Old projects: 1. */
export function portHeadroom(proc) { const h = toNum(proc && proc.headroom, 100); return Math.min(1, Math.max(0.5, h / 100)); }

/** Main ports a processor can take: half of its ports when every main port is paired with its neighbour (Brompton loop). */
export function procMainCap(proc) {
  const ppp = Math.max(1, toInt(proc && proc.portsPerProc, 16));
  return (proc && proc.redundancy) === 'pair' ? Math.max(1, Math.floor(ppp / 2)) : ppp;
}
/** Processor (1-based) and physical port on it of a global main-port index g. */
export function procSlot(proc, g) {
  const ppp = Math.max(1, toInt(proc && proc.portsPerProc, 16));
  const ix = (proc && proc.redundancy) === 'pair' ? 2 * g - 1 : g;
  return { proc: Math.ceil(ix / ppp), port: ((ix - 1) % ppp) + 1 };
}
/** Output a surface belongs to for the port allocation: the output of its first slice (outputs in project order). */
function surfaceOutputIndex(p, s) {
  let best = Infinity;
  for (const sl of p.slices || []) if (sl.surfaceId === s.id) { const i = p.outputs.findIndex((o) => o.id === sl.out); if (i >= 0 && i < best) best = i; }
  return best;
}
/**
 * First global port index of every surface.
 * Auto numbering follows the list order with two rig rules (processor settings, both on by default):
 *   outPerProc — one media-server output per processor: the screens of an output are grouped and each output starts on a
 *                new processor (an output bigger than one processor takes as many whole processors as it needs);
 *   noSplit    — a screen never straddles two processors: if its ports do not fit in what is left, it starts on the next
 *                one (a screen needing more ports than one processor starts on a fresh processor).
 * Manual numbering (autoNumber off) keeps each surface's portStart.
 */
export function portStarts(p) {
  const res = {};
  const proc = p.processor || {};
  let total = 0;
  if (proc.autoNumber === false) {
    for (const s of p.surfaces) {
      const n = s.kind === 'proj' ? 0 : dataChain(s, proc).ports.length;
      const start = Math.max(1, toInt(s.data.portStart, 1));
      res[s.id] = start; total = Math.max(total, start + n - 1);
    }
    res.__total = total;
    return res;
  }
  const cap = procMainCap(proc);
  const byOut = proc.outPerProc !== false;
  const noSplit = proc.noSplit !== false;
  const list = p.surfaces.map((s, i) => ({ s, i, o: byOut ? surfaceOutputIndex(p, s) : 0, n: s.kind === 'proj' ? 0 : dataChain(s, proc).ports.length }));
  if (byOut) list.sort((a, b) => (a.o - b.o) || (a.i - b.i));
  const fresh = (g) => ((g - 1) % cap === 0 ? g : (Math.floor((g - 1) / cap) + 1) * cap + 1);   // first port of the next processor
  let next = 1, lastOut = null;
  for (const it of list) {
    if (!it.n) { res[it.s.id] = next; continue; }
    if (byOut && lastOut !== null && it.o !== lastOut) next = fresh(next);
    lastOut = it.o;
    if (noSplit) {
      const used = (next - 1) % cap;
      if (used && (it.n > cap || used + it.n > cap)) next = fresh(next);
    }
    res[it.s.id] = next;
    next += it.n;
    total = Math.max(total, next - 1);
  }
  res.__total = total;
  return res;
}
/** Screens whose ports still straddle two processors (only possible when a screen needs more ports than one processor). */
export function splitScreens(p) {
  const st = portStarts(p), out = [];
  for (const s of p.surfaces) {
    const n = s.kind === 'proj' ? 0 : dataChain(s, p.processor).ports.length;
    if (!n) continue;
    const a = procSlot(p.processor, st[s.id]).proc, b = procSlot(p.processor, st[s.id] + n - 1).proc;
    if (a !== b) out.push({ s, from: a, to: b, n });
  }
  return out;
}

/** Port name presets for the « template » naming ({n} global number, {proc} processor, {port} port on it, {port2} 2 digits,
 *  {side} A / B with processor redundancy). */
export const PORT_TEMPLATES = ['P{n}', '{proc}:{port2}', '{side}{proc}-{port}', 'Port {port}', 'XD{proc}·{port}', 'Out {n}'];
export function formatPortTemplate(tpl, idx, ppp, side) {
  const proc = Math.ceil(idx / ppp), port = ((idx - 1) % ppp) + 1;
  return String(tpl || 'P{n}').replace(/\{n\}/g, idx).replace(/\{proc\}/g, proc).replace(/\{port2\}/g, String(port).padStart(2, '0')).replace(/\{port\}/g, port).replace(/\{side\}/g, side || '');
}
function fmtPort(p, idx, prefix) {
  const ppp = Math.max(1, toInt(p.processor.portsPerProc, 16));
  if (p.processor.portLabel === 'tpl') {
    const tpl = p.processor.portTpl || 'P{n}';
    // processor redundancy and no {side} in the template: add the A / B in front so main and backup stay distinct
    const name = formatPortTemplate(tpl, idx, ppp, prefix);
    return prefix && !tpl.includes('{side}') ? prefix + (/^[A-Za-z]/.test(name) ? ' ' : '') + name : name;
  }
  if (p.processor.portLabel === 'num') return `${prefix}${idx}`;
  if (p.processor.portLabel === 'proc') {
    const proc = Math.ceil(idx / ppp), port = ((idx - 1) % ppp) + 1;
    return `${prefix}${proc}:${String(port).padStart(2, '0')}`;
  }
  return `${prefix || 'P'}${idx}`;
}

/** Labels { main, backup } of every port of a surface. */
export function portLabels(p, s) {
  const st = portStarts(p);
  const start = st[s.id] || 1;
  const N = st.__total;
  const red = p.processor.redundancy || 'none';
  return dataChain(s, p.processor).ports.map((_, k) => {
    const g = start + k;
    if (red === 'processor') return { g, main: fmtPort(p, g, 'A'), backup: fmtPort(p, g, 'B') };
    if (red === 'pair') return { g, main: fmtPort(p, 2 * g - 1, ''), backup: fmtPort(p, 2 * g, '') };   // closed loop on the neighbour port (1→2, 3→4: Brompton)
    if (red === 'port') return { g, main: fmtPort(p, g, ''), backup: 'R·' + fmtPort(p, g + N, '') };
    return { g, main: fmtPort(p, g, ''), backup: null };
  });
}

export function surfaceStats(p, s) {
  if (s.kind === 'proj') return { tiles: 0, ports: 0, circuits: 0, wattsMax: 0, wattsAvg: 0, kg: 0 };
  const ti = tileInfo(s);
  const tiles = Math.max(0, ti.total);
  const pw = s.power || {};
  return {
    tiles,
    ports: dataChain(s, p.processor).ports.length,
    circuits: powerChain(s, p.power, p.cabling).circuits.length,
    wattsMax: tiles * toNum(pw.wattsMax, 0),
    wattsAvg: tiles * toNum(pw.wattsAvg, 0),
    kg: tiles * toNum(pw.kg, 0)
  };
}

/** First global circuit number of every surface: continued in list order (power.autoNumber) or per surface (circuitStart). */
export function circuitStarts(p) {
  const res = {};
  let next = 1;
  for (const s of p.surfaces) {
    const n = powerChain(s, p.power, p.cabling).circuits.length;
    const start = p.power && p.power.autoNumber !== false ? next : Math.max(1, toInt(s.power && s.power.circuitStart, 1));
    res[s.id] = start;
    next = Math.max(next, start + n);
  }
  return res;
}

export function cablingSummary(p) {
  const tot = { ports: 0, circuits: 0, wattsMax: 0, wattsAvg: 0, kg: 0, tiles: 0, per: {} };
  for (const s of p.surfaces) {
    const st = surfaceStats(p, s);
    tot.per[s.id] = st;
    for (const k of ['ports', 'circuits', 'wattsMax', 'wattsAvg', 'kg', 'tiles']) tot[k] += st[k];
  }
  const ppp = Math.max(1, toInt(p.processor.portsPerProc, 16));
  const red = p.processor.redundancy || 'none';
  const mains = Math.max(tot.ports, portStarts(p).__total);
  tot.mainPorts = mains;
  tot.backupPorts = red === 'none' ? 0 : mains;
  tot.mainProcs = red === 'pair' ? (mains ? procSlot(p.processor, mains).proc : 0) : red === 'port' ? Math.ceil(2 * mains / ppp) : Math.ceil(mains / ppp);
  tot.backupProcs = red === 'processor' ? Math.ceil(mains / ppp) : 0;
  tot.procs = tot.mainProcs + tot.backupProcs;
  tot.effPortPx = effPortPx(p.processor);
  // load per phase (three-phase supply: circuits on L1 / L2 / L3 in turn)
  tot.phaseW = [0, 0, 0];
  if (toInt(p.power.phases, 1) >= 3) {
    const cs = circuitStarts(p);
    for (const s of p.surfaces) {
      if (s.kind === 'proj') continue;
      const w = toNum(p.power.basis === 'avg' ? (s.power.wattsAvg || s.power.wattsMax) : s.power.wattsMax, 0);
      powerChain(s, p.power, p.cabling).circuits.forEach((c, k) => { tot.phaseW[(cs[s.id] + k - 1) % 3] += c.length * w; });
    }
  }
  return tot;
}

/** Viewing distance from pixel pitch (rule of thumb: min = pitch mm in metres, optimal = ×3). */
export function viewingDistance(pitch) {
  if (!pitch || pitch <= 0) return null;
  return { min: Math.round(pitch * 10) / 10, opt: Math.round(pitch * 3 * 10) / 10 };
}
export function kva(watts, pf) { return watts / 1000 / Math.max(0.1, toNum(pf, 0.95)); }

// ------------------------------------------------------------------ animation loop length
/** Period (s) of one full animation cycle for a style (null = no motion). */
export function animPeriod(st) {
  const a = st && st.anim;
  if (!a || !a.enabled) return null;
  const sp = Math.max(0.05, toNum(a.speed, 1));
  if (a.type === 'blink') return 1 / sp;           // on/off pair
  return 4 / sp;                                    // scan, bar, cross, sweep
}

/**
 * Seamless loop length (s) of a view: least common multiple of every visible surface's period
 * (surfaces can override speed). Falls back to the longest period if the LCM exceeds maxLen.
 */
export function loopDuration(p, view, maxLen = 120) {
  const surf = view === 'comp' ? p.surfaces : [...new Set(p.slices.filter((sl) => sl.out === view).map((sl) => sl.surfaceId))].map((id) => getSurface(p, id));
  const periods = [...new Set(surf.filter((s) => s && s.visible !== false).map((s) => animPeriod(effStyle(p, s))).filter(Boolean))];
  if (!periods.length) return null;
  // every period is 80/m s (speed steps of 0.05) -> LCM = 80 / gcd(m)
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const ms = periods.map((v) => Math.max(1, Math.round(80 / v)));
  const exact = periods.every((v, i) => Math.abs(80 / ms[i] - v) < 1e-6);
  const g = ms.reduce((acc, m) => gcd(acc, m));
  const lcm = 80 / g;
  if (!exact || lcm > maxLen) return { seconds: Math.max(...periods), exact: false };
  return { seconds: lcm, exact: true };
}
