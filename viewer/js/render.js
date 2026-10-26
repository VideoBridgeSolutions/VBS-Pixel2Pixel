// Pixel2Pixel — render engine (shared by editor + live output windows)
//
// Pipeline (Resolume-coherent):
//   Surface (LED screen, own pixel space) --pattern--> cached bitmap
//   Slice = src rect of a surface  -> placed on an Output (= Resolume Screen) with rotation/flip
//   Composition view = every surface at its Input Selection position.
//
// sliceSource() is the single place that decides where a slice's pixels come from.
// Today: the generated test pattern. Later (NDI input): a frame of the composition,
// sampled at the slice Input Selection — no change needed in the compositor.

import {
  tileInfo, surfacePalette, sliceDims, getSurface, slicesOfOutput, sliceName,
  mix, shade, hueShift, rgba, clamp, toNum, physicalSize, formatFooter,
  dataChain, powerChain, portLabels, PORT_COLORS, effStyle, portHeadroom, circuitStarts, circuitPhase,
  COMP_PATTERNS, formatSurfaceText, liveSourceOf, gradExtent, gradGeometry, gradT, gradColor, gradStops, gradLineStops, surfaceToComp, slotLogo, COLOR_PRESETS, hexToRgb
} from './model.js';

const MAX_SIDE = 16384;
const M_clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MAX_AREA = 120e6;

/** Piece of a screen split by « Séparer en écran indépendant »: the test pattern continues over the original screen. */
export function jointOf(s) {
  const j = s && s.joint;
  if (!j || j.on === false || !(j.w > 0) || !(j.h > 0)) return null;
  return { ox: +j.x || 0, oy: +j.y || 0, W0: +j.w, H0: +j.h, name: j.name || s.name };
}

export function compBox(s) {
  const r = ((s.comp.rot % 360) + 360) % 360;
  const swap = r === 90 || r === 270;
  return { x: s.comp.x, y: s.comp.y, w: swap ? s.h : s.w, h: swap ? s.w : s.h, rot: r };
}

export class Renderer {
  constructor(onAssetReady) {
    this.cache = new Map();      // surfaceId -> { key, canvas, k }
    this.logos = new Map();      // logo id -> { src, img, mono }
    this.liveProvider = null;    // key ('ndi:…' | 'dev:…') -> { img, w, h } | null — live inputs shown in 2D (editor / live outputs only)
    this.logoVer = 0;
    this.onAssetReady = onAssetReady || (() => {});
  }

