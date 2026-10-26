// Pixel2Pixel — 3D render look: environment / sky / haze, LED bloom, floor reflections, light spill from the screens, crowd.
import * as THREE from '../vendor/three/three.module.js';
import { EffectComposer } from '../vendor/three/addons/EffectComposer.js';
import { RenderPass } from '../vendor/three/addons/RenderPass.js';
import { UnrealBloomPass } from '../vendor/three/addons/UnrealBloomPass.js';
import { OutputPass } from '../vendor/three/addons/OutputPass.js';
import { Reflector } from '../vendor/three/addons/Reflector.js';
import { RectAreaLightUniformsLib } from '../vendor/three/addons/RectAreaLightUniformsLib.js';
import { mergeGeometries } from '../vendor/three/addons/BufferGeometryUtils.js';
import * as M from './model.js';

const MAX_SPILL = 24;
const QUALITY = { draft: { dpr: 1, refl: 512, bloomScale: 0.5 }, normal: { dpr: 1.5, refl: 1024, bloomScale: 0.75 }, high: { dpr: 2, refl: 2048, bloomScale: 1 } };

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }

/** Low-poly person (≈1 m tall unit, scaled per instance). arms: raised arms variant. */
export function personGeometry(arms) {
  const parts = [];
  const body = new THREE.CapsuleGeometry(0.105, 0.42, 3, 8); body.scale(1, 1, 0.62); body.translate(0, 0.56, 0); parts.push(body);
  const head = new THREE.SphereGeometry(0.065, 8, 6); head.translate(0, 0.935, 0); parts.push(head);
  const legL = new THREE.CapsuleGeometry(0.045, 0.34, 2, 6); legL.translate(-0.055, 0.215, 0); parts.push(legL);
  const legR = legL.clone(); legR.translate(0.11, 0, 0); parts.push(legR);
  if (arms) {
    for (const sx of [-1, 1]) {
      const a = new THREE.CapsuleGeometry(0.032, 0.36, 2, 6);
      a.rotateZ(sx * -0.32); a.translate(sx * 0.16, 1.02, 0); parts.push(a);
    }
  } else {
    for (const sx of [-1, 1]) { const a = new THREE.CapsuleGeometry(0.032, 0.34, 2, 6); a.translate(sx * 0.135, 0.56, 0); parts.push(a); }
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed ? p.toNonIndexed() : p), false);
  g.computeVertexNormals();
  return g;
}

