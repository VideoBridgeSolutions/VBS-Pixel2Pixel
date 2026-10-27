// Pixel2Pixel — map a flat pixelmap surface onto a mesh of an imported 3D model.
// Auto-unwrap for screen-like shapes: flat, curved bands, S / waves, returns (geodesic distance along the band),
// closed rings (angle around the centre), floors (top view). The model's own UVs can be used instead.
import * as THREE from '../vendor/three/three.module.js';

const KEY = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

/** Non-indexed world-space triangles of one or several meshes (+ their own uv when all have one); triMesh[t] = source mesh. */
function worldTriangles(meshes) {
  const parts = [];
  let hasUV = true, n = 0;
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    let g = mesh.geometry;
    g = g.index ? g.toNonIndexed() : g.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (!g.getAttribute('uv')) hasUV = false;
    parts.push(g); n += g.getAttribute('position').count;
  }
  const pos = new Float32Array(n * 3), uv = hasUV ? new Float32Array(n * 2) : null, triMesh = new Int32Array(n / 3);
  let o = 0;
  parts.forEach((g, k) => {
    const P = g.getAttribute('position'), c = P.count;
    for (let i = 0; i < c; i++) { pos[(o + i) * 3] = P.getX(i); pos[(o + i) * 3 + 1] = P.getY(i); pos[(o + i) * 3 + 2] = P.getZ(i); }
    if (uv) { const U = g.getAttribute('uv'); for (let i = 0; i < c; i++) { uv[(o + i) * 2] = U.getX(i); uv[(o + i) * 2 + 1] = U.getY(i); } }
    triMesh.fill(k, o / 3, (o + c) / 3);
    o += c; g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.userData.triMesh = triMesh;
  return out;
}

/** Thin-panel normal of a set of points (PCA): { n: Vector3 (unit), thin: bool } — n = axis of least spread. */
export function thinNormal(points) {
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.divideScalar(Math.max(1, points.length));
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) { const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z; xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z; }
  const C = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  const mul = (v) => new THREE.Vector3(C[0][0] * v.x + C[0][1] * v.y + C[0][2] * v.z, C[1][0] * v.x + C[1][1] * v.y + C[1][2] * v.z, C[2][0] * v.x + C[2][1] * v.y + C[2][2] * v.z);
  const power = (v, defl) => { for (let i = 0; i < 40; i++) { for (const d of defl) v.addScaledVector(d, -v.dot(d)); v = mul(v); const l = v.length(); if (l < 1e-12) break; v.divideScalar(l); } for (const d of defl) v.addScaledVector(d, -v.dot(d)); return v.normalize(); };
  const e1 = power(new THREE.Vector3(1, 0.31, 0.17), []);
  const e2 = power(new THREE.Vector3(0.13, 1, 0.41), [e1]);
  const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
  const l1 = mul(e1).dot(e1), l3 = Math.max(0, mul(n).dot(n));
  return { n, thin: l1 > 0 && Math.sqrt(l3 / l1) < 0.3 };
}

/**
 * Build the mapped geometry.
 * opts: { uv: 'auto' | 'model', faces: 'auto' | 'front' | 'outer' | 'inner' | 'all', flipU, flipV, swap }
 * Returns { geometry, info: { kind, length, height, faces, hasModelUV } }
 */
