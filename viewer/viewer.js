// Pixel2Pixel Viewer — read-only companion for iPad / iPhone (and any browser).
// Opens a .p2pmap project, keeps recent projects offline (IndexedDB) and shows, screen by screen,
// the data cabling and power plans drawn by the same engine as the desktop app, with the port / circuit tables.
import * as M from './js/model.js';
import { drawSurface } from './js/render.js';
import { portRows, circuitRows } from './js/export.js';
import { Renderer } from './js/render.js';
import * as SHR from './js/share.js';

const VERSION = '0.3.2';
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

// ------------------------------------------------------------------ i18n
const DICT = {
  fr: {
    open: 'Ouvrir un projet', demo: 'Voir le projet de démo', demoErr: 'Projet de démo indisponible', heroTitle: 'Pixel<span>2</span>Pixel Viewer', heroText: 'Les plans de câblage data et d\'alimentation de chaque écran, sur iPad ou iPhone, même sans réseau. Ouvre le fichier .p2pmap préparé dans Pixel2Pixel.',
    drop: 'Dépose un fichier .p2pmap ici, ou touche « Ouvrir un projet ».', recent: 'Projets récents (disponibles hors ligne)', none: 'Aucun projet récent.',
    screens: 'écrans', ports: 'ports', circuits: 'circuits', procs: 'processeurs', kw: 'kW max', tiles: 'dalles', search: 'Rechercher un écran…', noGroup: 'Sans groupe',
    data: 'Data', power: 'Alim', pattern: 'Mire', info: 'Écran', size: 'Résolution', grid: 'Dalles', model: 'Modèle', pitch: 'Pitch', phys: 'Taille', weight: 'Poids', wmax: 'Conso max',
    port: 'Port', backup: 'Secours', proc: 'Proc.', load: 'Charge', path: 'Départ → fin', circuit: 'Circuit', phase: 'Phase', multi: 'Multi', amps: 'A', watts: 'W',
    noPorts: 'Pas de câblage data pour cet écran.', noCircuits: 'Pas de circuit : la consommation des dalles n\'est pas renseignée.', fit: 'Ajuster', full: 'Plein écran', pwdTitle: 'Projet protégé', pwdText: 'Ce projet est protégé par un mot de passe. Demande-le à la personne qui te l\'a envoyé.', pwdLabel: 'Mot de passe', pwdOk: 'Ouvrir', cancel: 'Annuler', pwdBad: 'Mot de passe incorrect', badFile: 'Fichier endommagé ou modifié : il ne peut pas être ouvert', protected: 'Protégé', live: 'En direct', liveAt: 'à jour', offline: 'Hors ligne', updated: 'Projet mis à jour par le bureau d\'études (rév. {n})', shareGone: 'Ce partage a été arrêté : la dernière version reçue reste disponible.', shareErr: 'Lien de partage indisponible', noServer: 'Serveur de partage non configuré', loadingShare: 'Récupération du projet partagé…', rev: 'rév.', stage: 'Scène 3D', stageOpen: 'Voir la scène 3D', stageText: 'Mise en situation de tous les écrans, avec les points de vue enregistrés dans le projet.', views: 'Points de vue', vPersp: 'Perspective', vFront: 'Public', vFoh: 'Régie', vTop: 'Dessus', vSide: 'Côté', playSeq: 'Séquence moteurs', stopSeq: 'Stop', loading3d: 'Chargement de la 3D…', err3d: 'La 3D n\'est pas disponible sur cet appareil', screensBtn: 'Écrans', loadErr: 'Fichier illisible', opened: 'Projet ouvert', removed: 'Retiré de la liste',
    opened_at: 'ouvert le', readOnly: 'Lecture seule — les modifications se font dans Pixel2Pixel sur ordinateur.', redund: 'Redondance', mains: 'Arrivée', saved: 'Gardé sur cet appareil'
  },
  en: {
    open: 'Open a project', demo: 'See the demo project', demoErr: 'Demo project unavailable', heroTitle: 'Pixel<span>2</span>Pixel Viewer', heroText: 'The data cabling and power plans of every screen, on iPad or iPhone, even offline. Open the .p2pmap file prepared in Pixel2Pixel.',
    drop: 'Drop a .p2pmap file here, or tap “Open a project”.', recent: 'Recent projects (available offline)', none: 'No recent project.',
    screens: 'screens', ports: 'ports', circuits: 'circuits', procs: 'processors', kw: 'kW max', tiles: 'cabinets', search: 'Search a screen…', noGroup: 'No group',
    data: 'Data', power: 'Power', pattern: 'Pattern', info: 'Screen', size: 'Resolution', grid: 'Cabinets', model: 'Model', pitch: 'Pitch', phys: 'Size', weight: 'Weight', wmax: 'Max power',
    port: 'Port', backup: 'Backup', proc: 'Proc.', load: 'Load', path: 'Start → end', circuit: 'Circuit', phase: 'Phase', multi: 'Multi', amps: 'A', watts: 'W',
    noPorts: 'No data cabling for this screen.', noCircuits: 'No circuit: the cabinet power is not set.', fit: 'Fit', full: 'Full screen', pwdTitle: 'Protected project', pwdText: 'This project is protected by a password. Ask the person who sent it.', pwdLabel: 'Password', pwdOk: 'Open', cancel: 'Cancel', pwdBad: 'Wrong password', badFile: 'Damaged or modified file: it cannot be opened', protected: 'Protected', live: 'Live', liveAt: 'up to date', offline: 'Offline', updated: 'Project updated by the design office (rev. {n})', shareGone: 'This share was stopped: the last version received stays available.', shareErr: 'Share link unavailable', noServer: 'Share server not configured', loadingShare: 'Fetching the shared project…', rev: 'rev.', stage: '3D stage', stageOpen: 'See the 3D stage', stageText: 'All screens in place, with the viewpoints saved in the project.', views: 'Viewpoints', vPersp: 'Perspective', vFront: 'Audience', vFoh: 'FOH', vTop: 'Top', vSide: 'Side', playSeq: 'Motor sequence', stopSeq: 'Stop', loading3d: 'Loading 3D…', err3d: '3D is not available on this device', screensBtn: 'Screens', loadErr: 'Unreadable file', opened: 'Project opened', removed: 'Removed from the list',
    opened_at: 'opened', readOnly: 'Read only — edits are made in Pixel2Pixel on a computer.', redund: 'Redundancy', mains: 'Mains', saved: 'Kept on this device'
  }
};
let lang = (() => { try { return localStorage.getItem('p2pv.lang') || (navigator.language || 'fr').slice(0, 2); } catch (_) { return 'fr'; } })();
if (!DICT[lang]) lang = 'en';
const t = (k) => (DICT[lang] && DICT[lang][k]) || DICT.en[k] || k;
const fmt = (n, d = 0) => (Number(n) || 0).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
const tileRef = (tl) => (tl ? `C${tl.c + 1}·R${tl.r + 1}` : '—');
function toast(msg, kind = '') {
  const el = h('div', { class: 'toast ' + kind }, msg);
  document.body.append(el); setTimeout(() => el.remove(), 3200);
}

