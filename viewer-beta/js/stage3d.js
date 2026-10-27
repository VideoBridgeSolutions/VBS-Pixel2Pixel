// Pixel2Pixel — Stage 3D (three.js)
// Screens are placed in metres (Y up, audience towards +Z). The pixels shown on each screen come from the
// same Renderer bitmaps as the 2D views, so the 3D view is always the live pixelmap (and tomorrow an NDI frame).
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { TransformControls } from '../vendor/three/addons/TransformControls.js';
import { GLTFLoader } from '../vendor/three/addons/GLTFLoader.js';
import { OBJLoader } from '../vendor/three/addons/OBJLoader.js';
import * as M from './model.js';
import { buildMappedGeometry, thinNormal } from './meshmap.js';
import { StageFX, personGeometry } from './stagefx.js';
import { ProjectorLayer } from './projview.js';
import * as P from './projectors.js';

const D2R = Math.PI / 180;
const EULER = 'YXZ'; // yaw (ry), then tilt (rx), then roll (rz)

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

/** Live source of a surface: { key: 'ndi:<name>' | 'dev:<deviceId>', mode: 'comp' | 'full' } or null. */
export const liveSourceOf = M.liveSourceOf;

/** UV matrix: screen uv (u →, v ↑) -> source texture coords. comp: the screen's Input Selection in the composition-sized frame. */
export function liveUvMatrix(p, s, mode, flipY) {
  const m3 = new THREE.Matrix3();
  let f;
  if (mode === 'full') f = (u, v) => [u, 1 - v];
  else {
    const r = ((s.comp.rot % 360) + 360) % 360, swap = r === 90 || r === 270;
    const bw = swap ? s.h : s.w, bh = swap ? s.w : s.h;
    const cx = s.comp.x + bw / 2, cy = s.comp.y + bh / 2;
    const c = Math.round(Math.cos(r * D2R)), sn = Math.round(Math.sin(r * D2R));
    const CW = p.composition.w, CH = p.composition.h;
    f = (u, v) => {
      let x = u * s.w - s.w / 2; const y = (1 - v) * s.h - s.h / 2;
      if (s.comp.flip) x = -x;
      return [(cx + x * c - y * sn) / CW, (cy + x * sn + y * c) / CH];
    };
  }
  const T = (u, v) => { const [a, b] = f(u, v); return [a, flipY ? 1 - b : b]; };
  const [s00, t00] = T(0, 0), [s10, t10] = T(1, 0), [s01, t01] = T(0, 1);
  m3.set(s10 - s00, s01 - s00, s00, t10 - t00, t01 - t00, t00, 0, 0, 1);
  return m3;
}

export class Stage3D {
  /**
   * hooks: getProject(), renderer (Renderer), getSelection() -> Set of surface ids, select(ids, additive),
   *        edit(key, fn, live), commit(), t(key), onViewChange()
   */
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.h = hooks;
    this.active = false;
    this.screens = new Map();   // id -> { group, front, back, outline, tex, texCanvas, key, geoKey }
    this.models = new Map();    // id -> { obj, dataKey, loading }
    this.tool = 'translate';
    this.snap = true;
    this.anim = null;