export class StageFX {
  constructor(stage) {
    this.s = stage;
    const scene = stage.scene;
    RectAreaLightUniformsLib.init();
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x30343c, 1.4); scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4); this.sun.position.set(8, 20, 12); scene.add(this.sun);
    this.spillRoot = new THREE.Group(); scene.add(this.spillRoot);
    this.spill = [];
    this.crowdRoot = new THREE.Group(); scene.add(this.crowdRoot);
    this.time = { value: 0 };
    this.lastSpill = 0;
  }

  // ------------------------------------------------------------------ settings -> scene
  apply(p) {
    const r = p.stage.render, st = p.stage;
    const s = this.s, scene = s.scene;
    // sky
    const skyKey = JSON.stringify([r.sky, r.skyTop, r.skyBottom, st.bg]);
    if (skyKey !== this.skyKey) {
      this.skyKey = skyKey;
      if (scene.background && scene.background.isTexture) scene.background.dispose();
      if (r.sky === 'gradient') {
        const c = document.createElement('canvas'); c.width = 4; c.height = 256;
        const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 256);
        gr.addColorStop(0, r.skyTop); gr.addColorStop(1, r.skyBottom); g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
        const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; scene.background = tx;
      } else scene.background = new THREE.Color(st.bg || '#14171e');
    }
    // haze
    if (r.haze > 0.001) {
      const col = new THREE.Color(r.hazeColor || '#20242e');
      if (!scene.fog) scene.fog = new THREE.FogExp2(col, 0);
      scene.fog.color.copy(col); scene.fog.density = r.haze * 0.05;
    } else scene.fog = null;
    // lights
    this.hemi.intensity = 1.4 * r.ambient;
    this.sun.intensity = 1.4 * r.sun;
    this.sun.color.set(r.sunColor || '#ffffff');
    // camera
    if (this.lastFov !== r.fov) { this.lastFov = r.fov; s.persp.fov = r.fov; s.persp.updateProjectionMatrix(); }   // saved views may set their own fov
    // quality / bloom / reflections
    const q = QUALITY[r.quality] || QUALITY.normal;
    const qKey = r.quality;
    if (qKey !== this.qKey) { this.qKey = qKey; this.composer = null; this.reflKey = null; s.resize(); }
    this.bloomOn = !!r.bloom;
    if (this.bloomOn && !this.composer) this.makeComposer(q);
    if (this.bloomPass) { this.bloomPass.strength = r.bloomStrength; this.bloomPass.radius = r.bloomRadius; this.bloomPass.threshold = r.bloomThreshold; }
    this.applyReflector(p, q);
    this.spillOn = !!r.spill;
    if (!this.spillOn) this.clearSpill();
    this.buildCrowd(p);
  }

  makeComposer(q) {
    const s = this.s, rd = s.renderer3;
    const w = s.canvas.clientWidth || 2, h = s.canvas.clientHeight || 2;
    this.composer = new EffectComposer(rd);
    this.composer.addPass(new RenderPass(s.scene, s.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w * q.bloomScale, h * q.bloomScale), 0.5, 0.4, 0.2);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.composer.setPixelRatio(rd.getPixelRatio());
    this.composer.setSize(w, h);
  }

  applyReflector(p, q) {
    const r = p.stage.render, st = p.stage, s = this.s;
    const key = JSON.stringify([r.reflect && st.floor, q.refl]);
    const floor = s.ref.getObjectByName('floor');
    if (key !== this.reflKey) {
      this.reflKey = key;
      if (this.reflector) { s.scene.remove(this.reflector); this.reflector.dispose(); this.reflector = null; }
      if (r.reflect && st.floor) {
        const w = s.canvas.clientWidth || 1024, h = s.canvas.clientHeight || 768;
        const k = q.refl / Math.max(w, h);
        this.reflector = new Reflector(new THREE.PlaneGeometry(400, 400), { textureWidth: Math.round(w * k), textureHeight: Math.round(h * k), color: 0x8a8a8a, clipBias: 0.003 });
        this.reflector.rotation.x = -Math.PI / 2; this.reflector.position.y = -0.004;
        s.scene.add(this.reflector);
      }
    }
    if (floor) {
      // the floor becomes partly transparent over the mirror
      floor.material.transparent = !!this.reflector;
      floor.material.opacity = this.reflector ? 1 - Math.min(0.95, r.reflectAmount) : 1;
      floor.material.depthWrite = !this.reflector;
      floor.material.color.set(st.floorColor || '#22262f');
      floor.material.needsUpdate = true;
    }
  }
  /** Called after the reference scene (floor) is rebuilt. */
  refreshFloor(p) { this.reflKey = null; this.applyReflector(p, QUALITY[p.stage.render.quality] || QUALITY.normal); }

  // ------------------------------------------------------------------ light spill (RectAreaLight per screen, colour = average of its pixels)
  clearSpill() { for (const l of this.spill) { this.spillRoot.remove(l); l.dispose(); } this.spill = []; }
  updateSpill(p, now, force = false) {
    if (!this.spillOn || (!force && now - this.lastSpill < 250)) return;
    this.lastSpill = now;
    const r = p.stage.render;
    const s = this.s;
    const items = [];
    for (const sf of p.surfaces) {
      const e = s.screens.get(sf.id);
      if (!e || sf.visible === false || sf.kind === 'proj') continue;
      const obj = e.mapped && e.mapped.visible ? e.mapped : (e.group.visible ? e.front : null);
      if (!obj) continue;
      const m = M.surfaceMeters(p, sf);
      items.push({ e, obj, area: m.w * m.h, m, sf });
    }
    items.sort((a, b) => b.area - a.area);
    const use = items.slice(0, MAX_SPILL);
    while (this.spill.length < use.length) { const l = new THREE.RectAreaLight(0xffffff, 0, 1, 1); this.spillRoot.add(l); this.spill.push(l); }
    while (this.spill.length > use.length) { const l = this.spill.pop(); this.spillRoot.remove(l); l.dispose(); }
    if (!this.sampler) { this.sampler = document.createElement('canvas'); this.sampler.width = this.sampler.height = 6; this.sctx = this.sampler.getContext('2d', { willReadFrequently: true }); }
    const glow = Math.max(0.1, p.stage.glow ?? 1);
    use.forEach((it, i) => {
      const l = this.spill[i];
      // average colour of the screen pixels
      const lc = it.e.liveM && s.liveColor ? s.liveColor(p, it.sf, it.e) : null;   // live NDI / capture source
      if (lc) l.color.setRGB(lc[0], lc[1], lc[2], THREE.SRGBColorSpace);
      else {
        this.sctx.drawImage(it.e.texCanvas, 0, 0, 6, 6);
        const d = this.sctx.getImageData(0, 0, 6, 6).data;
        let R = 0, G = 0, B = 0;
        for (let k = 0; k < d.length; k += 4) { R += d[k]; G += d[k + 1]; B += d[k + 2]; }
        const n = d.length / 4;
        l.color.setRGB(R / n / 255, G / n / 255, B / n / 255, THREE.SRGBColorSpace);
      }
      // placement: centre + average normal of the emitting geometry, in world space
      if (!it.e.spillGeo || it.e.spillGeo.src !== it.obj.geometry) it.e.spillGeo = { src: it.obj.geometry, ...geoFrame(it.obj.geometry) };
      const f = it.e.spillGeo;
      it.obj.updateMatrixWorld(true);
      const c = f.c.clone().applyMatrix4(it.obj.matrixWorld);
      const nrm = f.n.clone().transformDirection(it.obj.matrixWorld);
      l.position.copy(c).addScaledVector(nrm, 0.12);
      l.lookAt(c.clone().addScaledVector(nrm, 5));
      l.width = Math.max(0.2, Math.min(f.w, it.m.w)); l.height = Math.max(0.2, Math.min(f.h, it.m.h));
      l.intensity = 6 * r.spillIntensity * glow;
    });
  }

  // ------------------------------------------------------------------ crowd (instanced, bounce in the vertex shader)
  crowdOriginNow(c) { return crowdOrigin(c, this.frontZ ?? 0, this.screenBounds); }
  buildCrowd(p) {
    const c = p.stage.crowd;
    const front = this.frontZ ?? 0, sb = this.screenBounds, fps = this.footprints || [];
    const key = JSON.stringify([c, Math.round(front * 10), sb && [sb.minX, sb.maxX, sb.minZ, sb.maxZ].map((x) => Math.round(x * 10)), c.avoid ? fps.map((f) => [f.tris.length, Math.round(f.x0 * 10), Math.round(f.z0 * 10), Math.round(f.x1 * 10), Math.round(f.z1 * 10)]) : 0]);
    if (key === this.crowdKey) { if (this.crowdMat) this.crowdMat.color.set(c.color); return; }
    this.crowdKey = key;
    this.crowdRoot.clear();
    if (!c.enabled) return;
    const area = Math.max(1, c.width * c.depth), count = Math.min(8000, Math.round(area * Math.max(0.05, c.density)));
    const step = Math.sqrt(area / count);
    const cols = Math.max(1, Math.round(c.width / step)), rows = Math.max(1, Math.ceil(count / cols));
    const rand = rng(c.seed || 7);
    const mat = this.crowdMat = new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.85, metalness: 0 });
    const time = this.time;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.uniforms.uBounce = { value: c.bounce ? 1 : 0 };
      sh.vertexShader = 'uniform float uTime; uniform float uBounce;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n float ph = float(gl_InstanceID) * 1.618;\n transformed.y += uBounce * max(0.0, sin(uTime * 7.5 + ph)) * 0.11;');
    };
    const geos = [personGeometry(false), personGeometry(true)];
    const meshes = geos.map((g) => new THREE.InstancedMesh(g, mat, count));
    const counts = [0, 0];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    // where the crowd stands: in front of the screens (default), centred between them (arena, U, in-the-round) or at a free position
    const { cx, z0 } = crowdOrigin(c, front, sb);
    const blocked = c.avoid !== false ? (x, z) => onScreen(fps, x, z, 0.35) : () => false;
    let placed = 0;
    for (let rr = 0; rr < rows && placed < count; rr++) for (let cc = 0; cc < cols && placed < count; cc++) {
      const x = cx - c.width / 2 + (cc + 0.5 + (rand() - 0.5) * 0.8) * (c.width / cols);
      const z = z0 + (rr + 0.5 + (rand() - 0.5) * 0.8) * (c.depth / rows);
      if (blocked(x, z)) { rand(); rand(); rand(); rand(); rand(); continue; }
      const hgt = c.height * (0.88 + rand() * 0.22);
      const k = rand() * 100 < c.arms ? 1 : 0;
      pos.set(x, 0, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + (rand() - 0.5) * 0.9);   // facing the stage (−Z)
      sc.set(hgt * (0.95 + rand() * 0.1), hgt, hgt);
      m4.compose(pos, q, sc);
      meshes[k].setMatrixAt(counts[k]++, m4);
      placed++;
    }
    meshes.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; this.crowdRoot.add(m); });
    this.crowdCount = placed;
  }

  // ------------------------------------------------------------------ frame
  render(now) {
    const s = this.s;
    this.time.value = now / 1000;
    if (this.bloomOn && this.composer) this.composer.render();
    else s.renderer3.render(s.scene, s.camera);
  }
  resize(w, h, dpr) {
    if (this.composer) { this.composer.setPixelRatio(dpr); this.composer.setSize(w, h); }
    if (this.reflector) {
      const q = QUALITY[this.qKey] || QUALITY.normal;
      const k = q.refl / Math.max(w, h);
      this.reflector.getRenderTarget().setSize(Math.round(w * k), Math.round(h * k));
    }
  }
  dpr() { return Math.min(window.devicePixelRatio || 1, (QUALITY[this.qKey] || QUALITY.normal).dpr); }
}