// ------------------------------------------------------------------ offline store (IndexedDB, falls back to memory)
const DB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('p2p-viewer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const x = db.transaction('projects', mode); const st = x.objectStore('projects'); const out = fn(st); x.oncomplete = () => res(out && out.result !== undefined ? out.result : out); x.onerror = () => rej(x.error); }); };
  const mem = new Map();
  return {
    async list() { try { return (await tx('readonly', (st) => st.getAll())) || []; } catch (_) { return [...mem.values()]; } },
    async put(rec) { mem.set(rec.id, rec); try { await tx('readwrite', (st) => st.put(rec)); } catch (_) { /* memory only */ } },
    async get(id) { try { return await tx('readonly', (st) => st.get(id)); } catch (_) { return mem.get(id); } },
    async del(id) { mem.delete(id); try { await tx('readwrite', (st) => st.delete(id)); } catch (_) { /* memory only */ } }
  };
})();

// ------------------------------------------------------------------ state
const S = { p: null, rec: null, screen: null, tab: 'data', q: '', view3d: false };

function loadProject(text, name) {
  const raw = JSON.parse(text);
  const p = M.normalizeProject(raw);
  p.surfaces = p.surfaces.filter((s) => s.kind !== 'proj');
  return p;
}
/** Ask a password in the page (iOS: no prompt()). Resolves null when cancelled. */
function askPassword(name, bad) {
  return new Promise((res) => {
    const inp = h('input', { type: 'password', class: 'search', autocomplete: 'off', placeholder: t('pwdLabel') });
    const done = (v) => { ov.remove(); res(v); };
    const ov = h('div', { class: 'modal-ov' }, h('form', { class: 'modal', onsubmit: (e) => { e.preventDefault(); done(inp.value); } },
      h('h3', {}, t('pwdTitle')), h('div', { class: 'note' }, name || ''), h('p', { class: 'note' }, t('pwdText')),
      bad ? h('div', { class: 'warnline' }, t('pwdBad')) : null, inp,
      h('div', { class: 'mbtns' }, h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, t('cancel')), h('button', { type: 'submit', class: 'btn primary' }, t('pwdOk')))));
    document.body.append(ov); setTimeout(() => inp.focus(), 50);
  });
}
/** Text of a .p2pmap or a protected .p2pview -> { project, meta }. rec may carry a stored password / link key. */
async function decodeAny(text, name, rec = {}) {
  if (!SHR.isViewerPackage(text)) return { project: loadProject(text, name), meta: null };
  const info = SHR.packageInfo(text);
  let password = rec.password || '', bad = false;
  for (;;) {
    if (info.prot === 'password' && !password) { password = await askPassword(info.name || name, bad); if (password == null) return null; }
    try {
      const r = await SHR.decodeViewerPackage(text, { password, key: rec.share ? rec.share.key : '' });
      const p = M.normalizeProject(r.project); p.surfaces = p.surfaces.filter((s) => s.kind !== 'proj'); p.viewerOnly = true;
      return { project: p, meta: r.meta, password };
    } catch (e) {
      if (e.code === 'password' && info.prot === 'password') { password = ''; bad = true; continue; }
      throw new Error(t('badFile'));
    }
  }
}
async function openText(text, name, keep = true, extra = {}) {
  let r;
  try { r = await decodeAny(text, name, extra); } catch (e) { toast(t('loadErr') + ' — ' + (e.message || e), 'err'); return; }
  if (!r) return;
  const p = r.project;
  const id = extra.share ? 'share:' + extra.share.id : (name || p.name || 'projet').toLowerCase();
  const rec = { id, name: name || p.name, project: p.name, at: Date.now(), text, screens: p.surfaces.length, prot: r.meta ? r.meta.prot : null,
    ...(r.password ? { password: r.password } : {}), ...(extra.share ? { share: extra.share } : {}) };
  if (keep) await DB.put(rec);
  S.p = p; S.rec = rec; S.screen = null; S.q = ''; S.view3d = false; ST.synced = null; S.pv = {};
  history.pushState({ v: 'project' }, '');
  render();
  if (rec.share) checkShare(true);
}
// ------------------------------------------------------------------ live share: the project follows the design office
const LIVE = { timer: 0, busy: false, ok: null, at: 0, gone: false };
async function shareFetch(share, rev) {
  const srv = share.server || SHR.DEFAULT_SHARE_SERVER;
  if (!srv) throw new Error(t('noServer'));
  if (!SHR.allowedServer(srv)) throw new Error(t('noServer'));
  const r = await fetch(`${srv}${srv.includes('?') ? '&' : '?'}a=get&id=${encodeURIComponent(share.id)}&rev=${rev || 0}&_=${Date.now()}`, { cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('HTTP ' + r.status);
  return j;
}
async function openShareLink(sh) {
  const box = h('div', { class: 'toast' }, t('loadingShare')); document.body.append(box);
  try {
    const old = await DB.get('share:' + sh.id);
    const j = await shareFetch(sh, 0).catch((e) => { if (old) return { ok: false, offline: true }; throw e; });
    if (j && j.ok && j.data) await openText(j.data, null, true, { share: { ...sh, rev: j.rev, at: j.at } });
    else if (old) await openText(old.text, old.name, true, { share: old.share, password: old.password });
    else throw new Error(j && j.error === 'not_found' ? t('shareGone') : (j && j.error) || '?');
  } catch (e) { toast(t('shareErr') + ' — ' + (e.message || e), 'err'); }
  finally { box.remove(); }
}
/** Ask the share server for a newer revision; apply it in place (same screen, same 3D view, same zoom). */
async function checkShare(force) {
  const rec = S.rec; if (!rec || !rec.share || LIVE.busy) return;
  if (!force && (document.visibilityState !== 'visible' || navigator.onLine === false)) return;
  LIVE.busy = true;
  try {
    const j = await shareFetch(rec.share, rec.share.rev || 0);
    if (!j.ok) { LIVE.ok = false; LIVE.gone = j.error === 'not_found'; if (LIVE.gone && force) toast(t('shareGone')); return; }
    LIVE.ok = true; LIVE.at = Date.now(); LIVE.gone = false;
    if (!j.same && j.data && S.rec === rec) {
      const r = await decodeAny(j.data, rec.name, rec);
      if (!r || S.rec !== rec) return;
      rec.text = j.data; rec.share = { ...rec.share, rev: j.rev, at: j.at }; rec.at = Date.now(); rec.screens = r.project.surfaces.length; rec.project = r.project.name;
      await DB.put(rec);
      const sid = S.screen && S.screen.id;
      S.p = r.project; ST.synced = null;
      if (sid) S.screen = S.p.surfaces.find((x) => x.id === sid) || null;
      toast(t('updated').replace('{n}', j.rev));
      render();
    }
  } catch (_) { LIVE.ok = false; }
  finally { LIVE.busy = false; liveBadge(); }
}
function liveBadge() {
  const el = $('#live'); if (!el) return;
  const rec = S.rec;
  if (!S.p || !rec || (!rec.share && !rec.prot)) { el.hidden = true; return; }
  el.hidden = false;
  if (!rec.share) { el.className = 'live prot'; el.textContent = '🔒 ' + t('protected'); return; }
  const on = LIVE.ok && !LIVE.gone;
  el.className = 'live ' + (on ? 'on' : 'off');
  const rv = rec.share.rev ? ` · ${t('rev')} ${rec.share.rev}` : '';
  el.textContent = (on ? '● ' + t('live') : '○ ' + t('offline')) + rv;
}
setInterval(() => checkShare(false), 45000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkShare(false); });
window.addEventListener('online', () => checkShare(false));
async function openDemo() {
  try { const r = await fetch('demo.p2pmap', { cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status); await openText(await r.text(), 'FESTIVAL MAIN STAGE (démo)', false); } catch (e) { toast(t('demoErr') + ' — ' + (e.message || e), 'err'); }
}
async function openFile(f) {
  if (!f) return;
  const text = await f.text();
  await openText(text, f.name.replace(/\.(p2pmap|p2pview|vbsmap|json)$/i, ''));
}

// ------------------------------------------------------------------ plan rendering (same engine as the desktop app)
const MAX_PX = 12e6, MAX_SIDE = 4096;   // iOS canvas limits (≈16.7 Mpx per canvas)
function styleFor(tab) {
  if (tab === 'data') return { cabling: true, powerPath: false, cablingLabels: true, cablingUsage: true, cablingDim: 0.55, cablingWidth: 1.6 };
  if (tab === 'power') return { cabling: false, powerPath: true, cablingLabels: true, cablingDim: 0.55, cablingWidth: 1.6 };
  return { cabling: false, powerPath: false };
}
function renderSurface(p, s, tab, maxSide = MAX_SIDE, canvas = null) {
  const k = Math.min(1, maxSide / Math.max(s.w, s.h), Math.sqrt(MAX_PX / (s.w * s.h)));
  const c = canvas || document.createElement('canvas');
  c.width = Math.max(1, Math.round(s.w * k)); c.height = Math.max(1, Math.round(s.h * k));
  const ctx = c.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const st = { ...M.effStyle(p, s), ...styleFor(tab), anim: { ...(M.effStyle(p, s).anim || {}), enabled: false } };
  try { drawSurface(ctx, s, st, null, p); } catch (e) { console.warn('render', s.name, e); }
  c.dataset.k = k;
  return c;
}

// ------------------------------------------------------------------ views
function render() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('#lang button').forEach((b) => b.classList.toggle('on', b.dataset.l === lang));
  const main = $('#main');
  main.className = '';
  main.innerHTML = '';
  $('#btnBack').hidden = !S.p;
  $('#title').textContent = S.p ? (S.screen ? S.screen.name : S.view3d ? t('stage') : S.p.name) : '';
  liveBadge();
  if (ST.stage && !S.view3d) { ST.stage.deactivate(); stopSeq(); }
  if (!S.p) return renderHome(main);
  if (S.view3d) return renderStage(main);
  if (S.screen) return renderPlan(main);
  return renderProject(main);
}

async function renderHome(main) {
  const drop = h('div', { class: 'drop' }, t('drop'));
  const hero = h('div', { class: 'hero' }, h('img', { src: 'icon-192.png', alt: '' }));
  const h1 = h('h1'); h1.innerHTML = t('heroTitle');
  hero.append(h1, h('p', {}, t('heroText')),
    h('div', { class: 'hero-btns' },
      h('label', { class: 'btn primary' }, h('input', { type: 'file', hidden: true, onchange: (e) => openFile(e.target.files[0]) }), t('open')),
      h('button', { class: 'btn', onclick: openDemo }, t('demo'))), drop);
  const list = (await DB.list()).sort((a, b) => b.at - a.at);
  const rec = h('div', { class: 'recent' }, h('h2', {}, t('recent')),
    list.length ? h('div', { class: 'rlist' }, list.map((r) => h('div', { class: 'ritem', onclick: () => openText(r.text, r.name, true, { share: r.share, password: r.password }) },
      h('div', { class: 'grow' }, h('b', {}, r.project || r.name), h('div', { class: 'meta' }, `${r.share ? '● ' + t('live') + ' · ' : r.prot ? '🔒 ' : ''}${r.screens} ${t('screens')} · ${t('opened_at')} ${new Date(r.at).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`)),
      h('button', { class: 'del', 'aria-label': 'remove', onclick: async (e) => { e.stopPropagation(); await DB.del(r.id); toast(t('removed')); render(); } }, '✕')))) : h('div', { class: 'note' }, t('none')));
  main.append(hero, rec);
  ['dragenter', 'dragover'].forEach((ev) => main.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => main.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  main.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
}

function renderProject(main) {
  const p = S.p;
  const sum = M.cablingSummary(p);
  main.append(h('div', { class: 'kpis' },
    kpi(p.surfaces.length, t('screens')), kpi(sum.tiles, t('tiles')), kpi(sum.ports, t('ports')), kpi(sum.procs || 0, t('procs')), kpi(sum.circuits, t('circuits')), kpi(fmt((sum.wattsMax || 0) / 1000, 1), t('kw'))));
  main.append(h('button', { class: 'stagecard', onclick: () => { S.view3d = true; history.pushState({ v: 'stage' }, ''); render(); } },
    h('div', { class: 'ic3d' }), h('div', { class: 'grow' }, h('b', {}, t('stageOpen')), h('div', { class: 'meta' }, t('stageText'))), h('span', { class: 'chev' }, '›')));
  main.querySelector('.ic3d').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/></svg>';
  const search = h('input', { class: 'search', type: 'search', placeholder: t('search'), value: S.q });
  const wrap = h('div');
  const fill = () => {
    wrap.innerHTML = '';
    const q = S.q.trim().toLowerCase();
    const list = p.surfaces.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.group || '').toLowerCase().includes(q));
    const groups = [...new Set(list.map((s) => s.group || ''))];
    for (const g of groups) {
      const mem = list.filter((s) => (s.group || '') === g);
      if (groups.length > 1 || g) wrap.append(h('div', { class: 'group' }, g || t('noGroup'), ` · ${mem.length}`));
      wrap.append(h('div', { class: 'cards' }, mem.map((s) => card(p, s))));
    }
  };
  search.addEventListener('input', () => { S.q = search.value; fill(); });
  main.append(search, wrap, h('p', { class: 'note', style: { marginTop: '18px' } }, t('readOnly') + ` · Viewer v${VERSION} (prototype)`));
  fill();
}
const kpi = (v, l) => h('div', { class: 'kpi' }, h('div', { class: 'v' }, typeof v === 'number' ? fmt(v) : v), h('div', { class: 'l' }, l));
function card(p, s) {
  const st = M.surfaceStats(p, s), ti = M.tileInfo(s);
  const c = renderSurface(p, s, 'pattern', 260);
  return h('button', { class: 'card', onclick: () => { S.screen = s; S.tab = S.tab || 'data'; history.pushState({ v: 'plan' }, ''); render(); } }, c,
    h('div', { class: 'grow' }, h('b', {}, s.name), h('div', { class: 'meta' }, `${s.w}×${s.h} px · ${ti.cols}×${ti.rows}`),
      h('div', {}, h('span', { class: 'chip' }, `${st.ports} ${t('ports')}`), h('span', { class: 'chip' }, `${st.circuits} ${t('circuits')}`))));
}