export function buildMappedGeometry(meshIn, opts = {}) {
  const meshes = Array.isArray(meshIn) ? meshIn : [meshIn];
  const g = worldTriangles(meshes);
  const triMesh = g.userData.triMesh;
  const P = g.getAttribute('position');
  const nV = P.count, nT = nV / 3;
  const hasModelUV = !!g.getAttribute('uv');
  const box = new THREE.Box3().setFromBufferAttribute(P);
  const size = box.getSize(new THREE.Vector3());
  const minY = box.min.y, H = Math.max(1e-6, size.y);
  const foot = Math.max(size.x, size.z);
  // floor = flat AND mostly facing up (a long low LED band is flat too, but faces sideways)
  let upA = 0, allA = 0;
  { const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t < nT; t++) { a.fromBufferAttribute(P, t * 3); b.fromBufferAttribute(P, t * 3 + 1); c.fromBufferAttribute(P, t * 3 + 2);
      n.crossVectors(b.sub(a), c.sub(a)); const ar = n.length(); allA += ar; if (ar > 0 && Math.abs(n.y) / ar > 0.7) upA += ar; } }
  const floor = size.y < 0.05 * foot && upA > 0.5 * allA;

  // ---- welded topology (GLB meshes split vertices per face)
  const wid = new Int32Array(nV);
  const wpos = [];
  const map = new Map();
  for (let i = 0; i < nV; i++) {
    const k = KEY(P.getX(i), P.getY(i), P.getZ(i));
    let id = map.get(k);
    if (id === undefined) { id = wpos.length; map.set(k, id); wpos.push([P.getX(i), P.getY(i), P.getZ(i)]); }
    wid[i] = id;
  }
  const nW = wpos.length;

  // ---- footprint analysis: ring?
  let cx = 0, cz = 0;
  for (const [x, , z] of wpos) { cx += x; cz += z; }
  cx /= nW; cz /= nW;
  const ang = wpos.map(([x, , z]) => Math.atan2(z - cz, x - cx));
  const rad = wpos.map(([x, , z]) => Math.hypot(x - cx, z - cz));
  const sorted = [...ang].sort((a, b) => a - b);
  let maxGap = sorted.length ? sorted[0] + 2 * Math.PI - sorted[sorted.length - 1] : 2 * Math.PI;
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
  const rMean = rad.reduce((a, b) => a + b, 0) / Math.max(1, nW);
  const rDev = Math.sqrt(rad.reduce((a, r) => a + (r - rMean) ** 2, 0) / Math.max(1, nW)) / Math.max(1e-6, rMean);
  const ring = !floor && maxGap < 30 * Math.PI / 180 && rDev < 0.25;

  // ---- faces kept
  const N = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), a3 = new THREE.Vector3(), b3 = new THREE.Vector3(), c3 = new THREE.Vector3();
  let faces = opts.faces || 'auto';
  if (faces === 'auto') faces = floor ? 'up' : ring ? 'outer' : 'front';
  // per source mesh: thin-panel normal (cabinet modelled as a box: keep only its big faces, not the sides)
  const meshThin = meshes.map((m, k) => {
    const pts = [];
    const step = Math.max(1, Math.floor(P.count / 4000));
    for (let i = 0; i < P.count; i += step) if (triMesh[Math.floor(i / 3)] === k) pts.push(new THREE.Vector3(P.getX(i), P.getY(i), P.getZ(i)));
    if (pts.length < 6) { for (let i = 0; i < P.count; i++) if (triMesh[Math.floor(i / 3)] === k) pts.push(new THREE.Vector3(P.getX(i), P.getY(i), P.getZ(i))); }
    return pts.length >= 4 ? thinNormal(pts) : { thin: false };
  });
  // cabinets modelled one by one (thin meshes: LED face, back, frame…): orient their panel normals consistently along
  // the surface (a band can turn to face the sides), then the LED side = the side facing the audience (+Z) on average.
  // 'front' then keeps the faces on that side wherever the band turns; 'back' the other side.
  let field = null;
  if (!floor && !ring && meshes.length > 1 && (faces === 'front' || faces === 'back')) field = orientField(meshes.length, meshThin, P, triMesh, nT);
  // a cabinet = LED face + back + frame meshes: keep only the meshes that are mostly LED side (else the back / frame
  // bits add zigzags to the distance along the band and show through)
  let faceMesh = null;
  if (field) {
    const fa = new Float64Array(meshes.length), ta = new Float64Array(meshes.length);
    for (let t = 0; t < nT; t++) {
      a3.fromBufferAttribute(P, t * 3); b3.fromBufferAttribute(P, t * 3 + 1); c3.fromBufferAttribute(P, t * 3 + 2);
      N.crossVectors(e1.subVectors(b3, a3), e2.subVectors(c3, a3));
      const ar = N.length(); if (ar < 1e-12) continue; N.divideScalar(ar);
      const k = triMesh[t], mt = meshThin[k], fs = field[k];
      ta[k] += ar;
      if (fs && mt.thin && (N.x * mt.n.x + N.y * mt.n.y + N.z * mt.n.z) * fs * (faces === 'back' ? -1 : 1) > 0.5) fa[k] += ar;
    }
    faceMesh = Array.from(fa, (x, k) => ta[k] > 0 && x / ta[k] > 0.6);
    if (!faceMesh.some(Boolean)) faceMesh = null;
  }
  const keep = [];
  for (let t = 0; t < nT; t++) {
    if (faceMesh && !faceMesh[triMesh[t]]) continue;
    a3.fromBufferAttribute(P, t * 3); b3.fromBufferAttribute(P, t * 3 + 1); c3.fromBufferAttribute(P, t * 3 + 2);
    N.crossVectors(e1.subVectors(b3, a3), e2.subVectors(c3, a3));
    const area = N.length(); if (area < 1e-12) continue;
    N.divideScalar(area);
    const mt = meshThin[triMesh[t]];
    if (faces !== 'all' && mt && mt.thin && Math.abs(N.dot(mt.n)) < 0.7) continue;   // side of a cabinet box
    let ok = true;
    const fs = field ? field[triMesh[t]] : 0;
    if (faces === 'up') ok = N.y > 0.5;
    else if (fs && (faces === 'front' || faces === 'back')) { const d = (N.x * mt.n.x + N.y * mt.n.y + N.z * mt.n.z) * fs; ok = (faces === 'front' ? d > 0.5 : d < -0.5) && Math.abs(N.y) < 0.8; }
    else if (faces === 'front') ok = N.z > 0.05 && Math.abs(N.y) < 0.8;
    else if (faces === 'back') ok = N.z < -0.05 && Math.abs(N.y) < 0.8;
    else if (faces === 'outer' || faces === 'inner') {
      const mx = (a3.x + b3.x + c3.x) / 3 - cx, mz = (a3.z + b3.z + c3.z) / 3 - cz;
      const d = N.x * mx + N.z * mz;
      ok = (faces === 'outer' ? d > 0 : d < 0) && Math.abs(N.y) < 0.8;
    } else if (faces === 'all') ok = true;
    if (ok) keep.push(t);
  }
  if (!keep.length) for (let t = 0; t < nT; t++) keep.push(t);   // inverted normals / single-sided plane: keep everything

  // ---- per welded vertex u, v
  const U = new Float64Array(nW), Vv = new Float64Array(nW);
  let kind, length;
  if (floor) {
    kind = 'floor';
    for (let i = 0; i < nW; i++) { U[i] = (wpos[i][0] - box.min.x) / Math.max(1e-6, size.x); Vv[i] = (box.max.z - wpos[i][2]) / Math.max(1e-6, size.z); }   // top of the image at the back, read from the audience
    length = size.x;
  } else if (ring) {
    kind = 'ring';
    const seam = Math.atan2(-1, 0);                  // seam at the back (−Z, away from the audience)
    for (let i = 0; i < nW; i++) {
      let a = ang[i] - seam; a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      U[i] = 1 - a / (2 * Math.PI);                  // left → right seen from the front (+Z), outside
      Vv[i] = (wpos[i][1] - minY) / H;
    }
    length = 2 * Math.PI * rMean;
  } else {
    kind = 'band';
    // graph of welded edges, horizontal (XZ) length: distance along the band, independent of height
    const adj = Array.from({ length: nW }, () => []);
    const add = (a, b) => {
      if (a === b) return;
      const w = Math.hypot(wpos[a][0] - wpos[b][0], wpos[a][2] - wpos[b][2]) + 1e-7 * Math.abs(wpos[a][1] - wpos[b][1]);
      adj[a].push([b, w]); adj[b].push([a, w]);
    };
    const graphTris = keep.length ? keep : Array.from({ length: nT }, (_, t) => t);   // visible faces only: distances measured on the LED face
    for (const t of graphTris) { const a = wid[t * 3], b = wid[t * 3 + 1], c = wid[t * 3 + 2]; add(a, b); add(b, c); add(c, a); }
    // separate pieces (cabinets modelled one by one, joints / gaps): bridge vertices of different pieces closer than tol
    const parent = new Int32Array(nW).map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const inGraph = new Uint8Array(nW);
    for (const t of graphTris) { const a = find(wid[t * 3]), b = find(wid[t * 3 + 1]); parent[b] = a; parent[find(wid[t * 3 + 2])] = a; inGraph[wid[t * 3]] = inGraph[wid[t * 3 + 1]] = inGraph[wid[t * 3 + 2]] = 1; }
    let comps = 0; for (let i = 0; i < nW; i++) if (inGraph[i] && find(i) === i) comps++;
    if (comps > 1) {
      // link every piece to its nearest pieces (centroid distance) through their closest vertices: robust to any gap,
      // overlap or angle between cabinets (curves), keeps distances along the surface
      const groups = new Map();
      for (let i = 0; i < nW; i++) { if (!inGraph[i]) continue; const r = find(i); let gl = groups.get(r); if (!gl) groups.set(r, gl = []); gl.push(i); }
      const G = [...groups.values()].map((vs) => {
        const c = [0, 0, 0]; for (const v of vs) { c[0] += wpos[v][0]; c[1] += wpos[v][1]; c[2] += wpos[v][2]; }
        const step = Math.max(1, Math.floor(vs.length / 160));
        return { c: c.map((x) => x / vs.length), vs: vs.filter((_, k) => k % step === 0) };
      });
      const K = Math.min(4, G.length - 1);
      const linked = new Set();
      for (let gi = 0; gi < G.length; gi++) {
        const near = [];
        for (let gj = 0; gj < G.length; gj++) if (gj !== gi) { const d = Math.hypot(G[gi].c[0] - G[gj].c[0], G[gi].c[1] - G[gj].c[1], G[gi].c[2] - G[gj].c[2]); near.push([d, gj]); }
        near.sort((x, y) => x[0] - y[0]);
        for (const [, gj] of near.slice(0, K)) {
          const key = gi < gj ? gi + ':' + gj : gj + ':' + gi;
          if (linked.has(key)) continue;
          linked.add(key);
          let best = Infinity, ba = -1, bb = -1;
          for (const va of G[gi].vs) for (const vb of G[gj].vs) { const d = (wpos[va][0] - wpos[vb][0]) ** 2 + (wpos[va][1] - wpos[vb][1]) ** 2 + (wpos[va][2] - wpos[vb][2]) ** 2; if (d < best) { best = d; ba = va; bb = vb; } }
          if (ba >= 0) add(ba, bb);
        }
      }
      // cabinets made of several meshes (face + back + frame) cluster together: the K nearest can all be the same
      // cabinet. Join the remaining clusters to their nearest one until the graph is connected (Borůvka).
      const gp = G.map((_, i) => i);
      const gf = (x) => { while (gp[x] !== x) { gp[x] = gp[gp[x]]; x = gp[x]; } return x; };
      for (const key of linked) { const [a, b] = key.split(':').map(Number); gp[gf(a)] = gf(b); }
      for (let pass = 0; pass < 40; pass++) {
        const best = new Map();
        for (let gi = 0; gi < G.length; gi++) {
          const ri = gf(gi);
          for (let gj = 0; gj < G.length; gj++) {
            if (gf(gj) === ri) continue;
            const d = (G[gi].c[0] - G[gj].c[0]) ** 2 + (G[gi].c[1] - G[gj].c[1]) ** 2 + (G[gi].c[2] - G[gj].c[2]) ** 2;
            const b = best.get(ri); if (!b || d < b[0]) best.set(ri, [d, gi, gj]);
          }
        }
        if (!best.size) break;
        for (const [, gi, gj] of best.values()) {
          if (gf(gi) === gf(gj)) continue;
          gp[gf(gi)] = gf(gj);
          let bd = Infinity, ba = -1, bb = -1;
          for (const va of G[gi].vs) for (const vb of G[gj].vs) { const d = (wpos[va][0] - wpos[vb][0]) ** 2 + (wpos[va][1] - wpos[vb][1]) ** 2 + (wpos[va][2] - wpos[vb][2]) ** 2; if (d < bd) { bd = d; ba = va; bb = vb; } }
          if (ba >= 0) add(ba, bb);
        }
      }
    }
    const dijkstra = (src) => {
      const d = new Float64Array(nW).fill(Infinity);
      d[src] = 0;
      // binary heap
      const hp = [[0, src]];
      const push = (it) => { hp.push(it); let i = hp.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hp[p][0] <= hp[i][0]) break; [hp[p], hp[i]] = [hp[i], hp[p]]; i = p; } };
      const pop = () => { const top = hp[0]; const last = hp.pop(); if (hp.length) { hp[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < hp.length && hp[l][0] < hp[m][0]) m = l; if (r < hp.length && hp[r][0] < hp[m][0]) m = r; if (m === i) break; [hp[m], hp[i]] = [hp[i], hp[m]]; i = m; } } return top; };
      while (hp.length) {
        const [du, u] = pop();
        if (du > d[u]) continue;
        for (const [v, w] of adj[u]) if (du + w < d[v]) { d[v] = du + w; push([d[v], v]); }
      }
      return d;
    };
    const far = (d) => { let best = 0, bv = -1; for (let i = 0; i < nW; i++) if (Number.isFinite(d[i]) && d[i] > bv) { bv = d[i]; best = i; } return best; };
    let src0 = 0; while (src0 < nW - 1 && !inGraph[src0]) src0++;
    const A = far(dijkstra(src0));
    const dA = dijkstra(A);
    // disconnected pieces (separate shells) fall back to projection on the main axis
    let dmax = 0; for (let i = 0; i < nW; i++) if (Number.isFinite(dA[i])) dmax = Math.max(dmax, dA[i]);
    const axisX = size.x >= size.z;
    for (let i = 0; i < nW; i++) {
      U[i] = Number.isFinite(dA[i]) && dmax > 0 ? dA[i] / dmax : (axisX ? (wpos[i][0] - box.min.x) / Math.max(1e-6, size.x) : (wpos[i][2] - box.min.z) / Math.max(1e-6, size.z));
      Vv[i] = (wpos[i][1] - minY) / H;
    }
    // u grows towards +X (left → right for the audience at +Z)
    let sx0 = 0, n0 = 0, sx1 = 0, n1 = 0;
    for (let i = 0; i < nW; i++) { if (!inGraph[i] || !Number.isFinite(dA[i])) continue; if (U[i] < 0.1) { sx0 += wpos[i][0]; n0++; } else if (U[i] > 0.9) { sx1 += wpos[i][0]; n1++; } }
    if (n0 && n1 && sx0 / n0 > sx1 / n1) for (let i = 0; i < nW; i++) U[i] = 1 - U[i];
    length = dmax;
  }

  // ---- output geometry (non-indexed, seams fixed per triangle), optionally clipped to a portion of the object
  const R = opts.range || null;
  const u0 = R ? clamp01(R.u0 ?? 0) : 0, u1 = R ? clamp01(R.u1 ?? 1) : 1, v0 = R ? clamp01(R.v0 ?? 0) : 0, v1 = R ? clamp01(R.v1 ?? 1) : 1;
  const ranged = !!R && (u0 > 0 || u1 < 1 || v0 > 0 || v1 < 1) && u1 > u0 && v1 > v0;
  const outPos = [], outUV = [];
  const MU = hasModelUV ? g.getAttribute('uv') : null;
  const emit = (poly) => {   // poly: [[x, y, z, u, v], …] in raw object coordinates
    for (let k = 1; k + 1 < poly.length; k++) for (const q of [poly[0], poly[k], poly[k + 1]]) {
      outPos.push(q[0], q[1], q[2]);
      let u = ranged ? (q[3] - u0) / (u1 - u0) : q[3], v = ranged ? (q[4] - v0) / (v1 - v0) : q[4];
      if (opts.swap) [u, v] = [v, 1 - u];
      if (opts.flipU) u = 1 - u;
      if (opts.flipV) v = 1 - v;
      outUV.push(u, v);
    }
  };
  for (const t of keep) {
    const tri = [];
    for (let j = 0; j < 3; j++) {
      const i = t * 3 + j;
      const uvv = opts.uv === 'model' && MU ? [MU.getX(i), MU.getY(i)] : [U[wid[i]], Vv[wid[i]]];
      tri.push([P.getX(i), P.getY(i), P.getZ(i), uvv[0], uvv[1]]);
    }
    if (kind === 'ring' && opts.uv !== 'model') {
      const us = tri.map((q) => q[3]);
      if (Math.max(...us) - Math.min(...us) > 0.5) for (const q of tri) if (q[3] < 0.5) q[3] += 1;
    }
    if (!ranged) { emit(tri); continue; }
    // a ring triangle across the seam has u > 1: its part beyond 1 belongs to the start of the ring
    const copies = [tri];
    if (kind === 'ring' && tri.some((q) => q[3] > 1)) copies.push(tri.map((q) => [q[0], q[1], q[2], q[3] - 1, q[4]]));
    for (const c of copies) {
      let poly = clip(c, 3, u0, 1); poly = clip(poly, 3, u1, -1); poly = clip(poly, 4, v0, 1); poly = clip(poly, 4, v1, -1);
      if (poly.length >= 3) emit(poly);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outPos), 3));
  out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUV), 2));
  out.computeVertexNormals(); out.computeBoundingBox(); out.computeBoundingSphere();
  g.dispose();
  const fullH = floor ? size.z : size.y;
  return { geometry: out, info: { kind, length: ranged ? length * (u1 - u0) : length, height: ranged ? fullH * (v1 - v0) : fullH, fullLength: length, fullHeight: fullH, ranged, faces, kept: keep.length, total: nT, hasModelUV } };
}