/** Centre, average normal and extent of a geometry (local space). */
function geoFrame(g) {
  g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const N = g.getAttribute('normal');
  const n = new THREE.Vector3();
  for (let i = 0; i < N.count; i++) n.x += N.getX(i), n.y += N.getY(i), n.z += N.getZ(i);
  if (n.lengthSq() < 1e-9) n.set(0, 0, 1);
  n.normalize();
  const sz = g.boundingBox.getSize(new THREE.Vector3());
  const w = Math.max(Math.hypot(sz.x, sz.z), 0.2), h = Math.max(sz.y, 0.2);
  return { c, n, w, h };
}

/** Crowd rectangle origin: centre X and the Z of its back-to-stage edge. */
export function crowdOrigin(c, front, sb) {
  const a = c.anchor || 'front';
  if (a === 'center' && sb) return { cx: (sb.minX + sb.maxX) / 2 + (+c.x || 0), z0: (sb.minZ + sb.maxZ) / 2 + (+c.z || 0) - c.depth / 2 };
  if (a === 'free') return { cx: +c.x || 0, z0: (+c.z || 0) - c.depth / 2 };
  return { cx: +c.x || 0, z0: front + (+c.dist || 0) };
}
/** True when (x, z) lies on a screen footprint (within margin m). */
export function onScreen(fps, x, z, m) {
  for (const f of fps) {
    if (x < f.x0 - m || x > f.x1 + m || z < f.z0 - m || z > f.z1 + m) continue;
    const t = f.tris;
    for (let i = 0; i < t.length; i += 6) if (triDist(x, z, t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5]) <= m) return true;
  }
  return false;
}
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
  const u = l > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  return Math.hypot(px - ax - u * dx, pz - az - u * dz);
}
function triDist(px, pz, ax, az, bx, bz, cx, cz) {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz), d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz), d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az));
  if (area > 1e-9 && !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)))) return 0;
  return Math.min(segDist(px, pz, ax, az, bx, bz), segDist(px, pz, bx, bz, cx, cz), segDist(px, pz, cx, cz, ax, az));
}
