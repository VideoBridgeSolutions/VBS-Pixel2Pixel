// Pixel2Pixel — fast display of heavy 3D models. A SketchUp / Collada venue holds thousands of meshes (seats, trusses,
// fixtures): drawn one by one they cost one draw call each, every frame — the stage crawled as soon as anything moved
// (a test animation). The display proxy groups them:
//   - meshes sharing geometry + material (instances of a component) -> one InstancedMesh;
//   - the remaining single meshes -> merged by material (geometry baked in model space, chunks of ≤ 1.5 M vertices).
// The original meshes stay in place (hidden from rendering) for picking, mapping, hidden elements and exports.
import * as THREE from '../vendor/three/three.module.js';
import { mergeGeometries } from '../vendor/three/addons/BufferGeometryUtils.js';

const MAX_VERTS = 1500000;
const matKey = (m) => (Array.isArray(m) ? m.map((x) => x.uuid).join('+') : m.uuid);
const attrSig = (g) => Object.keys(g.attributes).sort().map((k) => { const a = g.attributes[k]; return `${k}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}:${a.isInterleavedBufferAttribute ? 'i' : ''}`; }).join(',') + (g.index ? '|ix' : '|nx') + (Object.keys(g.morphAttributes || {}).length ? '|morph' : '');

/**
 * Builds the display proxy of a loaded model. holder: the model's transform group; meshes: its meshes;
 * shown(mesh) -> bool (hidden elements, mapped meshes…). Returns { group, owned: geometries to dispose, calls, source }.
 */
export function buildProxy(holder, meshes, shown) {
  holder.updateMatrixWorld(true);
  const inv = holder.matrixWorld.clone().invert();
  const group = new THREE.Group(); group.name = 'p2p-proxy';
  const owned = [];
  const byKey = new Map();
  let source = 0;
  for (const m of meshes) {
    if (!m.geometry || !m.material || !shown(m)) continue;
    source++;
    const k = m.geometry.uuid + '|' + matKey(m.material);
    let l = byKey.get(k); if (!l) byKey.set(k, l = []);
    l.push(m);
  }
  const singles = new Map();
  for (const l of byKey.values()) {
    const m0 = l[0];
    if (l.length >= 2) {
      const im = new THREE.InstancedMesh(m0.geometry, m0.material, l.length);
      const rel = new THREE.Matrix4();
      l.forEach((m, i) => { rel.multiplyMatrices(inv, m.matrixWorld); im.setMatrixAt(i, rel); });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere(); im.computeBoundingBox();
      group.add(im);
      continue;
    }
    // single mesh: merge candidates (one material, same attribute layout)
    if (Array.isArray(m0.material) || m0.geometry.groups.length > 1) { group.add(placed(m0, inv)); continue; }
    const k = matKey(m0.material) + '#' + attrSig(m0.geometry);
    let s = singles.get(k); if (!s) singles.set(k, s = []);
    s.push(m0);
  }
  for (const list of singles.values()) {
    if (list.length === 1) { group.add(placed(list[0], inv)); continue; }
    let chunk = [], verts = 0;
    const flush = () => {
      if (!chunk.length) return;
      if (chunk.length === 1) { group.add(placed(chunk[0], inv)); chunk = []; verts = 0; return; }
      const rel = new THREE.Matrix4();
      const geos = chunk.map((m) => { const g = m.geometry.clone(); g.applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld)); return g; });
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (merged) { merged.computeBoundingSphere(); owned.push(merged); group.add(new THREE.Mesh(merged, chunk[0].material)); }
      else for (const m of chunk) group.add(placed(m, inv));
      chunk = []; verts = 0;
    };
    for (const m of list) {
      const n = m.geometry.attributes.position ? m.geometry.attributes.position.count : 0;
      if (verts + n > MAX_VERTS) flush();
      chunk.push(m); verts += n;
    }
    flush();
  }
  return { group, owned, calls: group.children.length, source };
}

/** A mesh drawn as is, at its place in model space (shares geometry and material). */
function placed(m, inv) {
  const o = new THREE.Mesh(m.geometry, m.material);
  o.matrixAutoUpdate = false;
  o.matrix.multiplyMatrices(inv, m.matrixWorld);
  return o;
}

/** Releases a proxy (merged geometries only: the others belong to the model). */
export function disposeProxy(p) {
  if (!p) return;
  if (p.group.parent) p.group.parent.remove(p.group);
  for (const g of p.owned) g.dispose();
  for (const c of p.group.children) if (c.isInstancedMesh) c.dispose();
}