/**
 * Consistent sign per source mesh for the thin-panel normals: propagate between neighbouring meshes (centroid kNN,
 * only through near-parallel pairs), then flip everything so the area-weighted normal faces +Z (audience).
 * Returns Int8Array (±1, 0 = not a thin panel) or null when the meshes are not mostly thin panels.
 */
function orientField(nM, meshThin, P, triMesh, nT) {
  const c = Array.from({ length: nM }, () => [0, 0, 0, 0]);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
  let thinA = 0, allA = 0;
  for (let t = 0; t < nT; t++) {
    a.fromBufferAttribute(P, t * 3); b.fromBufferAttribute(P, t * 3 + 1); d.fromBufferAttribute(P, t * 3 + 2);
    const ar = n.crossVectors(b.clone().sub(a), d.clone().sub(a)).length() / 2;
    const k = triMesh[t], q = c[k];
    q[0] += (a.x + b.x + d.x) / 3 * ar; q[1] += (a.y + b.y + d.y) / 3 * ar; q[2] += (a.z + b.z + d.z) / 3 * ar; q[3] += ar;
    allA += ar; if (meshThin[k] && meshThin[k].thin) thinA += ar;
  }
  if (thinA < 0.6 * allA) return null;
  const ids = [];
  for (let k = 0; k < nM; k++) if (meshThin[k] && meshThin[k].thin && c[k][3] > 0) { c[k][0] /= c[k][3]; c[k][1] /= c[k][3]; c[k][2] /= c[k][3]; ids.push(k); }
  const sign = new Int8Array(nM);
  const K = Math.min(8, ids.length - 1);
  const nb = new Map();
  for (const i of ids) {
    const near = [];
    for (const j of ids) if (j !== i) near.push([(c[i][0] - c[j][0]) ** 2 + (c[i][1] - c[j][1]) ** 2 + (c[i][2] - c[j][2]) ** 2, j]);
    near.sort((x, y) => x[0] - y[0]);
    nb.set(i, near.slice(0, K).map((x) => x[1]));
  }
  for (const s0 of ids) {
    if (sign[s0]) continue;
    sign[s0] = 1;
    const comp = [s0], q = [s0];
    while (q.length) {
      const i = q.shift();
      for (const j of nb.get(i)) {
        if (sign[j]) continue;
        const dt = meshThin[i].n.dot(meshThin[j].n);
        if (Math.abs(dt) < 0.6) continue;               // perpendicular part (frame, side): no information
        sign[j] = dt > 0 ? sign[i] : -sign[i]; comp.push(j); q.push(j);
      }
    }
    // each separate patch faces the audience on average
    let z = 0; for (const k of comp) z += meshThin[k].n.z * sign[k] * c[k][3];
    if (z < 0) for (const k of comp) sign[k] = -sign[k];
  }
  return sign;
}

const clamp01 = (x) => Math.max(0, Math.min(1, +x || 0));
/** Sutherland–Hodgman: keep the part of poly where sign * (q[k] - limit) >= 0 (all attributes interpolated). */
function clip(poly, k, limit, sign) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const da = sign * (A[k] - limit), db = sign * (B[k] - limit);
    if (da >= 0) out.push(A);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push(A.map((x, m) => x + (B[m] - x) * t)); }
  }
  return out;
}

/** Name normalisation for auto-matching surfaces <-> meshes ("STRIP #1 - SL" ~ "strip_1_sl"). */
export const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