  // ------------------------------------------------------------ assets (logo library)
  /** logos: [{ id, data }] — images decoded once, re-decoded only when their data changes. */
  syncLogos(logos) {
    const seen = new Set();
    for (const l of logos || []) {
      if (!l || !l.id || !l.data) continue;
      seen.add(l.id);
      const cur = this.logos.get(l.id);
      if (cur && cur.src === l.data) continue;
      const e = { src: l.data, img: null, mono: null };
      this.logos.set(l.id, e);
      const img = new Image();
      img.onload = () => { if (this.logos.get(l.id) === e) { e.img = img; this.logoVer++; this.onAssetReady(); } };
      img.src = l.data;
    }
    for (const id of [...this.logos.keys()]) if (!seen.has(id)) { this.logos.delete(id); this.logoVer++; }
  }
  /** Decoded image of a logo slot (mono = white silhouette, for sober looks). */
  slotImage(p, slot) {
    const l = slotLogo(p, slot);
    const e = l && this.logos.get(l.id);
    if (!e || !e.img) return null;
    if (!slot.mono) return e.img;
    if (!e.mono) {
      const c = document.createElement('canvas');
      c.width = e.img.naturalWidth || 512; c.height = e.img.naturalHeight || 512;
      const x = c.getContext('2d');
      x.drawImage(e.img, 0, 0, c.width, c.height);
      x.globalCompositeOperation = 'source-in'; x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, c.width, c.height);
      c.naturalWidth = c.width; c.naturalHeight = c.height;
      e.mono = c;
    }
    return e.mono;
  }
  logoById(p, id) { return this.slotImage(p, { logo: id || '' }); }
  /** Rectangle of the extra free logo of an output (output px), null when hidden / not loaded / locked (Free). */
  outLogoRect(p, out) {
    if (!out || !out.logo || !out.logo.show || this.brandLock) return null;
    const img = this.logoById(p, out.logo.id);
    if (!img) return null;
    const w = Math.max(1, toNum(out.logo.w, 400));
    return { x: toNum(out.logo.x, 0), y: toNum(out.logo.y, 0), w, h: w * img.naturalHeight / img.naturalWidth };
  }
  /** Pixel2Pixel logo (output footer default; the only one allowed in Free). */
  appLogo() {
    if (!this._appLogo) {
      const img = new Image();
      img.onload = () => { this._appLogoReady = true; this.onAssetReady(); };
      img.src = new URL('../assets/logo-256.png', import.meta.url).href;
      this._appLogo = img;
    }
    return this._appLogoReady ? this._appLogo : null;
  }
  /** Output footer: logo left of the text, the block in a corner (st.footerCorner = tl | tr | bl | br).
   *  brandLock (Free): Pixel2Pixel logo, always shown, even with the text off. */
  drawFooter(ctx, p, out, st) {
    const lock = !!this.brandLock;
    const f = out.footer || {};
    const id = f.logoId ?? st.footerLogoId ?? '@app';
    const img = (lock || (f.logo ?? st.footerLogo) !== false) ? (lock || !id || id === '@app' ? this.appLogo() : (this.logoById(p, id) || this.appLogo())) : null;
    const text = st.footer ? formatFooter(st.footerTemplate, p, out) : '';
    if (!text && !img) return;
    const fs = Math.max(10, out.h * 0.0115 * (st.footerScale || 1));
    ctx.font = `${fs}px ${fontStack(st.fontFamily)}`;
    const tw = text ? ctx.measureText(text).width : 0;
    const lh = img ? fs * 2 : 0;
    const lw = img ? lh * (img.naturalWidth || 1) / (img.naturalHeight || 1) : 0;
    const gap = img && text ? fs * 0.6 : 0;
    const bw = lw + gap + tw, bh = Math.max(lh, fs);
    const cr = f.corner ?? st.footerCorner;
    const c = /^(t|b)(l|r)$/.test(cr || '') ? cr : 'br';
    const mx = fs * 1.2, my = fs * 0.9;
    const x0 = c[1] === 'l' ? mx : out.w - mx - bw;
    const y0 = c[0] === 't' ? my : out.h - my - bh;
    if (img) { const sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = true; ctx.drawImage(img, x0, y0 + (bh - lh) / 2, lw, lh); ctx.imageSmoothingEnabled = sm; }
    if (text) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = st.footerColor || '#fff';
      ctx.fillText(text, x0 + lw + gap, y0 + bh / 2);
    }
  }

  /** Live picture of a screen, when its source is a live input and the project shows inputs in 2D. */
  liveOf(p, s, opts) {
    if (!opts || !opts.live || !this.liveProvider) return null;
    const v = p.stage && p.stage.video;
    if (v && v.show2d === false) return null;
    const l = liveSourceOf(p, s);
    if (!l) return null;
    const src = this.liveProvider(l.key);
    return src ? { ...src, mode: l.mode } : null;
  }
  /** Draw a live picture in surface space (0..w, 0..h): own source stretched, or the screen's Input Selection of the composition input. */
  drawLiveInSurface(ctx, p, s, lv) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if (lv.mode === 'full') ctx.drawImage(lv.img, 0, 0, s.w, s.h);
    else {
      const r = ((s.comp.rot % 360) + 360) % 360, sw = r === 90 || r === 270;
      const bw = sw ? s.h : s.w, bh = sw ? s.w : s.h;
      ctx.translate(s.w / 2, s.h / 2);
      if (s.comp.flip) ctx.scale(-1, 1);
      ctx.rotate(-r * Math.PI / 180);
      ctx.translate(-(s.comp.x + bw / 2), -(s.comp.y + bh / 2));
      ctx.drawImage(lv.img, 0, 0, p.composition.w, p.composition.h);
    }
    ctx.restore();
  }

  invalidate(id) { if (id) this.cache.delete(id); else this.cache.clear(); }

  // ------------------------------------------------------------ surface bitmap
  surfaceBitmap(p, s) {
    const st = effStyle(p, s);
    const styleKey = { ...st, anim: null, info: null, infoScale: null, infoColor: null, infoBg: null, footer: null, footerTemplate: null, footerScale: null, footerColor: null, footerCorner: null, footerLogo: null, footerLogoId: null };
    const chainKey = (st.cabling || st.powerPath || st.numbering === 'port') ? [s.data, s.power, p.processor, p.power, p.cabling, portLabels(p, s), st.powerPath ? circuitStarts(p)[s.id] : 0] : null;
    const compKey = COMP_PATTERNS.includes(s.pattern) ? [p.gradient, s.comp, gradExtent(p)] : null;
    const key = JSON.stringify([s.name, s.w, s.h, s.tile, s.pitch, s.pattern, s.colors, s.virtual, s.joint || null, { ...styleKey, logoSlots: null }, chainKey, compKey]);
    const hit = this.cache.get(s.id);
    if (hit && hit.key === key) return hit;

    const k = Math.min(1, MAX_SIDE / Math.max(s.w, s.h), Math.sqrt(MAX_AREA / (s.w * s.h)));
    const cw = Math.max(1, Math.round(s.w * k)), ch = Math.max(1, Math.round(s.h * k));
    const canvas = (hit && hit.canvas.width === cw && hit.canvas.height === ch) ? hit.canvas : document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawSurface(ctx, s, st, null, p);
    const entry = { key, canvas, k };
    this.cache.set(s.id, entry);
    return entry;
  }

  /** Where the pixels of a slice come from. */
  sliceSource(p, sl) {
    const s = getSurface(p, sl.surfaceId);
    if (!s) return null;
    const bm = this.surfaceBitmap(p, s);
    return { surface: s, img: bm.canvas, k: bm.k, sx: sl.src.x, sy: sl.src.y, sw: sl.src.w, sh: sl.src.h };
  }

  // ------------------------------------------------------------ output (Resolume Screen)
  drawOutput(ctx, p, out, opts = {}) {
    const t = opts.time ?? performance.now() / 1000;
    const st = p.style;
    ctx.save();
    ctx.imageSmoothingEnabled = !!opts.smooth;
    ctx.fillStyle = out.bg || '#000';
    ctx.fillRect(0, 0, out.w, out.h);

    const slices = slicesOfOutput(p, out.id);
    for (const sl of slices) {
      const src = this.sliceSource(p, sl);
      if (!src || src.surface.visible === false) continue;
      const ss = effStyle(p, src.surface);
      const d = sliceDims(sl);
      ctx.save();
      ctx.translate(sl.x + d.dw / 2, sl.y + d.dh / 2);
      ctx.rotate((sl.rot || 0) * Math.PI / 180);
      if (sl.flip) ctx.scale(-1, 1);
      ctx.scale(d.ow / src.sw, d.oh / src.sh);                 // scaled slice (output size ≠ input selection)
      ctx.beginPath(); ctx.rect(-src.sw / 2, -src.sh / 2, src.sw, src.sh); ctx.clip();
      const lv = this.liveOf(p, src.surface, opts);
      if (!lv) ctx.drawImage(src.img, src.sx * src.k, src.sy * src.k, src.sw * src.k, src.sh * src.k, -src.sw / 2, -src.sh / 2, src.sw, src.sh);
      // surface space, origin at the surface (0,0)
      ctx.translate(-src.sw / 2 - src.sx, -src.sh / 2 - src.sy);
      if (lv) this.drawLiveInSurface(ctx, p, src.surface, lv);
      const box = ss.labelPerSlice ? { x: src.sx, y: src.sy, w: src.sw, h: src.sh } : { x: 0, y: 0, w: src.surface.w, h: src.surface.h };
      if (!lv || (p.stage.video && p.stage.video.overlay)) this.decorate(ctx, src.surface, ss, box, t, p);
      const bmode = opts.blend || (opts.live ? (st.blendView || 'zones') : 'off');
      if (bmode !== 'off' && sl.blend && (sl.blend.l || sl.blend.r || sl.blend.t || sl.blend.b)) drawBlend(ctx, sl.blend, src.sx, src.sy, src.sw, src.sh, bmode);
      ctx.restore();
    }

    if (st.info) {
      for (const sl of slices) {
        const s = getSurface(p, sl.surfaceId);
        if (!s || s.visible === false) continue;
        drawInfo(ctx, sl, sliceName(p, sl), st);
      }
    }

    const outLogo = out.logo && out.logo.show && !this.brandLock ? this.logoById(p, out.logo.id) : null;   // free extra logo: Pro
    if (outLogo) {
      const img = outLogo;
      const w = Math.max(1, toNum(out.logo.w, 400));
      const h = w * img.naturalHeight / img.naturalWidth;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, out.logo.x, out.logo.y, w, h);
      ctx.imageSmoothingEnabled = !!opts.smooth;
    }

    this.drawFooter(ctx, p, out, st);
    ctx.restore();
  }

  // ------------------------------------------------------------ composition (input map)
  drawComposition(ctx, p, opts = {}) {
    const t = opts.time ?? performance.now() / 1000;
    const st = p.style;
    ctx.save();
    ctx.imageSmoothingEnabled = !!opts.smooth;
    ctx.fillStyle = p.composition.bg || '#000';
    ctx.fillRect(0, 0, p.composition.w, p.composition.h);
    // composition input: whole frame dimmed, each screen shows its area at full brightness
    const vc = p.stage && p.stage.video && p.stage.video.comp;
    const compLive = vc && opts.live && this.liveProvider && p.stage.video.show2d !== false ? this.liveProvider(vc.startsWith('ndi:') || vc.startsWith('dev:') ? vc : 'dev:' + vc) : null;
    if (compLive) { ctx.save(); ctx.globalAlpha = 0.28; ctx.imageSmoothingEnabled = true; ctx.drawImage(compLive.img, 0, 0, p.composition.w, p.composition.h); ctx.restore(); }
    const overlay = !!(p.stage.video && p.stage.video.overlay);
    for (const s of p.surfaces) {
      if (s.visible === false) continue;
      const lv = this.liveOf(p, s, opts);
      const b = compBox(s);
      ctx.save();
      ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
      ctx.rotate(b.rot * Math.PI / 180);
      if (s.comp.flip) ctx.scale(-1, 1);
      if (!lv) { const bm = this.surfaceBitmap(p, s); ctx.drawImage(bm.canvas, 0, 0, bm.canvas.width, bm.canvas.height, -s.w / 2, -s.h / 2, s.w, s.h); }
      ctx.beginPath(); ctx.rect(-s.w / 2, -s.h / 2, s.w, s.h); ctx.clip();
      ctx.translate(-s.w / 2, -s.h / 2);
      if (lv) this.drawLiveInSurface(ctx, p, s, lv);
      if (!lv || overlay) this.decorate(ctx, s, effStyle(p, s), { x: 0, y: 0, w: s.w, h: s.h }, t, p);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Single surface, full size (for "export per surface"). */
  drawSurfaceFull(ctx, p, s) {
    const bm = this.surfaceBitmap(p, s);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bm.canvas, 0, 0, bm.canvas.width, bm.canvas.height, 0, 0, s.w, s.h);
    const st = effStyle(p, s);
    this.decorate(ctx, s, { ...st, anim: { ...st.anim, enabled: false } }, { x: 0, y: 0, w: s.w, h: s.h }, 0, p);
  }

  /** Label + logos + animation, in surface space. box = area the label/logos are placed in. */
  decorate(ctx, s, st, box, t, p) {
    const J = jointOf(s);
    if (J && box && box.x === 0 && box.y === 0 && box.w === s.w && box.h === s.h) {   // split piece: label / logos / texts of the original screen
      // label per slice (default): one label per piece, with the original screen's name and size, like the slices of the
      // undivided screen; otherwise one label / logo set for the whole original screen, clipped to this piece
      if (!st.labelPerSlice) box = { x: -J.ox, y: -J.oy, w: J.W0, h: J.H0 };
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, s.w, s.h); ctx.clip();
      drawLabel(ctx, { ...s, name: J.name, w: J.W0, h: J.H0 }, st, box);
      if (p && Array.isArray(st.logoSlots)) for (const slot of st.logoSlots) { const img = this.slotImage(p, slot); if (img) drawLogoSlot(ctx, img, slot, box); }
      if (Array.isArray(st.textSlots)) for (const slot of st.textSlots) drawTextSlot(ctx, formatSurfaceText(slot.text, p, { ...s, name: J.name, w: J.W0, h: J.H0 }), slot, box, st);
      ctx.restore();
      if (st.anim && st.anim.enabled) drawAnim(ctx, s, st, t);
      return;
    }
    drawLabel(ctx, s, st, box);
    if (p && Array.isArray(st.logoSlots)) for (const slot of st.logoSlots) {
      const img = this.slotImage(p, slot);
      if (img) drawLogoSlot(ctx, img, slot, box);
    }
    if (Array.isArray(st.textSlots)) for (const slot of st.textSlots) drawTextSlot(ctx, formatSurfaceText(slot.text, p, s), slot, box, st);
    if (st.anim && st.anim.enabled) drawAnim(ctx, s, st, t);
  }
}

