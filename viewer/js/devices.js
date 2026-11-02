// Pixel2Pixel — device library for the synoptic and the rack plans (v1).
// A device definition (DeviceDef) = identity + real size / weight / power + typed ports (signal, connector, direction,
// side). Port groups with a count (« In 1-8 », 8 × DP) are expanded into single ports for linking. Three sources:
// the common library (VBS, bundled in devlib.js), the user's own devices (synoptic only: no faces, no 3D) and the
// devices embedded in a project (so a project opens anywhere). See src/data/devices/SCHEMA.md.
import * as LIB from './devlib.js';

// ------------------------------------------------------------------ vocabulary
/** Signals: family (what can meet what), colour on the synoptic, bandwidth in Gb/s when it matters. */
export const SIGNALS = {
  hdmi14: { label: 'HDMI 1.4', fam: 'video', sub: 'hdmi', gbps: 10.2 }, hdmi20: { label: 'HDMI 2.0', fam: 'video', sub: 'hdmi', gbps: 18 }, hdmi21: { label: 'HDMI 2.1', fam: 'video', sub: 'hdmi', gbps: 48 },
  dp12: { label: 'DisplayPort 1.2', fam: 'video', sub: 'dp', gbps: 21.6 }, dp14: { label: 'DisplayPort 1.4', fam: 'video', sub: 'dp', gbps: 32.4 }, dp20: { label: 'DisplayPort 2.0', fam: 'video', sub: 'dp', gbps: 80 },
  dvi: { label: 'DVI', fam: 'video', sub: 'hdmi', gbps: 4.95 },
  sdi3g: { label: '3G-SDI', fam: 'video', sub: 'sdi', gbps: 3 }, sdi6g: { label: '6G-SDI', fam: 'video', sub: 'sdi', gbps: 6 }, sdi12g: { label: '12G-SDI', fam: 'video', sub: 'sdi', gbps: 12 },
  hdbaset: { label: 'HDBaseT', fam: 'video', sub: 'hdbaset' }, fiber: { label: 'Fibre (vidéo)', fam: 'video', sub: 'fiber' },
  eth1g: { label: 'Ethernet 1G', fam: 'net', gbps: 1 }, eth10g: { label: 'Ethernet 10G', fam: 'net', gbps: 10 }, eth25g: { label: 'Ethernet 25G', fam: 'net', gbps: 25 }, eth100g: { label: 'Ethernet 100G', fam: 'net', gbps: 100 },
  st2110: { label: 'ST 2110', fam: 'net', gbps: 10 }, ndi: { label: 'NDI', fam: 'net', gbps: 1 },
  led1g: { label: 'Data LED 1G', fam: 'led', gbps: 1 }, led5g: { label: 'Data LED 5G', fam: 'led', gbps: 5 }, led10g: { label: 'Data LED 10G', fam: 'led', gbps: 10 },
  genlock_bb: { label: 'Genlock (black burst)', fam: 'sync' }, genlock_tri: { label: 'Genlock (tri-level)', fam: 'sync' }, ltc: { label: 'Timecode LTC', fam: 'sync' },
  dmx: { label: 'DMX', fam: 'ctrl' }, usb: { label: 'USB', fam: 'ctrl' }, rs232: { label: 'RS-232', fam: 'ctrl' },
  power230: { label: '230 V', fam: 'power' }, power400: { label: '400 V tri', fam: 'power' }, socapex: { label: 'Socapex (6 circuits)', fam: 'power' }, harting: { label: 'Harting (multi)', fam: 'power' }, p17: { label: 'P17', fam: 'power' }
};
/** Families → colour and synoptic layer. */
export const FAMILIES = {
  video: { label: 'Vidéo', labelEn: 'Video', color: '#3AA0FF', layer: 'video' },
  led: { label: 'Data LED', labelEn: 'LED data', color: '#2EE6C8', layer: 'led' },
  net: { label: 'Réseau', labelEn: 'Network', color: '#B98CFF', layer: 'net' },
  sync: { label: 'Synchro', labelEn: 'Sync', color: '#7FD4FF', layer: 'video' },
  ctrl: { label: 'Contrôle', labelEn: 'Control', color: '#C0C6D0', layer: 'ctrl' },
  power: { label: 'Power', labelEn: 'Power', color: '#FFB020', layer: 'power' }
};
/** Connectors: label and face footprint in mm (w × h) for the face editor; shape for drawing. */
export const CONNECTORS = {
  bnc: { label: 'BNC', w: 14, h: 14, shape: 'round' }, hdmi: { label: 'HDMI', w: 15.5, h: 6.5, shape: 'hdmi' }, dp: { label: 'DisplayPort', w: 16.5, h: 6.5, shape: 'dp' }, mdp: { label: 'Mini DisplayPort', w: 8, h: 5, shape: 'dp' },
  dvi: { label: 'DVI', w: 39, h: 13, shape: 'rect' }, rj45: { label: 'RJ45', w: 12, h: 11, shape: 'rj' }, ethercon: { label: 'etherCON', w: 26, h: 31, shape: 'xlr' },
  opticalcon_duo: { label: 'opticalCON DUO', w: 26, h: 31, shape: 'xlr' }, opticalcon_quad: { label: 'opticalCON QUAD', w: 26, h: 31, shape: 'xlr' }, lc_duplex: { label: 'LC duplex', w: 13, h: 9, shape: 'rect' }, sc: { label: 'SC', w: 9, h: 9, shape: 'rect' },
  sfp: { label: 'SFP', w: 14, h: 9, shape: 'rect' }, sfpplus: { label: 'SFP+', w: 14, h: 9, shape: 'rect' }, sfp28: { label: 'SFP28', w: 14, h: 9, shape: 'rect' }, qsfp: { label: 'QSFP', w: 19, h: 9, shape: 'rect' },
  usb_a: { label: 'USB-A', w: 13, h: 6, shape: 'rect' }, usb_b: { label: 'USB-B', w: 9, h: 8, shape: 'rect' }, usb_c: { label: 'USB-C', w: 9, h: 3.5, shape: 'rect' },
  xlr3: { label: 'XLR 3', w: 26, h: 31, shape: 'xlr' }, xlr5: { label: 'XLR 5', w: 26, h: 31, shape: 'xlr' }, dsub9: { label: 'D-Sub 9', w: 31, h: 13, shape: 'rect' }, phoenix: { label: 'Phoenix', w: 15, h: 8, shape: 'rect' },
  iec_c14: { label: 'IEC C14', w: 28, h: 23, shape: 'iec' }, iec_c20: { label: 'IEC C20', w: 30, h: 24, shape: 'iec' }, powercon_true1: { label: 'powerCON TRUE1', w: 26, h: 31, shape: 'xlr' }, powercon_32: { label: 'powerCON 32 A', w: 38, h: 38, shape: 'round' },
  p17_16: { label: 'P17 16 A', w: 70, h: 70, shape: 'round' }, p17_32: { label: 'P17 32 A', w: 85, h: 85, shape: 'round' }, p17_63: { label: 'P17 63 A', w: 100, h: 100, shape: 'round' }, p17_125: { label: 'P17 125 A', w: 120, h: 120, shape: 'round' },
  socapex19: { label: 'Socapex 19', w: 45, h: 45, shape: 'round' }, harting16: { label: 'Harting 16', w: 60, h: 40, shape: 'rect' }, harting24: { label: 'Harting 24', w: 75, h: 40, shape: 'rect' },
  powerlock: { label: 'Powerlock', w: 45, h: 45, shape: 'round' }, camlock: { label: 'Camlock', w: 40, h: 40, shape: 'round' }, schuko: { label: 'Schuko', w: 40, h: 40, shape: 'round' }
};
export const CATEGORIES = {
  'media-server': 'Serveurs média', switcher: 'Switchers / processeurs vidéo', matrix: 'Matrices', 'led-processor': 'Processeurs LED', converter: 'Convertisseurs',
  extender: 'Extenders / fibre', splitter: 'Splitters / DA', network: 'Réseau', distro: 'Distros', projector: 'Vidéoprojecteurs', camera: 'Caméras', other: 'Divers'
};
export const CATEGORIES_EN = {
  'media-server': 'Media servers', switcher: 'Switchers / video processors', matrix: 'Matrices', 'led-processor': 'LED processors', converter: 'Converters',
  extender: 'Extenders / fibre', splitter: 'Splitters / DA', network: 'Network', distro: 'Distros', projector: 'Projectors', camera: 'Cameras', other: 'Other'
};
export const RU_MM = 44.45, RACK_W_MM = 482.6;

