// Pixel2Pixel — screen geometry in metres (pure: no three.js). Used by the 3D stage (meshes) and by the 2D renderer
// (test animations in stage space: a scan crossing the stage sees each screen where it really is, motorised or not).
import * as M from './model.js';

const D2R = Math.PI / 180;

/**
 * Profile of a bent strip: cabinets of lengths L[i] (m) joined with angles A[i] (deg, + = concave / towards the front).
 * Walks along "a" with front "f", normalises the chord onto the a axis and centres on half the arc length.
 * Returns stations { a, f, na, nf } at every cut.
 */
function bentProfile(L, A) {
  const n = L.length;
  const heads = [0];
  for (let i = 1; i < n; i++) heads.push(heads[i - 1] + ((A[i - 1] || 0) * D2R));
  const pts = [[0, 0]];
  for (let i = 0; i < n; i++) pts.push([pts[i][0] + L[i] * Math.cos(heads[i]), pts[i][1] + L[i] * Math.sin(heads[i])]);
  const chi = Math.atan2(pts[n][1], pts[n][0]);
  const c = Math.cos(-chi), sn = Math.sin(-chi);
  const rp = pts.map(([a, f]) => [a * c - f * sn, a * sn + f * c]);
  const hs = heads.map((h) => h - chi);
  const total = L.reduce((x, y) => x + y, 0), half = total / 2;
  let acc = 0, mid = [0, 0];
  for (let i = 0; i < n; i++) {
    if (acc + L[i] >= half - 1e-9) { const k = L[i] ? (half - acc) / L[i] : 0; mid = [rp[i][0] + (rp[i + 1][0] - rp[i][0]) * k, rp[i][1] + (rp[i + 1][1] - rp[i][1]) * k]; break; }
    acc += L[i];
  }
  return rp.map(([a, f], i) => {
    const h0 = hs[Math.max(0, i - 1)], h1 = hs[Math.min(n - 1, i)];
    const hm = i === 0 ? h1 : i === n ? h0 : (h0 + h1) / 2;
    return { a: a - mid[0], f: f - mid[1], na: -Math.sin(hm), nf: Math.cos(hm) };
  });
}

/** Joint angles per column (h) / row (v): explicit list (mode 'joints') or uniform curve ('h' / 'v' + curveDeg). */
function jointAngles(s, axis, count) {
  const sg = s.stage || {};
  if (sg.curve === 'joints') { const arr = (axis === 'h' ? sg.jh : sg.jv) || []; return Array.from({ length: count }, (_, i) => +arr[i] || 0); }
  if (sg.curve === axis && Math.abs(sg.curveDeg || 0) > 1e-4) return Array.from({ length: count }, () => +sg.curveDeg);
  return Array.from({ length: count }, () => 0);
}

/**
 * Unified screen geometry: horizontal profile (joints / uniform / rail) swept with the vertical profile (joints / uniform).
 * One facet per cabinet; rails add stations where they bend. Rail geometry is in rail space with absolute Y.
 */
export function surfaceGeometry(p, s, rail = null) {
  const m = M.surfaceMeters(p, s);
  const { xc, yc } = M.jointCuts(p, s);
  // ---- horizontal stations { x, z, nx, nz, u }
  let H;
  if (rail) {
    const rb = M.railBuild(rail);
    const d0 = +s.stage.railOffset || 0;
    const ds = xc.map((v) => d0 + v * m.mx);
    ds.push(...rb.bends(d0, d0 + m.w));
    const uniq = [...new Set(ds.map((v) => Math.round(v * 1e5) / 1e5))].sort((a, b) => a - b);
    H = uniq.map((d) => { const q = rb.at(d); return { x: q.x, z: q.z, nx: -Math.sin(q.th), nz: Math.cos(q.th), u: (d - d0) / m.w }; });
    if (s.stage.railFlip) H = H.reverse().map((q) => ({ ...q, nx: -q.nx, nz: -q.nz, u: 1 - q.u }));
  } else {
    const A = jointAngles(s, 'h', xc.length - 2);
    const bent = A.some((a) => a);
    const cuts = bent ? xc : [0, s.w];
    const L = cuts.slice(1).map((v, i) => (v - cuts[i]) * m.mx);
    H = bentProfile(L, bent ? A : []).map((q, i) => ({ x: q.a, z: q.f, nx: q.na, nz: q.nf, u: cuts[i] / s.w }));
  }
  // ---- vertical stations { y, f, ny, nf, v } (top -> bottom)
  const AV = jointAngles(s, 'v', yc.length - 2);
  const vb = AV.some((a) => a);
  const ycut = vb ? yc : [0, s.h];
  const LV = ycut.slice(1).map((v, i) => (v - ycut[i]) * m.my);
  const yOff = rail ? (+s.stage.y || 0) : 0;
  const V = bentProfile(LV, vb ? AV : []).map((q, j) => ({ y: yOff - q.a, f: q.f, ny: -q.na, nf: q.nf, v: 1 - ycut[j] / s.h }));
  // ---- grid
  const nh = H.length, nv = V.length;
  const pos = [], uv = [], nrm = [];
  const up = !!(rail && s.stage.upside);          // hung upside down on the rail: pixel (0,0) bottom-right seen from the front
  for (const hq of H) for (const vq of V) {
    pos.push(hq.x + hq.nx * vq.f, vq.y, hq.z + hq.nz * vq.f);
    uv.push(up ? 1 - hq.u : hq.u, up ? 1 - vq.v : vq.v);
    const nx = hq.nx * vq.nf, ny = vq.ny, nz = hq.nz * vq.nf, l = Math.hypot(nx, ny, nz) || 1;
    nrm.push(nx / l, ny / l, nz / l);
  }
  const I = (i, j) => i * nv + j;
  const index = [];
  for (let i = 0; i < nh - 1; i++) for (let j = 0; j < nv - 1; j++) {
    const A0 = I(i, j), B0 = I(i + 1, j), C0 = I(i, j + 1), D0 = I(i + 1, j + 1);
    index.push(A0, C0, B0, B0, C0, D0);
  }
  // ---- cabinet shell: back grid + 4 sides
  const depth = 0.085;
  const nF = nh * nv;
  const shell = [...pos];
  for (let k = 0; k < nF; k++) shell.push(pos[k * 3] - nrm[k * 3] * depth, pos[k * 3 + 1] - nrm[k * 3 + 1] * depth, pos[k * 3 + 2] - nrm[k * 3 + 2] * depth);
  const shellIdx = [];
  const Bk = (i, j) => nF + I(i, j);
  for (let i = 0; i < nh - 1; i++) for (let j = 0; j < nv - 1; j++) shellIdx.push(Bk(i, j), Bk(i + 1, j), Bk(i, j + 1), Bk(i + 1, j), Bk(i + 1, j + 1), Bk(i, j + 1));
  const side = (a, b) => shellIdx.push(a, nF + a, b, nF + a, nF + b, b);
  for (let i = 0; i < nh - 1; i++) { side(I(i, 0), I(i + 1, 0)); side(I(i, nv - 1), I(i + 1, nv - 1)); }
  for (let j = 0; j < nv - 1; j++) { side(I(0, j), I(0, j + 1)); side(I(nh - 1, j), I(nh - 1, j + 1)); }
  // ---- outline (border loop)
  const loop = [];
  for (let i = 0; i < nh; i++) loop.push(I(i, nv - 1));
  for (let j = nv - 1; j >= 0; j--) loop.push(I(nh - 1, j));
  for (let i = nh - 1; i >= 0; i--) loop.push(I(i, 0));
  for (let j = 0; j < nv; j++) loop.push(I(0, j));
  const outline = [];
  for (const k of loop) outline.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  return { pos, uv, index, outline, shell, shellIdx, meters: m, facets: (nh - 1) * (nv - 1) };
}
export const screenGeometry = (p, s) => surfaceGeometry(p, s, null);
export const railGeometry = (p, s, rail) => surfaceGeometry(p, s, rail);

