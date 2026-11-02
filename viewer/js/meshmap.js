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

  // ---- flat object turned in its own plane (logo letters, tilted sign): the image follows the object instead of the
  // world vertical. orient 'object' = main axis of the faces (snapped to ±45°), + rot degrees (manual).
  let planeH = null, orientInfo = null;
  const rotDeg = +opts.rot || 0;
  if (!floor && (opts.orient === 'object' || rotDeg) && keep.length) {
    const pts = [];
    const used = new Uint8Array(nW);
    for (const t of keep) for (let j = 0; j < 3; j++) { const w = wid[t * 3 + j]; if (!used[w]) { used[w] = 1; pts.push(new THREE.Vector3(...wpos[w])); } }
    const tn = pts.length >= 4 ? thinNormal(pts) : { thin: false };
    if (tn.thin) {
      const n = tn.n.clone(); if (n.z < 0 || (Math.abs(n.z) < 1e-3 && n.x < 0)) n.negate();
      const Y = new THREE.Vector3(0, 1, 0);
      const up = Y.clone().addScaledVector(n, -n.dot(Y));
      if (up.lengthSq() < 1e-6) up.set(0, 0, -1).addScaledVector(n, -n.dot(new THREE.Vector3(0, 0, -1)));
      up.normalize();
      const right = new THREE.Vector3().crossVectors(up, n).normalize();
      const xs = new Float64Array(nW), ys = new Float64Array(nW);
      for (let i = 0; i < nW; i++) { const [x, y, z] = wpos[i]; xs[i] = x * right.x + y * right.y + z * right.z; ys[i] = x * up.x + y * up.y + z * up.z; }
      let th = 0;
      // 1) tilt stored in the model: rotation of the elements (component / group transforms, as placed in SketchUp,
      // 3ds Max…). Per mesh, the local axis lying flattest in the plane gives an angle (mod 90°); kept when the
      // elements agree. 2) geometry baked without rotation: smallest bounding rectangle of the faces.
      let fromModel = null;
      if (opts.orient === 'object') {
        let sx = 0, sy = 0, wsum = 0;
        const e = new THREE.Vector3();
        for (const m of meshes) {
          let bestA = null, bestL = 0;
          for (let c = 0; c < 3; c++) {
            e.setFromMatrixColumn(m.matrixWorld, c);
            const len = e.length(); if (len < 1e-9) continue;
            e.divideScalar(len);
            const px = e.dot(right), py = e.dot(up), inPlane = Math.hypot(px, py);
            if (inPlane > bestL + 1e-6) { bestL = inPlane; bestA = Math.atan2(py, px); }
          }
          if (bestA == null || bestL < 0.9) continue;          // element turned out of the plane: no reading
          sx += Math.cos(4 * bestA); sy += Math.sin(4 * bestA); wsum++;
        }
        if (wsum && Math.hypot(sx, sy) / wsum > 0.97) {           // the elements agree (within a few degrees)
          let a = Math.atan2(sy, sx) / 4;
          while (a > Math.PI / 4) a -= Math.PI / 2;
          while (a < -Math.PI / 4) a += Math.PI / 2;
          if (Math.abs(a) > 0.2 * Math.PI / 180) fromModel = a;
        }
      }
      if (fromModel != null) th = fromModel;
      else if (opts.orient === 'object') {
        // smallest bounding rectangle of the faces (rotating calipers on the convex hull): a block of letters or a
        // tilted sign gives its own edges — the spread of the points (PCA) is biased by the letter shapes
        const P2 = []; for (let i = 0; i < nW; i++) if (used[i]) P2.push([xs[i], ys[i]]);
        P2.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lo = [], hi = [];
        for (const q of P2) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
        for (let i = P2.length - 1; i >= 0; i--) { const q = P2[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
        const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
        let best = Infinity;
        for (let i = 0; i < hull.length; i++) {
          const a = hull[i], b = hull[(i + 1) % hull.length];
          const an = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const c = Math.cos(an), s2 = Math.sin(an);
          let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
          for (const q of hull) { const px = q[0] * c + q[1] * s2, py = -q[0] * s2 + q[1] * c; p0 = Math.min(p0, px); p1 = Math.max(p1, px); q0 = Math.min(q0, py); q1 = Math.max(q1, py); }
          const ar = (p1 - p0) * (q1 - q0);
          if (ar < best - 1e-9) { best = ar; th = an; }
        }
        while (th > Math.PI / 4) th -= Math.PI / 2;
        while (th < -Math.PI / 4) th += Math.PI / 2;
      }
      th += rotDeg * Math.PI / 180;
      const cs = Math.cos(th), sn = Math.sin(th);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const xr = new Float64Array(nW), yr = new Float64Array(nW);
      for (let i = 0; i < nW; i++) {
        xr[i] = xs[i] * cs + ys[i] * sn; yr[i] = -xs[i] * sn + ys[i] * cs;
        if (used[i]) { x0 = Math.min(x0, xr[i]); x1 = Math.max(x1, xr[i]); y0 = Math.min(y0, yr[i]); y1 = Math.max(y1, yr[i]); }
      }
      const W = Math.max(1e-6, x1 - x0), Hh = Math.max(1e-6, y1 - y0);
      for (let i = 0; i < nW; i++) { U[i] = (xr[i] - x0) / W; Vv[i] = (yr[i] - y0) / Hh; }
      kind = 'flat'; length = W; planeH = Hh; orientInfo = { from: fromModel != null ? 'model' : opts.orient === 'object' ? 'shape' : 'manual', deg: Math.round((th - rotDeg * Math.PI / 180) * 1800 / Math.PI) / 10 };
    }
  }

  // ---- snap the pixelmap to the cabinets of the model (opts.snap): a screen modelled cabinet by cabinet (one mesh per
  // cabinet, or face + frame meshes) gets each cabinet on its own slot of the image — columns along u, rows along v,
  // slot sizes in proportion to the cabinets. The unwrap alone measures the distance along the surface, joints, frames
  // and gaps included: the test pattern drifted off the model's cabinets (two dark squares side by side…).
  let snapMap = null, snapInfo = null;
  if (opts.snap && opts.uv !== 'model' && meshes.length >= 2) {
    const ext = meshes.map(() => ({ u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity, n: 0 }));
    for (const t of keep) {
      const k = triMesh[t], e = ext[k];
      for (let j = 0; j < 3; j++) { const w = wid[t * 3 + j], u = U[w], v = Vv[w]; if (!Number.isFinite(u) || !Number.isFinite(v)) continue; if (u < e.u0) e.u0 = u; if (u > e.u1) e.u1 = u; if (v < e.v0) e.v0 = v; if (v > e.v1) e.v1 = v; e.n++; }
    }
    const ok = ext.map((e, k) => e.n > 0 && e.u1 - e.u0 > 1e-6 && e.v1 - e.v0 > 1e-6 && !(kind === 'ring' && e.u1 - e.u0 > 0.5) ? k : -1).filter((k) => k >= 0);
    const cluster = (key0, key1) => {      // group the cabinets by their centre, return [group index per mesh, group sizes]
      const items = ok.map((k) => ({ k, c: (ext[k][key0] + ext[k][key1]) / 2, w: ext[k][key1] - ext[k][key0] })).sort((a, b) => a.c - b.c);
      const ws = items.map((x) => x.w).sort((a, b) => a - b), med = ws[Math.floor(ws.length / 2)] || 0;
      const grp = new Map(), size = [];
      let g = -1, last = -Infinity;
      for (const it of items) { if (it.c - last > med * 0.5) { g++; size.push(0); } grp.set(it.k, g); size[g] = Math.max(size[g], it.w); last = it.c; }
      return { grp, size };
    };
    if (ok.length >= 2) {
      const C = cluster('u0', 'u1'), R = cluster('v0', 'v1');
      const cum = (sz) => { const tot = sz.reduce((a, b) => a + b, 0) || 1; let a = 0; return sz.map((w) => { const s = [a / tot, (a + w) / tot]; a += w; return s; }); };
      const cs = cum(C.size), rs = cum(R.size);
      const nc = C.size.length, nr = R.size.length;
      const slot = new Map(ok.map((k) => [k, [C.grp.get(k), R.grp.get(k)]]));
      const cen = (k) => (ext[k].u0 + ext[k].u1) / 2;
      // a slot of the grid left empty next to a slot with too many cabinets (one cabinet of the model a little off, or two
      // meshes for one cabinet: the pattern showed an empty cabinet and two cabinets on top of each other) → the cabinets
      // between them move one slot towards the hole (opts.snapAuto, default on)
      const occ = () => { const m = new Map(); for (const [k, [c, r]] of slot) { const kk = c + ',' + r; if (!m.has(kk)) m.set(kk, []); m.get(kk).push(k); } return m; };
      let o = occ();
      const counts = [...o.values()].map((a) => a.length), freq = new Map(); counts.forEach((n) => freq.set(n, (freq.get(n) || 0) + 1));
      const per = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ? [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : 1;   // usual meshes per cabinet
      const emptyBefore = nc * nr - o.size, dupBefore = counts.filter((n) => n > per).length;
      let moved = 0;
      if (opts.snapAuto !== false && per > 0) {
        for (let r = 0; r < nr; r++) for (let guard = 0; guard < nc; guard++) {
          o = occ();
          const n = (c) => (o.get(c + ',' + r) || []).length;
          let fixed = false;
          for (let e2 = 0; e2 < nc && !fixed; e2++) {
            if (n(e2) !== 0) continue;
            // nearest over-full slot on the row, then shift the cabinets in between by one slot towards the hole
            let d = -1;
            for (let dist = 1; dist < nc && d < 0; dist++) for (const c of [e2 - dist, e2 + dist]) if (c >= 0 && c < nc && n(c) > per && d < 0) d = c;
            if (d < 0) continue;
            const dir = d > e2 ? -1 : 1;                                    // move direction (towards the hole)
            for (let c = e2 - dir; c !== d; c -= dir) for (const k of o.get(c + ',' + r) || []) { slot.get(k)[0] += dir; moved++; }
            const extra = (o.get(d + ',' + r) || []).slice().sort((a, b) => (dir < 0 ? cen(a) - cen(b) : cen(b) - cen(a))).slice(0, n(d) - per);   // the cabinets on the hole's side
            for (const k of extra) { slot.get(k)[0] += dir; moved++; }
            fixed = true;
          }
          if (!fixed) break;
        }
      }
      // hand corrections from the UV editor: { [mesh index]: [dc, dr] } slots
      const fix = opts.snapFix && typeof opts.snapFix === 'object' ? opts.snapFix : null;
      let manual = 0;
      if (fix) for (const [kk, d] of Object.entries(fix)) { const k = +kk, sl = slot.get(k); if (!sl || !Array.isArray(d)) continue; sl[0] = Math.max(0, Math.min(nc - 1, sl[0] + (Math.round(+d[0]) || 0))); sl[1] = Math.max(0, Math.min(nr - 1, sl[1] + (Math.round(+d[1]) || 0))); manual++; }
      o = occ();
      snapMap = new Map();
      for (const k of ok) { const e = ext[k], [ci, ri] = slot.get(k); snapMap.set(k, { e, c: cs[ci], r: rs[ri], slot: [ci, ri] }); }
      // each cabinet's own frame: u / v from its geometry, along the directions to the cabinets of the next column / row. The global unwrap can give a cabinet reversed or squeezed coordinates (end of a band, a cabinet
      // a little off): with this, a cabinet can no longer show the pattern mirrored or distorted (« C60 L3 » read backwards).
      {
        const pts = new Map();   // mesh → { sum, n, P: [[x,y,z,u,v]] }
        for (const t of keep) {
          const k = triMesh[t]; if (!snapMap.has(k)) continue;
          let e = pts.get(k); if (!e) pts.set(k, e = { s: [0, 0, 0], n: 0, P: [], seen: new Set(), nn: [0, 0, 0] });
          { const i0 = t * 3, ax = P.getX(i0 + 1) - P.getX(i0), ay = P.getY(i0 + 1) - P.getY(i0), az = P.getZ(i0 + 1) - P.getZ(i0), bx = P.getX(i0 + 2) - P.getX(i0), by = P.getY(i0 + 2) - P.getY(i0), bz = P.getZ(i0 + 2) - P.getZ(i0);
            const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            if (e.nn[0] * nx + e.nn[1] * ny + e.nn[2] * nz < 0) { e.nn[0] -= nx; e.nn[1] -= ny; e.nn[2] -= nz; } else { e.nn[0] += nx; e.nn[1] += ny; e.nn[2] += nz; } }
          for (let j = 0; j < 3; j++) { const i = t * 3 + j, w = wid[i]; if (e.seen.has(w)) continue; e.seen.add(w); const x = P.getX(i), y = P.getY(i), z = P.getZ(i); e.s[0] += x; e.s[1] += y; e.s[2] += z; e.n++; e.P.push([x, y, z, U[w], Vv[w]]); }
        }
        const cen3 = new Map([...pts].map(([k, e]) => [k, e.s.map((v) => v / Math.max(1, e.n))]));
        const slotCen = new Map();
        for (const [k, c] of cen3) { const [ci, ri] = slot.get(k), key = ci + ',' + ri; const a2 = slotCen.get(key) || { s: [0, 0, 0], n: 0 }; a2.s = a2.s.map((v, i) => v + c[i]); a2.n++; slotCen.set(key, a2); }
        const sc = (ci, ri) => { const a2 = slotCen.get(ci + ',' + ri); return a2 ? a2.s.map((v) => v / a2.n) : null; };
        const sub = (a2, b2) => [a2[0] - b2[0], a2[1] - b2[1], a2[2] - b2[2]], dot = (a2, b2) => a2[0] * b2[0] + a2[1] * b2[1] + a2[2] * b2[2];
        const nrm = (a2) => { const l = Math.hypot(...a2) || 1; return a2.map((v) => v / l); };
        for (const [k, e] of pts) {
          if (e.P.length < 3) continue;
          e.nrm = nrm(e.nn);
          const c = cen3.get(k), [ci, ri] = slot.get(k);
          // axes from the neighbours (a square cabinet has no principal axis): u towards the next / from the previous column,
          // v towards the next / from the previous row, both laid in the cabinet's plane; a missing one = normal × the other
          const nb = (dc2, dr2) => { const fw = sc(ci + dc2, ri + dr2), bw = sc(ci - dc2, ri - dr2); return fw ? sub(fw, c) : bw ? sub(c, bw) : null; };
          const n0 = e.nrm, flat = (v3) => { const d = dot(v3, n0); return nrm(sub(v3, n0.map((x) => x * d))); };
          const corr = (ax, idx) => { let sp = 0, sq = 0, sv = 0; const ps = e.P.map((q) => dot(sub(q, c), ax)), vs = e.P.map((q) => q[idx]); const mv = vs.reduce((x, y) => x + y, 0) / vs.length; ps.forEach((x, i) => { sp += x * (vs[i] - mv); sq += x * x; sv += (vs[i] - mv) ** 2; }); return sq && sv ? sp / Math.sqrt(sq * sv) : 0; };
          const cross = (a3, b3) => [a3[1] * b3[2] - a3[2] * b3[1], a3[2] * b3[0] - a3[0] * b3[2], a3[0] * b3[1] - a3[1] * b3[0]];
          let uA = nb(1, 0), vA = nb(0, 1);
          if (uA) uA = flat(uA); if (vA) vA = flat(vA);
          if (uA && vA) vA = nrm(sub(vA, uA.map((x) => x * dot(vA, uA))));                // orthogonal, u wins
          else if (uA) { vA = nrm(cross(n0, uA)); if (corr(vA, 4) < 0) vA = vA.map((x) => -x); }
          else if (vA) { uA = nrm(cross(vA, n0)); if (corr(uA, 3) < 0) uA = uA.map((x) => -x); }
          else continue;                                                                    // single cabinet: keep the unwrap
          if (!uA.every(Number.isFinite) || !vA.every(Number.isFinite)) continue;
          const pu = e.P.map((q) => dot(sub(q, c), uA)), pv = e.P.map((q) => dot(sub(q, c), vA));
          const fr = { c, uA, vA, u0: Math.min(...pu), u1: Math.max(...pu), v0: Math.min(...pv), v1: Math.max(...pv) };
          if (fr.u1 - fr.u0 > 1e-9 && fr.v1 - fr.v0 > 1e-9) snapMap.get(k).fr = fr;
        }
      }
      const after = [...o.values()].map((a) => a.length);
      snapInfo = { cols: nc, rows: nr, meshes: ok.length, per, emptyBefore, dupBefore, moved, manual, empty: nc * nr - o.size, dup: after.filter((x) => x > per).length };
    }
  }

  // ---- output geometry (non-indexed, seams fixed per triangle), optionally clipped to a portion of the object
  const R = opts.range || null;
  const u0 = R ? clamp01(R.u0 ?? 0) : 0, u1 = R ? clamp01(R.u1 ?? 1) : 1, v0 = R ? clamp01(R.v0 ?? 0) : 0, v1 = R ? clamp01(R.v1 ?? 1) : 1;
  const ranged = !!R && (u0 > 0 || u1 < 1 || v0 > 0 || v1 < 1) && u1 > u0 && v1 > v0;
  const outPos = [], outUV = [], outMesh = [];
  let curMesh = -1;
  const MU = hasModelUV ? g.getAttribute('uv') : null;
  const T0 = opts.uvt || null;   // { du, dv: image offset (fraction of the screen, + = right / down), su, sv: scale, q: quarter turns }
  const T = T0 && (T0.du || T0.dv || (T0.su && T0.su !== 1) || (T0.sv && T0.sv !== 1) || T0.q) ? { du: +T0.du || 0, dv: +T0.dv || 0, su: Math.max(0.01, +T0.su || 1), sv: Math.max(0.01, +T0.sv || 1), q: ((Math.round(+T0.q || 0) % 4) + 4) % 4 } : null;
  const emit = (poly) => {   // poly: [[x, y, z, u, v], …] in raw object coordinates
    for (let k = 1; k + 1 < poly.length; k++) outMesh.push(curMesh);
    for (let k = 1; k + 1 < poly.length; k++) for (const q of [poly[0], poly[k], poly[k + 1]]) {
      outPos.push(q[0], q[1], q[2]);
      let u = ranged ? (q[3] - u0) / (u1 - u0) : q[3], v = ranged ? (q[4] - v0) / (v1 - v0) : q[4];
      if (T) {   // UV editor: quarter turns, scale and offset of the image on the object (about the image centre)
        for (let k2 = 0; k2 < T.q; k2++) [u, v] = [v, 1 - u];
        u = (u - 0.5) / T.su + 0.5 - T.du;
        v = (v - 0.5) / T.sv + 0.5 + T.dv;
      }
      if (opts.swap) [u, v] = [v, 1 - u];
      if (opts.flipU) u = 1 - u;
      if (opts.flipV) v = 1 - v;
      outUV.push(u, v);
    }
  };
  const triOf = (t) => {
    const tri = [];
    for (let j = 0; j < 3; j++) {
      const i = t * 3 + j;
      let uvv = opts.uv === 'model' && MU ? [MU.getX(i), MU.getY(i)] : [U[wid[i]], Vv[wid[i]]];
      const sm = snapMap && snapMap.get(triMesh[t]);
      if (sm && sm.fr) {   // the cabinet's own frame (see above)
        const f = sm.fr, d = [P.getX(i) - f.c[0], P.getY(i) - f.c[1], P.getZ(i) - f.c[2]];
        const lu = ((d[0] * f.uA[0] + d[1] * f.uA[1] + d[2] * f.uA[2]) - f.u0) / (f.u1 - f.u0), lv = ((d[0] * f.vA[0] + d[1] * f.vA[1] + d[2] * f.vA[2]) - f.v0) / (f.v1 - f.v0);
        uvv = [sm.c[0] + lu * (sm.c[1] - sm.c[0]), sm.r[0] + lv * (sm.r[1] - sm.r[0])];
      } else if (sm) uvv = [sm.c[0] + (uvv[0] - sm.e.u0) / (sm.e.u1 - sm.e.u0) * (sm.c[1] - sm.c[0]), sm.r[0] + (uvv[1] - sm.e.v0) / (sm.e.v1 - sm.e.v0) * (sm.r[1] - sm.r[0])];
      tri.push([P.getX(i), P.getY(i), P.getZ(i), uvv[0], uvv[1], j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0]);   // + barycentric weights (source attributes of the rest)
    }
    if (kind === 'ring' && opts.uv !== 'model') {
      const us = tri.map((q) => q[3]);
      if (Math.max(...us) - Math.min(...us) > 0.5) for (const q of tri) if (q[3] < 0.5) q[3] += 1;
    }
    return tri;
  };
  // ---- portion of the object: the source meshes it does not reach stay drawn as the model (and can be mapped by
  // another screen); the parts of the reached meshes outside the portion are given back as `rest` (drawn with the
  // model's material) — before, the whole object vanished and the free half could not be clicked any more.
  const touched = new Uint8Array(meshes.length);
  let rest = null;
  if (ranged) {
    const inside = (c) => { let q = clip(c, 3, u0, 1); q = clip(q, 3, u1, -1); q = clip(q, 4, v0, 1); return clip(q, 4, v1, -1); };
    const outsideOf = (c, a0, a1, b0, b1) => {
      const mid = clip(clip(c, 3, a0, 1), 3, a1, -1);
      return [clip(c, 3, a0, -1), clip(c, 3, a1, 1), clip(mid, 4, b0, -1), clip(mid, 4, b1, 1)].filter((q) => q.length >= 3);
    };
    // portions taken by other screens on the same object are not given back either (they show their own pixelmap)
    const ex = (opts.exclude || []).map((r) => [clamp01(r.u0 ?? 0), clamp01(r.u1 ?? 1), clamp01(r.v0 ?? 0), clamp01(r.v1 ?? 1)]).filter((r) => r[1] > r[0] && r[3] > r[2]);
    const outside = (c) => {
      let parts = outsideOf(c, u0, u1, v0, v1);
      for (const r of ex) parts = parts.flatMap((q) => outsideOf(q, ...r));
      return parts;
    };
    const ringOut = (c) => {       // ring: the part beyond u = 1 is the start of the ring
      const res = [];
      for (const q of outside(c)) {
        const lo = clip(q, 3, 1, -1); if (lo.length >= 3) res.push(lo);
        const hi = clip(q, 3, 1, 1); if (hi.length >= 3) for (const r of outside(hi.map((x) => [x[0], x[1], x[2], x[3] - 1, ...x.slice(4)]))) res.push(r);
      }
      return res;
    };
    const tris = new Array(nT);
    const nIn = new Uint32Array(meshes.length), nFin = new Uint32Array(meshes.length);   // unwrapped faces of each mesh, inside the portion
    for (let t = 0; t < nT; t++) {
      const k = triMesh[t];
      const c = tris[t] = triOf(t);
      if (c.some((q) => !Number.isFinite(q[3]) || !Number.isFinite(q[4]))) continue;
      nFin[k]++;
      const cu = (c[0][3] + c[1][3] + c[2][3]) / 3, cv = (c[0][4] + c[1][4] + c[2][4]) / 3;
      if (((cu >= u0 && cu <= u1) || (kind === 'ring' && cu - 1 >= u0 && cu - 1 <= u1)) && cv >= v0 && cv <= v1) nIn[k]++;
      if (touched[k]) continue;
      if (inside(c).length >= 3 || (kind === 'ring' && c.some((q) => q[3] > 1) && inside(c.map((q) => [q[0], q[1], q[2], q[3] - 1, q[4]])).length >= 3)) touched[k] = 1;
    }
    const byMesh = new Map(), bary = new Map();
    const triStart = new Int32Array(meshes.length).fill(-1);
    for (let t = 0; t < nT; t++) if (triStart[triMesh[t]] < 0) triStart[triMesh[t]] = t;
    for (let t = 0; t < nT; t++) {
      const k = triMesh[t]; if (!touched[k]) continue;
      const c = tris[t] || triOf(t);
      // faces the unwrap does not reach (backs, sides of a cabinet: no u / v) are given back whole
      const unreached = c.some((q) => !Number.isFinite(q[3]) || !Number.isFinite(q[4]));
      if (unreached && nIn[k] * 2 >= nFin[k]) continue;                  // back / sides of a cabinet that carries the pixelmap: hidden, as without a portion
      const parts = unreached ? [c] : kind === 'ring' && c.some((q) => q[3] > 1) ? ringOut(c) : outside(c);
      if (!parts.length) continue;
      let arr = byMesh.get(k), ba = bary.get(k); if (!arr) { byMesh.set(k, arr = []); bary.set(k, ba = []); }
      const lt = t - triStart[k];
      for (const poly of parts) for (let j = 1; j + 1 < poly.length; j++) for (const q of [poly[0], poly[j], poly[j + 1]]) { arr.push(q[0], q[1], q[2]); ba.push(lt, q[5] || 0, q[6] || 0, q[7] || 0); }
    }
    rest = byMesh; rest.bary = bary;
  } else touched.fill(1);
  for (const t of keep) {
    const tri = triOf(t);
    curMesh = triMesh[t];
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
  out.userData.srcMesh = Int32Array.from(outMesh);   // source mesh of every output triangle (UV editor: pick a cabinet)
  if (snapMap) out.userData.slotOf = new Map([...snapMap].map(([k, v]) => [k, v.slot]));
  g.dispose();
  const fullH = planeH != null ? planeH : floor ? size.z : size.y;
  return { geometry: out, touched, rest, info: { kind, length: ranged ? length * (u1 - u0) : length, height: ranged ? fullH * (v1 - v0) : fullH, fullLength: length, fullHeight: fullH, ranged, faces, kept: keep.length, total: nT, hasModelUV, orient: orientInfo, snap: snapInfo } };
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