/** Free text zone on the 3×3 anchor grid (multi-line, shrunk to fit the box width). */
/**
 * Soft-edge zones of a slice (projector overlap). 'ramp' multiplies the content by the blend curve (gamma 2.2 corrected so
 * two overlapping ramps add up to 1 in light); 'zones' only marks the bands (editor).
 */
export function drawBlend(ctx, b, x, y, w, h, mode = 'zones') {
  const sides = [['l', x, y, b.l, h, 1, 0], ['r', x + w, y, -b.r, h, 1, 0], ['t', x, y, w, b.t, 0, 1], ['b', x, y + h, w, -b.b, 0, 1]];
  ctx.save();
  for (const [k, x0, y0, sw, sh, hx, hy] of sides) {
    const size = Math.abs(hx ? sw : sh);
    if (!(b[k] > 0) || size < 1) continue;
    const gx0 = x0, gy0 = y0, gx1 = x0 + (hx ? sw : 0), gy1 = y0 + (hy ? sh : 0);
    const rx = hx ? Math.min(x0, x0 + sw) : x0, ry = hy ? Math.min(y0, y0 + sh) : y0, rw = hx ? size : w, rh = hy ? size : h;
    if (mode === 'ramp') {
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      for (let i = 0; i <= 10; i++) { const v = Math.round(255 * Math.pow(i / 10, 1 / 2.2)); g.addColorStop(i / 10, `rgb(${v},${v},${v})`); }
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(79,139,255,0.22)'; ctx.fillRect(rx, ry, rw, rh);
      const lw = Math.max(2, Math.min(w, h) / 400);
      ctx.strokeStyle = 'rgba(160,195,255,0.95)'; ctx.lineWidth = lw; ctx.setLineDash([lw * 6, lw * 4]);
      ctx.beginPath();
      if (hx) { const xi = x0 + sw; ctx.moveTo(xi, y); ctx.lineTo(xi, y + h); } else { const yi = y0 + sh; ctx.moveTo(x, yi); ctx.lineTo(x + w, yi); }
      ctx.stroke(); ctx.setLineDash([]);
      const fs = Math.max(12, Math.min(size * 0.22, h * 0.03, 64));
      ctx.font = `600 ${fs}px Arial`; ctx.fillStyle = 'rgba(220,232,255,0.95)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.save(); ctx.translate(rx + rw / 2, ry + rh / 2); if (hx) ctx.rotate(-Math.PI / 2);
      ctx.fillText(`BLEND ${b[k]} px`, 0, 0); ctx.restore();
    }
  }
  ctx.restore();
}

export function drawTextSlot(ctx, text, slot, box, st) {
  const lines = String(text || '').split('\n').map((l) => l.trimEnd());
  if (!lines.some((l) => l.trim())) return;
  const base = Math.min(box.w, box.h);
  let fs = Math.max(6, Math.min(base * (slot.size ?? 0.08), slot.max || 160));
  const m = base * 0.035;
  const fam = fontStack(slot.font || (st && st.fontFamily) || 'Arial');
  const font = (k) => `${slot.bold !== false ? 'bold ' : ''}${k}px ${fam}`;
  ctx.save();
  ctx.font = font(fs);
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  const pad = slot.bg ? fs * 0.4 : 0;
  const p0 = slot.pos || 't';
  const corner = p0.includes('l') || p0.includes('r');                    // side columns: leave room for the opposite corner (logo…)
  const avail = (corner ? box.w * 0.6 : box.w) - 2 * m - 2 * pad;
  if (widest > avail) { fs *= avail / widest; ctx.font = font(fs); }
  const lh = fs * 1.18;
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const th = lh * lines.length;
  const pos = slot.pos || 't';
  const col = pos.includes('l') ? 0 : pos.includes('r') ? 2 : 1;
  const row = pos.startsWith('t') ? 0 : pos.startsWith('b') ? 2 : 1;
  const bw = tw + 2 * pad, bh = th + 2 * pad * 0.7;
  let x = col === 0 ? box.x + m : col === 2 ? box.x + box.w - bw - m : box.x + (box.w - bw) / 2;
  let y = row === 0 ? box.y + m : row === 2 ? box.y + box.h - bh - m : box.y + (box.h - bh) / 2;
  y += (slot.offY || 0) * box.h;
  ctx.globalAlpha = slot.opacity ?? 1;
  if (slot.bg) {
    ctx.fillStyle = rgba(slot.bgColor || '#000000', slot.bgOpacity ?? 0.55);
    const r = Math.min(bh / 2, fs * 0.35);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, r); else ctx.rect(x, y, bw, bh);
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = col === 0 ? 'left' : col === 2 ? 'right' : 'center';
  const tx = col === 0 ? x + pad : col === 2 ? x + bw - pad : x + bw / 2;
  ctx.fillStyle = slot.color || '#FFFFFF';
  if (slot.stroke) { ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = Math.max(1, fs * 0.1); ctx.lineJoin = 'round'; }
  lines.forEach((l, i) => {
    const ly = y + pad * 0.7 + lh * (i + 0.5);
    if (slot.stroke) ctx.strokeText(l, tx, ly);
    ctx.fillText(l, tx, ly);
  });
  ctx.restore();
}

