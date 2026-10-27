// Pixel2Pixel — video projectors in the 3D view (Pixera-like mapping previz).
// Each projector draws its body + frustum and projects its output (the real pixelmap, soft edges applied) onto every
// receiving surface: projection screens and the 3D models flagged "receives projection". One shader, shared uniforms.
// Brightness is physical: illuminance E = lm · tr² · aspect / z² (· incidence), luminance = E · gain / π, displayed
// against an exposure reference (cd/m²). No occlusion yet: a projector also lights what is hidden behind an object.
import * as THREE from '../vendor/three/three.module.js';
import * as M from './model.js';
import * as P from './projectors.js';

const D2R = Math.PI / 180;
const EULER = 'YXZ';
export const MAX_PROJ = 8;
const NEAR = 0.3, FAR = 300;                           // projector camera range (shadow depth precision)
const REF_NITS = 300;

function receiverShader() {
  const adds = Array.from({ length: MAX_PROJ }, (_, i) => `  addP(${i}, pTex${i}, pDep${i}, N, acc, lux, cnt);`).join('\n');
  const samplers = Array.from({ length: MAX_PROJ }, (_, i) => `uniform sampler2D pTex${i}; uniform sampler2D pDep${i};`).join('\n');
  return {
    vertexShader: `
varying vec3 vW; varying vec3 vN;
void main() {
  vec4 lp = vec4(position, 1.0); vec3 ln = normal;
#ifdef USE_INSTANCING
  lp = instanceMatrix * lp; ln = mat3(instanceMatrix) * ln;
#endif
  vec4 w = modelMatrix * lp;
  vW = w.xyz; vN = normalize(mat3(modelMatrix) * ln);
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
    fragmentShader: `
uniform int nP;
uniform mat4 pM[${MAX_PROJ}];
uniform vec3 pPos[${MAX_PROJ}];
uniform vec3 pFwd[${MAX_PROJ}];
uniform float pK[${MAX_PROJ}];
uniform float pSh[${MAX_PROJ}];
uniform vec2 pNF;
${samplers}
uniform vec3 base; uniform float amb; uniform float gain; uniform float refNits; uniform int mode; uniform float opacity; uniform float transmit; uniform float selfAmb;
varying vec3 vW; varying vec3 vN;
vec3 heat(float x) { x = clamp(x, 0.0, 1.0); return clamp(vec3(1.5 - abs(4.0 * x - 3.0), 1.5 - abs(4.0 * x - 2.0), 1.5 - abs(4.0 * x - 1.0)), 0.0, 1.0); }
float linZ(float d) { float n = pNF.x, f = pNF.y; return 2.0 * n * f / (f + n - (2.0 * d - 1.0) * (f - n)); }
void addP(int i, sampler2D tx, sampler2D dx, vec3 N, inout vec3 acc, inout float lux, inout float cnt) {
  if (i >= nP) return;
  vec4 c = pM[i] * vec4(vW, 1.0);
  if (c.w <= 0.0) return;
  vec2 nd = c.xy / c.w;
  if (abs(nd.x) > 1.0 || abs(nd.y) > 1.0) return;
  if (pSh[i] > 0.5) {                                   // occlusion: something nearer to the projector on this ray
    float lf = linZ(c.z / c.w * 0.5 + 0.5), ls = linZ(texture(dx, nd * 0.5 + 0.5).r);
    if (lf > ls + 0.03 + 0.006 * lf) return;
  }
  vec3 L = pPos[i] - vW; float d = length(L); L /= d;
  float cosI = dot(N, L);
  if (transmit > 0.5) cosI = abs(cosI);             // rear-projection screen: lit from either side
  if (cosI <= 0.0) return;
  float z = dot(vW - pPos[i], pFwd[i]);
  if (z <= 0.01) return;
  float E = pK[i] / (z * z) * cosI / max(z / d, 0.2);
  vec4 t = texture(tx, nd * 0.5 + 0.5);          // alpha = soft-edge factor (linear light), 0 outside the slices
  acc += t.rgb * t.a * E; lux += E * t.a; cnt += step(0.02, t.a);
}
void main() {
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 acc = vec3(0.0); float lux = 0.0; float cnt = 0.0;
${adds}
  float k = gain / 3.14159265 / refNits;
  vec3 col;
  if (mode == 1) col = cnt > 0.0 ? heat(lux * k * 0.5) : base * (amb + selfAmb);
  else if (mode == 2) col = cnt < 0.5 ? base * amb : (cnt < 1.5 ? vec3(0.18, 0.75, 0.42) : (cnt < 2.5 ? vec3(0.95, 0.78, 0.2) : vec3(0.95, 0.3, 0.25)));
  else col = base * (amb + selfAmb * (0.55 + 0.45 * max(dot(N, normalize(vec3(0.35, 0.8, 0.5))), 0.0)) + acc * k);   // people keep a soft key light
  gl_FragColor = vec4(col, opacity);
  #include <colorspace_fragment>
}`
  };
}

export class ProjectorLayer {
  constructor(stage) {
    this.s = stage;
    this.root = new THREE.Group(); this.root.name = 'projectors';
    stage.scene.add(this.root);
    this.items = new Map();          // id -> entry
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.blank.needsUpdate = true;
    this.U = {
      nP: { value: 0 }, pM: { value: Array.from({ length: MAX_PROJ }, () => new THREE.Matrix4()) },
      pPos: { value: Array.from({ length: MAX_PROJ }, () => new THREE.Vector3()) }, pFwd: { value: Array.from({ length: MAX_PROJ }, () => new THREE.Vector3(0, 0, -1)) },
      pK: { value: new Array(MAX_PROJ).fill(0) }, refNits: { value: REF_NITS }, mode: { value: 0 }, amb: { value: 0.06 },
      pSh: { value: new Array(MAX_PROJ).fill(0) }, pNF: { value: new THREE.Vector2(NEAR, FAR) }
    };
    for (let i = 0; i < MAX_PROJ; i++) { this.U['pTex' + i] = { value: this.blank }; this.U['pDep' + i] = { value: this.blank }; }
    this.black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    this.tplMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, flatShading: true });
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.dirty = true;
    this.shader = receiverShader();
    this.mats = new Set();
  }

  /** A receiving material (own base colour / gain / opacity, shared projector uniforms). */
  receiverMaterial({ color = '#E6E6E6', gain = 1, opacity = 1, transmit = false, selfAmb = 0 } = {}) {
    const uniforms = { ...this.U, base: { value: new THREE.Color(color) }, gain: { value: gain }, opacity: { value: opacity }, transmit: { value: transmit ? 1 : 0 }, selfAmb: { value: selfAmb } };
    const m = new THREE.ShaderMaterial({ uniforms, vertexShader: this.shader.vertexShader, fragmentShader: this.shader.fragmentShader, side: THREE.DoubleSide, transparent: opacity < 1, depthWrite: opacity >= 1, toneMapped: false });
    m.userData.receiver = true;
    this.mats.add(m);
    return m;
  }
  dropMaterial(m) { if (m && this.mats.delete(m)) m.dispose(); }

  sync(p) {
    const st = p.stage;
    const seen = new Set();
    const list = (p.projectors || []);
    for (const pj of list) {
      seen.add(pj.id);
      let e = this.items.get(pj.id);
      if (!e) { e = this.make(pj); this.items.set(pj.id, e); }
      e.group.position.set(pj.x, pj.y, pj.z);
      e.group.rotation.set(pj.rx * D2R, pj.ry * D2R, pj.rz * D2R, EULER);
      e.group.visible = pj.visible !== false;
      const look = pj.color + '|' + pj.resW + 'x' + pj.resH;
      if (e.look !== look) { e.look = look; e.stripe.material.color.set(pj.color); e.lines.material.color.set(pj.color); e.faces.material.color.set(pj.color); }
    }
    for (const [id, e] of this.items) if (!seen.has(id)) { this.root.remove(e.group, e.outline); e.tex.dispose(); if (e.depthRT) e.depthRT.dispose(); if (e.povRT) e.povRT.dispose(); this.items.delete(id); }
    const mode = { image: 0, lux: 1, cover: 2 }[st.projView || 'image'] || 0;
    this.U.mode.value = mode;
    this.U.refNits.value = REF_NITS / Math.max(0.05, st.projExposure || 1);
    this.U.amb.value = 0.04 + 0.08 * Math.min(1.5, (st.render && st.render.ambient) ?? 1);
    this.root.visible = true;
    this.shadows = st.projShadows !== false;
    this.dirty = true;
    this.update(p, true);
  }

  make(pj) {
    const group = new THREE.Group(); group.userData.pjid = pj.id;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.3, 0.72), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.55, metalness: 0.3 }));
    body.position.z = 0.42; body.userData.pjid = pj.id;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.625, 0.03, 0.725), new THREE.MeshBasicMaterial({ color: pj.color }));
    stripe.position.set(0, 0.1, 0.42); stripe.userData.pjid = pj.id;
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.14, 24), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.3, metalness: 0.6 }));
    lens.rotation.x = Math.PI / 2; lens.position.z = 0.0; lens.userData.pjid = pj.id;
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.068, 24), new THREE.MeshBasicMaterial({ color: 0xbfd6ff }));
    glass.position.z = -0.071; glass.rotation.y = Math.PI;
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: pj.color, transparent: true, opacity: 0.75 }));
    const faces = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: pj.color, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    const outline = new THREE.BoxHelper(body, 0x4f8bff); outline.material.depthTest = false; outline.renderOrder = 10; outline.visible = false;
    group.add(body, stripe, lens, glass, lines, faces);
    this.root.add(group, outline);
    const texCanvas = document.createElement('canvas'); texCanvas.width = texCanvas.height = 4;
    const tex = new THREE.CanvasTexture(texCanvas); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.anisotropy = 8;
    return { group, body, stripe, lines, faces, outline, tex, texCanvas, key: null, look: null, fkey: null };
  }

  /** Per frame: textures (when their pixelmap changed), matrices, frustum length (distance to what it hits). */
  update(p, force = false) {
    const now = performance.now();
    const list = (p.projectors || []).filter((pj) => pj.visible !== false);
    if (!force && now - (this.lastTex || 0) < 200) { this.uploadUniforms(p, list); return; }
    this.lastTex = now;
    for (const pj of list) this.updateTexture(p, pj, this.items.get(pj.id));
    if (this.dirty && now - (this.lastPass || 0) > 120) {
      this.dirty = false; this.lastPass = now;
      for (const pj of list) { const e = this.items.get(pj.id); if (!e) continue; if (this.shadows) this.renderDepth(p, pj, e); if (pj.out === '@pov' || pj.out === '@tpl') this.renderPovTex(p, pj, e); }
    }
    this.uploadUniforms(p, list);
    this.updateFrusta(p, list);
  }

  /** Camera with the projector's exact off-axis frustum (lens shift included). */
  projCamera(pj, e) {
    e.group.updateMatrixWorld(true);
    const f = P.frustum(pj);
    const cam = this.cam || (this.cam = new THREE.PerspectiveCamera());
    cam.position.setFromMatrixPosition(e.group.matrixWorld);
    cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(e.group.matrixWorld));
    cam.updateMatrixWorld(true);
    cam.projectionMatrix.makePerspective(f.l * NEAR, f.r * NEAR, f.t * NEAR, f.b * NEAR, NEAR, FAR);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    return cam;
  }

  /**
   * Show only what a projector "sees": screens and models (no helpers, floor, crowd, sky). mode 'depth' (occluders),
   * 'content' (projection screens show their pixelmap, the rest black = what the projector must send) or 'template'
   * (receiving surfaces shaded by their normals, the rest black: mapping template). Returns a restore function.
   */
  isolate(p, mode) {
    const s = this.s, scene = s.scene;
    const saved = { bg: scene.background, fog: scene.fog, vis: [], mats: [], ov: scene.overrideMaterial };
    const keep = new Set([s.screenRoot, s.modelRoot, s.peopleRoot, s.fx && s.fx.crowdRoot, s.ref].filter(Boolean));
    for (const e of s.screens.values()) if (e.mapped) keep.add(e.mapped);
    for (const c of scene.children) if (!keep.has(c)) { saved.vis.push([c, c.visible]); c.visible = false; }
    for (const c of s.ref.children) if (c !== s.human) { saved.vis.push([c, c.visible]); c.visible = false; }   // floor / grid off, silhouette kept
    for (const e of s.screens.values()) { saved.vis.push([e.outline, e.outline.visible]); e.outline.visible = false; }
    const setMat = (o, m) => { saved.mats.push([o, o.material]); o.material = m; };
    if (mode === 'depth') scene.overrideMaterial = this.depthMat;
    else {
      scene.background = new THREE.Color(0); scene.fog = null;
      for (const [id, e] of s.screens) {
        const sf = M.getSurface(p, id), proj = sf && sf.kind === 'proj';
        const m = proj ? (mode === 'content' ? e.ledMat || e.front.material : this.tplMat) : this.black;
        setMat(e.front, m); if (e.mapped) setMat(e.mapped, mode === 'content' ? (proj ? m : e.ledMat || e.mapped.material) : m); setMat(e.back, this.black);
      }
      for (const me of s.models.values()) for (const m of me.meshes || []) if (m.visible) setMat(m, mode === 'template' && me.receive ? this.tplMat : this.black);
      for (const m of this.peopleMeshes()) setMat(m, this.black);        // people in the beam: black holes in what the projector sends
    }
    return () => {
      scene.background = saved.bg; scene.fog = saved.fog; scene.overrideMaterial = saved.ov;
      for (const [o, v] of saved.vis) o.visible = v;
      for (const [o, m] of saved.mats.reverse()) o.material = m;
    };
  }

  renderDepth(p, pj, e) {
    const f = P.frustum(pj);
    const w = 1024, h = Math.max(64, Math.round(1024 / f.aspect));
    if (!e.depthRT || e.depthRT.width !== w || e.depthRT.height !== h) {
      if (e.depthRT) e.depthRT.dispose();
      e.depthRT = new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h), depthBuffer: true });
    }
    const rd = this.s.renderer3, cam = this.projCamera(pj, e), restore = this.isolate(p, 'depth');
    const prev = rd.getRenderTarget();
    rd.setRenderTarget(e.depthRT); rd.clear(); rd.render(this.s.scene, cam); rd.setRenderTarget(prev);
    restore();
    e.hasDepth = true;
  }

  /** Projector source "3D render": what this projector sees of the mapped content (or the mapping template). */
  renderPovTex(p, pj, e) {
    const k = Math.min(1, 2048 / Math.max(pj.resW, pj.resH));
    const w = Math.max(16, Math.round(pj.resW * k)), h = Math.max(16, Math.round(pj.resH * k));
    if (!e.povRT || e.povRT.width !== w || e.povRT.height !== h) {
      if (e.povRT) e.povRT.dispose();
      e.povRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
      e.povRT.texture.colorSpace = THREE.SRGBColorSpace;
    }
    const rd = this.s.renderer3, cam = this.projCamera(pj, e), restore = this.isolate(p, pj.out === '@tpl' ? 'template' : 'content');
    const prev = rd.getRenderTarget();
    rd.setRenderTarget(e.povRT); rd.clear(); rd.render(this.s.scene, cam); rd.setRenderTarget(prev);
    restore();
  }

  /**
   * Image a projector must output, at its native resolution: 'content' (mapped pixelmap as seen from the lens) or
   * 'template' (surface shading). Ceiling / rear menus are undone so the file is authored upright. Returns a canvas.
   */
  renderPovImage(p, pjId, mode = 'content') {
    const pj = (p.projectors || []).find((x) => x.id === pjId), e = this.items.get(pjId);
    if (!pj || !e) return null;
    const w = pj.resW, h = pj.resH;
    const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const rd = this.s.renderer3, cam = this.projCamera(pj, e), restore = this.isolate(p, mode);
    const prev = rd.getRenderTarget();
    rd.setRenderTarget(rt); rd.clear(); rd.render(this.s.scene, cam); rd.setRenderTarget(prev);
    restore();
    const buf = new Uint8Array(w * h * 4);
    rd.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    rt.dispose();
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);   // GL rows are bottom-up
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    // the projector undoes ceiling (180°) / rear (mirror) itself: author the file upright
    const fx = (pj.ceiling ? -1 : 1) * (pj.rear ? -1 : 1), fy = pj.ceiling ? -1 : 1;
    if (fx < 0 || fy < 0) { const o = document.createElement('canvas'); o.width = w; o.height = h; const oc = o.getContext('2d'); oc.setTransform(fx, 0, 0, fy, fx < 0 ? w : 0, fy < 0 ? h : 0); oc.drawImage(c, 0, 0); return o; }
    return c;
  }

  uploadUniforms(p, list) {
    const U = this.U;
    let n = 0;
    for (const pj of list) {
      if (n >= MAX_PROJ) break;
      const e = this.items.get(pj.id); if (!e) continue;
      e.group.updateMatrixWorld(true);
      const f = P.frustum(pj);
      const proj = new THREE.Matrix4().makePerspective(f.l * NEAR, f.r * NEAR, f.t * NEAR, f.b * NEAR, NEAR, FAR);
      const view = e.group.matrixWorld.clone().invert();
      U.pM.value[n].multiplyMatrices(proj, view);
      U.pPos.value[n].setFromMatrixPosition(e.group.matrixWorld);
      U.pFwd.value[n].set(0, 0, -1).transformDirection(e.group.matrixWorld);
      U.pK.value[n] = (+pj.lumens || 0) * Math.max(1, +pj.stack || 1) * f.tr * f.tr * f.aspect;
      U['pTex' + n].value = (pj.out === '@pov' || pj.out === '@tpl') && e.povRT ? e.povRT.texture : e.tex;
      const shadowOn = this.shadows && e.hasDepth && e.depthRT;
      U['pDep' + n].value = shadowOn ? e.depthRT.depthTexture : this.blank;
      U.pSh.value[n] = shadowOn ? 1 : 0;
      n++;
    }
    for (let i = n; i < MAX_PROJ; i++) { U['pTex' + i].value = this.blank; U['pDep' + i].value = this.blank; U.pSh.value[i] = 0; }
    U.nP.value = n;
  }

  updateTexture(p, pj, e) {
    if (!e) return;
    if (pj.out === '@pov' || pj.out === '@tpl') return;    // rendered from the 3D scene (renderPovTex)
    const R = this.s.h.renderer;
    const out = pj.out && pj.out[0] !== '@' ? M.getOutput(p, pj.out) : null;
    let key;
    if (out) {
      const sls = M.slicesOfOutput(p, out.id);
      key = JSON.stringify([out, sls, sls.map((sl) => { const s = M.getSurface(p, sl.surfaceId); return s ? R.surfaceBitmap(p, s).key : ''; }), p.style.footer, p.style.info, R.logoVer, !!pj.ceiling, !!pj.rear]);
    } else key = JSON.stringify(['test', pj.name, pj.resW, pj.resH, pj.color, !!pj.ceiling, !!pj.rear]);
    if (key === e.key) return;
    e.key = key;
    const c = e.texCanvas;
    const k = Math.min(1, 2048 / Math.max(pj.resW, pj.resH));
    const w = Math.max(16, Math.round(pj.resW * k)), h = Math.max(16, Math.round(pj.resH * k));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; e.tex.dispose(); }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (out) {
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(w / out.w, 0, 0, h / out.h, 0, 0);
      const pp = { ...p, style: { ...p.style, anim: { ...p.style.anim, enabled: false } } };
      R.drawOutput(ctx, pp, out, { time: 0, smooth: true, blend: 'off' });
      // alpha = where the slices are, with their soft edges as linear ramps: the shader multiplies light by it
      const mk = this.maskCanvas || (this.maskCanvas = document.createElement('canvas'));
      mk.width = w; mk.height = h;
      const m = mk.getContext('2d');
      m.setTransform(w / out.w, 0, 0, h / out.h, 0, 0);
      for (const sl of M.slicesOfOutput(p, out.id)) {
        const src = M.getSurface(p, sl.surfaceId); if (!src || src.visible === false) continue;
        const r = M.sliceRect(sl), d = M.sliceDims(sl), k = d.ow / Math.max(1, sl.src.w), b = sl.blend || {};
        m.globalCompositeOperation = 'source-over'; m.fillStyle = '#fff'; m.fillRect(r.x, r.y, r.w, r.h);
        m.globalCompositeOperation = 'destination-out';
        const ramp = (x0, y0, x1, y1, rx, ry, rw, rh) => { const g = m.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); m.fillStyle = g; m.fillRect(rx, ry, rw, rh); };
        if (b.l > 0) { const bw = b.l * k; ramp(r.x, 0, r.x + bw, 0, r.x, r.y, bw, r.h); }
        if (b.r > 0) { const bw = b.r * k; ramp(r.x + r.w, 0, r.x + r.w - bw, 0, r.x + r.w - bw, r.y, bw, r.h); }
        if (b.t > 0) { const bh = b.t * k; ramp(0, r.y, 0, r.y + bh, r.x, r.y, r.w, bh); }
        if (b.b > 0) { const bh = b.b * k; ramp(0, r.y + r.h, 0, r.y + r.h - bh, r.x, r.y + r.h - bh, r.w, bh); }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mk, 0, 0); ctx.globalCompositeOperation = 'source-over';
    } else drawTestRaster(ctx, w, h, pj);
    // installation menu of the projector: ceiling = raster turned 180°, rear = raster mirrored left / right
    const fx = (pj.ceiling ? -1 : 1) * (pj.rear ? -1 : 1), fy = pj.ceiling ? -1 : 1;
    if (fx < 0 || fy < 0) {
      const tmp = this.flipCanvas || (this.flipCanvas = document.createElement('canvas'));
      tmp.width = w; tmp.height = h; const tc = tmp.getContext('2d'); tc.clearRect(0, 0, w, h); tc.drawImage(c, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.setTransform(fx, 0, 0, fy, fx < 0 ? w : 0, fy < 0 ? h : 0); ctx.drawImage(tmp, 0, 0); ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    e.tex.needsUpdate = true;
  }

  /** Frustum lines / faces down to the first receiving surface (or 12 m). */
  updateFrusta(p, list) {
    const recv = this.s.receivers ? this.s.receivers() : [];
    const ray = new THREE.Raycaster();
    for (const pj of list) {
      const e = this.items.get(pj.id); if (!e) continue;
      const f = P.frustum(pj);
      e.group.updateMatrixWorld(true);
      const o = new THREE.Vector3().setFromMatrixPosition(e.group.matrixWorld);
      const dir = new THREE.Vector3(f.cx, f.cy, -1).normalize().transformDirection(e.group.matrixWorld);
      ray.set(o, dir); ray.far = 400;
      const hit = recv.length ? ray.intersectObjects(recv, false)[0] : null;
      const depth = hit ? hit.distance * new THREE.Vector3(f.cx, f.cy, -1).normalize().z * -1 : 12;
      const fkey = [f.l, f.r, f.b, f.t, depth.toFixed(3)].join(',');
      e.hitDepth = hit ? depth : null;
      if (fkey === e.fkey) continue;
      e.fkey = fkey;
      const D = Math.max(0.2, depth);
      const C = [[f.l * D, f.b * D, -D], [f.r * D, f.b * D, -D], [f.r * D, f.t * D, -D], [f.l * D, f.t * D, -D]];
      const L = [];
      for (const c of C) L.push(0, 0, -0.07, ...c);
      for (let i = 0; i < 4; i++) L.push(...C[i], ...C[(i + 1) % 4]);
      e.lines.geometry.dispose(); e.lines.geometry = new THREE.BufferGeometry(); e.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(L, 3));
      const F = [];
      for (let i = 0; i < 4; i++) F.push(0, 0, -0.07, ...C[i], ...C[(i + 1) % 4]);
      e.faces.geometry.dispose(); e.faces.geometry = new THREE.BufferGeometry(); e.faces.geometry.setAttribute('position', new THREE.Float32BufferAttribute(F, 3));
    }
  }

  /** Every mesh standing for a person: audience (instanced), the scale silhouette, placed people. */
  peopleMeshes() {
    const s = this.s, out = [];
    if (s.fx && s.fx.crowdRoot) for (const m of s.fx.crowdRoot.children) if (m.isMesh) out.push(m);
    if (s.human) s.human.traverse((o) => { if (o.isMesh) out.push(o); });
    if (s.peopleRoot) s.peopleRoot.traverse((o) => { if (o.isMesh) out.push(o); });
    return out;
  }
  /** People lit by the projectors (receiver shader, instancing aware) so a beam crossing someone shows on them. */
  syncPeopleLight(p) {
    const on = (p.projectors || []).length > 0 && p.stage.projLitPeople !== false;
    for (const m of this.peopleMeshes()) {
      if (on) {
        if (!m.userData.stdMat) m.userData.stdMat = m.material;
        const col = m.userData.personColor || (m.isInstancedMesh ? '#8C929C' : '#A7ADB8');
        if (!m.userData.recvMat || m.userData.recvCol !== col) { this.dropMaterial(m.userData.recvMat); m.userData.recvMat = this.receiverMaterial({ color: col, selfAmb: 0.28 }); m.userData.recvCol = col; }
        m.material = m.userData.recvMat;
      } else if (m.userData.stdMat) { m.material = m.userData.stdMat; }
    }
    this.dirty = true;
  }

  /**
   * What stands between a projector and the surfaces it lights: a grid of rays over its raster. Each ray that reaches a
   * receiving surface is "blocked" when a person (cylinder of their height) or an object / LED screen is hit first.
   * Returns { total, blocked, pct, list: [[name, rays]], spill } (spill = rays that reach no projection surface).
   */
  analyzeObstruction(p, pj) {
    const s = this.s, e = this.items.get(pj.id);
    if (!e) return null;
    const ax = P.projAxes(pj), f = P.frustum(pj), O = new THREE.Vector3(pj.x, pj.y, pj.z);
    const R = new THREE.Vector3(...ax.right), U = new THREE.Vector3(...ax.up), Fw = new THREE.Vector3(...ax.fwd);
    // people as vertical cylinders, pre-filtered on the frustum
    const cyl = [];
    const inFrustum = (x, y, z, rad) => { const q = new THREE.Vector3(x, y, z).sub(O); const zz = q.dot(Fw); if (zz <= 0.05) return false; const u = q.dot(R) / zz, v = q.dot(U) / zz, m = rad / zz + 0.02; return u > f.l - m && u < f.r + m && v > f.b - m && v < f.t + m; };
    const addCyl = (x, y0, z, hh, r, name) => { if (inFrustum(x, y0 + hh / 2, z, Math.max(r, hh / 2))) cyl.push({ x, y0, z, hh, r, name }); };
    const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), q4 = new THREE.Quaternion(), sc = new THREE.Vector3();
    if (s.fx && s.fx.crowdRoot) for (const m of s.fx.crowdRoot.children) if (m.isInstancedMesh && m.visible !== false) for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, m4); m4.decompose(pos, q4, sc); addCyl(pos.x, pos.y, pos.z, sc.y * 1.02, 0.2 * sc.x, 'public'); }
    if (s.human && s.human.visible) { s.human.updateMatrixWorld(true); const hp = new THREE.Vector3().setFromMatrixPosition(s.human.matrixWorld); addCyl(hp.x, hp.y, hp.z, 1.8, 0.22, 'silhouette'); }
    for (const ps of p.stage.people || []) if (ps.visible !== false) addCyl(ps.x, ps.y || 0, ps.z, (ps.h || 1.75) * (ps.arms ? 1.18 : 1.0), 0.22 * (ps.h || 1.75) / 1.75, ps.name);
    const hitCyl = (o, d, c) => {
      const ox = o.x - c.x, oz = o.z - c.z, a = d.x * d.x + d.z * d.z;
      if (a < 1e-9) return Infinity;
      const b = 2 * (ox * d.x + oz * d.z), cc = ox * ox + oz * oz - c.r * c.r, disc = b * b - 4 * a * cc;
      if (disc < 0) return Infinity;
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) { if (t <= 0.05) continue; const y = o.y + d.y * t; if (y >= c.y0 && y <= c.y0 + c.hh) return t; }
      return Infinity;
    };
    // solid meshes (receivers + occluders)
    const recv = new Set(s.receivers()), meshes = [...recv];
    for (const sc2 of s.screens.values()) { if (sc2.group.visible && !recv.has(sc2.front)) meshes.push(sc2.front, sc2.back); if (sc2.mapped && sc2.mapped.visible && !recv.has(sc2.mapped)) meshes.push(sc2.mapped); }
    for (const me of s.models.values()) if (me.holder.visible) for (const m of me.meshes || []) if (m.visible && !recv.has(m)) meshes.push(m);
    const nameOf = (ob) => {
      if (ob.userData.sid) { const sf = M.getSurface(p, ob.userData.sid); return sf ? sf.name : 'LED'; }
      const md = p.stage.models.find((x) => x.id === ob.userData.mid); return md ? md.name : 'objet';
    };
    const ray = new THREE.Raycaster(); ray.far = FAR;
    const nx = 24, ny = Math.max(8, Math.round(24 / f.aspect));
    let total = 0, blocked = 0, spill = 0;
    const tally = new Map();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const d = Fw.clone().addScaledVector(R, f.l + (i + 0.5) / nx * (f.r - f.l)).addScaledVector(U, f.b + (j + 0.5) / ny * (f.t - f.b)).normalize();
      ray.set(O, d);
      const hits = ray.intersectObjects(meshes, false);
      const target = hits.find((h) => recv.has(h.object));
      if (!target) { spill++; continue; }
      total++;
      let best = target.distance - 0.05, who = null;
      for (const c of cyl) { const tt = hitCyl(O, d, c); if (tt < best) { best = tt; who = c.name; } }
      const first = hits[0];
      if (first && !recv.has(first.object) && first.distance < best) { best = first.distance; who = nameOf(first.object); }
      if (who) { blocked++; tally.set(who, (tally.get(who) || 0) + 1); }
    }
    return { total, blocked, pct: total ? blocked / total * 100 : 0, list: [...tally.entries()].sort((a, b) => b[1] - a[1]), spill, people: cyl.length };
  }

  setSelected(id, presentation) {
    for (const [pid, e] of this.items) {
      e.outline.visible = !presentation && pid === id;
      if (e.outline.visible) e.outline.update();
      e.lines.material.opacity = pid === id ? 1 : 0.6;
      e.faces.material.opacity = pid === id ? 0.08 : 0.04;
    }
  }
  setPresentation(on) { for (const e of this.items.values()) { e.lines.visible = !on; e.faces.visible = !on; if (on) e.outline.visible = false; } }
  pickables() { const a = []; for (const e of this.items.values()) if (e.group.visible) a.push(e.body, e.stripe); return a; }
}

/** Projector raster without an output: alignment grid, centre cross, name and resolution. */
export function drawTestRaster(ctx, w, h, pj) {
  ctx.fillStyle = '#5b616c'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(1, w / 900);
  const n = 16, cw = w / n, rows = Math.round(h / cw);
  for (let i = 1; i < n; i++) { ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, h); ctx.stroke(); }
  for (let j = 1; j < rows; j++) { const y = j * h / rows; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = pj.color || '#4F8BFF'; ctx.lineWidth = Math.max(3, w / 200); ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, w / 500);
  ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.42, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(h * 0.09)}px Arial`; ctx.fillText(pj.name || 'PROJ', w / 2, h / 2 - h * 0.08);
  ctx.font = `500 ${Math.round(h * 0.045)}px Arial`; ctx.fillText(`${pj.resW} × ${pj.resH}`, w / 2, h / 2 + h * 0.05);
}
