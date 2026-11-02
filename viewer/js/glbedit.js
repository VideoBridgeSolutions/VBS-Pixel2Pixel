// Pixel2Pixel — GLB editing without three.js: element tree of a model and removal of elements (the file really gets
// lighter: meshes, accessors, materials, textures and binary data no longer used are dropped, instancing is kept).

const te = new TextEncoder(), td = new TextDecoder();

/** GLB bytes -> { json, bin (Uint8Array | null) }. */
export function parseGlb(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off + 8 <= u8.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const body = u8.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(td.decode(body));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  if (!json) throw new Error('GLB without JSON');
  return { json, bin };
}

/** { json, bin } -> GLB bytes. */
export function writeGlb(json, bin) {
  let js = te.encode(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4;
  const jl = js.length + jpad;
  const bl = bin ? bin.length + ((4 - (bin.length % 4)) % 4) : 0;
  const total = 12 + 8 + jl + (bin ? 8 + bl : 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(js, 20); for (let i = 0; i < jpad; i++) out[20 + js.length + i] = 0x20;
  if (bin) { const o = 20 + jl; dv.setUint32(o, bl, true); dv.setUint32(o + 4, 0x004e4942, true); out.set(bin, o + 8); }
  return out;
}

const triOf = (json, mi) => {
  const m = json.meshes && json.meshes[mi]; if (!m) return 0;
  let n = 0;
  for (const pr of m.primitives || []) {
    if (pr.mode != null && pr.mode !== 4) continue;
    if (pr.indices != null) n += (json.accessors[pr.indices].count || 0) / 3;
    else if (pr.attributes && pr.attributes.POSITION != null) n += (json.accessors[pr.attributes.POSITION].count || 0) / 3;
  }
  return Math.round(n);
};

/**
 * Element tree of the default scene: [{ i (node index), name, tris (own + descendants, × instances), own, children }].
 * Unnamed nodes take their mesh name; a node with a single child and no mesh is folded into it (SketchUp wraps groups).
 */
export function nodeTree(json) {
  const nodes = json.nodes || [];
  const sc = (json.scenes || [])[json.scene || 0] || { nodes: nodes.map((_, i) => i) };
  const seen = new Set();
  const build = (i) => {
    if (seen.has(i) || !nodes[i]) return null;
    seen.add(i);
    const n = nodes[i];
    const own = n.mesh != null ? triOf(json, n.mesh) : 0;
    const children = (n.children || []).map(build).filter(Boolean);
    const name = n.name || (n.mesh != null && json.meshes[n.mesh] && json.meshes[n.mesh].name) || '';
    return { i, name, own, tris: own + children.reduce((a, c) => a + c.tris, 0), children };
  };
  let top = (sc.nodes || []).map(build).filter(Boolean);
  // a lone wrapper (ROOT, Scene…): list its children instead; its own loose geometry (faces outside any group)
  // becomes an element of its own, id 'm<node>' (removing / hiding it leaves the children alone)
  while (top.length === 1 && top[0].children.length) {
    const r = top[0];
    top = r.own ? [{ i: 'm' + r.i, name: '', loose: true, own: r.own, tris: r.own, children: [] }, ...r.children] : r.children;
  }
  return top;
}

/** Every node index of a subtree. */
export function subtreeNodes(json, i, out = new Set()) {
  if (out.has(i)) return out;
  out.add(i);
  for (const c of (json.nodes[i] && json.nodes[i].children) || []) subtreeNodes(json, c, out);
  return out;
}

/**
 * Removes elements and everything only they used. remove: Iterable of element ids — node index (node + descendants) or
 * 'm<node>' (that node's own mesh only). Returns { glb, map } — map: old node index -> new node index.
 */
export function pruneGlb(u8, remove) {
  const { json, bin } = parseGlb(u8);
  const nodes = json.nodes = (json.nodes || []).map((n) => ({ ...n }));
  const gone = new Set();
  let meshDrop = 0;
  for (const id of remove) {
    if (typeof id === 'string' && id[0] === 'm') { const n = nodes[+id.slice(1)]; if (n && n.mesh != null) { delete n.mesh; meshDrop++; } }
    else subtreeNodes(json, +id, gone);
  }
  if (!gone.size && !meshDrop) return { glb: u8, map: new Map(nodes.map((_, i) => [i, i])) };
  // nodes kept, re-indexed
  const keep = nodes.map((_, i) => !gone.has(i));
  const nodeMap = new Map(); let k = 0;
  nodes.forEach((_, i) => { if (keep[i]) nodeMap.set(i, k++); });
  // what the kept nodes use
  const useMesh = new Set(), useAcc = new Set(), useMat = new Set(), useTex = new Set(), useImg = new Set(), useSamp = new Set(), useView = new Set(), useSkin = new Set(), useCam = new Set();
  const addAttrs = (o) => { if (o) for (const v of Object.values(o)) if (typeof v === 'number') useAcc.add(v); };
  nodes.forEach((n, i) => {
    if (!keep[i]) return;
    if (n.mesh != null) useMesh.add(n.mesh);
    if (n.skin != null) useSkin.add(n.skin);
    if (n.camera != null) useCam.add(n.camera);
    const inst = n.extensions && n.extensions.EXT_mesh_gpu_instancing; if (inst) addAttrs(inst.attributes);
  });
  for (const mi of useMesh) for (const pr of (json.meshes[mi].primitives || [])) {
    addAttrs(pr.attributes); if (pr.indices != null) useAcc.add(pr.indices); if (pr.material != null) useMat.add(pr.material);
    for (const tg of pr.targets || []) addAttrs(tg);
  }
  for (const si of useSkin) { const s = json.skins[si]; if (s.inverseBindMatrices != null) useAcc.add(s.inverseBindMatrices); }
  const texRefs = (o) => { if (!o || typeof o !== 'object') return; for (const [key, v] of Object.entries(o)) { if (v && typeof v === 'object') { if (typeof v.index === 'number' && /texture/i.test(key)) useTex.add(v.index); texRefs(v); } } };
  for (const mi of useMat) texRefs(json.materials[mi]);
  for (const ti of useTex) { const tx = json.textures[ti]; if (tx.source != null) useImg.add(tx.source); if (tx.sampler != null) useSamp.add(tx.sampler);
    const ext = tx.extensions || {}; for (const e of Object.values(ext)) if (e && typeof e.source === 'number') useImg.add(e.source); }
  for (const ai of useAcc) { const a = json.accessors[ai]; if (a.bufferView != null) useView.add(a.bufferView); if (a.sparse) { useView.add(a.sparse.indices.bufferView); useView.add(a.sparse.values.bufferView); } }
  for (const ii of useImg) { const im = json.images[ii]; if (im.bufferView != null) useView.add(im.bufferView); }
  const remap = (set, len) => { const m = new Map(); let n = 0; for (let i = 0; i < len; i++) if (set.has(i)) m.set(i, n++); return m; };
  const mMesh = remap(useMesh, (json.meshes || []).length), mAcc = remap(useAcc, (json.accessors || []).length), mMat = remap(useMat, (json.materials || []).length);
  const mTex = remap(useTex, (json.textures || []).length), mImg = remap(useImg, (json.images || []).length), mSamp = remap(useSamp, (json.samplers || []).length);
  const mView = remap(useView, (json.bufferViews || []).length), mSkin = remap(useSkin, (json.skins || []).length), mCam = remap(useCam, (json.cameras || []).length);
  // binary: copy the views kept, 4-byte aligned
  const views = [], parts = []; let off = 0;
  (json.bufferViews || []).forEach((v, i) => {
    if (!mView.has(i)) return;
    const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); off += pad; }
    const src = bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    parts.push(src);
    views.push({ ...v, buffer: 0, byteOffset: off });
    off += v.byteLength;
  });
  const nb = new Uint8Array(off); let o2 = 0; for (const p of parts) { nb.set(p, o2); o2 += p.length; }
  const remapAttrs = (o) => { if (!o) return o; const r = {}; for (const [kk, v] of Object.entries(o)) r[kk] = typeof v === 'number' ? mAcc.get(v) : v; return r; };
  const remapTex = (o) => { if (!o || typeof o !== 'object') return o; if (Array.isArray(o)) return o.map(remapTex); const r = {}; for (const [key, v] of Object.entries(o)) { if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.index === 'number' && /texture/i.test(key)) r[key] = { ...remapTex(v), index: mTex.get(v.index) }; else r[key] = remapTex(v); } return r; };
  const pick = (arr, m) => (arr || []).filter((_, i) => m.has(i));
  const out = { ...json };
  out.nodes = nodes.filter((_, i) => keep[i]).map((n) => {
    const c = { ...n };
    if (c.children) { c.children = c.children.filter((x) => nodeMap.has(x)).map((x) => nodeMap.get(x)); if (!c.children.length) delete c.children; }
    if (c.mesh != null) c.mesh = mMesh.get(c.mesh);
    if (c.skin != null) c.skin = mSkin.get(c.skin);
    if (c.camera != null) c.camera = mCam.get(c.camera);
    if (c.extensions && c.extensions.EXT_mesh_gpu_instancing) c.extensions = { ...c.extensions, EXT_mesh_gpu_instancing: { ...c.extensions.EXT_mesh_gpu_instancing, attributes: remapAttrs(c.extensions.EXT_mesh_gpu_instancing.attributes) } };
    return c;
  });
  out.scenes = (json.scenes || []).map((s) => ({ ...s, nodes: (s.nodes || []).filter((x) => nodeMap.has(x)).map((x) => nodeMap.get(x)) }));
  out.meshes = pick(json.meshes, mMesh).map((m) => ({ ...m, primitives: m.primitives.map((pr) => {
    const c = { ...pr, attributes: remapAttrs(pr.attributes) };
    if (c.indices != null) c.indices = mAcc.get(c.indices);
    if (c.material != null) c.material = mMat.get(c.material);
    if (c.targets) c.targets = c.targets.map(remapAttrs);
    return c;
  }) }));
  out.accessors = pick(json.accessors, mAcc).map((a) => {
    const c = { ...a }; if (c.bufferView != null) c.bufferView = mView.get(c.bufferView);
    if (c.sparse) c.sparse = { ...c.sparse, indices: { ...c.sparse.indices, bufferView: mView.get(c.sparse.indices.bufferView) }, values: { ...c.sparse.values, bufferView: mView.get(c.sparse.values.bufferView) } };
    return c;
  });
  out.materials = pick(json.materials, mMat).map(remapTex);
  out.textures = pick(json.textures, mTex).map((tx) => {
    const c = { ...tx }; if (c.source != null) c.source = mImg.get(c.source); if (c.sampler != null) c.sampler = mSamp.get(c.sampler);
    if (c.extensions) { const e2 = {}; for (const [kk, e] of Object.entries(c.extensions)) e2[kk] = e && typeof e.source === 'number' ? { ...e, source: mImg.get(e.source) } : e; c.extensions = e2; }
    return c;
  });
  out.images = pick(json.images, mImg).map((im) => (im.bufferView != null ? { ...im, bufferView: mView.get(im.bufferView) } : im));
  out.samplers = pick(json.samplers, mSamp);
  out.skins = pick(json.skins, mSkin).map((s) => ({ ...s, joints: (s.joints || []).filter((j) => nodeMap.has(j)).map((j) => nodeMap.get(j)), ...(s.inverseBindMatrices != null ? { inverseBindMatrices: mAcc.get(s.inverseBindMatrices) } : {}), ...(s.skeleton != null ? { skeleton: nodeMap.get(s.skeleton) } : {}) }));
  out.cameras = pick(json.cameras, mCam);
  out.bufferViews = views;
  out.buffers = [{ byteLength: nb.length }];
  delete out.animations;   // their samplers may point to removed data; architectural models rarely have any
  for (const key of ['meshes', 'accessors', 'materials', 'textures', 'images', 'samplers', 'skins', 'cameras', 'animations']) if (Array.isArray(out[key]) && !out[key].length) delete out[key];
  return { glb: writeGlb(out, nb.length ? nb : null), map: nodeMap };
}
