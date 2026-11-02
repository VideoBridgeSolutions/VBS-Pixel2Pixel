// Pixel2Pixel — 3D model wizard: placement before (or after) import, in a light preview of its own, and element
// management (hide, or delete for good: the file gets lighter). The heavy stage is only touched once, at the end.
//   openModelWizard({ glb, name, md, project, ui: { h, t, icon } }) -> Promise<null | {
//     glb (pruned when elements were deleted), pruned: bool, unit, scale, x, y, z, rx, ry, rz, hidden: [element ids] }>
// Element ids: node index (node + descendants) or 'm<node>' (the node's own loose geometry only).
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { GLTFLoader } from '../vendor/three/addons/GLTFLoader.js';
import * as M from './model.js';
import { surfaceWorld } from './geometry.js';
import { parseGlb, nodeTree, pruneGlb } from './glbedit.js';

const D2R = Math.PI / 180, EULER = 'YXZ';
const UNITS = ['m', 'cm', 'mm', 'in', 'ft'];

/** Node index -> Object3D of a GLTFLoader result (the node's own object). */
export function nodeObjects(parser) {
  const map = new Map();
  for (const [obj, a] of parser.associations) if (obj && obj.isObject3D && a && a.nodes !== undefined && !map.has(a.nodes)) map.set(a.nodes, obj);
  return map;
}
/** Meshes carrying a node's own geometry (not its children's). */
function ownMeshes(obj, parser) {
  if (!obj) return [];
  if (obj.isMesh) return [obj];
  return obj.children.filter((c) => c.isMesh && (() => { const a = parser.associations.get(c); return a && a.nodes === undefined; })());
}
/**
 * Applies the hidden elements to a loaded model: nodes -> visible = false; loose geometry -> its meshes draw nothing.
 * state: object kept between calls (restores what was hidden before).
 */
export function applyHidden(parser, nodeObj, hidden, state) {
  for (const o of state.nodes || []) o.visible = true;
  for (const g of state.geos || []) g.setDrawRange(0, Infinity);
  state.nodes = []; state.geos = [];
  for (const id of hidden || []) {
    if (typeof id === 'string' && id[0] === 'm') { for (const m of ownMeshes(nodeObj.get(+id.slice(1)), parser)) { m.geometry.setDrawRange(0, 0); state.geos.push(m.geometry); } }
    else { const o = nodeObj.get(+id); if (o) { o.visible = false; state.nodes.push(o); } }
  }
}