function renderPlan(main) {
  const p = S.p, s = S.screen;
  main.className = 'plan-mode';
  const box = h('div', { class: 'stagebox' });
  const tabs = h('div', { class: 'seg ptabs' }, [['data', t('data')], ['power', t('power')], ['pattern', t('pattern')]].map(([k, l]) =>
    h('button', { class: S.tab === k ? 'on' : '', onclick: () => { S.tab = k; render(); } }, l)));
  const src = renderSurface(p, s, S.tab);              // full plan, off screen (≤ 12 Mpx)
  // what is shown: a canvas the size of the view, redrawn at each move (iOS cannot composite a huge scaled canvas)
  const cv = h('canvas', { class: 'view' });
  const ctx = cv.getContext('2d');
  const view = { s: 1, x: 0, y: 0 };
  let raf = 0;
  const W = () => box.clientWidth, H = () => box.clientHeight;
  const draw = () => {
    raf = 0;
    const dpr = Math.min(3, window.devicePixelRatio || 1), bw = W(), bh = H();
    if (cv.width !== Math.round(bw * dpr) || cv.height !== Math.round(bh * dpr)) { cv.width = Math.round(bw * dpr); cv.height = Math.round(bh * dpr); cv.style.width = bw + 'px'; cv.style.height = bh + 'px'; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0B0D10'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.x, dpr * view.y);
    ctx.imageSmoothingEnabled = view.s * dpr < 1.5; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
    ctx.strokeRect(view.x - 0.5, view.y - 0.5, src.width * view.s + 1, src.height * view.s + 1);
  };
  const clamp = () => {
    // the plan never leaves the screen: at least half of the view (or the whole plan when smaller) stays covered
    const bw = W(), bh = H(), w = src.width * view.s, hh = src.height * view.s;
    const mx = Math.min(w, bw) * 0.5, my = Math.min(hh, bh) * 0.5;
    view.x = Math.min(bw - mx, Math.max(mx - w, view.x));
    view.y = Math.min(bh - my, Math.max(my - hh, view.y));
  };
  const apply = () => { clamp(); if (!raf) raf = requestAnimationFrame(draw); };
  const fitScale = () => { const fs = document.body.classList.contains('fs'), top = fs ? 16 : 64; return Math.min((W() - 32) / src.width, (H() - top - 16) / src.height); };
  const fit = () => {
    const fs = document.body.classList.contains('fs'), top = fs ? 16 : 64;
    view.s = fitScale(); view.x = (W() - src.width * view.s) / 2; view.y = top + (H() - top - 16 - src.height * view.s) / 2;
    apply();
  };
  const zoomAt = (f, cx, cy) => {
    const ns = Math.min(fitScale() * 30, Math.max(fitScale() * 0.5, view.s * f));
    const r = ns / view.s; view.x = cx - (cx - view.x) * r; view.y = cy - (cy - view.y) * r; view.s = ns; apply();
  };
  // touch / mouse: one finger pans, two fingers pinch, double tap zooms in / back to fit, wheel zooms
  const pos = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const pts = new Map(); let last = null, lastTap = 0;
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .seg')) return;
    try { box.setPointerCapture(e.pointerId); } catch (_) { /* old Safari */ }
    const pt = pos(e); pts.set(e.pointerId, pt); last = null;
    if (pts.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { if (view.s > fitScale() * 1.3) fit(); else zoomAt(3, pt[0], pt[1]); lastTap = 0; } else lastTap = now;
    }
  });
  box.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, pos(e));
    const a = [...pts.values()];
    const cur = a.length >= 2 ? { x: (a[0][0] + a[1][0]) / 2, y: (a[0][1] + a[1][1]) / 2, d: Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]) } : { x: a[0][0], y: a[0][1], d: 0 };
    if (last && last.n === a.length) {
      view.x += cur.x - last.x; view.y += cur.y - last.y;
      if (a.length >= 2 && last.d > 0) zoomAt(cur.d / last.d, cur.x, cur.y); else apply();
    }
    last = { ...cur, n: a.length };
  });
  const up = (e) => { pts.delete(e.pointerId); last = null; };
  box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
  box.addEventListener('wheel', (e) => { e.preventDefault(); const pt = pos(e); zoomAt(Math.exp(-e.deltaY * 0.0015), pt[0], pt[1]); }, { passive: false });
  ['gesturestart', 'gesturechange'].forEach((ev) => box.addEventListener(ev, (e) => e.preventDefault()));   // Safari: no page zoom
  const toggleFs = () => {
    const on = !document.body.classList.contains('fs');
    document.body.classList.toggle('fs', on);
    try { if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (_) { /* iPhone: CSS full screen only */ }
    fsBtn.innerHTML = on ? ICON_SHRINK : ICON_EXPAND;
    requestAnimationFrame(() => requestAnimationFrame(fit));
  };
  const fsBtn = h('button', { class: 'ic', title: t('full'), onclick: toggleFs }); fsBtn.innerHTML = document.body.classList.contains('fs') ? ICON_SHRINK : ICON_EXPAND;
  box.append(cv, tabs, h('div', { class: 'zoombtns' },
    fsBtn,
    h('button', { class: 'ic', 'aria-label': '+', onclick: () => zoomAt(1.6, W() / 2, H() / 2) }, '+'),
    h('button', { class: 'ic', 'aria-label': '−', onclick: () => zoomAt(1 / 1.6, W() / 2, H() / 2) }, '−'),
    h('button', { class: 'ic', title: t('fit'), onclick: fit }, h('span', { class: 'fit' }, '⤢'))));
  main.append(h('div', { class: 'plan' }, box, sidePanel(p, s)));
  const pvKey = s.id + '|' + S.tab;
  S.pv = S.pv || {};
  const savedPv = S.pv[pvKey];
  const keep = () => { S.pv[pvKey] = { ...view }; };
  box.addEventListener('pointerup', keep); box.addEventListener('wheel', keep); box.addEventListener('click', keep);
  requestAnimationFrame(() => { if (savedPv && savedPv.w === W() && savedPv.h === H()) { Object.assign(view, savedPv); apply(); } else fit(); view.w = W(); view.h = H(); });
  window.onresize = () => requestAnimationFrame(() => { fit(); view.w = W(); view.h = H(); });
}
const ICON_EXPAND = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_SHRINK = '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