    const r = this.renderer3 = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setPixelRatio(window.devicePixelRatio || 1);
    this.scene = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    this.persp.position.set(0, 4, 18);
    // orthographic views (plans: face, dessus, côtés): same viewpoint, no perspective; orthoH = half height of the view (m)
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 6000);
    this.orthoH = 5; this.aspect = 1; this.isOrtho = false;
    this.camera = this.persp;

    this.fx = new StageFX(this);   // lights, sky, haze, bloom, reflections, spill, crowd

    this.ref = new THREE.Group(); this.scene.add(this.ref);
    this.screenRoot = new THREE.Group(); this.scene.add(this.screenRoot);
    this.modelRoot = new THREE.Group(); this.scene.add(this.modelRoot);
    this.motionRoot = new THREE.Group(); this.motionRoot.name = 'motion'; this.scene.add(this.motionRoot);   // virtual limits of motorised items (editor only)
    this.peopleRoot = new THREE.Group(); this.peopleRoot.name = 'people'; this.scene.add(this.peopleRoot);
    this.people = new Map();    // id -> { mesh, outline, key }
    this.projLayer = new ProjectorLayer(this);
    this.buildReference();

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.12;
    this.orbit.target.set(0, 2, 0);
    this.orbit.screenSpacePanning = true;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.orbit.addEventListener('change', () => this.dirtyView = true);

    this.pivot = new THREE.Object3D(); this.scene.add(this.pivot);
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    this.gizmoHelper = this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo;
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this.beginGizmo(); else this.endGizmo();
    });
    this.gizmo.addEventListener('objectChange', () => this.applyGizmo());

    this.ray = new THREE.Raycaster();
    canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.down || this.gizmo.dragging) { this.down = null; return; }
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved > 4) return;
      if (e.button === 2) { if (!this.meshPick && this.h.contextMenu) this.h.contextMenu(this.pick(e), e); return; }
      if (e.button !== 0) return;
      if (this.meshPick) { const hit = this.pickMesh(e); if (hit) { const cb = this.meshPick; this.meshPick = null; this.canvas.style.cursor = ''; cb(hit); } return; }
      if (this.gizmoAxisHover()) return;
      const pjid = this.pickProjector(e);
      if (pjid && this.h.selectProjector) { this.h.selectProjector(pjid); return; }
      const psid = this.pickPerson(e);
      if (psid && this.h.selectPerson) { this.h.selectPerson(psid); return; }
      const id = this.pick(e);
      this.h.select(id ? [id] : [], e.shiftKey || e.metaKey || e.ctrlKey);
    });
    canvas.addEventListener('dblclick', (e) => { const id = this.pick(e); if (id) this.frame([id]); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.loop = this.loop.bind(this);
  }

  // ------------------------------------------------------------------ lifecycle
  activate() {
    if (this.active) return;
    this.active = true;
    this.resize();
    this.sync();
    if (!this.framedOnce) { this.framedOnce = true; this.goView('persp', false); }
    requestAnimationFrame(this.loop);
  }
  deactivate() { this.active = false; }

  /** Fixed render size (video recording at 1080p / 4K): the canvas renders at w×h whatever its box, shown letterboxed. null = follow the viewport. */
  setFixedSize(size) {
    this.fixedSize = size && size.w > 0 && size.h > 0 ? { w: Math.round(size.w), h: Math.round(size.h) } : null;
    this.canvas.style.objectFit = this.fixedSize ? 'contain' : '';
    this.canvas.style.background = this.fixedSize ? '#000' : '';
    this.resize();
  }
  resize() {
    if (this.fixedSize) {
      const { w, h } = this.fixedSize;
      this.renderer3.setPixelRatio(1);
      this.renderer3.setSize(w, h, false);
      this.aspect = w / h;
      this.persp.aspect = this.aspect; this.persp.updateProjectionMatrix();
      this.updateOrtho();
      if (this.fx) this.fx.resize(w, h, 1);
      return;
    }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const dpr = this.fx ? this.fx.dpr() : (window.devicePixelRatio || 1);
    this.renderer3.setPixelRatio(dpr);
    this.renderer3.setSize(w, h, false);
    this.aspect = w / h;
    this.persp.aspect = this.aspect; this.persp.updateProjectionMatrix();
    this.updateOrtho();
    if (this.fx) this.fx.resize(w, h, dpr);
  }

  loop() {
    if (!this.active) return;
    requestAnimationFrame(this.loop);
    if (this.anim) {
      const A = this.anim;
      const k = Math.min(1, (performance.now() - A.t0) / A.dur);
      const e = A.ease === 'linear' ? k : A.ease === 'smooth' ? k * k * k * (k * (k * 6 - 15) + 10) : (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
      this.orbit.target.lerpVectors(A.t0v, A.t1, e);
      if (A.arc) {
        // orbit-like move: the offset to the target turns around it (azimuth / elevation) and its distance eases geometrically
        const r = A.r0 * Math.pow(A.r1 / A.r0, e);
        const th = A.th0 + A.dth * e, ph = A.ph0 + (A.ph1 - A.ph0) * e;
        this.camera.position.set(Math.sin(ph) * Math.sin(th), Math.cos(ph), Math.sin(ph) * Math.cos(th)).multiplyScalar(r).add(this.orbit.target);
      } else this.camera.position.lerpVectors(A.p0, A.p1, e);
      if (A.f1 && A.f0 !== A.f1) { this.persp.fov = A.f0 + (A.f1 - A.f0) * e; this.persp.updateProjectionMatrix(); }
      if (k >= 1) this.anim = null;
    }
    if (this.pov) this.applyPov(); else this.orbit.update();
    if (this.h.onCamera) {
      const c = this.camera.position, tg = this.orbit.target;
      const sig = [c.x, c.y, c.z, tg.x, tg.y, tg.z, this.persp.fov, this.isOrtho ? this.orthoH / this.ortho.zoom : 0].map((v) => v.toFixed(3)).join(',');
      if (sig !== this.camSig) { this.camSig = sig; this.h.onCamera(this.currentView()); }
    }
    this.updateTextures(false);
    this.updateLive(this.h.getProject());
    this.projLayer.update(this.h.getProject());
    const now = performance.now();
    this.fx.updateSpill(this.h.getProject(), now);
    this.renderFrame(now);
  }
  /** Render; orthographic views are technical plans: no haze (depth-based) and no floor mirror (perspective only). */
  renderFrame(now) {
    if (!this.isOrtho) { this.fx.render(now); return; }
    const fog = this.scene.fog, refl = this.fx.reflector, floor = this.ref.getObjectByName('floor');
    const fo = floor ? floor.material.opacity : 1;
    this.scene.fog = null;
    if (refl) refl.visible = false;
    if (floor && refl) floor.material.opacity = 1;
    this.fx.render(now);
    this.scene.fog = fog;
    if (refl) refl.visible = true;
    if (floor && refl) floor.material.opacity = fo;
  }

  // ------------------------------------------------------------------ perspective / orthographic
  updateOrtho() {
    const o = this.ortho, hh = this.orthoH, a = this.aspect || 1;
    o.left = -hh * a; o.right = hh * a; o.top = hh; o.bottom = -hh;
    o.updateProjectionMatrix();
  }
  useCamera(cam) {
    this.camera = cam;
    this.orbit.object = cam;
    this.gizmo.camera = cam;
    if (this.fx.composer && this.fx.composer.passes[0]) this.fx.composer.passes[0].camera = cam;
    this.orbit.update();
    this.dirtyView = true;
  }
  /** Switch projection keeping the viewpoint and the framing (visible height at the target). */
  setOrtho(on) {
    on = !!on;
    if (on === this.isOrtho) return;
    if (this.pov) this.setPov(null);
    this.anim = null;
    const tg = this.orbit.target, from = this.camera;
    const dir = from.position.clone().sub(tg); const dist = Math.max(0.1, dir.length()); dir.normalize();
    const tanH = Math.tan(this.persp.fov * D2R / 2);
    if (on) {
      this.orthoH = dist * tanH; this.ortho.zoom = 1;
      // the ortho camera stays far behind the target: nothing in front of it is clipped
      this.ortho.position.copy(tg).addScaledVector(dir, Math.max(dist, this.sceneRadius() * 2 + 20));
      this.ortho.quaternion.copy(from.quaternion); this.ortho.up.copy(from.up);
      this.updateOrtho();
    } else {
      const hh = this.orthoH / (this.ortho.zoom || 1);
      this.persp.position.copy(tg).addScaledVector(dir, Math.max(0.5, hh / tanH));
      this.persp.quaternion.copy(from.quaternion);
    }
    this.isOrtho = on;
    this.useCamera(on ? this.ortho : this.persp);
    if (this.h.onProjection) this.h.onProjection(on);
  }
  sceneRadius() {
    const b = this.screensBox();
    return b.isEmpty() ? 10 : b.getSize(new THREE.Vector3()).length() / 2 + b.getCenter(new THREE.Vector3()).length();
  }

  /** Floor footprint of every visible screen reaching below head height: XZ triangles + bounds, so the crowd never stands inside a screen or on an LED floor. */
  screenFootprints() {
    const out = [], v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (const [, e] of this.screens) {
      if (!e.group.visible || !e.front || !e.front.geometry) continue;
      e.front.updateMatrixWorld(true);
      const g = e.front.geometry, pos = g.attributes.position, idx = g.index, mw = e.front.matrixWorld;
      if (!pos) continue;
      const n = idx ? idx.count : pos.count, tris = [];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i + 2 < n; i += 3) {
        for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(mw);
        if (Math.min(v[0].y, v[1].y, v[2].y) > 2.3) continue;   // screen above the heads: people can stand under it
        tris.push(v[0].x, v[0].z, v[1].x, v[1].z, v[2].x, v[2].z);
        for (let k = 0; k < 3; k++) { x0 = Math.min(x0, v[k].x); x1 = Math.max(x1, v[k].x); z0 = Math.min(z0, v[k].z); z1 = Math.max(z1, v[k].z); }
      }
      if (tris.length) out.push({ tris, x0, x1, z0, z1 });
    }
    return out;
  }

  // ------------------------------------------------------------------ reference scene
  buildReference() {
    const g = this.ref;
    g.clear();
    const st = (this.h.getProject().stage) || M.newStage();
    if (st.floor) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: st.floorColor || '#22262f', roughness: 0.95 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -0.002; floor.name = 'floor';
      g.add(floor);
    }
    if (st.grid) {
      const g1 = new THREE.GridHelper(100, 100, 0x3a404c, 0x2c313b); g1.material.transparent = true; g1.material.opacity = 0.7;
      const g10 = new THREE.GridHelper(100, 10, 0x56607a, 0x56607a);
      g.add(g1, g10);
    }
    if (st.axes) { const ax = new THREE.AxesHelper(2); ax.position.y = 0.01; g.add(ax); }
    if (st.human) {
      // 1.80 m silhouette for scale
      const mat = new THREE.MeshStandardMaterial({ color: 0x8a93a6, roughness: 0.8 });
      const man = new THREE.Group(); man.name = 'human';
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.78, 6, 16), mat); body.position.y = 1.0; body.scale.z = 0.62;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 14), mat); head.position.y = 1.68;
      const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.62, 4, 10), mat); legL.position.set(-0.1, 0.38, 0);
      const legR = legL.clone(); legR.position.x = 0.1;
      man.add(body, head, legL, legR);
      g.add(man);
      this.human = man;
    } else this.human = null;
    if (this.fx) this.fx.refreshFloor(this.h.getProject());
  }

  placeHuman() {
    if (!this.human) return;
    const b = this.screensBox();
    if (b.isEmpty()) { this.human.position.set(0, 0, 2); return; }
    this.human.position.set(b.min.x - 1.2, 0, Math.max(b.max.z, 0) + 1.5);
  }

  // ------------------------------------------------------------------ project sync
  sync() {
    const p = this.h.getProject();
    const st = p.stage;
    const refKey = JSON.stringify([st.floor, st.grid, st.human, st.axes]);
    if (refKey !== this.refKey) { this.refKey = refKey; this.buildReference(); }
    const seen = new Set();
    for (const s of p.surfaces) {
      seen.add(s.id);
      let e = this.screens.get(s.id);
      if (!e) { e = this.makeScreen(s); this.screens.set(s.id, e); }
      const sg = s.stage;
      const rail = sg.rail ? (st.rails || []).find((r) => r.id === sg.rail) : null;
      const geoKey = this.geoKeyOf(p, s, rail);
      if (geoKey !== e.geoKey) { e.geoKey = geoKey; this.rebuildGeometry(e, p, s, rail); }
      e.rail = rail ? rail.id : null;
      if (rail) {
        // the height on the rail is a plain offset of the built geometry (motorised hoists move it every frame)
        e.group.position.set(rail.x, (+sg.y || 0) - (e.geoY || 0), rail.z);
        e.group.rotation.set(0, (rail.ry || 0) * D2R, 0, EULER);
      } else {
        e.group.position.set(sg.x, sg.y, sg.z);
        e.group.rotation.set(sg.rx * D2R, sg.ry * D2R, sg.rz * D2R, EULER);
      }
      e.group.visible = s.visible !== false;
      e.back.visible = st.backs !== false;
      this.syncReceiver(e, s, st);
      if (e.front.material.color) e.front.material.color.setScalar(Math.max(0.1, st.glow ?? 1));
    }
    for (const [id, e] of this.screens) if (!seen.has(id)) { this.screenRoot.remove(e.group); if (e.mapped) this.scene.remove(e.mapped, e.mappedBox); e.tex.dispose(); e.front.geometry.dispose(); this.screens.delete(id); }
    this.syncRails(p);
    this.syncModels(p);
    this.syncMapped(p);
    this.updateTextures(false);
    this.syncPeople(p);
    this.projLayer.sync(p);
    this.syncSelection();
    this.syncMotionGuides(p);
    this.placeHuman();
    const fb = this.screensBox();
    this.fx.frontZ = fb.isEmpty() ? 0 : Math.max(0, fb.max.z);
    this.fx.screenBounds = fb.isEmpty() ? null : { minX: fb.min.x, maxX: fb.max.x, minZ: fb.min.z, maxZ: fb.max.z };
    this.fx.footprints = this.screenFootprints();
    this.fx.apply(p);
    this.projLayer.syncPeopleLight(p);   // after the crowd is (re)built
  }

  /** Motion playback: move the motorised screens / models only (no texture, crowd or projector rebuild). */
  /** Geometry signature of a screen (the height on a rail is not part of it: it is applied as an offset). */
  geoKeyOf(p, s, rail) {
    const sg = s.stage, st = p.stage;
    return JSON.stringify([s.w, s.h, s.tile, s.pitch, s.panel && [s.panel.cabW, s.panel.cabH, s.panel.pxW, s.panel.pxH], sg.curve, sg.curveDeg, sg.jh, sg.jv, st.pitchDefault,
      rail ? [rail.segs, rail.closed, rail.h0, sg.railOffset, sg.railFlip, sg.upside] : null]);
  }
  syncTransforms() {
    const p = this.h.getProject();
    for (const s of p.surfaces) {
      const e = this.screens.get(s.id); const sg = s.stage;
      if (!e) continue;
      if (sg.rail) {
        const rail = (p.stage.rails || []).find((r) => r.id === sg.rail);
        if (!rail) continue;
        const k = this.geoKeyOf(p, s, rail);              // position along the rail (motorised track) rebuilds the bent geometry
        if (k !== e.geoKey) { e.geoKey = k; this.rebuildGeometry(e, p, s, rail); }
        e.group.position.set(rail.x, (+sg.y || 0) - (e.geoY || 0), rail.z);
        continue;
      }
      e.group.position.set(sg.x, sg.y, sg.z);
      e.group.rotation.set(sg.rx * D2R, sg.ry * D2R, sg.rz * D2R, EULER);
    }
    for (const md of p.stage.models) {
      const e = this.models.get(md.id); if (!e) continue;
      e.holder.position.set(md.x, md.y, md.z);
      e.holder.rotation.set(md.rx * D2R, md.ry * D2R, md.rz * D2R, EULER);
    }
    if (!this.gizmo.dragging) this.syncSelection();
    this.syncMotionGuides(p);
    this.mapDirty = true;
  }

  /** Ghost outlines of a selected motorised screen at both virtual limits of each axis, joined by a dashed travel line. */
  syncMotionGuides(p) {
    const root = this.motionRoot;
    for (const c of [...root.children]) { root.remove(c); if (c.material) c.material.dispose(); if (c.userData.ownGeo && c.geometry) c.geometry.dispose(); }
    root.visible = !this.presentation && !this.hideMotionGuides;
    if (!root.visible) return;
    const sel = new Set(this.selectedIds());
    const colA = 0xffb020, colB = 0x3ddc97;
    for (const s of p.surfaces) {
      if (!sel.has(s.id) || !s.motion || !s.motion.on) continue;
      const e = this.screens.get(s.id); if (!e || !e.outline.geometry.attributes.position) continue;
      const rail = s.stage.rail ? (p.stage.rails || []).find((r) => r.id === s.stage.rail) : null;
      if (s.stage.rail && !rail) continue;
      for (const a of s.motion.axes || []) {
        if (rail) {
          // screen on a rail: hoists move it vertically (ghosts at both heights); along the track no ghost is drawn
          if (a.axis !== 'y') continue;
          const ends = [Math.min(+a.min || 0, +a.max || 0), Math.max(+a.min || 0, +a.max || 0)];
          ends.forEach((v, i) => {
            const ln = new THREE.Line(e.outline.geometry, new THREE.LineDashedMaterial({ color: i ? colB : colA, dashSize: 0.15, gapSize: 0.1, depthTest: false, transparent: true, opacity: 0.85 }));
            ln.position.set(rail.x, v - (e.geoY || 0), rail.z); ln.rotation.set(0, (rail.ry || 0) * D2R, 0, EULER);
            ln.computeLineDistances(); ln.renderOrder = 11; root.add(ln);
          });
          continue;
        }
        const ends = [Math.min(+a.min || 0, +a.max || 0), Math.max(+a.min || 0, +a.max || 0)];
        const pts = [];
        ends.forEach((v, i) => {
          const st = { ...s.stage, [a.axis]: v };
          const ln = new THREE.Line(e.outline.geometry, new THREE.LineDashedMaterial({ color: i ? colB : colA, dashSize: 0.15, gapSize: 0.1, depthTest: false, transparent: true, opacity: 0.85 }));
          ln.position.set(st.x, st.y, st.z); ln.rotation.set(st.rx * D2R, st.ry * D2R, st.rz * D2R, EULER);
          ln.computeLineDistances(); ln.renderOrder = 11;
          root.add(ln); pts.push(new THREE.Vector3(st.x, st.y, st.z));
        });
        if (!M.isRotAxis(a.axis) && pts[0].distanceTo(pts[1]) > 1e-4) {
          const g = new THREE.BufferGeometry().setFromPoints(pts);
          const tl = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.08, gapSize: 0.06, depthTest: false, transparent: true, opacity: 0.6 }));
          tl.userData.ownGeo = true; tl.computeLineDistances(); tl.renderOrder = 11; root.add(tl);
        }
      }
    }
  }

  /** People placed on stage (performers, crew): same silhouette as the crowd, height = h. */
  syncPeople(p) {
    const seen = new Set();
    for (const ps of p.stage.people || []) {
      seen.add(ps.id);
      let e = this.people.get(ps.id);
      if (!e || e.arms !== !!ps.arms) {
        if (e) { this.peopleRoot.remove(e.mesh, e.outline); e.mesh.geometry.dispose(); }
        const mesh = new THREE.Mesh(personGeometry(!!ps.arms), new THREE.MeshStandardMaterial({ color: ps.color || '#B8BEC9', roughness: 0.8 }));
        mesh.userData.personId = ps.id;
        const outline = new THREE.BoxHelper(mesh, 0x4f8bff); outline.material.depthTest = false; outline.renderOrder = 10; outline.visible = false;
        this.peopleRoot.add(mesh, outline);
        e = { mesh, outline, arms: !!ps.arms };
        this.people.set(ps.id, e);
      }
      e.mesh.position.set(ps.x, ps.y || 0, ps.z);
      e.mesh.rotation.set(0, (ps.ry || 0) * D2R, 0);
      e.mesh.scale.setScalar(Math.max(0.3, ps.h || 1.75));
      e.mesh.visible = ps.visible !== false;
      e.mesh.userData.personColor = ps.color || '#B8BEC9';
      if (e.mesh.userData.stdMat) e.mesh.userData.stdMat.color.set(ps.color || '#B8BEC9'); else e.mesh.material.color.set(ps.color || '#B8BEC9');
      e.mesh.updateMatrixWorld(true); e.outline.update();
    }
    for (const [id, e] of this.people) if (!seen.has(id)) { this.peopleRoot.remove(e.mesh, e.outline); e.mesh.geometry.dispose(); this.people.delete(id); }
  }
  pickPerson(e) {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const list = [...this.people.values()].filter((x) => x.mesh.visible).map((x) => x.mesh);
    const hit = this.ray.intersectObjects(list, false)[0];
    return hit ? hit.object.userData.personId : null;
  }

  /** Projection screens are lit by the projectors (receiver shader) unless shown as a flat pixelmap ('map'). */
  syncReceiver(e, s, st) {
    const want = s.kind === 'proj' && (s.stage.projLook || 'lit') !== 'map';
    if (!e.ledMat) e.ledMat = e.front.material;
    if (want) {
      const look = JSON.stringify([s.gain, s.stage.screenColor, !!s.rearProj]);
      if (!e.recvMat || e.recvLook !== look) {
        this.projLayer.dropMaterial(e.recvMat);
        e.recvMat = this.projLayer.receiverMaterial({ color: s.stage.screenColor || '#E6E6E6', gain: +s.gain || 1, transmit: !!s.rearProj });
        e.recvLook = look;
      }
      if (e.front.material !== e.recvMat) e.front.material = e.recvMat;
    } else if (e.front.material !== e.ledMat) e.front.material = e.ledMat;
    if (e.mapped) e.mapped.material = e.front.material;
  }

  /** Every mesh that receives projection (projection screens, models flagged "receives projection"). */
  receivers() {
    const a = [];
    for (const e of this.screens.values()) { if (e.group.visible && e.front.material.userData.receiver) a.push(e.front); if (e.mapped && e.mapped.visible && e.mapped.material.userData.receiver) a.push(e.mapped); }
    for (const me of this.models.values()) if (me.holder.visible && me.receive) for (const m of me.meshes || []) if (m.visible) a.push(m);
    return a;
  }

  // ------------------------------------------------------------------ projector point of view
  /** Look through a projector (exact frustum, lens shift included); the projected raster is framed on screen. null = back. */
  setPov(id, label = '') {
    if (id && !this.pov) this.povPrev = this.currentView();
    if (id && this.isOrtho) { this.isOrtho = false; this.useCamera(this.persp); if (this.h.onProjection) this.h.onProjection(false); }
    this.pov = id || null;
    this.orbit.enabled = !this.pov;
    if (!this.povEl) {
      this.povEl = document.createElement('div'); this.povEl.className = 'pov-frame';
      this.povEl.innerHTML = '<span></span>';
      this.canvas.parentElement.append(this.povEl);
    }
    this.povEl.style.display = this.pov ? '' : 'none';
    this.povEl.firstChild.textContent = label;
    for (const [pid, e] of this.projLayer.items) { e.lines.visible = e.faces.visible = !this.presentation && pid !== this.pov; }
    if (!this.pov) { this.camera.updateProjectionMatrix(); if (this.povPrev) this.goView(this.povPrev, false); this.syncSelection(); }
    else this.gizmo.detach();
  }
  applyPov() {
    const p = this.h.getProject();
    const pj = (p.projectors || []).find((x) => x.id === this.pov), e = this.projLayer.items.get(this.pov);
    if (!pj || !e) { this.setPov(null); return; }
    const cam = this.projLayer.projCamera(pj, e), f = P.frustum(pj);
    const A = this.aspect;
    let L = f.l, R = f.r, B = f.b, T = f.t;
    const fw = R - L, fh = T - B;
    if (A > fw / fh) { const w = fh * A, c = (L + R) / 2; L = c - w / 2; R = c + w / 2; } else { const hh = fw / A, c = (B + T) / 2; B = c - hh / 2; T = c + hh / 2; }
    const cx = (L + R) / 2, cy = (B + T) / 2, k = 1.06;                       // a little margin around the raster
    L = cx + (L - cx) * k; R = cx + (R - cx) * k; B = cy + (B - cy) * k; T = cy + (T - cy) * k;
    this.camera.position.copy(cam.position); this.camera.quaternion.copy(cam.quaternion); this.camera.updateMatrixWorld(true);
    const n = 0.05;
    this.camera.projectionMatrix.makePerspective(L * n, R * n, T * n, B * n, n, 2000);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const st = this.povEl.style;
    st.left = ((f.l - L) / (R - L) * 100) + '%'; st.width = (fw / (R - L) * 100) + '%';
    st.top = ((T - f.t) / (T - B) * 100) + '%'; st.height = (fh / (T - B) * 100) + '%';
  }

  /** What the centre of a projector's image lands on (screens, LED, models): { name, kind, dist, depth } or null. */
  projectorHit(id) {
    const p = this.h.getProject();
    const pj = (p.projectors || []).find((x) => x.id === id), e = this.projLayer.items.get(id);
    if (!pj || !e) return null;
    const f = P.frustum(pj);
    e.group.updateMatrixWorld(true);
    const o = new THREE.Vector3().setFromMatrixPosition(e.group.matrixWorld);
    const dl = new THREE.Vector3(f.cx, f.cy, -1), dir = dl.clone().normalize().transformDirection(e.group.matrixWorld);
    const list = [];
    for (const sc of this.screens.values()) { if (sc.group.visible) list.push(sc.front, sc.back); if (sc.mapped && sc.mapped.visible) list.push(sc.mapped); }
    for (const me of this.models.values()) if (me.holder.visible) for (const m of me.meshes || []) if (m.visible) list.push(m);
    this.ray.set(o, dir); this.ray.far = 1000;
    const hit = this.ray.intersectObjects(list, false)[0];
    if (!hit) return null;
    const ob = hit.object;
    let name = '', kind = 'model', modelId = null;
    if (ob.userData.sid) { const sf = M.getSurface(p, ob.userData.sid); name = sf ? sf.name : ''; kind = sf && sf.kind === 'proj' ? 'proj' : 'led'; }
    else { modelId = ob.userData.mid; const md = p.stage.models.find((m) => m.id === modelId); name = (md ? md.name : '') + (ob.name ? ' · ' + ob.name : ''); }
    return { name, kind, modelId, dist: hit.distance, depth: hit.distance / dl.length(), point: hit.point.toArray() };
  }

  /** World bounding box of a model, and its extent across / along a projector's axes: { w, h, front, centre }. */
  objectExtent(modelId, pjId = null) {
    const me = this.models.get(modelId);
    if (!me || !me.holder) return null;
    me.holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(me.holder);
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3());
    const p = this.h.getProject();
    const pj = pjId ? (p.projectors || []).find((x) => x.id === pjId) : null;
    if (!pj) { const sz = box.getSize(new THREE.Vector3()); return { w: sz.x, h: sz.y, front: null, centre: c.toArray() }; }
    const ax = P.projAxes(pj), R = new THREE.Vector3(...ax.right), U = new THREE.Vector3(...ax.up), Fw = new THREE.Vector3(...ax.fwd), O = new THREE.Vector3(pj.x, pj.y, pj.z);
    let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity, f0 = Infinity;
    for (let i = 0; i < 8; i++) {
      const q = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(O);
      const r = q.dot(R), u = q.dot(U), fz = q.dot(Fw);
      r0 = Math.min(r0, r); r1 = Math.max(r1, r); u0 = Math.min(u0, u); u1 = Math.max(u1, u); f0 = Math.min(f0, fz);
    }
    return { w: r1 - r0, h: u1 - u0, front: f0, offH: -(r0 + r1) / 2, offV: -(u0 + u1) / 2, centre: c.toArray() };
  }

  pickProjector(e) {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const hit = this.ray.intersectObjects(this.projLayer.pickables(), false)[0];
    return hit ? hit.object.userData.pjid : null;
  }

  makeScreen(s) {
    const group = new THREE.Group(); group.userData.sid = s.id;
    const texCanvas = document.createElement('canvas'); texCanvas.width = texCanvas.height = 4;
    const tex = new THREE.CanvasTexture(texCanvas);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    const front = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide, toneMapped: false }));
    front.userData.sid = s.id;
    const back = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x30343d, roughness: 0.75, metalness: 0.25, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    back.userData.sid = s.id;
    const outline = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4f8bff, depthTest: false, transparent: true }));
    outline.renderOrder = 10; outline.visible = false;
    group.add(front, back, outline);
    this.screenRoot.add(group);
    return { group, front, back, outline, tex, texCanvas, key: null, geoKey: null };
  }

  /** Surfaces mapped onto a mesh of an imported model: the mesh (unwrapped) shows the live pixelmap instead of the flat screen. */
  syncMapped(p) {
    if (!this.mappedInfo) this.mappedInfo = new Map();
    const hidden = new Set();
    for (const s of p.surfaces) {
      const e = this.screens.get(s.id);
      if (!e) continue;
      const mm = s.stage.mesh;
      const me = mm ? this.models.get(mm.model) : null;
      const idxs = mm ? (Array.isArray(mm.indices) && mm.indices.length ? mm.indices : [mm.index]) : [];
      const meshes = me && me.meshes ? idxs.map((i) => me.meshes[i]).filter(Boolean) : [];
      const mesh = meshes[0] || null;
      const md = mm ? p.stage.models.find((x) => x.id === mm.model) : null;
      if (!mesh || !md) {
        if (e.mapped) { this.scene.remove(e.mapped, e.mappedBox); e.mapped.geometry.dispose(); e.mapped = null; e.mappedKey = null; }
        if (mm && md) e.group.visible = false;   // mapped, model still loading: nothing until the mesh exists
        continue;
      }
      const key = JSON.stringify([mm, md.x, md.y, md.z, md.rx, md.ry, md.rz, md.scale, md.unit, meshes.map((m) => m.uuid)]);
      if (key !== e.mappedKey || !e.mapped || this.mapDirty) {
        me.holder.updateMatrixWorld(true);
        const { geometry, info } = buildMappedGeometry(meshes, mm);
        if (e.mapped) { e.mapped.geometry.dispose(); e.mapped.geometry = geometry; }
        else {
          e.mapped = new THREE.Mesh(geometry, e.front.material); e.mapped.userData.sid = s.id;
          e.mappedBox = new THREE.BoxHelper(e.mapped, 0x4dd8ff); e.mappedBox.material.depthTest = false; e.mappedBox.renderOrder = 10;
          this.scene.add(e.mapped, e.mappedBox);
        }
        e.mappedBox.setFromObject(e.mapped);
        e.mappedKey = key;
        this.mappedInfo.set(s.id, { ...info, model: md.name, mesh: mesh.name || (mesh.parent && mesh.parent.name) || `#${mm.index}`, meshes: meshes.length });
      }
      e.mapped.visible = s.visible !== false;
      e.group.visible = false;
      for (const m of meshes) hidden.add(m);
    }
    this.mapDirty = false;
    // hide the source meshes that now carry a pixelmap, restore the others
    for (const me of this.models.values()) for (const m of me.meshes || []) m.visible = !hidden.has(m);
  }

  /** Every mesh of the loaded models (for pick lists and name matching). */
  meshCatalog() {
    const out = [];
    for (const [mid, me] of this.models) (me.meshes || []).forEach((m, i) => out.push({ model: mid, index: i, name: m.name || (m.parent && m.parent.name) || `mesh ${i}` }));
    return out;
  }

  /** World bbox, size and thin-panel normal of a model mesh (cached per model transform). */
  meshInfo(modelId, i) {
    const me = this.models.get(modelId);
    if (!me || !me.meshes || !me.meshes[i]) return null;
    me.holder.updateMatrixWorld(true);
    const m = me.meshes[i];
    const key = m.matrixWorld.elements.join(',');
    me.minfo = me.minfo || [];
    if (me.minfo[i] && me.minfo[i].key === key) return me.minfo[i];
    const P = m.geometry.getAttribute('position');
    const step = Math.max(1, Math.floor(P.count / 2000));
    const pts = [];
    const box = new THREE.Box3();
    for (let k = 0; k < P.count; k += step) { const v = new THREE.Vector3(P.getX(k), P.getY(k), P.getZ(k)).applyMatrix4(m.matrixWorld); pts.push(v); box.expandByPoint(v); }
    const tn = pts.length >= 4 ? thinNormal(pts) : { thin: false, n: new THREE.Vector3(0, 0, 1) };
    const info = { key, box, diag: box.getSize(new THREE.Vector3()).length(), thin: tn.thin, n: tn.n };
    me.minfo[i] = info;
    return info;
  }

  /**
   * Meshes of the same model forming one surface with mesh `seed`: thin panels, close (gap ≤ tol), roughly parallel
   * to their neighbour (follows curves cabinet by cabinet), not much bigger than the seed. Returns sorted indices.
   */
  connectedMeshes(modelId, seed) {
    const me = this.models.get(modelId);
    if (!me || !me.meshes) return [seed];
    const s0 = this.meshInfo(modelId, seed);
    if (!s0 || !s0.thin) return [seed];          // not a panel (whole object already): don't grow into the structure
    const tol = Math.max(0.03, s0.diag * 0.05);
    const N = me.meshes.length;
    const info = new Array(N);
    const get = (i) => (info[i] ??= this.meshInfo(modelId, i));
    const seen = new Set([seed]), queue = [seed];
    while (queue.length && seen.size < 5000) {
      const i = queue.shift(), a = get(i);
      const grown = a.box.clone().expandByScalar(tol);
      for (let j = 0; j < N; j++) {
        if (seen.has(j)) continue;
        const b = get(j);
        if (!b || !b.thin || b.diag > s0.diag * 3) continue;
        if (!grown.intersectsBox(b.box)) continue;
        if (Math.abs(a.n.dot(b.n)) < 0.77) continue;        // > ~40° between neighbours: another surface
        seen.add(j); queue.push(j);
      }
    }
    return [...seen].sort((x, y) => x - y);
  }

  /** Unwrapped size of a set of meshes (same unwrap as the mapping): { length, height, kind } or null. */
  unwrapInfo(modelId, indices, opts = {}) {
    const me = this.models.get(modelId);
    if (!me || !me.meshes) return null;
    const meshes = indices.map((i) => me.meshes[i]).filter(Boolean);
    if (!meshes.length) return null;
    me.holder.updateMatrixWorld(true);
    const { geometry, info } = buildMappedGeometry(meshes, { ...opts, range: null });
    geometry.dispose();
    return info;
  }

  /** Next click on a model mesh calls cb({ model, index, name }) (null on cancel). */
  startMeshPick(cb) { this.meshPick = cb; this.canvas.style.cursor = 'crosshair'; }
  cancelMeshPick() { if (this.meshPick) { const cb = this.meshPick; this.meshPick = null; this.canvas.style.cursor = ''; cb(null); } }
  pickMesh(e) {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const list = [];
    for (const me of this.models.values()) if (me.holder.visible) for (const m of me.meshes || []) list.push(m);
    const hit = this.ray.intersectObjects(list, false)[0];
    return hit ? { model: hit.object.userData.mid, index: hit.object.userData.mindex, name: hit.object.name || (hit.object.parent && hit.object.parent.name) || '' } : null;
  }

  /** Dashed path of every rail on the floor; highlighted when one of its screens is selected. */
  syncRails(p) {
    if (!this.railRoot) { this.railRoot = new THREE.Group(); this.scene.add(this.railRoot); this.railLines = new Map(); }
    const sel = this.h.getSelection();
    const active = new Set(p.surfaces.filter((s) => sel.has(s.id) && s.stage.rail).map((s) => s.stage.rail));
    const seen = new Set();
    for (const r of p.stage.rails || []) {
      seen.add(r.id);
      let e = this.railLines.get(r.id);
      const key = JSON.stringify([r.segs, r.closed, r.h0]);
      if (!e) { e = { line: new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x8fb8ff, dashSize: 0.25, gapSize: 0.15, transparent: true })) }; this.railRoot.add(e.line); this.railLines.set(r.id, e); }
      if (e.key !== key) {
        e.key = key;
        const rb = M.railBuild(r);
        const n = Math.max(2, Math.ceil(rb.len / 0.1));
        const pts = [];
        for (let i = 0; i <= n; i++) { const q = rb.at(rb.len * i / n); pts.push(q.x, 0.02, q.z); }
        e.line.geometry.dispose();
        e.line.geometry = new THREE.BufferGeometry(); e.line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        e.line.computeLineDistances();
      }
      e.line.position.set(r.x, 0, r.z); e.line.rotation.set(0, (r.ry || 0) * D2R, 0);
      e.line.material.opacity = active.has(r.id) ? 1 : 0.35;
    }
    for (const [id, e] of this.railLines) if (!seen.has(id)) { this.railRoot.remove(e.line); this.railLines.delete(id); }
  }

  rebuildGeometry(e, p, s, rail = null) {
    e.geoY = rail ? (+s.stage.y || 0) : 0;
    const g = rail ? railGeometry(p, s, rail) : screenGeometry(p, s);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setIndex(g.index);
    geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
    e.front.geometry.dispose(); e.back.geometry.dispose();
    e.front.geometry = geo;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(g.shell, 3));
    sg.setIndex(g.shellIdx); sg.computeVertexNormals();
    e.back.geometry = sg;
    const og = new THREE.BufferGeometry(); og.setAttribute('position', new THREE.Float32BufferAttribute(g.outline, 3));
    e.outline.geometry.dispose(); e.outline.geometry = og;
    e.meters = g.meters;
  }

  /** Copy the 2D pixelmap (bitmap + label / logo / animation) into each screen texture. */
  updateTextures(force) {
    const p = this.h.getProject();
    const R = this.h.renderer;
    const animOn = p.style.anim && p.style.anim.enabled;
    const t = Date.now() / 1000 % 86400;
    for (const s of p.surfaces) {
      const e = this.screens.get(s.id);
      if (!e || s.visible === false) continue;
      const bm = R.surfaceBitmap(p, s);
      const st = M.effStyle(p, s);
      const decoKey = bm.key + '|' + R.logoVer + '|' + JSON.stringify([st.labelShape, st.showName, st.showSize, st.sizeFormat, st.showPhysical, st.labelPerSlice, st.labelScale, st.labelMax, st.fontFamily, st.textColor, st.textStroke, st.shapeFill, st.shapeOpacity, st.pillColor, st.logoSlots, st.textSlots, p.name, s.group, (p.logos || []).map((l) => l.id), st.anim && st.anim.enabled]);
      const animated = animOn && st.anim && st.anim.enabled;
      // live video source: a device feeding the whole composition (each screen shows its Input Selection) or one screen directly
      const vcfg = p.stage.video || {};
      const live = liveSourceOf(p, s);
      if (live && (live.key.startsWith('ndi:') || !vcfg.overlay)) { e.key = null; continue; }   // GPU path (updateLive): no CPU copy
      let video = null, vmode = null;
      if (live && this.h.getVideo) { video = this.h.getVideo(live.key.slice(4)); vmode = live.mode; }
      if (!video && !force && !animated && decoKey === e.key) continue;
      e.key = video ? null : decoKey;
      const c = e.texCanvas;
      if (c.width !== bm.canvas.width || c.height !== bm.canvas.height) { c.width = bm.canvas.width; c.height = bm.canvas.height; e.tex.dispose(); }
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (video) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.setTransform(bm.k, 0, 0, bm.k, 0, 0);
        if (vmode === 'full') ctx.drawImage(video, 0, 0, s.w, s.h);
        else {
          // composition px -> this surface (inverse of its placement in the comp: rotation / mirror)
          const r = ((s.comp.rot % 360) + 360) % 360, swap = r === 90 || r === 270;
          const bw = swap ? s.h : s.w, bh = swap ? s.w : s.h;
          ctx.translate(s.w / 2, s.h / 2);
          if (s.comp.flip) ctx.scale(-1, 1);
          ctx.rotate(-r * Math.PI / 180);
          ctx.translate(-(s.comp.x + bw / 2), -(s.comp.y + bh / 2));
          ctx.drawImage(video, 0, 0, p.composition.w, p.composition.h);
        }
        if (vcfg.overlay) { ctx.setTransform(bm.k, 0, 0, bm.k, 0, 0); R.decorate(ctx, s, { ...st, anim: { ...st.anim, enabled: false } }, { x: 0, y: 0, w: s.w, h: s.h }, t, p); }
      } else {
        ctx.drawImage(bm.canvas, 0, 0);
        ctx.setTransform(bm.k, 0, 0, bm.k, 0, 0);
        R.decorate(ctx, s, st, { x: 0, y: 0, w: s.w, h: s.h }, t, p);
      }
      e.tex.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ live sources on the GPU (NDI frames / capture devices)
  // One texture per source (uploaded once per frame), each screen samples it through its own UV matrix
  // (its Input Selection in the composition, or the full frame) — no canvas copies, minimum latency.
  updateLive(p) {
    if (!this.live) this.live = new Map();   // key -> { tex, seq, w, h, flip, frame }
    const vcfg = p.stage.video || {};
    const need = new Map();
    for (const s of p.surfaces) { const l = liveSourceOf(p, s); if (l && (l.key.startsWith('ndi:') || !vcfg.overlay)) need.set(s.id, l); }
    const keys = new Set([...need.values()].map((l) => l.key));
    if (this.h.ndiKeep) this.h.ndiKeep([...keys].filter((k) => k.startsWith('ndi:')).map((k) => k.slice(4)));
    // masters
    for (const key of keys) {
      let m = this.live.get(key);
      if (key.startsWith('ndi:')) {
        const f = this.h.getNdiFrame ? this.h.getNdiFrame(key.slice(4), m ? m.seq : -1) : null;
        if (f) {
          if (!m || m.w !== f.w || m.h !== f.h) {
            if (m) m.tex.dispose();
            const tex = new THREE.DataTexture(f.data, f.w, f.h, THREE.RGBAFormat, THREE.UnsignedByteType);
            tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
            m = { tex, seq: f.seq, w: f.w, h: f.h, flip: false, gen: (m ? m.gen : 0) + 1 };
            this.live.set(key, m);
          } else { m.tex.image.data = f.data; m.seq = f.seq; }
          m.frame = f;
          m.tex.needsUpdate = true;
          m.fresh = true;             // the per-screen clones must be flagged too (three.js uploads per texture version)
        }
      } else if (!m && this.h.getVideo) {
        const v = this.h.getVideo(key.slice(4));
        if (v && v.videoWidth) {
          const tex = new THREE.VideoTexture(v); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false;
          m = { tex, seq: 0, w: v.videoWidth, h: v.videoHeight, flip: true, video: v, gen: 1 };
          this.live.set(key, m);
        }
      }
    }
    for (const [key, m] of this.live) if (!keys.has(key)) { m.tex.dispose(); this.live.delete(key); }
    // screens
    for (const s of p.surfaces) {
      const e = this.screens.get(s.id);
      if (!e) continue;
      const l = need.get(s.id);
      const m = l ? this.live.get(l.key) : null;
      const mat = e.front.material;
      if (mat.userData.receiver) { e.liveM = null; continue; }
      if (!m) {
        if (mat.map !== e.tex) { mat.map = e.tex; mat.needsUpdate = true; }
        e.liveM = null;
        continue;
      }
      const sig = [l.key, l.mode, m.gen, s.w, s.h, s.comp.x, s.comp.y, s.comp.rot, s.comp.flip, p.composition.w, p.composition.h].join('|');
      if (e.liveSig !== sig || !e.liveTex) {
        e.liveSig = sig;
        if (e.liveTex) e.liveTex.dispose();
        e.liveTex = m.tex.clone();            // shares the master's image source: one upload per frame
        e.liveTex.matrixAutoUpdate = false;
        e.liveTex.matrix.copy(liveUvMatrix(p, s, l.mode, m.flip));
      }
      e.liveM = m; e.liveMode = l.mode;
      if (m.fresh) e.liveTex.needsUpdate = true;   // shared source: uploaded once, the other clones reuse it
      if (mat.map !== e.liveTex) { mat.map = e.liveTex; mat.needsUpdate = true; }
    }
    for (const m of this.live.values()) m.fresh = false;
  }

  /** Average colour of what a screen shows from its live source (for the light spill). */
  liveColor(p, s, e) {
    const m = e.liveM;
    if (!m) return null;
    const M3 = liveUvMatrix(p, s, e.liveMode, m.flip).elements;
    const pts = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 5; i++) pts.push([(i + 0.5) / 5, (j + 0.5) / 3]);
    let R = 0, G = 0, B = 0, n = 0;
    if (m.frame) {
      const d = m.frame.data, W = m.w, H = m.h;
      for (const [u, v] of pts) {
        const sx = M3[0] * u + M3[3] * v + M3[6], ty = M3[1] * u + M3[4] * v + M3[7];
        const x = Math.min(W - 1, Math.max(0, Math.floor(sx * W))), y = Math.min(H - 1, Math.max(0, Math.floor(ty * H)));
        const k = (y * W + x) * 4; R += d[k]; G += d[k + 1]; B += d[k + 2]; n++;
      }
    } else if (m.video) {
      if (!this.lsc) { this.lsc = document.createElement('canvas'); this.lsc.width = 16; this.lsc.height = 9; this.lctx = this.lsc.getContext('2d', { willReadFrequently: true }); }
      this.lctx.drawImage(m.video, 0, 0, 16, 9);
      const d = this.lctx.getImageData(0, 0, 16, 9).data;
      for (const [u, v] of pts) {
        const sx = M3[0] * u + M3[3] * v + M3[6], ty = M3[1] * u + M3[4] * v + M3[7];
        const x = Math.min(15, Math.max(0, Math.floor(sx * 16))), y = Math.min(8, Math.max(0, Math.floor((1 - ty) * 9)));
        const k = (y * 16 + x) * 4; R += d[k]; G += d[k + 1]; B += d[k + 2]; n++;
      }
    }
    return n ? [R / n / 255, G / n / 255, B / n / 255] : null;
  }

  // ------------------------------------------------------------------ 3D models (décor / salle)
  syncModels(p) {
    const seen = new Set();
    for (const md of p.stage.models) {
      seen.add(md.id);
      let e = this.models.get(md.id);
      const dataKey = md.kind + ':' + (md.data ? md.data.length + md.data.slice(0, 64) + md.data.slice(-64) : '');
      if (!e) { e = { holder: new THREE.Group(), obj: null, dataKey: null }; e.holder.userData.mid = md.id; this.modelRoot.add(e.holder); this.models.set(md.id, e); }
      if (e.dataKey !== dataKey) { e.dataKey = dataKey; this.loadModel(e, md); }
      const k = (md.scale || 1) * (M.UNIT_SCALE[md.unit] || 1);
      e.holder.position.set(md.x, md.y, md.z);
      e.holder.rotation.set(md.rx * D2R, md.ry * D2R, md.rz * D2R, EULER);
      e.holder.scale.setScalar(k);
      e.holder.visible = md.visible !== false;
      const look = JSON.stringify([md.opacity, md.color, !!md.receive]);
      if (e.obj && e.look !== look) { e.look = look; this.applyLook(e.obj, md); }
      e.receive = !!md.receive;
    }
    for (const [id, e] of this.models) if (!seen.has(id)) { this.modelRoot.remove(e.holder); this.models.delete(id); }
  }

  loadModel(e, md) {
    e.holder.clear(); e.obj = null; e.look = null;
    if (!md.data) return;
    const done = (obj) => {
      if (!this.models.has(md.id) || this.models.get(md.id) !== e) return;
      e.obj = obj; e.holder.add(obj);
      e.meshes = []; obj.traverse((o) => { if (o.isMesh) { o.userData.mid = md.id; o.userData.mindex = e.meshes.length; e.meshes.push(o); } });
      this.mapDirty = true; if (this.projLayer) this.projLayer.dirty = true;
      const cur = this.h.getProject().stage.models.find((x) => x.id === md.id) || md;
      e.look = JSON.stringify([cur.opacity, cur.color, !!cur.receive]); this.applyLook(obj, cur); e.receive = !!cur.receive;
      if (this.h.onModelLoaded) this.h.onModelLoaded(md.id, new THREE.Box3().setFromObject(obj));
      if (this.active) this.sync();
    };
    const fail = (err) => { console.warn('model load', err); if (this.h.onModelError) this.h.onModelError(md, err); };
    // native base64 decoding (fast for big models), then parse
    fetch('data:application/octet-stream;base64,' + md.data).then((r) => r.arrayBuffer()).then((buf) => {
      if (!this.models.has(md.id) || this.models.get(md.id) !== e) return;
      try {
        if (md.kind === 'obj') done(new OBJLoader().parse(new TextDecoder().decode(buf)));   // projects ≤ 1.13 (OBJ text stored as is)
        else new GLTFLoader().parse(buf, '', (gl) => done(gl.scene), fail);
      } catch (err) { fail(err); }
    }).catch(fail);
  }

  applyLook(obj, md) {
    const op = Math.max(0.05, Math.min(1, md.opacity ?? 1));
    obj.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.origMat) o.userData.origMat = o.material;
      const base = Array.isArray(o.userData.origMat) ? o.userData.origMat : [o.userData.origMat];
      if (Array.isArray(o.userData.lookMats)) o.userData.lookMats.forEach((m) => this.projLayer.dropMaterial(m));
      const mats = base.map((m0) => {
        if (md.receive) {
          // receives projection: its own colour (or the model's) lit by the projectors
          const c = md.color || (m0.color ? '#' + m0.color.getHexString() : '#d0d0d0');
          return this.projLayer.receiverMaterial({ color: c, gain: 1, opacity: op });
        }
        const m = md.color ? new THREE.MeshStandardMaterial({ color: md.color, roughness: 0.85 }) : m0.clone();
        m.transparent = op < 1; m.opacity = op; m.depthWrite = op >= 1; m.side = THREE.DoubleSide;
        return m;
      });
      o.userData.lookMats = mats;
      o.material = Array.isArray(o.userData.origMat) ? mats : mats[0];
    });
  }

  // ------------------------------------------------------------------ selection + gizmo
  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const meshes = [];
    for (const s of this.screens.values()) { if (s.group.visible) meshes.push(s.front, s.back); if (s.mapped && s.mapped.visible) meshes.push(s.mapped); }
    const hit = this.ray.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.sid : null;
  }
  gizmoAxisHover() { return this.gizmo.axis !== null && this.gizmo.object; }

  selectedIds() {
    const p = this.h.getProject();
    const sel = this.h.getSelection();
    const list = p.surfaces.filter((s) => sel.has(s.id) && s.visible !== false && !s.locked && !s.stage.mesh);
    // mixed selection: free screens only (rail screens move with their rail)
    const rails = new Set(list.map((s) => s.stage.rail || ''));
    return (rails.size > 1 ? list.filter((s) => !s.stage.rail) : list).map((s) => s.id);
  }

  /** Selection all on one rail -> the gizmo moves / turns the rail (plan) and the screens' height. */
  railOfSelection() {
    const p = this.h.getProject();
    const ids = this.selectedIds();
    if (!ids.length) return null;
    const rails = new Set(ids.map((id) => M.getSurface(p, id).stage.rail || ''));
    if (rails.size !== 1) return null;
    const rid = [...rails][0];
    return rid ? (p.stage.rails || []).find((r) => r.id === rid) || null : null;
  }

  syncSelection() {
    const psSel = this.h.getPersonSel ? this.h.getPersonSel() : null;
    for (const [id, e] of this.people) e.outline.visible = !this.presentation && id === psSel;
    const pse = psSel ? this.people.get(psSel) : null;
    if (pse && !this.presentation && this.tool !== 'none' && !this.pov) {
      this.projLayer.setSelected(null, this.presentation);
      for (const e of this.screens.values()) { e.outline.visible = false; if (e.mappedBox) e.mappedBox.visible = false; }
      if (this.gizmo.dragging) return;
      this.gizmo.showX = this.gizmo.showZ = this.tool !== 'rotate'; this.gizmo.showY = true;
      this.pivot.position.copy(pse.mesh.position); this.pivot.rotation.set(0, pse.mesh.rotation.y, 0); this.pivot.updateMatrixWorld();
      this.gizmo.attach(this.pivot); this.gizmo.setMode(this.tool); this.gizmo.setSpace('world'); this.applySnap();
      return;
    }
    this.gizmo.showY = true;
    const pjSel = this.h.getProjSel ? this.h.getProjSel() : null;
    this.projLayer.setSelected(pjSel, this.presentation);
    const pje = pjSel ? this.projLayer.items.get(pjSel) : null;
    if (pje && !this.presentation && this.tool !== 'none') {
      for (const e of this.screens.values()) { e.outline.visible = false; if (e.mappedBox) e.mappedBox.visible = false; }
      if (this.gizmo.dragging) return;
      this.gizmo.showX = this.gizmo.showZ = true;
      pje.group.updateMatrixWorld(true);
      this.pivot.position.copy(pje.group.position); this.pivot.rotation.copy(pje.group.rotation); this.pivot.updateMatrixWorld();
      this.gizmo.attach(this.pivot); this.gizmo.setMode(this.tool); this.gizmo.setSpace(this.tool === 'rotate' ? 'local' : 'world'); this.applySnap();
      return;
    }
    const sel = this.h.getSelection();
    for (const [id, e] of this.screens) { e.outline.visible = !this.presentation && sel.has(id); if (e.mappedBox) e.mappedBox.visible = !this.presentation && sel.has(id) && !!e.mapped && e.mapped.visible; }
    if (this.presentation) { this.gizmo.detach(); return; }
    const ids = this.selectedIds().filter((id) => this.screens.has(id));   // screens not built yet (first opening)
    if (!ids.length || this.tool === 'none') { this.gizmo.detach(); return; }
    if (this.gizmo.dragging) return;
    const rail = this.railOfSelection();
    this.gizmo.showX = this.gizmo.showZ = !(rail && this.tool === 'rotate');
    if (rail) {
      const p = this.h.getProject();
      const ys = ids.map((id) => M.getSurface(p, id).stage.y || 0);
      this.pivot.position.set(rail.x, ys.reduce((a, b) => a + b, 0) / ys.length, rail.z);
      this.pivot.rotation.set(0, (rail.ry || 0) * D2R, 0);
      this.pivot.updateMatrixWorld();
      this.gizmo.attach(this.pivot); this.gizmo.setMode(this.tool); this.gizmo.setSpace('world'); this.applySnap();
      return;
    }
    // pivot at the centre of the selection, oriented like the screen when only one
    const box = new THREE.Box3();
    for (const id of ids) box.expandByObject(this.screens.get(id).group);
    const c = ids.length === 1 ? this.screens.get(ids[0]).group.position.clone() : box.getCenter(new THREE.Vector3());
    this.pivot.position.copy(c);
    this.pivot.rotation.copy(ids.length === 1 ? this.screens.get(ids[0]).group.rotation : new THREE.Euler());
    this.pivot.updateMatrixWorld();
    this.gizmo.attach(this.pivot);
    this.gizmo.setMode(this.tool);
    this.gizmo.setSpace(this.tool === 'rotate' && ids.length === 1 ? 'local' : 'world');
    this.applySnap();
  }

  setTool(tool) { this.tool = tool; this.syncSelection(); }
  setSnap(on) { this.snap = on; this.applySnap(); }
  applySnap() {
    this.gizmo.setTranslationSnap(this.snap ? 0.05 : null);
    this.gizmo.setRotationSnap(this.snap ? 5 * D2R : null);
  }

  beginGizmo() {
    this.pivot.updateMatrixWorld();
    const psSel = this.h.getPersonSel ? this.h.getPersonSel() : null;
    if (psSel && this.people.has(psSel)) { this.ps0 = { id: psSel, inv: this.pivot.matrixWorld.clone().invert(), m: this.people.get(psSel).mesh.matrixWorld.clone() }; this.pj0 = null; this.r0 = null; this.g0 = null; return; }
    this.ps0 = null;
    const pjSel = this.h.getProjSel ? this.h.getProjSel() : null;
    const pje = pjSel ? this.projLayer.items.get(pjSel) : null;
    if (pje) { pje.group.updateMatrixWorld(true); this.pj0 = { id: pjSel, inv: this.pivot.matrixWorld.clone().invert(), m: pje.group.matrixWorld.clone() }; this.r0 = null; this.g0 = null; return; }
    this.pj0 = null;
    const rail = this.railOfSelection();
    if (rail) {
      const p = this.h.getProject();
      this.r0 = { id: rail.id, y0: this.pivot.position.y, ys: this.selectedIds().map((id) => [id, M.getSurface(p, id).stage.y || 0]) };
      this.g0 = null; return;
    }
    this.r0 = null;
    this.g0 = { inv: this.pivot.matrixWorld.clone().invert(), items: this.selectedIds().map((id) => ({ id, m: this.screens.get(id).group.matrixWorld.clone() })) };
  }
  applyGizmo() {
    if (this.ps0) {
      this.pivot.updateMatrixWorld();
      const m = this.pivot.matrixWorld.clone().multiply(this.ps0.inv).multiply(this.ps0.m);
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.decompose(pos, q, sc);
      const eu = new THREE.Euler().setFromQuaternion(q, EULER);
      const rm = (v) => Math.round(v * 1000) / 1000, id = this.ps0.id;
      this.h.edit('ps-gizmo', (pp) => { const x = (pp.stage.people || []).find((y) => y.id === id); if (x) Object.assign(x, { x: rm(pos.x), y: rm(Math.max(0, pos.y)), z: rm(pos.z), ry: Math.round(eu.y / D2R * 100) / 100 }); }, true);
      return;
    }
    if (this.pj0) {
      this.pivot.updateMatrixWorld();
      const m = this.pivot.matrixWorld.clone().multiply(this.pj0.inv).multiply(this.pj0.m);
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.decompose(pos, q, sc);
      const eu = new THREE.Euler().setFromQuaternion(q, EULER);
      const rd = (v) => Math.round(v / D2R * 100) / 100, rm = (v) => Math.round(v * 1000) / 1000;
      const id = this.pj0.id;
      this.h.edit('proj-gizmo', (pp) => { const pj = (pp.projectors || []).find((x) => x.id === id); if (pj) Object.assign(pj, { x: rm(pos.x), y: rm(pos.y), z: rm(pos.z), rx: rd(eu.x), ry: rd(eu.y), rz: rd(eu.z) }); }, true);
      return;
    }
    if (this.r0) {
      const r0 = this.r0, pv = this.pivot;
      const eu = new THREE.Euler().setFromQuaternion(pv.quaternion, EULER);
      const rm = (v) => Math.round(v * 1000) / 1000;
      const dy = pv.position.y - r0.y0;
      this.h.edit('stage-rail-gizmo', (pp) => {
        const r = pp.stage.rails.find((x) => x.id === r0.id); if (!r) return;
        r.x = rm(pv.position.x); r.z = rm(pv.position.z); r.ry = Math.round(eu.y / D2R * 100) / 100;
        for (const [id, y] of r0.ys) { const s = M.getSurface(pp, id); if (s) s.stage.y = rm(y + dy); }
      }, true);
      return;
    }
    if (!this.g0) return;
    this.pivot.updateMatrixWorld();
    const delta = this.pivot.matrixWorld.clone().multiply(this.g0.inv);
    const res = this.g0.items.map((it) => {
      const m = delta.clone().multiply(it.m);
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.decompose(pos, q, sc);
      const eu = new THREE.Euler().setFromQuaternion(q, EULER);
      const rd = (v) => Math.round(v / D2R * 100) / 100;
      const rm = (v) => Math.round(v * 1000) / 1000;
      return { id: it.id, x: rm(pos.x), y: rm(pos.y), z: rm(pos.z), rx: rd(eu.x), ry: rd(eu.y), rz: rd(eu.z) };
    });
    this.h.edit('stage-gizmo', (pp) => { for (const { id, ...v } of res) { const s = M.getSurface(pp, id); if (s) Object.assign(s.stage, v, { placed: true }); } }, true);
  }
  endGizmo() { this.g0 = null; this.r0 = null; this.pj0 = null; this.ps0 = null; this.h.commit(); }

  /** Vertical offset that puts the lowest point of a screen on the floor (Y = 0). */
  floorDelta(id) {
    const e = this.screens.get(id);
    if (!e) return null;
    e.group.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(e.front);
    return b.isEmpty() ? null : -b.min.y;
  }

  // ------------------------------------------------------------------ cameras
  screensBox(ids = null) {
    const b = new THREE.Box3();
    for (const [id, e] of this.screens) if (!ids || ids.includes(id)) { if (e.group.visible) b.expandByObject(e.group); if (e.mapped && e.mapped.visible) b.expandByObject(e.mapped); }
    return b;
  }

  /** Orthographic plan views, square to the stage axes. Audience is +Z: « face » looks from the audience, « droite » from +X. */
  orthoView(name, b = null) {
    b = b || this.screensBox();
    if (b.isEmpty()) b = new THREE.Box3(new THREE.Vector3(-3, 0, -0.5), new THREE.Vector3(3, 3, 0.5));
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    const a = this.aspect || 1, m = 1.15;
    const D = Math.max(60, size.length() * 2 + 20);
    const fitH = (wv, hv) => Math.max(hv, wv / a) / 2 * m + 0.05;
    switch (name) {
      case 'top': return { pos: [c.x, c.y + D, c.z + 1e-4], target: [c.x, c.y, c.z], ortho: true, oh: fitH(size.x, size.z) };
      case 'back': return { pos: [c.x, c.y, c.z - D], target: [c.x, c.y, c.z], ortho: true, oh: fitH(size.x, size.y) };
      case 'left': return { pos: [c.x - D, c.y, c.z], target: [c.x, c.y, c.z], ortho: true, oh: fitH(size.z, size.y) };
      case 'right': case 'side': return { pos: [c.x + D, c.y, c.z], target: [c.x, c.y, c.z], ortho: true, oh: fitH(size.z, size.y) };
      case 'front': case 'foh': return { pos: [c.x, c.y, c.z + D], target: [c.x, c.y, c.z], ortho: true, oh: fitH(size.x, size.y) };
      default: {             // axonometric: the perspective viewpoint, without perspective
        const v = this.presetView('persp', true);
        const dir = new THREE.Vector3(...v.pos).sub(c).normalize();
        return { pos: c.clone().addScaledVector(dir, D).toArray(), target: c.toArray(), ortho: true, oh: size.length() / 2 * 0.85 + 0.2 };
      }
    }
  }

  presetView(name, forcePersp = false) {
    if (this.isOrtho && !forcePersp) return this.orthoView(name);
    let b = this.screensBox();
    if (b.isEmpty()) b = new THREE.Box3(new THREE.Vector3(-3, 0, -0.5), new THREE.Vector3(3, 3, 0.5));
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    const fov = this.persp.fov * D2R;
    const fit = Math.max(size.y, size.x / this.aspect) / 2 / Math.tan(fov / 2) * 1.25 + size.z / 2;
    const front = b.max.z;
    switch (name) {
      case 'front': return { pos: [c.x, 1.7, front + Math.max(fit, 4)], target: [c.x, c.y, c.z] };
      case 'foh': { const d = Math.max(22, fit * 1.4); return { pos: [c.x, 3.2, front + d], target: [c.x, c.y, c.z] }; }
      case 'top': return { pos: [c.x, c.y + Math.max(fit * 1.3, size.z + 8), c.z + 0.01], target: [c.x, 0, c.z] };
      case 'side': case 'right': return { pos: [b.max.x + Math.max(fit, size.z * 2, 6), Math.max(c.y, 1.7), c.z + 2], target: [c.x, c.y, c.z] };
      case 'left': return { pos: [b.min.x - Math.max(fit, size.z * 2, 6), Math.max(c.y, 1.7), c.z + 2], target: [c.x, c.y, c.z] };
      case 'back': return { pos: [c.x, Math.max(c.y, 1.7), b.min.z - Math.max(fit, 4)], target: [c.x, c.y, c.z] };
      default: return { pos: [c.x + fit * 0.75, c.y + fit * 0.45, front + fit * 0.9], target: [c.x, c.y, c.z] };
    }
  }

  /** opts (recording / camera direction): { arc: orbit-like path, ease: 'smooth'|'linear'|undefined } — the fov is tweened too. */
  goView(nameOrView, animate = true, dur = null, opts = null) {
    const v = typeof nameOrView === 'string' ? this.presetView(nameOrView) : nameOrView;
    const f0 = this.persp.fov;
    if (v.fov && !(opts && animate && dur > 0)) { this.persp.fov = v.fov; this.persp.updateProjectionMatrix(); }
    // a saved / streamed view carries its projection (older views: perspective)
    const wantOrtho = typeof nameOrView === 'string' ? this.isOrtho : !!v.ortho;
    if (wantOrtho !== this.isOrtho) { this.setOrtho(wantOrtho); animate = false; }
    if (this.isOrtho && v.oh > 0) { this.orthoH = v.oh; this.ortho.zoom = 1; this.updateOrtho(); }
    const p1 = new THREE.Vector3(...v.pos), t1 = new THREE.Vector3(...v.target);
    const d = dur ?? this.transitionMs ?? 450;
    if (!animate || d <= 0) { this.camera.position.copy(p1); this.orbit.target.copy(t1); this.anim = null; this.orbit.update(); return; }
    const A = { t0: performance.now(), dur: d, p0: this.camera.position.clone(), p1, t0v: this.orbit.target.clone(), t1 };
    if (opts) {
      A.ease = opts.ease || 'smooth';
      if (v.fov && !this.isOrtho) { A.f0 = f0; A.f1 = v.fov; }
      if (opts.arc && !this.isOrtho) {
        const o0 = A.p0.clone().sub(A.t0v), o1 = p1.clone().sub(t1);
        const r0 = o0.length(), r1 = o1.length();
        if (r0 > 1e-3 && r1 > 1e-3) {
          const sph = (o, r) => [Math.atan2(o.x, o.z), Math.acos(Math.max(-1, Math.min(1, o.y / r)))];
          const [th0, ph0] = sph(o0, r0), [th1, ph1] = sph(o1, r1);
          let dth = th1 - th0; while (dth > Math.PI) dth -= 2 * Math.PI; while (dth < -Math.PI) dth += 2 * Math.PI;
          Object.assign(A, { arc: true, r0, r1, th0, dth, ph0, ph1 });
        }
      }
    }
    this.anim = A;
  }
  /** True while a camera transition runs. */
  get camMoving() { return !!this.anim; }

  /** Presentation (studio / fullscreen / 3D output): no gizmo, no selection outlines, no rail paths. */
  setPresentation(on) {
    this.presentation = !!on;
    this.gizmoHelper.visible = !on;
    if (this.railRoot) this.railRoot.visible = !on;
    this.projLayer.setPresentation(on);
    if (this.povEl) this.povEl.classList.toggle('pres', !!on);
    for (const e of this.screens.values()) { if (on) { e.outline.visible = false; if (e.mappedBox) e.mappedBox.visible = false; } }
    if (!on) this.syncSelection();
  }

  currentView() {
    const r = (v) => Math.round(v * 1000) / 1000;
    const v = { pos: this.camera.position.toArray().map(r), target: this.orbit.target.toArray().map(r), fov: this.persp.fov };
    if (this.isOrtho) { v.ortho = true; v.oh = r(this.orthoH / (this.ortho.zoom || 1)); }
    return v;
  }

  frame(ids) {
    const b = this.screensBox(ids && ids.length ? ids : null);
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()).length();
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    if (this.isOrtho) { this.goView({ pos: c.clone().addScaledVector(dir, Math.max(60, size * 2 + 20)).toArray(), target: c.toArray(), ortho: true, oh: size / 2 * 0.95 + 0.1 }); return; }
    const d = size / 2 / Math.tan(this.persp.fov * D2R / 2) * 1.2 + 0.5;
    this.goView({ pos: c.clone().add(dir.multiplyScalar(d)).toArray(), target: c.toArray() });
  }

  screenshot(scale = 2) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const pr = this.renderer3.getPixelRatio();
    this.renderer3.setPixelRatio(scale);
    this.renderer3.setSize(w, h, false);
    this.fx.resize(w, h, scale);
    const helper = this.gizmoHelper.visible; this.gizmoHelper.visible = false;
    const outl = [...this.screens.values()].map((e) => e.outline.visible);
    for (const e of this.screens.values()) e.outline.visible = false;
    this.updateTextures(true);
    this.fx.updateSpill(this.h.getProject(), performance.now(), true);
    this.fx.render(performance.now());
    const url = this.canvas.toDataURL('image/png');
    this.gizmoHelper.visible = helper;
    [...this.screens.values()].forEach((e, i) => { e.outline.visible = outl[i]; });
    this.renderer3.setPixelRatio(pr); this.resize();
    return url;
  }
}