/** Logo placed on a 3×3 anchor grid of the box (size relative to the box short side, capped in px). */
export function drawLogoSlot(ctx, img, slot, box) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const base = Math.min(box.w, box.h);
  const maxSide = Math.min(base * (slot.size ?? 0.16), slot.max || 400);
  const k = Math.min(maxSide / iw, maxSide / ih);
  const w = iw * k, h = ih * k;
  const m = base * (slot.margin ?? 0.035);
  const pos = slot.pos || 'br';
  const col = pos.includes('l') ? 0 : pos.includes('r') ? 2 : 1;
  const row = pos.startsWith('t') ? 0 : pos.startsWith('b') ? 2 : 1;
  let x = col === 0 ? box.x + m : col === 2 ? box.x + box.w - w - m : box.x + (box.w - w) / 2;
  let y = row === 0 ? box.y + m : row === 2 ? box.y + box.h - h - m : box.y + (box.h - h) / 2;
  y += (slot.offY || 0) * box.h;
  ctx.save();
  ctx.globalAlpha = slot.opacity ?? 0.9;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

// ==================================================================== drawing
export function fontStack(f) {
  const fam = (f || 'Arial').includes(' ') ? `"${f}"` : (f || 'Arial');
  return `${fam}, "Helvetica Neue", Helvetica, Arial, sans-serif`;
}

function tileColor(s, pal, c, r, ti) {
  const cols = ti.cols, rows = ti.rows;
  switch (s.pattern) {
    case 'solid': return pal[0];
    case 'tone': return (c + r) % 2 ? shade(pal[0], 1 - clamp(toNum(s.colors.tone, 0.22), 0, 0.9)) : pal[0];
    case 'outline': return (c + r) % 2 ? shade(pal[0], 0.1) : shade(pal[0], 0.16);
    case 'gradient': {
      const C = s.colors;
      let tt = C.gradDir === 'h' ? (cols > 1 ? c / (cols - 1) : 0) : (rows > 1 ? r / (rows - 1) : 0);
      if ((C.gradMirror === 'v' && C.gradDir === 'h') || (C.gradMirror === 'h' && C.gradDir !== 'h')) tt = 1 - tt;   // symmetric pair: mirrored direction
      const base = mix(hueShift(C.gradA || '#FF1A1A', toNum(C.hue, 0)), hueShift(C.gradB || '#1E1EFF', toNum(C.hue, 0)), tt);
      return (c + r) % 2 ? shade(base, 0.62) : base;
    }
    case 'bars': {
      const bars = ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#000000'];
      const cx = (c + 0.5) / cols;
      return bars[Math.min(bars.length - 1, Math.floor(cx * bars.length))];
    }
    case 'grayramp': {
      const v = cols > 1 ? c / (cols - 1) : 1;
      const g = Math.round(v * 255);
      return `rgb(${g},${g},${g})`;
    }
    case 'checker3': {   // 3 tones: the palette when it has 3+ colours, else the first colour in 3 shades
      const p3 = pal.length >= 3 ? pal.slice(0, 3) : [pal[0], shade(pal[0], 0.62), shade(pal[0], 0.36)];
      return p3[((c % 3) + (r % 3) * 2) % 3];
    }
    case 'rows': case 'cols': {   // stripes per cabinet row / column (2..4 palette colours, 1 colour = 2 shades)
      const pp = pal.length >= 2 ? pal : [pal[0], shade(pal[0], 0.55)];
      return pp[(s.pattern === 'rows' ? r : c) % pp.length];
    }
    default: { // checker
      const n = pal.length;
      if (n <= 1) return pal[0];
      const idx = n === 2 ? (c + r) % 2 : (c + 2 * r) % n;
      return pal[idx];
    }
  }
}

function rowLetters(i) {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function tileNumber(mode, c, r, ti, counter) {
  switch (mode) {
    case 'colrow': return `${c + 1}.${r + 1}`;
    case 'rowcol': return `${r + 1}.${c + 1}`;
    case 'letters': return `${rowLetters(r)}.${c + 1}`;
    case 'index': return String(counter.i);
    case 'snake-h': return String(r % 2 === 0 ? r * ti.cols + c + 1 : r * ti.cols + (ti.cols - c));
    case 'snake-v': return String(c % 2 === 0 ? c * ti.rows + r + 1 : c * ti.rows + (ti.rows - r));
    default: return '';
  }
}

/**
 * Smooth patterns: 'compgrad' = the project gradient seen through the screen's place in the composition
 * (continuous across screens), 'soft' = the screen's colour family as a soft gradient.
 * Every other cabinet is darkened by colors.tone so the map stays readable (cabinet count, orientation).
 */
function drawSmoothTiles(ctx, s, p, pal, ti, xs, ys, virt) {
  const W = s.w, H = s.h, C = s.colors || {};
  const hue = toNum(C.hue, 0);
  const smooth = C.smooth !== false;
  if (s.pattern === 'compgrad' && p) {
    const g = p.gradient || {};
    const geo = gradGeometry(g, gradExtent(p));
    if (smooth) {
      // fill in composition space: the canvas gradient is defined with comp coordinates
      const rr = ((s.comp.rot % 360) + 360) % 360, sw = rr === 90 || rr === 270;
      const bw = sw ? s.h : s.w, bh = sw ? s.w : s.h;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      if (s.comp.flip) ctx.scale(-1, 1);
      ctx.rotate(-rr * Math.PI / 180);
      ctx.translate(-(s.comp.x + bw / 2), -(s.comp.y + bh / 2));
      const cg = geo.type === 'radial' ? ctx.createRadialGradient(geo.cx, geo.cy, 0, geo.cx, geo.cy, geo.r) : ctx.createLinearGradient(geo.x0, geo.y0, geo.x1, geo.y1);
      for (const st of gradLineStops(g)) cg.addColorStop(st.p, hue ? gradColor({ stops: [st] }, 0, hue) : st.c);
      ctx.fillStyle = cg;
      ctx.fillRect(s.comp.x - 2, s.comp.y - 2, bw + 4, bh + 4);
      ctx.restore();
    } else {
      for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) {
        const [x, y] = surfaceToComp(s, (xs[c] + xs[c + 1]) / 2, (ys[r] + ys[r + 1]) / 2);
        ctx.fillStyle = gradColor(g, gradT(geo, x, y, g), hue);
        ctx.fillRect(xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]);
      }
    }
  } else {
    // soft: light → dark shade of the screen's family
    const fam = C.preset && C.preset !== 'Custom' && COLOR_PRESETS[C.preset] ? COLOR_PRESETS[C.preset].map((x) => hueShift(x, hue)) : [pal[0], pal[1] || shade(pal[0], 0.45)];
    const a = fam[0], b = fam.length > 2 ? fam[2] : fam[1];
    const d = C.gradDir || 'v';
    const mx = C.gradMirror === 'v', my = C.gradMirror === 'h';     // symmetric pair: mirrored direction
    const lg = d === 'h' ? (mx ? ctx.createLinearGradient(W, 0, 0, 0) : ctx.createLinearGradient(0, 0, W, 0)) : d === 'd' ? ctx.createLinearGradient(mx ? W : 0, my ? H : 0, mx ? 0 : W, my ? 0 : H) : d === 'r' ? null : (my ? ctx.createLinearGradient(0, H, 0, 0) : ctx.createLinearGradient(0, 0, 0, H));
    const fill = lg || ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
    fill.addColorStop(0, a); if (fam.length > 2) fill.addColorStop(0.55, fam[1]); fill.addColorStop(1, b);
    if (smooth) { ctx.fillStyle = fill; ctx.fillRect(0, 0, W, H); }
    else for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) {
      const fc = mx ? 1 - (c + 0.5) / ti.cols : (c + 0.5) / ti.cols, fr = my ? 1 - (r + 0.5) / ti.rows : (r + 0.5) / ti.rows;
      const u = d === 'h' ? fc : d === 'd' ? (fc + fr) / 2 : d === 'r' ? Math.hypot(fc - 0.5, fr - 0.5) / 0.7071 : fr;
      ctx.fillStyle = fam.length > 2 ? (u < 0.55 ? mix(a, fam[1], u / 0.55) : mix(fam[1], b, (u - 0.55) / 0.45)) : mix(a, b, u);
      ctx.fillRect(xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]);
    }
  }
  // cabinet checker (technical readability) + virtual cabinets
  const tone = clamp(toNum(C.tone, 0.22), 0, 0.9);
  ctx.save();
  if (tone > 0) {
    ctx.fillStyle = `rgba(0,0,0,${tone})`;
    ctx.beginPath();
    for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) if ((c + r) % 2) ctx.rect(xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]);
    ctx.fill();
  }
  if (virt.size) {
    ctx.fillStyle = '#262626';
    for (const key of virt) { const [c, r] = key.split(',').map(Number); if (c < ti.cols && r < ti.rows) ctx.fillRect(xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]); }
  }
  ctx.restore();
}