// ------------------------------------------------------------------ 3D stage (same engine as the desktop app, read only)
const ST = { stage: null, canvas: null, loading: null, synced: null, seq: null, R: null };
const hooks = {
  getProject: () => S.p, renderer: null, getSelection: () => new Set(), select: () => {}, edit: () => {}, commit: () => {},
  getVideo: () => null, getNdiFrame: () => null, ndiKeep: () => {}, onCamera: () => {}, contextMenu: () => {},
  getProjSel: () => null, getPersonSel: () => null, selectProjector: () => {}, selectPerson: () => {}, onProjection: () => {},
  onModelLoaded: () => {}, onModelError: () => {}
};
/** Screens never placed in 3D get the desktop app's automatic layout (from the composition). */
function ensurePlaced(p) {
  const un = p.surfaces.filter((s) => !s.stage || !s.stage.placed);
  if (!un.length) return;
  if (un.length === p.surfaces.length) { M.stageFromComp(p, un.map((s) => s.id), 0, 0); return; }
  let right = -Infinity;
  for (const s of p.surfaces) if (s.stage.placed) right = Math.max(right, s.stage.x + M.surfaceMeters(p, s).w / 2);
  if (!Number.isFinite(right)) right = 0;
  for (const s of un) { const m = M.surfaceMeters(p, s); s.stage = { ...s.stage, placed: true, x: right + 0.5 + m.w / 2, y: m.h / 2, z: 0, rx: 0, ry: 0, rz: 0 }; right += m.w + 0.5; }
}
async function getStage() {
  if (ST.stage) return ST.stage;
  if (!ST.loading) ST.loading = import('./js/stage3d.js').then((mod) => {
    ST.canvas = h('canvas', { class: 'c3d' });
    ST.R = new Renderer(() => {});
    hooks.renderer = ST.R;
    ST.stage = new mod.Stage3D(ST.canvas, hooks);
    ST.stage.setTool('none');
    return ST.stage;
  });
  return ST.loading;
}
function renderStage(main) {
  const p = S.p;
  main.className = 'plan-mode';
  const box = h('div', { class: 'stagebox s3d' }, h('div', { class: 'loading3d' }, t('loading3d')));
  main.append(h('div', { class: 'plan one' }, box));
  getStage().then((stage) => {
    if (!S.view3d || !box.isConnected) return;
    box.innerHTML = '';
    box.append(ST.canvas);
    if (ST.synced !== p) { ensurePlaced(p); ST.R.syncLogos(p.logos || []); ST.synced = p; ST.stage.framedOnce = false; }
    stage.setPresentation(true);
    stage.activate();
    stage.sync();
    // viewpoints: presets + the cameras saved in the project
    const presets = [['persp', t('vPersp')], ['front', t('vFront')], ['foh', t('vFoh')], ['top', t('vTop')], ['side', t('vSide')]];
    const views = h('div', { class: 'views3d' }, presets.map(([v, l]) => h('button', { class: 'vbtn', onclick: () => stage.goView(v, true, 1600, { arc: true, ease: 'smooth' }) }, l)),
      (p.stage.views || []).map((v) => h('button', { class: 'vbtn saved', onclick: () => stage.goView(v, true, Number.isFinite(+v.dur) ? +v.dur * 1000 : 2000, { arc: true, ease: 'smooth' }) }, v.name)));
    const cues = (p.stage.cues || []);
    const seqBtn = cues.length && M.motionObjects(p).length ? h('button', { class: 'btn seq', onclick: () => (ST.seq ? stopSeq() : playSeq(seqBtn)) }, '▶ ' + t('playSeq')) : null;
    const fsBtn = h('button', { class: 'ic', title: t('full'), onclick: () => { const on = !document.body.classList.contains('fs'); document.body.classList.toggle('fs', on); fsBtn.innerHTML = on ? ICON_SHRINK : ICON_EXPAND; } });
    fsBtn.innerHTML = document.body.classList.contains('fs') ? ICON_SHRINK : ICON_EXPAND;
    box.append(views, h('div', { class: 'zoombtns' }, fsBtn), seqBtn ? h('div', { class: 'seqbar' }, seqBtn) : null);
  }).catch((e) => { console.warn(e); box.innerHTML = ''; box.append(h('div', { class: 'loading3d err' }, t('err3d') + ' — ' + (e.message || e))); });
}
/** Motor cue list played as in the desktop app: each cue from the reached position, motor speeds respected, S-curve. */
function stopSeq() { if (ST.seq) ST.seq.stop = true; }
async function playSeq(btn) {
  const p = S.p, stage = ST.stage; if (!stage) return;
  const cues = p.stage.cues || []; if (!cues.length) return;
  const run = ST.seq = { stop: false };
  if (btn) btn.textContent = '■ ' + t('stopSeq');
  const tween = (target, fade) => new Promise((res) => {
    const T = M.motionTravel(p, target, fade), tracks = [];
    for (const o of M.motionObjects(p)) { const tg = target[o.key]; if (!tg) continue; for (const a of o.axes) { if (!(a.axis in tg)) continue; const lo = Math.min(+a.min || 0, +a.max || 0), hi = Math.max(+a.min || 0, +a.max || 0); tracks.push({ h: o.holder, k: a.axis, a: +o.holder[a.axis] || 0, b: Math.min(hi, Math.max(lo, +tg[a.axis] || 0)) }); } }
    const t0 = performance.now();
    const step = () => { const u = T > 0 ? (performance.now() - t0) / (T * 1000) : 1; const e = M.motionEase(u); for (const tr of tracks) tr.h[tr.k] = tr.a + (tr.b - tr.a) * e; stage.syncTransforms(); if (u >= 1 || run.stop) res(); else requestAnimationFrame(step); };
    step();
  });
  const sleep = (ms) => new Promise((r) => { const t0 = performance.now(); const tick = () => (run.stop || performance.now() - t0 >= ms ? r() : setTimeout(tick, 30)); tick(); });
  do {
    for (const c of cues) { if (run.stop) break; await tween(c.pos || {}, +c.fade || 0); if (run.stop) break; await sleep((+c.wait || 0) * 1000); }
  } while (!run.stop && p.stage.motionLoop);
  if (ST.seq === run) ST.seq = null;
  if (btn && btn.isConnected) btn.textContent = '▶ ' + t('playSeq');
}

