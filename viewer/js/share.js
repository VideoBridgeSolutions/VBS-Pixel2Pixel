// Pixel2Pixel — protected project for technicians (Viewer), shared by the desktop app and Pixel2Pixel Viewer.
//
// A .p2pview file holds a reduced copy of the project (what the Viewer shows: screens with their test pattern, logos and
// texts, data cabling, power, Resolume outputs, 3D stage) encrypted with AES-GCM 256. It cannot be opened, edited or
// exported by Pixel2Pixel (desktop); the sharing secrets, live inputs and recorded 3D takes are not in it.
//   prot 'app'      — app key: stops casual opening / editing (not a secret against a determined developer)
//   prot 'password' — key derived from a password (PBKDF2-SHA256, 250 000 rounds): only who has the password opens it
//   prot 'link'     — live share: random key carried by the link (#s=<id>.<key>), never sent to the server
// AES-GCM also authenticates: a modified file is refused.

export const SHARE_FORMAT = 'p2pview';
export const DEFAULT_VIEWER_URL = 'https://videobridgesolutions.github.io/VBS-Pixel2Pixel/viewer/';
export const DEFAULT_SHARE_SERVER = 'https://p2p-share.phalbig.workers.dev/';   // Cloudflare Worker + R2 (server/cloudflare)
const APP_KEY = 'P2P-VIEWER-1|Video Bridge Solutions|7f3c9a2e5b18d4c6a0e1f2b3c4d5e6f7';
const enc = new TextEncoder(), dec = new TextDecoder();

// ---------------------------------------------------------------- encoding helpers
export function b64u(bytes) {
  let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
/** Random identifier / secret (base64url). */
export const randomToken = (bytes = 16) => b64u(randomBytes(bytes));

async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }

async function aesKey(prot, { password = '', key = '' } = {}, salt) {
  let raw;
  if (prot === 'password') {
    if (!password) throw Object.assign(new Error('password required'), { code: 'password' });
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  if (prot === 'link') {
    if (!key) throw Object.assign(new Error('link key required'), { code: 'key' });
    raw = unb64u(key);
    if (raw.length < 16) throw Object.assign(new Error('bad link key'), { code: 'key' });
    raw = await sha256(raw);
  } else raw = await sha256(enc.encode(APP_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// ---------------------------------------------------------------- content
/** What the Viewer needs, nothing more: no sharing secrets, no live inputs (NDI / capture), no recorded 3D takes.
 *  Screens, logos / texts, outputs and slices stay: the technicians see the test patterns and the outputs as delivered.
 *  brandLock: the sender's licence is Free (the Viewer then draws the Pixel2Pixel output footer, as the app does). */
export function viewerSubset(p, { models = true, brandLock = true } = {}) {
  const c = JSON.parse(JSON.stringify(p));
  delete c.share; delete c.ui; delete c.app;
  if (c.stage) {
    if (!models) c.stage.models = [];
    if (c.stage.video) c.stage.video = {};          // live inputs (NDI / capture) mean nothing on a tablet
    delete c.stage.take;                              // recorded 3D takes stay in the studio
  }
  c._brandLock = brandLock !== false;
  c.viewerOnly = true;
  return c;
}

/** Project -> .p2pview text. prot: 'app' | 'password' | 'link'. */
export async function encodeViewerPackage(project, { prot = 'app', password = '', key = '', rev = 1, models = true, brandLock = true } = {}) {
  const body = enc.encode(JSON.stringify(viewerSubset(project, { models, brandLock })));
  const z = await gzip(body);
  const plain = z || body;
  const salt = randomBytes(16), iv = randomBytes(12);
  const k = await aesKey(prot, { password, key }, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plain));
  return JSON.stringify({ fmt: SHARE_FORMAT, v: 1, app: 'Pixel2Pixel', name: project.name || '', at: new Date().toISOString(), rev, prot,
    ...(prot === 'password' ? { salt: b64u(salt), kdf: 'PBKDF2-SHA256-250000' } : {}), iv: b64u(iv), z: !!z, data: b64u(ct) });
}

export function isViewerPackage(text) {
  if (typeof text !== 'string' || text.length > 2e8) return false;
  const head = text.slice(0, 200);
  return head.includes('"fmt"') && head.includes(SHARE_FORMAT);
}
export function packageInfo(text) { const o = JSON.parse(text); return { name: o.name, at: o.at, rev: o.rev, prot: o.prot }; }

/** .p2pview text -> project. Throws { code: 'password' | 'key' | 'bad' }. */
export async function decodeViewerPackage(text, { password = '', key = '' } = {}) {
  let o;
  try { o = JSON.parse(text); } catch (_) { throw Object.assign(new Error('not a package'), { code: 'bad' }); }
  if (!o || o.fmt !== SHARE_FORMAT) throw Object.assign(new Error('not a package'), { code: 'bad' });
  const k = await aesKey(o.prot, { password, key }, o.salt ? unb64u(o.salt) : null);
  let plain;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(o.iv) }, k, unb64u(o.data))); } catch (_) {
    throw Object.assign(new Error(o.prot === 'password' ? 'wrong password' : 'damaged or modified file'), { code: o.prot === 'password' ? 'password' : 'bad' });
  }
  if (o.z) plain = await gunzip(plain);
  const p = JSON.parse(dec.decode(plain));
  p.viewerOnly = true;   // p._brandLock: read by the Viewer before normalizeProject
  return { project: p, meta: { name: o.name, at: o.at, rev: o.rev, prot: o.prot } };
}

// ---------------------------------------------------------------- live share link
/** Viewer link of a live share: the key stays in the #fragment (browsers never send it to a server).
 *  The server rides along (g=<Apps Script deployment> or u=<server URL>) so a link works whatever server the Viewer was built with. */
export function shareLink(share, viewerUrl = DEFAULT_VIEWER_URL, server = '') {
  const srv = String(server || '');
  const g = (srv.match(/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]{20,})\/exec/) || [])[1];
  const tail = g ? '&g=' + g : (srv && srv !== DEFAULT_SHARE_SERVER ? '&u=' + b64u(enc.encode(srv)) : '');
  return `${String(viewerUrl || DEFAULT_VIEWER_URL).replace(/#.*$/, '')}#s=${share.id}.${share.key}${tail}`;
}
/** Share servers a link may point to (an arbitrary URL in a link must not make the Viewer talk to any host). */
export function allowedServer(url) {
  return /^https:\/\/(script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec|[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev\/?|([a-z0-9-]+\.)*videobridgesolutions\.com\/)/i.test(String(url || ''));
}
export function parseShareHash(hash) {
  const m = String(hash || '').match(/[#&]s=([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{20,128})/);
  if (!m) return null;
  const g = (String(hash).match(/[#&]g=([A-Za-z0-9_-]{20,})/) || [])[1];
  const u = (String(hash).match(/[#&]u=([A-Za-z0-9_-]{8,400})/) || [])[1];
  let server = DEFAULT_SHARE_SERVER;
  if (g) server = `https://script.google.com/macros/s/${g}/exec`;
  else if (u) { try { const x = dec.decode(unb64u(u)); if (allowedServer(x)) server = x; } catch (_) { /* default */ } }
  return { id: m[1], key: m[2], server };
}
export function newShare() { return { id: randomToken(15), key: randomToken(24), token: randomToken(24), auto: true, rev: 0, at: null }; }