// ------------------------------------------------------------------ definitions
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);

/** A device definition with every field present (unknown = null) and stable port ids. */
export function normalizeDevice(raw, author = 'vbs') {
  const d = raw || {};
  const id = d.id || slug(`${d.brand || ''}-${d.model || ''}`) || 'device';
  const rack = d.rack && num(d.rack.u) ? { u: Math.max(1, Math.round(num(d.rack.u))), width: ['19', 'half', 'third'].includes(String(d.rack.width)) ? String(d.rack.width) : '19' } : null;
  const dims = d.dims ? { w: num(d.dims.w), h: num(d.dims.h), d: num(d.dims.d) } : { w: null, h: null, d: null };
  if (rack && dims.h == null) dims.h = Math.round(rack.u * RU_MM * 10) / 10;
  if (rack && dims.w == null && rack.width === '19') dims.w = RACK_W_MM;
  const seen = new Set();
  const ports = (Array.isArray(d.ports) ? d.ports : []).map((p, i) => {
    let pid = p.id || slug(`${p.group || ''}-${p.label || ''}`) || 'p' + i;
    while (seen.has(pid)) pid += '-' + i;
    seen.add(pid);
    return { id: pid, group: p.group || '', label: p.label || pid, signal: p.signal || null, connector: p.connector || null, dir: ['in', 'out', 'io'].includes(p.dir) ? p.dir : 'io',
      count: Math.max(1, Math.round(num(p.count) || 1)), side: p.side === 'front' ? 'front' : 'rear', modes: Array.isArray(p.modes) ? p.modes : [] };
  });
  return {
    id, brand: d.brand || '', model: d.model || id, category: CATEGORIES[d.category] ? d.category : 'other',
    dims, rack, kg: num(d.kg),
    power: { typ: num(d.power && d.power.typ), max: num(d.power && d.power.max), psu: num(d.power && d.power.psu), connector: (d.power && d.power.connector) || null },
    ports, slots: Array.isArray(d.slots) ? d.slots : [],
    front: d.front || null, rear: d.rear || null,           // face drawings (face editor), null = generated
    src: Array.isArray(d.src) ? d.src : (d.src ? [d.src] : []), notes: d.notes || '',
    author: d.author || author, version: num(d.version) || 1
  };
}