const fmtN = (n) => Math.round(n).toLocaleString('fr-FR');
const fmtM = (v) => (Math.round(v * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function openModelWizard({ glb, name, md, project, ui }) {
  const { h, t, icon } = ui;
  const existing = !!md && !md._guess;   // _guess: new import whose unit is known (SketchUp m, FBX cm, Collada m)
  const st = {
    unit: md ? md.unit || 'm' : 'm', scale: md ? +md.scale || 1 : 1,
    x: md ? +md.x || 0 : 0, y: md ? +md.y || 0 : 0, z: md ? +md.z || 0 : 0,
    rx: md ? +md.rx || 0 : 0, ry: md ? +md.ry || 0 : 0, rz: md ? +md.rz || 0 : 0,
    mode: new Map((md && md.hidden || []).map((id) => [String(id), 'hide'])),   // element id -> 'hide' | 'del'
    sel: null, q: '', open: new Set(), limit: 300
  };
  const { json } = parseGlb(glb);
  const tree = nodeTree(json);
  const byId = new Map(); const parentOf = new Map();
  const walk = (list, par) => { for (const n of list) { byId.set(String(n.i), n); if (par) parentOf.set(String(n.i), String(par.i)); walk(n.children, n); } };
  walk(tree, null);
  const totalTris = tree.reduce((a, n) => a + n.tris, 0);

  return new Promise((resolve) => {
    // ---------------------------------------------------------------- three preview
    const canvas = h('canvas', { class: 'mw-canvas' });
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#14171e');
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    const orbit = new OrbitControls(camera, canvas); orbit.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(20, 40, 25); scene.add(sun);
    const grid = new THREE.GridHelper(100, 100, 0x3a4150, 0x262b35); scene.add(grid);
    // screens of the project (where the model has to fit) + a 1.80 m figure for the scale
    const screenBox = new THREE.Box3();
    for (const s of project.surfaces || []) {
      if (s.visible === false || !(s.stage && s.stage.placed)) continue;
      let w; try { w = surfaceWorld(project, s); } catch (_) { w = null; }
      if (!w) continue;
      const col = (M.COLOR_PRESETS[s.colors && s.colors.preset] || ['#4f8bff'])[0] || '#4f8bff';
      const pos = [];
      for (const f of w.facets) {
        const p11 = [f.p10[0] + f.p01[0] - f.p00[0], f.p10[1] + f.p01[1] - f.p00[1], f.p10[2] + f.p01[2] - f.p00[2]];
        pos.push(...f.p00, ...f.p01, ...f.p10, ...f.p10, ...f.p01, ...p11);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
      scene.add(mesh, new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })));
      g.computeBoundingBox(); screenBox.union(g.boundingBox);
    }
    const human = new THREE.Group();
    const hm = new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 1.5, 16), hm); body.position.y = 0.75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), hm); head.position.y = 1.67;
    human.add(body, head); human.position.set(screenBox.isEmpty() ? 0 : (screenBox.min.x + screenBox.max.x) / 2, 0, screenBox.isEmpty() ? 2 : screenBox.max.z + 3);
    scene.add(human);
    const holder = new THREE.Group(); scene.add(holder);
    const selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffb020); selBox.visible = false; scene.add(selBox);
    let model = null, parser = null, nodeObj = new Map();
    const hideState = {};
    let rawBox = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    const k = () => st.scale * (M.UNIT_SCALE[st.unit] || 1);

    // ---------------------------------------------------------------- panel
    const dims = h('div', { class: 'mw-dims' });
    const unitSel = h('select', { onchange: () => { st.unit = unitSel.value; place(); } }, UNITS.map((u) => h('option', { value: u }, u)));
    const num = (key, step = 0.1, on = () => place()) => { const i = h('input', { type: 'number', step, onchange: () => { st[key] = +i.value || 0; on(); } }); i._key = key; return i; };
    const hInput = h('input', { type: 'number', step: 0.1, min: 0.01, onchange: () => { const want = +hInput.value; const raw = rawBox.max.y - rawBox.min.y; if (want > 0 && raw > 0) { st.scale = want / (raw * (M.UNIT_SCALE[st.unit] || 1)); place(); } } });
    const nx = num('x'), ny = num('y'), nz = num('z'), nry = num('ry', 1, () => { orient(); }), nscale = num('scale', 0.01);
    const fields = [nx, ny, nz, nry, nscale];
    const btn = (label, fn, cls = 'btn sm') => h('button', { class: cls, onclick: fn }, label);
    const listBox = h('div', { class: 'mw-list' });
    const summary = h('div', { class: 'mw-sum' });
    const search = h('input', { type: 'text', class: 'mw-search', placeholder: t('mw.search'), oninput: () => { st.q = search.value.trim().toLowerCase(); st.limit = 300; renderList(); } });
    const okBtn = h('button', { class: 'btn primary', onclick: () => finish(true) }, existing ? t('mw.apply') : t('mw.import'));
    const close = () => { cancelAnimationFrame(raf); ro.disconnect(); orbit.dispose(); renderer.dispose(); scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ov.remove(); };
    const finish = (ok) => {
      if (!ok) { close(); resolve(null); return; }
      const del = [...st.mode].filter(([, m]) => m === 'del').map(([id]) => (id[0] === 'm' ? id : +id));
      const hid = [...st.mode].filter(([, m]) => m === 'hide').map(([id]) => (id[0] === 'm' ? id : +id));
      let out = glb, hidden = hid, pruned = false;
      if (del.length) {
        const r = pruneGlb(glb, del); out = r.glb; pruned = true;
        hidden = hid.map((id) => (typeof id === 'string' ? (r.map.has(+id.slice(1)) ? 'm' + r.map.get(+id.slice(1)) : null) : (r.map.has(id) ? r.map.get(id) : null))).filter((v) => v !== null);
      }
      close();
      resolve({ glb: out, pruned, unit: st.unit, scale: Math.round(st.scale * 1e6) / 1e6, x: r3(st.x), y: r3(st.y), z: r3(st.z), rx: st.rx, ry: st.ry, rz: st.rz, hidden });
    };
    const r3 = (v) => Math.round(v * 1000) / 1000;

    const sec = (title, ...kids) => h('div', { class: 'mw-sec' }, h('div', { class: 'panel-sub' }, title), ...kids);
    const row = (label, el) => h('label', { class: 'mw-row' }, h('span', {}, label), el);
    const panel = h('div', { class: 'mw-panel' },
      sec(t('mw.size'), dims, row(t('st3.unit'), unitSel), row(t('mw.height'), hInput), row(t('mw.scale'), nscale), h('div', { class: 'note' }, t('mw.sizeH'))),
      sec(t('mw.orient'),
        h('div', { class: 'row-btns wrap mw-btns' }, btn(t('mw.zUp'), () => { st.rx = st.rx ? 0 : -90; orient(); }), btn('⟲ 90°', () => { st.ry = ((st.ry + 90) % 360 + 360) % 360; orient(); }), btn('⟳ 90°', () => { st.ry = ((st.ry - 90) % 360 + 360) % 360; orient(); })),
        row(t('mw.yaw'), nry)),
      sec(t('mw.place'),
        h('div', { class: 'row-btns wrap mw-btns' }, btn(t('mw.floor'), () => { st.y = -rawBox.min.y * k(); place(); }), btn(t('mw.origin'), () => { const c = rawBox.getCenter(new THREE.Vector3()); st.x = -c.x * k(); st.z = -c.z * k(); place(); }),
          screenBox.isEmpty() ? null : btn(t('mw.onScreens'), () => { const c = rawBox.getCenter(new THREE.Vector3()), sc = screenBox.getCenter(new THREE.Vector3()); st.x = sc.x - c.x * k(); st.z = sc.z - c.z * k(); place(); })),
        h('div', { class: 'mw-xyz' }, row('X', nx), row('Y', ny), row('Z', nz)), h('div', { class: 'note' }, t('mw.placeH'))),
      sec(t('mw.elements'), search, h('div', { class: 'row-btns wrap mw-btns' }, btn(t('mw.showAll'), () => { st.mode.clear(); applyModes(); renderList(); }), btn(t('mw.delHidden'), () => { for (const [id, m] of st.mode) if (m === 'hide') st.mode.set(id, 'del'); applyModes(); renderList(); })),
        listBox, summary, h('div', { class: 'note' }, t('mw.elementsH'))));
    const ov = h('div', { class: 'modal-ov' },
      h('div', { class: 'modal mw-modal' },
        h('div', { class: 'panel-head' }, h('span', {}, (existing ? t('mw.titleEdit') : t('mw.title')) + ' — ' + name), h('button', { class: 'btn ghost icon', onclick: () => finish(false) }, '✕')),
        h('div', { class: 'mw-body' }, h('div', { class: 'mw-view' }, canvas, h('div', { class: 'mw-hint' }, t('mw.viewH'))), panel),
        h('div', { class: 'row-btns' }, h('button', { class: 'btn', onclick: () => finish(false) }, t('pnl.cancel')), okBtn)));
    ov._onEsc = () => finish(false);
    document.body.append(ov);

    // ---------------------------------------------------------------- behaviour
    function syncFields() {
      unitSel.value = st.unit;
      for (const f of fields) if (document.activeElement !== f) f.value = r3(st[f._key]);
      const s = new THREE.Vector3(); rawBox.getSize(s); s.multiplyScalar(k());
      if (document.activeElement !== hInput) hInput.value = r3(s.y);
      dims.textContent = `${fmtM(s.x)} × ${fmtM(s.y)} × ${fmtM(s.z)} m`;
    }
    // size / orientation changes keep the model's bottom-centre where it is (it stays on the floor, on its mark)
    let anchor = null;   // { k, box } of the last placement
    function keepAnchor() {
      const kk = k();
      if (anchor && model && (anchor.k !== kk || !anchor.box.equals(rawBox))) {
        const c0 = anchor.box.getCenter(new THREE.Vector3()), c1 = rawBox.getCenter(new THREE.Vector3());
        st.x += c0.x * anchor.k - c1.x * kk; st.z += c0.z * anchor.k - c1.z * kk; st.y += anchor.box.min.y * anchor.k - rawBox.min.y * kk;
      }
      if (model) anchor = { k: kk, box: rawBox.clone() };
    }
    function place() {
      keepAnchor();
      holder.position.set(st.x, st.y, st.z);
      holder.rotation.set(st.rx * D2R, st.ry * D2R, st.rz * D2R, EULER);
      holder.scale.setScalar(k());
      syncFields(); updateSel();
    }
    /** Raw box (unit 1, rotation applied) — recomputed when the orientation changes. */
    function orient() {
      if (model) { holder.position.set(0, 0, 0); holder.rotation.set(st.rx * D2R, st.ry * D2R, st.rz * D2R, EULER); holder.scale.setScalar(1); holder.updateMatrixWorld(true); rawBox = new THREE.Box3().setFromObject(holder); }
      place();
    }
    function frame() {
      const b = new THREE.Box3().setFromObject(holder); if (!screenBox.isEmpty()) b.union(screenBox); b.expandByObject(human);
      const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()).length();
      orbit.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(0.55, 0.45, 0.75).multiplyScalar(size * 0.95)); camera.near = size / 2000; camera.far = size * 20; camera.updateProjectionMatrix(); orbit.update();
    }
    function objsOf(id) { return id[0] === 'm' ? ownMeshes(nodeObj.get(+id.slice(1)), parser) : [nodeObj.get(+id)].filter(Boolean); }
    function updateSel() {
      if (!st.sel || !model) { selBox.visible = false; return; }
      const b = new THREE.Box3(); holder.updateMatrixWorld(true);
      for (const o of objsOf(st.sel)) b.expandByObject(o);
      selBox.box.copy(b); selBox.visible = !b.isEmpty();
    }
    function applyModes() {
      if (!model) return;
      const hiddenIds = [...st.mode].map(([id]) => (id[0] === 'm' ? id : +id));   // hidden and deleted both disappear here
      applyHidden(parser, nodeObj, hiddenIds, hideState);
      updateSel(); renderSummary();
    }
    function renderSummary() {
      let hid = 0, del = 0, delTris = 0;
      const delSet = new Set([...st.mode].filter(([, m]) => m === 'del').map(([id]) => id));
      for (const [id, m] of st.mode) { if (m === 'hide') hid++; else { del++; let p = parentOf.get(id), inDel = false; while (p) { if (delSet.has(p)) { inDel = true; break; } p = parentOf.get(p); } if (!inDel) delTris += (byId.get(id) || { tris: 0 }).tris; } }
      summary.textContent = t('mw.sum', { h: hid, d: del, tri: fmtN(totalTris - delTris), all: fmtN(totalTris) });
    }
    const setMode = (id, m) => { if (st.mode.get(id) === m) st.mode.delete(id); else st.mode.set(id, m); applyModes(); renderList(); };
    const label = (n) => n.loose ? t('mw.loose') : n.name || t('mw.unnamed', { n: n.i });
    function matches(n) { return !st.q || label(n).toLowerCase().includes(st.q) || n.children.some(matches); }
    function renderList() {
      listBox.innerHTML = ''; let count = 0;
      const add = (n, depth) => {
        if (count >= st.limit || !matches(n)) return;
        const id = String(n.i), m = st.mode.get(id), open = st.open.has(id) || (st.q && n.children.some(matches));
        count++;
        const r = h('div', { class: 'mw-item' + (st.sel === id ? ' sel' : '') + (m ? ' ' + m : ''), style: { paddingLeft: 6 + depth * 14 + 'px' } },
          n.children.length ? h('button', { class: 'mw-tw', onclick: (e) => { e.stopPropagation(); if (st.open.has(id)) st.open.delete(id); else st.open.add(id); renderList(); } }, open ? '▾' : '▸') : h('span', { class: 'mw-tw' }),
          h('span', { class: 'mw-nm', title: label(n) }, label(n)),
          h('span', { class: 'mw-tri' }, fmtN(n.tris)),
          h('button', { class: 'btn ghost icon mw-ic' + (m === 'hide' ? ' on' : ''), title: t('mw.hide'), onclick: (e) => { e.stopPropagation(); setMode(id, 'hide'); } }, icon(m === 'hide' ? 'eyeOff' : 'eye', 14)),
          h('button', { class: 'btn ghost icon mw-ic' + (m === 'del' ? ' on' : ''), title: t('mw.del'), onclick: (e) => { e.stopPropagation(); setMode(id, 'del'); } }, icon('trash', 14)));
        r.addEventListener('click', () => { st.sel = st.sel === id ? null : id; updateSel(); renderList(); });
        r._id = id; listBox.append(r);
        if (open) for (const c of n.children) add(c, depth + 1);
      };
      for (const n of tree) add(n, 0);
      if (count >= st.limit) listBox.append(h('button', { class: 'btn sm block', onclick: () => { st.limit += 500; renderList(); } }, t('mw.more')));
      if (!tree.length) listBox.append(h('div', { class: 'note' }, t('mw.noElements')));
      renderSummary();
      const selEl = [...listBox.children].find((c) => c._id === st.sel); if (selEl && selEl.scrollIntoViewIfNeeded) selEl.scrollIntoViewIfNeeded(false);
    }
    // click in the preview: select the element under the mouse (top-most listed ancestor that is open)
    const ray = new THREE.Raycaster(); let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !model) return;
      const r = canvas.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObject(model, true).find((x) => x.object.visible && x.object.geometry.drawRange.count !== 0);
      if (!hit) { st.sel = null; updateSel(); renderList(); return; }
      // node chain of the hit object, from the top of the tree
      const chain = []; let o = hit.object;
      const objNode = new Map([...nodeObj].map(([i, ob]) => [ob, i]));
      while (o && o !== model) { if (objNode.has(o)) chain.unshift(String(objNode.get(o))); o = o.parent; }
      let pickId = null;
      for (const id of chain) { if (byId.has(id)) { pickId = id; if (!st.open.has(id)) break; } }
      if (!pickId && byId.has('m' + chain[chain.length - 1])) pickId = 'm' + chain[chain.length - 1];
      if (!pickId) { const loose = [...byId.keys()].find((x) => x[0] === 'm'); pickId = loose || null; }
      // open the parents so the row shows
      let p = pickId && parentOf.get(pickId); while (p) { st.open.add(p); p = parentOf.get(p); }
      st.sel = pickId; updateSel(); renderList();
    });
    // keyboard: H = hide, Delete = delete the selected element
    ov.addEventListener('keydown', (e) => { if (!st.sel || /INPUT|SELECT/.test(e.target.tagName)) return; if (e.key === 'h' || e.key === 'H') setMode(st.sel, 'hide'); if (e.key === 'Delete' || e.key === 'Backspace') setMode(st.sel, 'del'); });
    ov.tabIndex = -1;

    const view = canvas.parentElement;
    const resize = () => { const w = view.clientWidth, hh = view.clientHeight; if (!w || !hh) return; renderer.setSize(w, hh, false); camera.aspect = w / hh; camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(view); resize();
    let raf = 0; const loop = () => { raf = requestAnimationFrame(loop); orbit.update(); renderer.render(scene, camera); }; loop();
    renderList(); syncFields();

    // ---------------------------------------------------------------- model
    okBtn.disabled = true;
    const buf = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    new GLTFLoader().parse(buf, '', (gl) => {
      model = gl.scene; parser = gl.parser; nodeObj = nodeObjects(parser);
      model.traverse((o) => { if (o.isMesh) { const mats = Array.isArray(o.material) ? o.material : [o.material]; for (const m of mats) m.side = THREE.DoubleSide; } });
      holder.add(model);
      orient();
      if (!existing) {
        // first guess: a unit giving a plausible venue size, then on the floor and centred on the screens (or the origin)
        const s = rawBox.getSize(new THREE.Vector3()), mx = Math.max(s.x, s.y, s.z);
        const order = ['m', 'mm', 'cm', 'in'];
        if (!(md && md._guess)) st.unit = order.find((u) => { const v = mx * M.UNIT_SCALE[u]; return v >= 3 && v <= 150; }) || 'm';
        const c = rawBox.getCenter(new THREE.Vector3()), sc = screenBox.isEmpty() ? new THREE.Vector3() : screenBox.getCenter(new THREE.Vector3());
        st.x = sc.x - c.x * k(); st.z = sc.z - c.z * k(); st.y = -rawBox.min.y * k();
      }
      anchor = { k: k(), box: rawBox.clone() };
      place(); applyModes(); frame(); okBtn.disabled = false;
    }, (err) => { panel.prepend(h('div', { class: 'note warn' }, t('mw.loadErr') + ' — ' + (err && err.message || err))); okBtn.disabled = false; });
  });
}