/** Draw a full surface pattern in its own pixel space (0..w, 0..h). */
export function drawSurface(ctx, s, st, logoImg, p) {
  const W = s.w, H = s.h;
  const ti = tileInfo(s);
  const pal = surfacePalette(s);
  const virt = new Set(s.virtual || []);
  const xs = [], ys = [];
  for (let c = 0; c <= ti.cols; c++) xs.push(Math.min(W, Math.round(c * ti.tw)));
  for (let r = 0; r <= ti.rows; r++) ys.push(Math.min(H, Math.round(r * ti.th)));

  // split piece of a screen: tile colours, numbering and guides continue over the original screen
  const J = jointOf(s);
  const oc = J ? Math.round(J.ox / ti.tw) : 0, orr = J ? Math.round(J.oy / ti.th) : 0;
  const tiG = J ? { ...ti, cols: Math.max(ti.cols, Math.round(J.W0 / ti.tw)), rows: Math.max(ti.rows, Math.round(J.H0 / ti.th)) } : ti;
  // 1. tiles
  if (s.pattern === 'compgrad' || s.pattern === 'soft') drawSmoothTiles(ctx, s, p, pal, ti, xs, ys, virt);
  else for (let r = 0; r < ti.rows; r++) {
    for (let c = 0; c < ti.cols; c++) {
      const x0 = xs[c], x1 = xs[c + 1], y0 = ys[r], y1 = ys[r + 1];
      ctx.fillStyle = virt.has(c + ',' + r) ? '#262626' : tileColor(s, pal, c + oc, r + orr, tiG);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  if (s.pattern === 'outline') {   // fine inner frame of every cabinet in the screen colour
    const ow = Math.max(1, Math.min(ti.tw, ti.th) * 0.035);
    ctx.save();
    ctx.strokeStyle = rgba(pal[0], 0.95); ctx.lineWidth = ow;
    ctx.beginPath();
    for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) {
      if (virt.has(c + ',' + r)) continue;
      const i = ow * 1.5;
      ctx.rect(xs[c] + i, ys[r] + i, xs[c + 1] - xs[c] - 2 * i, ys[r + 1] - ys[r] - 2 * i);
    }
    ctx.stroke();
    ctx.restore();
  }

  const base = Math.min(W, H);
  const lw = Math.max(1, st.gridWidth || 1);

  // 2. faint X in each tile
  if (st.tileX && ti.cols * ti.rows <= 40000) {
    ctx.save();
    ctx.strokeStyle = rgba('#000000', st.tileXOpacity ?? 0.18);
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) {
      const x0 = xs[c], x1 = xs[c + 1], y0 = ys[r], y1 = ys[r + 1];
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1, y0); ctx.lineTo(x0, y1);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 2b. per-cabinet marks (HappyMaps style): corner crosspoints, centre plus, circle
  const tm = st.tileMarks || 'none';
  if (tm !== 'none' && ti.cols * ti.rows <= 40000) {
    ctx.save();
    ctx.strokeStyle = rgba(st.guideColor || '#FFFFFF', st.tileMarkOpacity ?? 0.6);
    ctx.lineWidth = lw;
    ctx.beginPath();
    const tmin = Math.min(ti.tw, ti.th);
    if (tm === 'cross') {
      const a = Math.max(3, tmin * 0.09);
      for (let r = 0; r <= ti.rows; r++) for (let c = 0; c <= ti.cols; c++) { const x = xs[c], y = ys[r]; ctx.moveTo(x - a, y); ctx.lineTo(x + a, y); ctx.moveTo(x, y - a); ctx.lineTo(x, y + a); }
    }
    if (tm === 'plus' || tm === 'ring') {
      const a = Math.max(3, tmin * 0.12);
      for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) { if (virt.has(c + ',' + r)) continue; const x = (xs[c] + xs[c + 1]) / 2, y = (ys[r] + ys[r + 1]) / 2; ctx.moveTo(x - a, y); ctx.lineTo(x + a, y); ctx.moveTo(x, y - a); ctx.lineTo(x, y + a); }
    }
    if (tm === 'circle' || tm === 'ring') {
      for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) {
        if (virt.has(c + ',' + r)) continue;
        const x = (xs[c] + xs[c + 1]) / 2, y = (ys[r] + ys[r + 1]) / 2, rad = Math.max(2, Math.min(xs[c + 1] - xs[c], ys[r + 1] - ys[r]) * 0.38);
        ctx.moveTo(x + rad, y); ctx.arc(x, y, rad, 0, Math.PI * 2);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  // 3. virtual tiles hatch
  if (virt.size) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (const key of virt) {
      const [c, r] = key.split(',').map(Number);
      if (c >= ti.cols || r >= ti.rows) continue;
      const x0 = xs[c], x1 = xs[c + 1], y0 = ys[r], y1 = ys[r + 1];
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      ctx.beginPath();
      const step = Math.max(6, Math.min(x1 - x0, y1 - y0) / 10);
      for (let d = -(y1 - y0); d < x1 - x0; d += step) { ctx.moveTo(x0 + d, y1); ctx.lineTo(x0 + d + (y1 - y0), y0); }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // 4. tile grid
  if (st.grid && ti.cols * ti.rows > 1) {
    ctx.save();
    ctx.strokeStyle = rgba(st.gridColor || '#fff', st.gridOpacity ?? 0.55);
    ctx.lineWidth = lw;
    if (st.gridDashed) ctx.setLineDash([Math.max(3, ti.tw / 16), Math.max(3, ti.tw / 16)]);
    ctx.beginPath();
    for (let c = 1; c < ti.cols; c++) { const x = xs[c] + (lw % 2 ? 0.5 : 0); ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let r = 1; r < ti.rows; r++) { const y = ys[r] + (lw % 2 ? 0.5 : 0); ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.restore();
  }

  // 5. numbering
  if (st.numbering && st.numbering !== 'none') {
    const fs = Math.max(7, Math.min(ti.tw, ti.th) * 0.17 * (st.numberingScale || 1));
    if (fs * 1.2 < ti.th) {
      ctx.save();
      ctx.font = `bold ${fs}px ${fontStack(st.fontFamily)}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = rgba('#FFFFFF', st.numberingOpacity ?? 0.75);
      ctx.strokeStyle = rgba('#000000', (st.numberingOpacity ?? 0.75) * 0.6);
      ctx.lineWidth = Math.max(1, fs * 0.12);
      const counter = { i: 0 };
      let portMap = null;
      if (st.numbering === 'port' && p) {
        portMap = new Map();
        const labels = portLabels(p, s);
        dataChain(s, p.processor).ports.forEach((port, k) => port.forEach((tl, i) => portMap.set(tl.c + ',' + tl.r, `${labels[k] ? labels[k].main : k + 1}.${i + 1}`)));
      }
      for (let r = 0; r < ti.rows; r++) for (let c = 0; c < ti.cols; c++) {
        if (virt.has(c + ',' + r)) continue;
        counter.i++;
        const txt = portMap ? (portMap.get(c + ',' + r) || '') : tileNumber(st.numbering, c + oc, r + orr, tiG, counter);
        const cx = (xs[c] + xs[c + 1]) / 2, ty = ys[r] + fs * 0.35;
        ctx.strokeText(txt, cx, ty);
        ctx.fillText(txt, cx, ty);
      }
      ctx.restore();
    }
  }

  // whole-screen guides of a split piece: drawn in the original screen's frame, clipped to this piece
  ctx.save();
  let gW = W, gH = H, gBase = base;
  if (J) { ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); ctx.translate(-J.ox, -J.oy); gW = J.W0; gH = J.H0; gBase = Math.min(gW, gH); }
  drawGuides(ctx, st, ti, gW, gH, gBase, lw);
  ctx.restore();

  // 7. LED cabling (data + power)
  if (p && (st.cabling || st.powerPath)) drawChains(ctx, s, st, p, xs, ys, ti);

  // (centre label is drawn at composite time — per slice or per surface — see drawLabel)
}

/** Circle, diagonals, axes, concentric circles, border and corner markers of a screen (W × H frame). */
function drawGuides(ctx, st, ti, W, H, base, lw) {
  if (st.outerCircles) {   // concentric circles from the centre, spaced by one cabinet
    ctx.save();
    ctx.strokeStyle = rgba(st.guideColor || '#FFFFFF', (st.guideOpacity ?? 0.85) * 0.6);
    ctx.lineWidth = lw;
    const stp = Math.max(8, Math.min(ti.tw, ti.th));
    const rmax = Math.hypot(W, H) / 2;
    ctx.beginPath();
    for (let rr = stp; rr < rmax && rr / stp < 400; rr += stp) { ctx.moveTo(W / 2 + rr, H / 2); ctx.arc(W / 2, H / 2, rr, 0, Math.PI * 2); }
    ctx.stroke();
    ctx.restore();
  }

  // 6. guides
  ctx.save();
  const gcol = rgba(st.guideColor || '#fff', st.guideOpacity ?? 0.85);
  const gw = Math.max(1, (st.guideWidth || 1.5) * Math.max(1, base / 1000));
  ctx.strokeStyle = gcol;
  ctx.lineWidth = gw;
  const dl = Math.max(4, (st.guideDash ?? 8) * Math.max(1, base / 800));
  const dash = st.guideDash === 0 ? [] : [dl, dl];

  if (st.diagonals) {
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, H); ctx.moveTo(W, 0); ctx.lineTo(0, H); ctx.stroke();
  }
  if (st.circle) {
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.max(1, base / 2 * (st.circleSize ?? 0.9) - gw / 2), 0, Math.PI * 2);
    ctx.stroke();
  }
  if (st.cornerCircles) {
    ctx.setLineDash(dash);
    const cr = base * 0.12;
    ctx.beginPath();
    for (const [cx, cy] of [[cr, cr], [W - cr, cr], [cr, H - cr], [W - cr, H - cr]]) { ctx.moveTo(cx + cr, cy); ctx.arc(cx, cy, cr, 0, Math.PI * 2); }
    ctx.stroke();
  }
  if (st.axis) {
    ctx.setLineDash([]);
    ctx.beginPath();
    const ax = Math.round(W / 2) + (gw % 2 ? 0.5 : 0), ay = Math.round(H / 2) + (gw % 2 ? 0.5 : 0);
    ctx.moveTo(ax, 0); ctx.lineTo(ax, H); ctx.moveTo(0, ay); ctx.lineTo(W, ay);
    ctx.stroke();
  }
  ctx.restore();

  if (st.border) {
    const bw = Math.max(1, st.borderWidth || 2);
    ctx.save();
    ctx.strokeStyle = st.borderColor || '#fff';
    ctx.lineWidth = bw;
    ctx.strokeRect(bw / 2, bw / 2, W - bw, H - bw);
    ctx.restore();
  }
  if (st.cornerMarkers) {
    const m = clamp(base * 0.05, 6, 40);
    ctx.save();
    ctx.fillStyle = st.cornerMarkerColor || '#4DFFE1';
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(m, 0); ctx.lineTo(0, m); ctx.closePath();
    ctx.moveTo(W, 0); ctx.lineTo(W - m, 0); ctx.lineTo(W, m); ctx.closePath();
    ctx.moveTo(0, H); ctx.lineTo(m, H); ctx.lineTo(0, H - m); ctx.closePath();
    ctx.moveTo(W, H); ctx.lineTo(W - m, H); ctx.lineTo(W, H - m); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

}

function drawChains(ctx, s, st, p, xs, ys, ti) {
  const W = s.w, H = s.h;
  const tmin = Math.min(ti.tw, ti.th);
  const cen = (t) => [(xs[t.c] + xs[t.c + 1]) / 2, (ys[t.r] + ys[t.r + 1]) / 2];
  const lw = Math.max(1.5, tmin * 0.045 * (st.cablingWidth || 1));
  const fam = fontStack(st.fontFamily);
  /** Nearest point of the screen's outline (where a cable from the processor comes in / goes back). */
  const edgeOf = (x, y) => {
    const c = [[x, 0], [W - x, 1], [y, 2], [H - y, 3]].reduce((a, b) => (b[0] < a[0] ? b : a));
    return c[1] === 0 ? [0, y] : c[1] === 1 ? [W, y] : c[1] === 2 ? [x, 0] : [x, H];
  };
  if (st.cablingDim > 0) { ctx.fillStyle = rgba('#000000', st.cablingDim); ctx.fillRect(0, 0, W, H); }

  const arrow = (x0, y0, x1, y1, size) => {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(a) * size, my + Math.sin(a) * size);
    ctx.lineTo(mx + Math.cos(a + 2.5) * size, my + Math.sin(a + 2.5) * size);
    ctx.lineTo(mx + Math.cos(a - 2.5) * size, my + Math.sin(a - 2.5) * size);
    ctx.closePath(); ctx.fill();
  };
  const tag = (x, y, text, color, fs, round) => {
    ctx.font = `bold ${fs}px ${fam}`;
    const w = ctx.measureText(text).width + fs * 0.7, h = fs * 1.35;
    ctx.fillStyle = color;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, round ? h / 2 : h * 0.2); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, fs * 0.08); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + fs * 0.04);
  };

  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (st.cabling) {
    const { ports, tilePx, portPx } = dataChain(s, p.processor);
    const labels = portLabels(p, s);
    ports.forEach((port, k) => {
      const lb = labels[k] || { g: k + 1, main: 'P' + (k + 1), backup: null };
      const col = PORT_COLORS[(lb.g - 1) % PORT_COLORS.length];
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw;
      ctx.beginPath();
      port.forEach((t, i) => { const [x, y] = cen(t); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      for (let i = 1; i < port.length; i++) { const [x0, y0] = cen(port[i - 1]); const [x1, y1] = cen(port[i]); arrow(x0, y0, x1, y1, lw * 2.2); }
      if (st.cablingLabels && port.length) {
        const [x, y] = cen(port[0]);
        const fs = Math.max(7, tmin * 0.2);
        // main feed: the cable comes in from the nearest edge of the screen (solid stub + arrow)
        const [mx, my] = edgeOf(x, y);
        if (Math.hypot(mx - x, my - y) > 1) {
          ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw * 1.3;
          ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(x, y); ctx.stroke(); arrow(mx, my, x, y, lw * 2.6);
          ctx.restore();
        }
        tag(x, y, lb.main, col, fs, true);
        if (st.cablingUsage !== false) {
          // load of the port: small counter on its line, next to the second cabinet (or under the port tag)
          const pct = Math.round(port.length * tilePx / Math.max(1, portPx) * 100);
          const [ux, uy] = port.length > 1 ? cen(port[1]) : [x, y + fs * 1.6];
          const txt = pct + '%', f2 = fs * 0.78;
          ctx.save();
          ctx.font = `bold ${f2}px ${fam}`;
          const w = ctx.measureText(txt).width + f2 * 0.7, hh = f2 * 1.3;
          ctx.fillStyle = 'rgba(0,0,0,0.78)'; roundRect(ctx, ux - w / 2, uy - hh / 2, w, hh, hh / 2); ctx.fill();
          ctx.fillStyle = pct > 100 ? '#FF5D6C' : pct > Math.round(portHeadroom(p.processor) * 100) ? '#F2C94C' : col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(txt, ux, uy + f2 * 0.04);
          ctx.restore();
        }
        const [ex, ey] = cen(port[port.length - 1]);
        if (lb.backup) {
          // redundancy: the backup cable leaves the last cabinet of the chain and goes back to the processor (loop) —
          // dashed line to the nearest edge of the screen, backup port name at the edge
          const [bx, by] = edgeOf(ex, ey);
          ctx.save();
          ctx.strokeStyle = col; ctx.lineWidth = lw * 1.3; ctx.setLineDash([lw * 3, lw * 2]);
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(bx, by); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(ex, ey, lw * 2, 0, Math.PI * 2); ctx.fill();
          ctx.font = `bold ${fs * 0.85}px ${fam}`;
          const w = ctx.measureText(lb.backup).width + fs * 0.7, hh = fs * 1.2;
          // label just inside the edge
          const lx = Math.min(W - w / 2 - 1, Math.max(w / 2 + 1, bx)), ly = Math.min(H - hh / 2 - 1, Math.max(hh / 2 + 1, by));
          ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = Math.max(1.5, fs * 0.12);
          ctx.setLineDash([fs * 0.25, fs * 0.15]);
          roundRect(ctx, lx - w / 2, ly - hh / 2, w, hh, hh / 2); ctx.fill(); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(lb.backup, lx, ly + fs * 0.03);
          ctx.restore();
        } else {
          ctx.fillStyle = col; ctx.fillRect(ex - lw * 1.6, ey - lw * 1.6, lw * 3.2, lw * 3.2);
        }
      }
    });
  }
  if (st.powerPath) {
    const { circuits } = powerChain(s, p.power, p.cabling);
    const start = circuitStarts(p)[s.id] || 1;
    const off = tmin * 0.18;
    ctx.setLineDash([lw * 3, lw * 2]);
    circuits.forEach((cir, k) => {
      const col = PORT_COLORS[(PORT_COLORS.length - 1 - ((k + start - 1) % PORT_COLORS.length))];
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      cir.forEach((t, i) => { const [x, y] = cen(t); if (i) ctx.lineTo(x + off, y + off); else ctx.moveTo(x + off, y + off); });
      ctx.stroke();
      if (st.cablingLabels && cir.length) {
        const [x, y] = cen(cir[0]);
        ctx.setLineDash([]);
        const ph = circuitPhase(p.power, k + start);
        tag(x + off, y + off, 'C' + (k + start) + (ph ? ' ' + ph : ''), col, Math.max(7, tmin * 0.17), false);
        ctx.setLineDash([lw * 3, lw * 2]);
      }
    });
  }
  ctx.restore();
}

function fitFont(ctx, text, size, maxW, weight, family) {
  let fs = size;
  ctx.font = `${weight} ${fs}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW && w > 0) { fs = fs * maxW / w; ctx.font = `${weight} ${fs}px ${family}`; }
  return fs;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function strokedText(ctx, st, text, x, y, fs) {
  if (st.textStroke) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = st.strokeColor || '#000';
    ctx.lineWidth = Math.max(1, fs * (st.strokeWidth ?? 0.08) * 2);
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = st.textColor || '#fff';
  ctx.fillText(text, x, y);
}

export function drawLabel(ctx, s, st, box) {
  if (st.labelShape === 'none' && !st.showName && !st.showSize) return;
  const bx = box || { x: 0, y: 0, w: s.w, h: s.h };
  const W = bx.w, H = bx.h, cx = bx.x + W / 2, cy = bx.y + H / 2;
  const scale = st.labelScale || 1;
  const cap = Math.max(8, (st.labelMax || 96) * scale);
  // base drives the label size; capped so big surfaces keep a readable label
  const base = Math.min(Math.min(W, H), cap / 0.2);
  const fam = fontStack(st.fontFamily);
  const name = st.showName ? (s.name || '') : '';
  const size = st.showSize ? (st.sizeFormat !== 'x' ? `W ${s.w}  X  H ${s.h}` : `${s.w} × ${s.h}`) : '';
  const phys = st.showPhysical ? physicalSize(s) : null;
  const shape = st.labelShape;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (shape === 'pill') {
    // name + pill style: big stroked name + light pill with dimensions
    let nameFs = fitFont(ctx, name || ' ', Math.min(base * 0.2 * scale, cap), W * 0.86, 'bold', fam);
    const pillFs = Math.max(6, nameFs * 0.34);
    const pillH = pillFs * 1.5;
    const totalH = (name ? nameFs : 0) + (size ? pillH : 0) + (phys ? pillFs * 1.3 : 0);
    let y = cy - totalH / 2;
    if (name) {
      ctx.font = `bold ${nameFs}px ${fam}`;
      strokedText(ctx, st, name, cx, y + nameFs / 2, nameFs);
      y += nameFs;
    }
    if (size) {
      ctx.font = `bold ${pillFs}px ${fam}`;
      const tw = Math.max(ctx.measureText(size).width + pillFs * 1.6, name ? ctx.measureText(name).width * 0 : 0);
      const nw = name ? (ctx.font = `bold ${nameFs}px ${fam}`, ctx.measureText(name).width) : 0;
      const pw = Math.min(W * 0.95, Math.max(tw, nw * 1.04));
      ctx.font = `bold ${pillFs}px ${fam}`;
      const grad = ctx.createLinearGradient(0, y, 0, y + pillH);
      grad.addColorStop(0, shade(st.pillColor || '#D9D9D9', 1.25));
      grad.addColorStop(1, shade(st.pillColor || '#D9D9D9', 0.75));
      ctx.fillStyle = grad;
      roundRect(ctx, cx - pw / 2, y, pw, pillH, pillH * 0.25);
      ctx.fill();
      ctx.fillStyle = st.pillTextColor || '#222';
      ctx.fillText(size, cx, y + pillH / 2 + pillFs * 0.04);
      y += pillH;
    }
    if (phys) {
      ctx.font = `bold ${pillFs}px ${fam}`;
      strokedText(ctx, st, phys, cx, y + pillFs * 0.75, pillFs);
    }
    ctx.restore();
    return;
  }

  // hexagon / circle / rect
  const R = base * 0.3 * scale;
  if (shape === 'hexagon' || shape === 'circle' || shape === 'rect') {
    ctx.beginPath();
    if (shape === 'hexagon') {
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3; // pointy-top
        const px = cx + R * Math.cos(a), py = cy + R * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else if (shape === 'circle') {
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
    } else {
      const rw = Math.min(W * 0.8, R * 3.2), rh = R * 1.3;
      roundRect(ctx, cx - rw / 2, cy - rh / 2, rw, rh, rh * 0.18);
    }
    ctx.fillStyle = rgba(st.shapeFill || '#000', st.shapeOpacity ?? 0.35);
    ctx.fill();
    if (st.shapeBorderWidth > 0) {
      ctx.strokeStyle = st.shapeBorder || '#fff';
      ctx.lineWidth = Math.max(1, st.shapeBorderWidth * Math.max(1, base / 600));
      ctx.stroke();
    }
  }

  const maxW = shape === 'rect' ? Math.min(W * 0.76, R * 3.0) : (shape === 'none' ? W * 0.86 : R * 1.55);
  const nameFs = name ? fitFont(ctx, name, R * 0.42, maxW, 'bold', fam) : 0;
  const sizeFs = size ? fitFont(ctx, size, Math.max(6, (nameFs || R * 0.42) * 0.45), maxW, 'bold', fam) : 0;
  const physFs = phys ? sizeFs * 0.95 : 0;
  const gap = (nameFs || sizeFs) * 0.18;
  const total = nameFs + (size ? sizeFs + gap : 0) + (phys ? physFs + gap : 0);
  let y = cy - total / 2;
  if (name) { ctx.font = `bold ${nameFs}px ${fam}`; strokedText(ctx, st, name, cx, y + nameFs / 2, nameFs); y += nameFs + gap; }
  if (size) { ctx.font = `bold ${sizeFs}px ${fam}`; strokedText(ctx, st, size, cx, y + sizeFs / 2, sizeFs); y += sizeFs + gap; }
  if (phys) { ctx.font = `bold ${physFs}px ${fam}`; strokedText(ctx, st, phys, cx, y + physFs / 2, physFs); }
  ctx.restore();
}


/** Slice info overlay — top-left of the slice, in output space (always upright). */
function drawInfo(ctx, sl, name, st) {
  const d = sliceDims(sl);
  const fs = clamp(Math.min(d.dw, d.dh) * 0.075, 9, 26) * (st.infoScale || 1);
  const sc = Math.abs(d.ow - sl.src.w) > 0.5 || Math.abs(d.oh - sl.src.h) > 0.5;
  const r1 = (v) => Math.round(v * 10) / 10;
  const lines = [name, sc ? `W: ${sl.src.w}→${r1(d.ow)} - H: ${sl.src.h}→${r1(d.oh)}` : `W: ${sl.src.w} - H: ${sl.src.h}`, `X: ${r1(sl.x)} - Y: ${r1(sl.y)}` + (sl.rot && !(sl.rot % 90 === 0) ? ` · ${r1(sl.rot)}°` : '')];
  ctx.save();
  ctx.beginPath(); ctx.rect(sl.x, sl.y, d.dw, d.dh); ctx.clip();
  ctx.font = `bold ${fs}px ${fontStack(st.fontFamily)}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const pad = fs * 0.4;
  if (st.infoBg) {
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(sl.x, sl.y, w, lines.length * fs * 1.12 + pad * 1.4);
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, fs * 0.18);
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.fillStyle = st.infoColor || '#fff';
  lines.forEach((l, i) => {
    const y = sl.y + pad * 0.8 + i * fs * 1.12;
    ctx.strokeText(l, sl.x + pad, y);
    ctx.fillText(l, sl.x + pad, y);
  });
  ctx.restore();
}

/** Animated overlay, drawn in surface space (0..w, 0..h). */
function drawAnim(ctx, s, st, t) {
  const a = st.anim;
  const W = s.w, H = s.h;
  const sp = Math.max(0.05, toNum(a.speed, 1));
  const col = a.color || '#fff';
  ctx.save();
  if (a.type === 'scan') {
    // gradient band transparent -> white, leading edge in the travel direction
    const period = 4 / sp;
    const ph = (t % period) / period;
    const dir = a.dir || 'lr';
    const horiz = dir === 'lr' || dir === 'rl';
    const L = horiz ? W : H;
    const bw = Math.max(8, L * M_clamp(a.width ?? 0.25, 0.02, 1));
    let lead = ph * (L + bw);                    // leading edge position along travel axis
    if (dir === 'rl' || dir === 'bt') lead = L - lead;
    const tail = (dir === 'rl' || dir === 'bt') ? lead + bw : lead - bw;
    const g = horiz ? ctx.createLinearGradient(tail, 0, lead, 0) : ctx.createLinearGradient(0, tail, 0, lead);
    g.addColorStop(0, rgba(col, 0));
    g.addColorStop(0.85, rgba(col, 0.75));
    g.addColorStop(1, rgba(col, 1));
    ctx.fillStyle = g;
    const a0 = Math.min(tail, lead), a1 = Math.max(tail, lead);
    if (horiz) ctx.fillRect(a0, 0, a1 - a0, H); else ctx.fillRect(0, a0, W, a1 - a0);
  } else if (a.type === 'bar' || a.type === 'cross') {
    const period = 4 / sp;
    const ph = (t % period) / period;
    const bw = Math.max(4, W * 0.012);
    ctx.fillStyle = rgba(col, 0.9);
    const x = (a.dir === 'rl') ? W - ph * (W + bw) : ph * (W + bw) - bw;
    ctx.fillRect(x, 0, bw, H);
    if (a.type === 'cross') {
      const bh = Math.max(4, H * 0.012);
      ctx.fillRect(0, ph * (H + bh) - bh, W, bh);
    }
  } else if (a.type === 'sweep') {
    const ang = (t * sp * Math.PI * 2 / 4) % (Math.PI * 2);
    const R = Math.hypot(W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.fillStyle = rgba(col, 0.35);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, ang - 0.25, ang); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.95); ctx.lineWidth = Math.max(2, Math.min(W, H) * 0.006);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * R, Math.sin(ang) * R); ctx.stroke();
    ctx.restore();
  } else if (a.type === 'blink') {
    const on = Math.floor(t * sp * 2) % 2 === 0;
    const m = Math.min(W, H) * 0.14;
    ctx.fillStyle = col;
    if (on) { ctx.fillRect(0, 0, m, m); ctx.fillRect(W - m, H - m, m, m); }
    else { ctx.fillRect(W - m, 0, m, m); ctx.fillRect(0, H - m, m, m); }
  }
  if (a.counter) {
    const total = Math.max(0, t);
    const mm = Math.floor(total / 60) % 60, ss = Math.floor(total) % 60, ff = Math.floor((total % 1) * 100);
    const txt = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
    const fs = Math.min(H * 0.14, W * 0.1);
    if (fs >= 8) {
      ctx.font = `bold ${fs}px "Courier New", Menlo, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = fs * 0.12; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round';
      ctx.strokeText(txt, W / 2, H - fs * 0.25);
      ctx.fillStyle = col;
      ctx.fillText(txt, W / 2, H - fs * 0.25);
    }
  }
  ctx.restore();
}