/** Port label of index k in a group: « In 1-8 » → In 1 … In 8 ; « Out » → Out 1 … ; single port keeps its label. */
export function portLabelAt(p, k) {
  if (p.count <= 1) return p.label;
  const m = String(p.label).match(/^(.*?)(\d+)\s*[-–]\s*(\d+)\s*(.*)$/);
  if (m) return `${m[1]}${+m[2] + k}${m[4] ? ' ' + m[4].trim() : ''}`.trim();
  return `${p.label} ${k + 1}`;
}
/** Every single port of a device: { key: 'portId#k', port, k, label, signal, connector, dir, side }. */
export function expandPorts(dev) {
  const out = [];
  for (const p of dev.ports) for (let k = 0; k < p.count; k++) out.push({ key: p.count > 1 ? `${p.id}#${k}` : p.id, port: p, k, label: portLabelAt(p, k), signal: p.signal, connector: p.connector, dir: p.dir, side: p.side });
  return out;
}
/** Library checks: { errors: [], warnings: [] }. VBS devices need size, weight and power; user devices only ports. */
export function validateDevice(dev) {
  const errors = [], warnings = [];
  if (!dev.brand) errors.push('brand');
  if (!dev.model) errors.push('model');
  if (!dev.ports.length) warnings.push('noPorts');
  for (const p of dev.ports) {
    if (p.signal && !SIGNALS[p.signal]) errors.push('signal:' + p.label);
    if (p.connector && !CONNECTORS[p.connector]) errors.push('connector:' + p.label);
    if (!p.signal) warnings.push('noSignal:' + p.label);
  }
  if (dev.author === 'vbs') {
    if (dev.dims.w == null || dev.dims.h == null || dev.dims.d == null) warnings.push('dims');
    if (dev.kg == null) warnings.push('kg');
    if (dev.power.max == null && dev.power.typ == null) warnings.push('power');
  }
  return { errors, warnings };
}

// ------------------------------------------------------------------ links
/**
 * Can port a (from) feed port b (to)? { ok, adapter, warn, reason }. Directions: out → in, io with anything but the
 * same fixed direction. Same family needed (video, LED data, network, sync, control, power); inside video, HDMI ↔ DVI
 * meet directly, DP → HDMI, SDI ↔ HDMI, etc. need an adapter or a converter (flagged); bandwidth drop is a warning.
 */
export function canLink(a, b) {
  if (!a || !b) return { ok: false, reason: 'missing' };
  if (a.dir === 'in' && b.dir === 'in') return { ok: false, reason: 'inIn' };
  if (a.dir === 'out' && b.dir === 'out') return { ok: false, reason: 'outOut' };
  const sa = SIGNALS[a.signal], sb = SIGNALS[b.signal];
  if (!sa || !sb) return { ok: true, warn: 'unknownSignal' };
  if (sa.fam !== sb.fam) return { ok: false, reason: 'family' };
  if (a.signal === b.signal) return { ok: true, adapter: a.connector && b.connector && a.connector !== b.connector };
  let adapter = false, warn = null;
  if (sa.fam === 'video' && sa.sub !== sb.sub) {
    const passive = (sa.sub === 'dp' && sb.sub === 'hdmi') || (sa.sub === 'hdmi' && sb.sub === 'hdmi');
    if (!passive) return { ok: true, adapter: true, warn: 'converter' };   // SDI ↔ HDMI, fibre, HDBaseT: a converter / extender belongs here
    adapter = true;
  }
  if (sa.fam === 'led' && a.signal !== b.signal) return { ok: false, reason: 'ledProtocol' };
  if (sa.gbps && sb.gbps && sb.gbps < sa.gbps) warn = 'bandwidth';
  return { ok: true, adapter: adapter || (a.connector && b.connector && a.connector !== b.connector), warn };
}