/** Rotation matrix (row-major 3×3) of Euler angles in degrees, order YXZ (yaw, tilt, roll) as in the 3D stage. */
function rotYXZ(rx, ry, rz) {
  const a = rx * D2R, b = ry * D2R, c = rz * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // R = Ry · Rx · Rz
  return [
    cb * cc + sb * sa * sc, -cb * sc + sb * sa * cc, sb * ca,
    ca * sc, ca * cc, -sa,
    -sb * cc + cb * sa * sc, sb * sc + cb * sa * cc, cb * ca
  ];
}
/**
 * Screen in world space for the 2D renderer: facets { x0, y0, x1, y1 (pixels), p00, p10, p01 (world corners: top-left,
 * top-right, bottom-left of the facet) }. Same placement as the 3D stage (rail: rail position + yaw; free: x y z + YXZ).
 * Screens mapped on a 3D model mesh use their placement as a flat screen (approximation).
 */
export function surfaceWorld(p, s) {
  const st = s.stage || {};
  const rail = st.rail ? ((p.stage && p.stage.rails) || []).find((r) => r.id === st.rail) : null;
  if (st.rail && !rail) return null;
  const g = surfaceGeometry(p, s, rail);
  let R, T;
  if (rail) { R = rotYXZ(0, +rail.ry || 0, 0); T = [+rail.x || 0, 0, +rail.z || 0]; }
  else { R = rotYXZ(+st.rx || 0, +st.ry || 0, +st.rz || 0); T = [+st.x || 0, +st.y || 0, +st.z || 0]; }
  const W = (k) => { const x = g.pos[k * 3], y = g.pos[k * 3 + 1], z = g.pos[k * 3 + 2];
    return [R[0] * x + R[1] * y + R[2] * z + T[0], R[3] * x + R[4] * y + R[5] * z + T[1], R[6] * x + R[7] * y + R[8] * z + T[2]]; };
  // grid: stations H (columns) × V (rows); vertex (i, j) = i * nv + j; uv: u →, v ↑ (upside-down rails flip both)
  const n = g.pos.length / 3;
  let nv = 1; while (nv < n && Math.abs(g.uv[nv * 2] - g.uv[0]) < 1e-9) nv++;
  const nh = n / nv;
  const px = (k) => [g.uv[k * 2] * s.w, (1 - g.uv[k * 2 + 1]) * s.h];
  const facets = [];
  for (let i = 0; i < nh - 1; i++) for (let j = 0; j < nv - 1; j++) {
    const ks = [i * nv + j, (i + 1) * nv + j, i * nv + j + 1, (i + 1) * nv + j + 1];
    const P = ks.map(px), Wp = ks.map(W);
    // order the corners as top-left / top-right / bottom-left in pixel space (handles flipped / upside-down screens)
    const xs = P.map((q) => q[0]), ys = P.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const near = (x, y) => { let best = 0, bd = Infinity; P.forEach((q, k) => { const d = Math.abs(q[0] - x) + Math.abs(q[1] - y); if (d < bd) { bd = d; best = k; } }); return Wp[best]; };
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) continue;
    facets.push({ x0, y0, x1, y1, p00: near(x0, y0), p10: near(x1, y0), p01: near(x0, y1) });
  }
  return { facets };
}
