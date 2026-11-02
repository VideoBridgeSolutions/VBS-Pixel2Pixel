// Pixel2Pixel — fast picking on heavy 3D models (venues: seats, trusses, crowd…). three.js tests every triangle of every
// mesh the ray meets; on a model with millions of triangles one click froze the app. Here:
//   - one bounding-volume hierarchy per geometry (built on the first pick, cached on the geometry, ~16 triangles per leaf);
//   - meshes visited nearest-first by bounding sphere, stopping as soon as no remaining mesh can be closer.
import * as THREE from '../vendor/three/three.module.js';

const LEAF = 16;
const _inv = new THREE.Matrix4(), _ray = new THREE.Ray(), _sph = new THREE.Sphere();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _hit = new THREE.Vector3();

/** BVH of a geometry: { nodes: Float32Array (6 per node: box), meta: Int32Array (3 per node: left|start, right|count, leaf), tri: Uint32Array }. */
function buildBVH(geo) {
  const pos = geo.getAttribute('position'), idx = geo.index;
  const n = Math.floor((idx ? idx.count : pos.count) / 3);
  const vert = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
  const bmin = new Float32Array(n * 3), bmax = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) { const i = vert(t, k), x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z; if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z; }
    bmin[t * 3] = x0; bmin[t * 3 + 1] = y0; bmin[t * 3 + 2] = z0; bmax[t * 3] = x1; bmax[t * 3 + 1] = y1; bmax[t * 3 + 2] = z1;
    cx[t] = (x0 + x1) / 2; cy[t] = (y0 + y1) / 2; cz[t] = (z0 + z1) / 2;
  }
  const tri = new Uint32Array(n); for (let t = 0; t < n; t++) tri[t] = t;
  const nodes = [], meta = [];
  const make = (s, e) => {
    const id = meta.length / 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = s; i < e; i++) { const t = tri[i];
      x0 = Math.min(x0, bmin[t * 3]); y0 = Math.min(y0, bmin[t * 3 + 1]); z0 = Math.min(z0, bmin[t * 3 + 2]);
      x1 = Math.max(x1, bmax[t * 3]); y1 = Math.max(y1, bmax[t * 3 + 1]); z1 = Math.max(z1, bmax[t * 3 + 2]); }
    nodes.push(x0, y0, z0, x1, y1, z1); meta.push(0, 0, 0);
    if (e - s <= LEAF) { meta[id * 3] = s; meta[id * 3 + 1] = e - s; meta[id * 3 + 2] = 1; return id; }
    // split the longest axis at the centroid median (partial sort by nth element)
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const C = dx >= dy && dx >= dz ? cx : dy >= dz ? cy : cz;
    const mid = (s + e) >> 1;
    let lo = s, hi = e - 1;
    while (lo < hi) {   // quickselect
      const pv = C[tri[(lo + hi) >> 1]]; let i = lo, j = hi;
      while (i <= j) { while (C[tri[i]] < pv) i++; while (C[tri[j]] > pv) j--; if (i <= j) { const tt = tri[i]; tri[i] = tri[j]; tri[j] = tt; i++; j--; } }
      if (mid <= j) hi = j; else if (mid >= i) lo = i; else break;
    }
    const l = make(s, mid), r = make(mid, e);
    meta[id * 3] = l; meta[id * 3 + 1] = r; meta[id * 3 + 2] = 0;
    return id;
  };
  if (n) make(0, n);
  return { nodes: new Float32Array(nodes), meta: new Int32Array(meta), tri, n, vert };
}

/** Distance along the ray to a box, or Infinity. */
function boxDist(r, B, o) {
  const ox = r.origin.x, oy = r.origin.y, oz = r.origin.z, dx = r.direction.x, dy = r.direction.y, dz = r.direction.z;
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const org = k === 0 ? ox : k === 1 ? oy : oz, d = k === 0 ? dx : k === 1 ? dy : dz;
    const mn = B[o + k], mx = B[o + 3 + k];
    if (Math.abs(d) < 1e-12) { if (org < mn || org > mx) return Infinity; continue; }
    let a = (mn - org) / d, b = (mx - org) / d; if (a > b) { const tt = a; a = b; b = tt; }
    if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Nearest hit of a local-space ray on a geometry (BVH), or null: { t (local), face index }. */
function hitGeometry(geo, r, maxT) {
  const B = geo.userData.p2pBVH || (geo.userData.p2pBVH = buildBVH(geo));
  if (!B.n) return null;
  const pos = geo.getAttribute('position');
  let best = maxT, face = -1;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop();
    if (boxDist(r, B.nodes, id * 6) >= best) continue;
    if (B.meta[id * 3 + 2]) {
      const s = B.meta[id * 3], c = B.meta[id * 3 + 1];
      for (let i = s; i < s + c; i++) {
        const t = B.tri[i];
        _a.fromBufferAttribute(pos, B.vert(t, 0)); _b.fromBufferAttribute(pos, B.vert(t, 1)); _c.fromBufferAttribute(pos, B.vert(t, 2));
        if (r.intersectTriangle(_a, _b, _c, false, _hit)) { const d = _hit.distanceTo(r.origin); if (d < best) { best = d; face = t; } }
      }
    } else {
      const l = B.meta[id * 3], rr = B.meta[id * 3 + 1];
      const dl = boxDist(r, B.nodes, l * 6), dr = boxDist(r, B.nodes, rr * 6);
      if (dl < dr) { if (dr < best) stack.push(rr); if (dl < best) stack.push(l); } else { if (dl < best) stack.push(l); if (dr < best) stack.push(rr); }
    }
  }
  return face < 0 ? null : { t: best, face };
}

/** Nearest mesh hit by a world ray among `meshes` (visible, non-empty draw range assumed): { object, distance, point } | null. */
export function pickFirst(ray, meshes) {
  const cand = [];
  for (const m of meshes) {
    const g = m.geometry; if (!g || !g.getAttribute('position')) continue;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sph.copy(g.boundingSphere).applyMatrix4(m.matrixWorld);
    if (!ray.intersectsSphere(_sph)) continue;
    const d = Math.max(0, ray.origin.distanceTo(_sph.center) - _sph.radius);
    cand.push([d, m]);
  }
  cand.sort((x, y) => x[0] - y[0]);
  let best = null, bestD = Infinity;
  for (const [d, m] of cand) {
    if (d > bestD) break;   // no remaining mesh can be closer
    _inv.copy(m.matrixWorld).invert();
    _ray.copy(ray).applyMatrix4(_inv);
    // local distances differ from world ones under scale: the hit is compared in world space
    const h = hitGeometry(m.geometry, _ray, Infinity);
    if (!h) continue;
    const p = _ray.at(h.t, new THREE.Vector3()).applyMatrix4(m.matrixWorld);
    const dw = p.distanceTo(ray.origin);
    if (dw < bestD) { bestD = dw; best = { object: m, distance: dw, point: p, faceIndex: h.face }; }
  }
  return best;
}