// ------------------------------------------------------------------ libraries
const builtin = (LIB.DEVICES || []).map((d) => normalizeDevice(d, 'vbs'));
let user = [];
export function setUserDevices(list) { user = (list || []).map((d) => normalizeDevice({ ...d, author: 'user' }, 'user')); }
export const userDevices = () => user.slice();
export const builtinDevices = () => builtin.slice();
/** Every device known (common + user + the ones of a project), project / user ids win over the common library. */
export function allDevices(p = null) {
  const map = new Map(builtin.map((d) => [d.id, d]));
  for (const d of user) map.set(d.id, d);
  for (const d of (p && p.syn && p.syn.defs) || []) if (!map.has(d.id)) map.set(d.id, normalizeDevice(d, d.author || 'user'));
  return [...map.values()];
}
export const deviceById = (id, p = null) => allDevices(p).find((d) => d.id === id) || null;
export const devicesOf = (cat, p = null) => allDevices(p).filter((d) => d.category === cat).sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
/** Can a device go in the rack plans with its own drawing / 3D? User devices: neutral block when they have a U. */
export const rackMode = (d) => (!d.rack ? 'none' : d.author === 'user' ? 'neutral' : 'full');

// ------------------------------------------------------------------ project part
/** Synoptic and racks of a project (empty, every field present). */
export function newSyn(raw = {}) {
  return {
    devices: Array.isArray(raw.devices) ? raw.devices : [],    // instances { uid, defId, tag, x, y, cfg, hideFree, res { port: '1920×1080p50' }, net { port | '_': { ip, cidr, vlan } }, host, gw }
    links: Array.isArray(raw.links) ? raw.links : [],          // { uid, from: { dev, port }, to: { dev, port }, cable, adapter, style, layer, auto }
    groups: Array.isArray(raw.groups) ? raw.groups : [], texts: Array.isArray(raw.texts) ? raw.texts : [],   // texts = info blocks { uid, kind note | net | res, x, y, title, color, text }
    opts: { overlap: false, arrows: true, route: true, ...(raw.opts || {}) },   // cables: share paths or keep apart, direction arrows, routing around devices
    pages: Array.isArray(raw.pages) ? raw.pages : [], defs: Array.isArray(raw.defs) ? raw.defs : [],   // defs: device definitions embedded in the project
    layers: { video: true, led: true, power: true, net: true, ctrl: true, ...(raw.layers || {}) },
    bundles: Array.isArray(raw.bundles) ? raw.bundles : [],                          // cable bundles made by hand { uid, links: [link uid], label, j1 { x, y } | null, j2 }
    imgs: raw.imgs && typeof raw.imgs === 'object' ? raw.imgs : {},                 // picture per model for the simple view { defId: { data, w, h } }
    meta: { title: '', date: '', client: '', ...(raw.meta || {}) }                     // title block of the exports
  };
}
export function newRack(props = {}) {
  const items = (Array.isArray(props.items) ? props.items : []).filter((it) => it && (it.dev || it.acc)).map((it) => ({ ...(it.acc ? { acc: String(it.acc) } : { dev: String(it.dev) }), u: Math.max(1, Math.round(+it.u || 1)), col: Math.max(0, Math.round(+it.col || 0)), side: it.side === 'rear' ? 'rear' : 'front', bay: Math.max(0, Math.min(2, Math.round(+it.bay || 0))) }));
  return { id: props.id || 'rk_' + Math.random().toString(36).slice(2, 10), name: props.name || 'RACK 1', u: Math.max(1, Math.min(60, Math.round(+props.u || 12))), depth: Math.max(100, +props.depth || 600), width: props.width || '19',
    kind: ['flight', 'bay', 'open'].includes(props.kind) ? props.kind : 'flight', bays: Math.max(1, Math.min(3, Math.round(+props.bays || 1))), kg: +props.kg >= 0 ? +props.kg : 0, note: String(props.note || ''), items };
}
/** Totals of a list of definitions (rack, bill of material): weight, typical / max power, rack units. */
export function totals(defs) {
  let kg = 0, typ = 0, max = 0, u = 0, unknown = 0;
  for (const d of defs) {
    if (d.kg != null) kg += d.kg; else unknown++;
    typ += d.power.typ != null ? d.power.typ : (d.power.max || 0); max += d.power.max != null ? d.power.max : (d.power.typ || 0);
    if (d.rack) u += d.rack.u;
  }
  return { kg: Math.round(kg * 10) / 10, typ: Math.round(typ), max: Math.round(max), u, unknown };
}