function sidePanel(p, s) {
  const st = M.surfaceStats(p, s), ti = M.tileInfo(s), pn = s.panel;
  const side = h('div', { class: 'side' },
    h('h3', {}, s.name),
    h('div', { class: 'note' }, s.group || ''),
    h('div', { class: 'kv' },
      h('span', {}, t('size')), h('span', {}, `${s.w} × ${s.h} px`),
      h('span', {}, t('grid')), h('span', {}, `${ti.cols} × ${ti.rows} (${fmt(st.tiles)})`),
      pn ? [h('span', {}, t('model')), h('span', {}, `${pn.brand || ''} ${pn.model || ''}`.trim())] : null,
      s.pitch ? [h('span', {}, t('pitch')), h('span', {}, fmt(s.pitch, 2) + ' mm')] : null,
      [h('span', {}, t('phys')), h('span', {}, M.physicalSize(s) || '—')],
      st.kg ? [h('span', {}, t('weight')), h('span', {}, fmt(st.kg) + ' kg')] : null,
      st.wattsMax ? [h('span', {}, t('wmax')), h('span', {}, fmt(st.wattsMax / 1000, 2) + ' kW')] : null));
  if (S.tab === 'data' || S.tab === 'pattern') side.append(h('h2', {}, `${t('ports')} · ${st.ports}`), portsTable(p, s));
  if (S.tab === 'power' || S.tab === 'pattern') side.append(h('h2', { style: { marginTop: '18px' } }, `${t('circuits')} · ${st.circuits}`), circuitsTable(p, s));
  return side;
}
function portsTable(p, s) {
  const rows = portRows(p, s);
  if (!rows.length) return h('div', { class: 'empty' }, t('noPorts'));
  const labs = M.portLabels(p, s), red = (p.processor && p.processor.redundancy) || 'none', head = Number(p.processor && p.processor.headroom) || 100;
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('port')), red !== 'none' ? h('th', {}, t('backup')) : null, h('th', {}, t('proc')), h('th', {}, t('tiles')), h('th', {}, t('load')), h('th', {}, t('path')))),
    h('tbody', {}, rows.map((r, k) => {
      const g = labs[k] ? labs[k].g : k + 1, col = M.PORT_COLORS[(g - 1) % M.PORT_COLORS.length];
      return h('tr', {}, h('td', {}, h('span', { class: 'sw', style: { background: col } }), h('b', {}, r.main)), red !== 'none' ? h('td', {}, r.backup || '') : null,
        h('td', {}, red === 'processor' ? `A${r.proc}/B${r.proc}` : String(r.proc)), h('td', {}, String(r.tiles)),
        h('td', { class: r.load > 1 ? 'bad' : r.load > head / 100 ? 'w' : '' }, Math.round(r.load * 100) + ' %'), h('td', {}, `${tileRef(r.from)} → ${tileRef(r.to)}`));
    })));
}
function circuitsTable(p, s) {
  const rows = circuitRows(p, s);
  if (!rows.length) return h('div', { class: 'empty' }, t('noCircuits'));
  const tri = Number(p.power && p.power.phases) >= 3, mu = rows.some((r) => r.multi);
  const L = M.PORT_COLORS.length;
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('circuit')), tri ? h('th', {}, t('phase')) : null, mu ? h('th', {}, t('multi')) : null, h('th', {}, t('tiles')), h('th', {}, t('watts')), h('th', {}, t('amps')), h('th', {}, t('path')))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', {}, h('span', { class: 'sw', style: { background: M.PORT_COLORS[L - 1 - ((r.n - 1) % L)] } }), h('b', {}, 'C' + r.n)), tri ? h('td', {}, r.phase) : null, mu ? h('td', {}, r.multi ? `${r.multi}·${r.way}` : '') : null,
      h('td', {}, String(r.tiles)), h('td', {}, fmt(r.W)), h('td', { class: r.load > 1 ? 'bad' : r.load > 0.8 ? 'w' : '' }, fmt(r.A, 1)), h('td', {}, `${tileRef(r.from)} → ${tileRef(r.to)}`)))));
}

// ------------------------------------------------------------------ wiring
$('#file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('#btnBack').addEventListener('click', () => history.back());
document.querySelectorAll('#lang button').forEach((b) => b.addEventListener('click', () => { lang = b.dataset.l; try { localStorage.setItem('p2pv.lang', lang); } catch (_) { /* private mode */ } render(); }));
window.addEventListener('popstate', () => { document.body.classList.remove('fs'); try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) { /* none */ } if (S.screen) S.screen = null; else if (S.view3d) S.view3d = false; else if (S.p) { S.p = null; S.rec = null; } render(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__p2pv = { S, openText, render };
render();
// opened from a live share link (#s=<id>.<key>&g=<server>): fetch, then forget the key from the address bar
{ const sh = SHR.parseShareHash(location.hash); if (sh) { try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* sandboxed frame */ } openShareLink(sh); } }
window.__p2pv.SHR = SHR; window.__p2pv.checkShare = checkShare; window.__p2pv.openShareLink = openShareLink;
