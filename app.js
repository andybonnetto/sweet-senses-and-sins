import * as pdfjsLib from './vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

/* ───────────────────────── helpers ───────────────────────── */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));          // flip easing
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const STRIPS = 12;            // bend resolution of an interior page
const OVERHANG = 1.035;       // hard cover is a bit larger than the paper block
const PAPER = '#fbf8f0', ENDPAPER = '#e7dcc4';
const LIGHT = [-0.3, 0.954];  // light direction (x,z) for page shading

const el = {
  stage: $('stage'), zoomwrap: $('zoomwrap'), scene: $('scene'), book: $('book'), leaves: $('leaves'),
  floor: $('floor'), edgeR: $('edgeR'), edgeL: $('edgeL'), shR: $('shadowR'), shL: $('shadowL'),
  slider: $('slider'), label: $('label'), title: $('title'), thumbs: $('thumbList'),
  loader: $('loader'), loadMsg: $('loadMsg'), loadBar: $('loadBar'), toast: $('toast'),
  menu: $('menu'), menuList: $('menuList'), file: $('file'),
  prev: $('btnPrev'), next: $('btnNext'), first: $('btnFirst'), last: $('btnLast'),
  sideP: $('sideP'), sideN: $('sideN'),
};

/* ───────────────────────── state ───────────────────────── */
const S = {
  doc: null, n: 0, name: '', key: '',
  faces: [], N: 0, L: 0,             // faces, total faces, leaves (sheets)
  ratio: 1.41,                        // page height / width
  mode: 'spread', userMode: store.get('book.mode') || 'auto',
  pos: 0,                             // spread: s ; single: face index
  W: 300, H: 420, Wc: 310, Hc: 435, e: 1.4,
  zoom: 1, panX: 0, panY: 0,
  dpr: Math.min(window.devicePixelRatio || 1, 2.5), boost: 1,
};
let leaves = [];       // {el, slabs, shF[], shB[], N, sw}
let p = [];            // flip progress per leaf 0..1
let anim = [];         // per-leaf tween
let vxAnim = null, vxCur = 1;      // single-page mode camera tween
let drag = null;       // live page drag {i}
let par = { x: 0, y: 0, tx: 0, ty: 0 };  // parallax (smoothed)
let running = false;

/* ───────────────────────── PDF loading ───────────────────────── */
const pageCache = new Map();
const getPage = i => {
  if (!pageCache.has(i)) pageCache.set(i, S.doc.getPage(i + 1));
  return pageCache.get(i);
};

function setLoad(msg, frac) {
  el.loadMsg.textContent = msg;
  if (frac != null) el.loadBar.style.width = (frac * 100) + '%';
}
function toast(msg, ms = 2400) {
  el.toast.textContent = msg; el.toast.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.toast.classList.remove('show'), ms);
}

async function loadSource(src, keepFace) {
  el.loader.classList.remove('done', 'empty');
  setLoad('Opening book…', 0.05);
  if (S.doc) { try { S.doc.destroy(); } catch {} }
  texCache.forEach(t => URL.revokeObjectURL(t.url)); texCache.clear(); wanted.clear();
  pageCache.clear();
  const task = pdfjsLib.getDocument(src.data ? { data: src.data } : { url: src.url, isEvalSupported: false });
  task.onProgress = ({ loaded, total }) => total && setLoad('Opening book…', 0.05 + 0.5 * loaded / total);
  const doc = await task.promise;
  S.doc = doc; S.n = doc.numPages; S.name = src.name; S.key = 'book.pos.' + src.name;
  let title = src.name.replace(/\.pdf$/i, '');
  try { const m = await doc.getMetadata(); if (m.info?.Title && m.info.Title.trim().length > 1 && !/^microsoft word/i.test(m.info.Title)) title = m.info.Title.trim(); } catch {}
  el.title.textContent = title; document.title = title;
  const vp = (await getPage(0)).getViewport({ scale: 1 });
  S.ratio = vp.height / vp.width;
  buildFaces();
  buildBook();
  buildThumbs();
  layout(true);
  let face = keepFace;
  if (face == null) {
    const h = /[#&]p=(\d+)/.exec(location.hash);
    if (h) face = faceOfPdfPage(clamp(+h[1] - 1, 0, S.n - 1));
    else face = +store.get(S.key) || 0;
  }
  goFace(clamp(face, 0, S.N - 1), true);
  setLoad('Preparing pages…', 0.7);
  await waitFor(() => wanted.size === 0 || [...wanted].every(f => Math.abs(f - S.curFaceCenter) > 3), 6000);
  el.loader.classList.add('done');
}
const waitFor = (fn, max) => new Promise(r => { const t0 = performance.now(); (function c() { if (fn() || performance.now() - t0 > max) r(); else setTimeout(c, 60); })(); });

/* The physical book:  cover | endpaper, p1 | p2 … , endpaper | back cover   (no hard-coded page counts) */
function buildFaces() {
  const n = S.n, f = [{ kind: 'cover', page: 0 }, { kind: 'end' }];
  for (let i = 1; i <= n - 2; i++) f.push({ kind: 'pdf', page: i });
  if (f.length % 2) f.push({ kind: 'pad' });
  f.push({ kind: 'end' });
  f.push(n >= 2 ? { kind: 'back', page: n - 1 } : { kind: 'board' });
  S.faces = f; S.N = f.length; S.L = f.length / 2;
}
const faceOfPdfPage = j => (j === 0 ? 0 : (S.n >= 2 && j === S.n - 1) ? S.N - 1 : j + 1);
const isCoverLeaf = i => i === 0 || i === S.L - 1;
const faceDims = f => isCoverLeaf(f >> 1) ? { w: S.Wc, h: S.Hc } : { w: S.W, h: S.H };

/* ───────────────────────── building the 3D book ───────────────────────── */
function div(cls, parent) { const d = document.createElement('div'); d.className = cls; parent && parent.appendChild(d); return d; }

function buildBook() {
  el.leaves.innerHTML = ''; leaves = []; p = []; anim = [];
  for (let i = 0; i < S.L; i++) {
    const cover = isCoverLeaf(i), N = cover ? 1 : STRIPS;
    const root = div('leaf' + (cover ? ' cover' : ''), el.leaves);
    const slabs = [], shF = [], shB = [];
    let parent = root;
    for (let k = 0; k < N; k++) {
      const s = k === 0 ? root : div('slab', parent);
      s.style.setProperty('--k', k); s.style.setProperty('--kb', N - 1 - k);
      const a = div('f a', s), b = div('f b', s);
      shF.push(div('sh', a)); shB.push(div('sh', b));
      slabs.push(s); parent = s;
    }
    leaves.push({ el: root, slabs, shF, shB, N, cover });
    p.push(0); anim.push(null);
  }
  // restore any textures we already hold (e.g. after a layout rebuild)
  texCache.forEach((t, f) => paintFace(f, t.url));
}

function sizeBook() {
  const b = el.book.style, { W, H, Wc, Hc } = S;
  b.setProperty('--W', W + 'px'); b.setProperty('--H', H + 'px'); b.setProperty('--Wc', Wc + 'px'); b.setProperty('--Hc', Hc + 'px');
  leaves.forEach(l => {
    const w = l.cover ? Wc : W, h = l.cover ? Hc : H, sw = w / l.N;
    l.el.style.setProperty('--lw', w + 'px'); l.el.style.setProperty('--lh', h + 'px'); l.el.style.setProperty('--sw', sw + 'px');
    l.sw = sw;
  });
  el.scene.style.perspective = Math.round(H * 4) + 'px';
  el.edgeR.style.left = W + 'px';
  el.edgeL.style.left = -W + 'px';
}

/* ───────────────────────── layout / responsiveness ───────────────────────── */
function layout(force) {
  const w = el.stage.clientWidth, h = el.stage.clientHeight;
  if (!w || !h || !S.n) return;
  const auto = (w < 640 && h > w * 1.1) ? 'single' : 'spread';
  const mode = S.userMode === 'auto' ? auto : S.userMode;
  const aw = w - 36, ah = h - 36;
  let W;
  if (mode === 'single') W = Math.min(aw / OVERHANG, ah / (S.ratio * OVERHANG * 1.04));
  else W = Math.min(aw / (2 * OVERHANG), ah / (S.ratio * OVERHANG * 1.04));
  W = Math.max(80, Math.floor(W));
  const changed = force || mode !== S.mode || Math.abs(W - S.W) > 0.5;
  const modeChanged = mode !== S.mode;
  // convert the logical position when switching mode so the reader stays on the same page
  if (modeChanged && S.pos != null && S.faces.length) {
    if (mode === 'single') S.pos = clamp(S.mode === 'spread' ? Math.min(S.pos * 2, S.N - 1) : S.pos, 0, S.N - 1);
    else S.pos = posFromFace(S.pos, 'spread');
  }
  S.mode = mode;
  document.body.classList.toggle('single', mode === 'single');
  S.W = W; S.H = Math.round(W * S.ratio); S.Wc = Math.round(W * OVERHANG); S.Hc = Math.round(S.H * OVERHANG);
  S.e = Math.max(0.9, W * 0.0042);
  if (changed) {
    sizeBook();
    texKeyBump();
    if (S.faces.length) { updateSliderRange(); apply(true); }
  }
}
const ro = new ResizeObserver(() => { clearTimeout(ro.t); ro.t = setTimeout(() => layout(false), 60); });
ro.observe(el.stage);

/* ───────────────────────── position model ───────────────────────── */
// spread mode: pos = s (0 = closed front … L = closed back). single mode: pos = face index
const spreadOfFace = f => (f % 2 === 0 ? f / 2 : (f + 1) / 2);
function posFromFace(f, mode = S.mode) { return mode === 'single' ? f : spreadOfFace(f); }
const maxPos = () => (S.mode === 'single' ? S.N - 1 : S.L);
function stateOf(pos) {
  if (S.mode === 'single') return { s: spreadOfFace(pos), vx: pos % 2 === 0 ? 1 : -1 };
  return { s: pos, vx: null };
}
function visibleFaces(pos = S.pos) {
  if (S.mode === 'single') return [pos];
  const s = pos, out = [];
  if (s > 0) out.push(2 * s - 1);
  if (s < S.L) out.push(2 * s);
  return out;
}

function goFace(f, instant) { goPos(posFromFace(f), instant); }
function goPos(pos, instant) {
  if (!S.faces.length) return;
  S.pos = clamp(Math.round(pos), 0, maxPos());
  apply(instant);
}
const step = d => goPos(S.pos + d);

function apply(instant) {
  const { s, vx } = stateOf(S.pos);
  retarget(s, vx, instant);
  updateUI();
  requestTextures();
  store.set(S.key, String(visibleFaces()[0] ?? 0));
}

function retarget(sT, vxT, instant) {
  const now = performance.now(), chg = [];
  for (let i = 0; i < S.L; i++) {
    const to = i < sT ? 1 : 0, cur = anim[i] ? anim[i].to : p[i];
    if (to !== cur) chg.push(i);
  }
  if (drag) chg.length = 0;
  let end = 0;
  if (instant) {
    for (let i = 0; i < S.L; i++) { p[i] = i < sT ? 1 : 0; anim[i] = null; applyLeaf(i); }
    if (vxT != null) { vxCur = vxT; vxAnim = null; }
  } else if (chg.length) {
    if (chg[0] >= sT) chg.reverse();   // turning back: last page first
    const multi = chg.length > 1;
    const stag = multi ? Math.min(110, 1000 / chg.length) : 0;
    const dur = multi ? 650 : 1000;
    chg.forEach((i, idx) => {
      const to = i < sT ? 1 : 0;
      const d = dur * Math.max(0.4, Math.abs(to - p[i]));
      anim[i] = { from: p[i], to, t0: now, delay: idx * stag, dur: d };
      end = Math.max(end, idx * stag + d);
    });
  }
  if (vxT != null && !instant) vxAnim = { from: vxCur, to: vxT, t0: now, delay: 0, dur: Math.max(end, 700) };
  kick();
}

/* ───────────────────────── render loop ───────────────────────── */
function kick() { if (!running) { running = true; requestAnimationFrame(tick); } }

function tick(now) {
  let busy = false;
  for (let i = 0; i < S.L; i++) {
    const a = anim[i]; if (!a) continue;
    const t = (now - a.t0 - a.delay) / a.dur;
    if (t < 0) { busy = true; continue; }
    p[i] = lerp(a.from, a.to, ease(t));
    if (t >= 1) { p[i] = a.to; anim[i] = null; } else busy = true;
    applyLeaf(i);
  }
  if (drag) busy = true;
  // camera x
  let vx;
  if (S.mode === 'single') {
    if (vxAnim) {
      const t = (now - vxAnim.t0) / vxAnim.dur;
      vxCur = lerp(vxAnim.from, vxAnim.to, ease(t));
      if (t >= 1) { vxCur = vxAnim.to; vxAnim = null; } else busy = true;
    }
    vx = vxCur;
  } else vx = spreadVx();
  // parallax easing
  par.x += (par.tx - par.x) * 0.08; par.y += (par.ty - par.y) * 0.08;
  if (Math.abs(par.tx - par.x) > 0.002 || Math.abs(par.ty - par.y) > 0.002) busy = true;

  placeBook(vx);
  updateAux();
  if (busy) requestAnimationFrame(tick); else running = false;
}
const spreadVx = () => (1 - p[0]) - p[S.L - 1];

function placeBook(vx) {
  const shift = -(S.Wc / 2) * vx;
  const ry = par.x * 13, rx = 9 - par.y * 7;
  el.book.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateX(${shift.toFixed(1)}px)`;
  // floor shadow follows the real extent of the block
  const vs = spreadVx(), open = 1 - Math.abs(vs);
  const cx = (S.Wc / 2) * vs, wid = S.Wc * (1.08 + open * 0.95);
  el.floor.style.width = wid + 'px'; el.floor.style.left = cx + 'px';
}

function applyLeaf(i) {
  const l = leaves[i], pr = p[i], e = S.e, L = S.L;
  const theta = -180 * pr;
  const zU = (L - i) * e, zF = i * e;
  const z = lerp(zU, zF, pr) + L * e * Math.sin(Math.PI * pr) * 0.55;
  l.el.style.transform = `translateZ(${z.toFixed(2)}px) rotateY(${theta.toFixed(3)}deg)`;
  const moving = pr > 0.0005 && pr < 0.9995;
  let cum = theta;
  const rad = d => d * Math.PI / 180;
  for (let k = 0; k < l.N; k++) {
    if (k > 0) {
      let d = 0;
      if (moving && !l.cover) d = -(46 / l.N) * Math.sin(2 * Math.PI * pr) * (0.35 + 0.65 * (k / l.N));
      const next = clamp(cum + d, -180, 0);
      l.slabs[k].style.transform = `rotateY(${(next - cum).toFixed(3)}deg)`;
      cum = next;
    }
    // shading from the strip's facing direction
    const a = rad(cum), dotF = Math.sin(a) * LIGHT[0] + Math.cos(a) * LIGHT[1];
    const of = Math.max(0, 0.954 - Math.max(dotF, 0)) * 0.55, ob = Math.max(0, 0.954 - Math.max(-dotF, 0)) * 0.55;
    l.shF[k].style.opacity = of < 0.004 ? 0 : of.toFixed(3);
    l.shB[k].style.opacity = ob < 0.004 ? 0 : ob.toFixed(3);
  }
}

// page-block edges (thickness) and the soft cast shadow of the page being turned
function updateAux() {
  const { L, e, W } = S;
  let flipped = 0, mi = -1;
  for (let i = 0; i < L; i++) { if (p[i] >= 0.5) flipped++; if (p[i] > 0.002 && p[i] < 0.998 && (mi < 0 || Math.abs(p[i] - .5) < Math.abs(p[mi] - .5))) mi = i; }
  const unf = L - flipped;
  const setEdge = (n, count, ztop) => {
    n.style.display = count > 0 ? 'block' : 'none';
    n.style.width = (count * e) + 'px';
    n.style.transform = `translateZ(${(ztop * e).toFixed(2)}px) rotateY(90deg)`;
  };
  setEdge(el.edgeR, unf, unf); setEdge(el.edgeL, flipped, flipped);
  if (mi < 0) { el.shR.style.opacity = el.shL.style.opacity = 0; return; }
  const pr = p[mi], c = Math.cos(Math.PI * pr), s = Math.sin(Math.PI * pr);
  const rz = (L - Math.min(L - 1, mi + 1)) * e + e * 0.4, lz = Math.max(0, mi - 1) * e + e * 0.4;
  const base = (n, w, z, dir) => {
    n.style.width = Math.max(0, w) + 'px';
    n.style.background = `linear-gradient(${dir},rgba(0,0,0,.42),rgba(0,0,0,.14) 55%,transparent)`;
    n.style.transform = `translateZ(${z.toFixed(2)}px)`;
  };
  base(el.shR, c > 0 ? W * c * 1.02 : 0, rz, 'to right'); el.shR.style.left = '0px';
  base(el.shL, c < 0 ? -W * c * 1.02 : 0, lz, 'to left'); el.shL.style.left = (c < 0 ? -(-W * c * 1.02) : 0) + 'px';
  el.shR.style.opacity = c > 0 ? s : 0; el.shL.style.opacity = c < 0 ? s : 0;
}

/* ───────────────────────── textures (PDF → page images) ───────────────────────── */
const texCache = new Map();    // face → {url, key}
const wanted = new Set();
const inflight = new Set();
let texKey = 0;
function texQ() { return S.dpr * S.boost * 1.2; }
function texKeyBump() { texKey = Math.round(S.W * texQ() / 40); requestTextures(); }

function paintFace(f, url) {
  const l = leaves[f >> 1]; if (!l) return;
  l.el.style.setProperty(f % 2 ? '--imgB' : '--imgF', url ? `url("${url}")` : 'none');
}

function requestTextures() {
  if (!S.faces.length) return;
  const center = visibleFaces()[0] ?? 0;
  S.curFaceCenter = center;
  const span = 8, lo = Math.max(0, center - span), hi = Math.min(S.N - 1, center + span + 1);
  const keep = new Set();
  for (let f = lo; f <= hi; f++) {
    keep.add(f);
    const t = texCache.get(f);
    if (!t || t.key !== texKey) wanted.add(f);
  }
  // drop textures far away to keep memory bounded on phones
  for (const [f, t] of texCache) if (!keep.has(f) && Math.abs(f - center) > 18) { paintFace(f, null); URL.revokeObjectURL(t.url); texCache.delete(f); }
  pumpTextures();
}
function pumpTextures() {
  while (inflight.size < 2 && wanted.size) {
    const c = S.curFaceCenter ?? 0;
    let best = null, bd = 1e9;
    for (const f of wanted) { if (inflight.has(f)) continue; const d = Math.abs(f - c - 0.5); if (d < bd) { bd = d; best = f; } }
    if (best == null) return;
    wanted.delete(best); inflight.add(best);
    const key = texKey, doc = S.doc;
    makeTexture(best).then(url => {
      if (doc !== S.doc) { URL.revokeObjectURL(url); return; }
      const old = texCache.get(best);
      texCache.set(best, { url, key });
      paintFace(best, url);
      if (old) setTimeout(() => URL.revokeObjectURL(old.url), 400);
    }).catch(err => console.warn('render failed', best, err)).finally(() => { inflight.delete(best); pumpTextures(); });
  }
}

async function makeTexture(f) {
  const face = S.faces[f], d = faceDims(f), q = texQ();
  let cw = Math.round(d.w * q), ch = Math.round(d.h * q);
  const cap = 2600 / Math.max(cw, ch); if (cap < 1) { cw = Math.round(cw * cap); ch = Math.round(ch * cap); }
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  g.fillStyle = face.kind === 'end' ? ENDPAPER : face.kind === 'board' ? '#2a2433' : PAPER;
  g.fillRect(0, 0, cw, ch);
  if (face.page != null) {
    const page = await getPage(face.page), v1 = page.getViewport({ scale: 1 });
    const sc = Math.min(cw / v1.width, ch / v1.height), vp = page.getViewport({ scale: sc });
    const ox = (cw - vp.width) / 2, oy = (ch - vp.height) / 2;
    await page.render({ canvasContext: g, viewport: vp, transform: [1, 0, 0, 1, ox, oy], background: 'rgba(0,0,0,0)' }).promise;
  }
  bake(g, cw, ch, f, face);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));
  return URL.createObjectURL(blob);
}

// gutter shadow, paper edges, and the hinge groove of hard covers are baked into the image
function bake(g, w, h, f, face) {
  const spineLeft = f % 2 === 0;         // right-hand pages have the spine on their left
  const gr = (x0, x1, stops) => { const gg = g.createLinearGradient(x0, 0, x1, 0); stops.forEach(([o, c]) => gg.addColorStop(o, c)); return gg; };
  const cover = face.kind === 'cover' || face.kind === 'back' || face.kind === 'board';
  const s0 = spineLeft ? 0 : w, dir = spineLeft ? 1 : -1;
  if (!cover) {
    g.fillStyle = gr(s0, s0 + dir * w * 0.085, [[0, 'rgba(40,25,10,.40)'], [0.35, 'rgba(40,25,10,.14)'], [1, 'rgba(40,25,10,0)']]);
    g.fillRect(0, 0, w, h);
    const o0 = spineLeft ? w : 0;      // faint darkening at the outer paper edge
    g.fillStyle = gr(o0, o0 - dir * w * 0.02, [[0, 'rgba(0,0,0,.10)'], [1, 'rgba(0,0,0,0)']]);
    g.fillRect(0, 0, w, h);
  } else {
    // hard-cover hinge groove + gentle sheen
    const gx = s0 + dir * w * 0.045;
    g.fillStyle = gr(gx - 6 * dir, gx + 6 * dir, [[0, 'rgba(0,0,0,0)'], [0.45, 'rgba(0,0,0,.45)'], [0.55, 'rgba(255,255,255,.18)'], [1, 'rgba(0,0,0,0)']]);
    g.fillRect(Math.min(gx - 6, gx + 6), 0, 12, h);
    g.fillStyle = gr(s0, s0 + dir * w * 0.045, [[0, 'rgba(0,0,0,.35)'], [1, 'rgba(0,0,0,0)']]);
    g.fillRect(0, 0, w, h);
    const sh = g.createLinearGradient(0, 0, w, h);
    sh.addColorStop(0, 'rgba(255,255,255,.10)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,.10)');
    g.fillStyle = sh; g.fillRect(0, 0, w, h);
  }
}

/* ───────────────────────── UI: slider, labels, thumbnails ───────────────────────── */
function describeFace(f) {
  const x = S.faces[f]; if (!x) return null;
  if (x.kind === 'cover') return 'Cover';
  if (x.kind === 'back' || x.kind === 'board') return 'Back cover';
  if (x.kind === 'pdf') return x.page + 1;
  return null;
}
function updateSliderRange() {
  el.slider.max = maxPos(); el.slider.value = S.pos;
}
function updateUI() {
  el.slider.max = maxPos(); el.slider.value = S.pos;
  el.slider.style.setProperty('--fill', (maxPos() ? S.pos / maxPos() * 100 : 0) + '%');
  const vf = visibleFaces().map(describeFace).filter(x => x != null);
  let txt;
  if (!vf.length) txt = '—';
  else if (vf.length === 1) txt = typeof vf[0] === 'number' ? `Page ${vf[0]} of ${S.n}` : vf[0];
  else if (typeof vf[0] === 'number' && typeof vf[1] === 'number') txt = `Pages ${vf[0]}–${vf[1]} of ${S.n}`;
  else txt = vf.map(v => typeof v === 'number' ? `Page ${v}` : v).join(' · ');
  el.label.textContent = txt;
  const atStart = S.pos <= 0, atEnd = S.pos >= maxPos();
  el.prev.disabled = el.first.disabled = atStart; el.next.disabled = el.last.disabled = atEnd;
  el.sideP.hidden = atStart; el.sideN.hidden = atEnd;
  // thumbnails highlight
  const cur = new Set(visibleFaces());
  let first = null;
  el.thumbs.querySelectorAll('.th').forEach(t => { const on = cur.has(+t.dataset.face); t.classList.toggle('cur', on); if (on && !first) first = t; });
  if (first && document.body.classList.contains('thumbs')) first.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  history.replaceState(null, '', '#p=' + ((visibleFaces()[0] != null ? (S.faces[visibleFaces()[0]].page ?? 0) : 0) + 1));
}

const thumbObs = new IntersectionObserver(entries => {
  for (const en of entries) if (en.isIntersecting) { thumbObs.unobserve(en.target); thumbQueue.push(en.target); pumpThumbs(); }
}, { root: el.thumbs, rootMargin: '0px 300px' });
const thumbQueue = []; let thumbBusy = false;
async function pumpThumbs() {
  if (thumbBusy) return; thumbBusy = true;
  const doc = S.doc;
  while (thumbQueue.length) {
    const t = thumbQueue.shift(); if (doc !== S.doc) break;
    try {
      const page = await getPage(+t.dataset.page), v1 = page.getViewport({ scale: 1 });
      const sc = 260 / v1.height, vp = page.getViewport({ scale: sc });
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      const g = cv.getContext('2d'); g.fillStyle = PAPER; g.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: g, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
      t.style.backgroundImage = `url(${cv.toDataURL('image/jpeg', 0.8)})`;
    } catch {}
  }
  thumbBusy = false;
}
function buildThumbs() {
  thumbObs.disconnect(); thumbQueue.length = 0;
  el.thumbs.innerHTML = '';
  for (let j = 0; j < S.n; j++) {
    const t = document.createElement('div');
    t.className = 'th'; t.dataset.page = j; t.dataset.face = faceOfPdfPage(j);
    t.style.setProperty('--ar', (1 / S.ratio).toFixed(4));
    t.innerHTML = `<span>${j === 0 ? 'Cover' : j === S.n - 1 && S.n > 1 ? 'Back' : j + 1}</span>`;
    t.addEventListener('click', () => { goFace(+t.dataset.face); });
    el.thumbs.appendChild(t); thumbObs.observe(t);
  }
}

/* ───────────────────────── input: buttons, keyboard, slider ───────────────────────── */
el.prev.onclick = el.sideP.onclick = () => step(-1);
el.next.onclick = el.sideN.onclick = () => step(1);
el.first.onclick = () => goPos(0);
el.last.onclick = () => goPos(maxPos());
let sliderRaf = 0;
el.slider.addEventListener('input', () => {
  cancelAnimationFrame(sliderRaf);
  sliderRaf = requestAnimationFrame(() => goPos(+el.slider.value));
});
$('btnThumbs').onclick = e => { document.body.classList.toggle('thumbs'); e.currentTarget.classList.toggle('on'); setTimeout(() => { layout(false); updateUI(); }, 330); };
$('btnMode').onclick = () => {
  S.userMode = S.mode === 'single' ? 'spread' : 'single';
  store.set('book.mode', S.userMode);
  layout(true);
};
$('btnZoomIn').onclick = () => setZoom(S.zoom * 1.35);
$('btnZoomOut').onclick = () => setZoom(S.zoom / 1.35);
const fsEl = document.documentElement;
if (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen) {
  $('btnFull').hidden = false;
  $('btnFull').onclick = () => {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
  };
}
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { step(1); e.preventDefault(); }
  else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { step(-1); e.preventDefault(); }
  else if (k === 'Home') goPos(0);
  else if (k === 'End') goPos(maxPos());
  else if (k === '+' || k === '=') setZoom(S.zoom * 1.25);
  else if (k === '-') setZoom(S.zoom / 1.25);
  else if (k === '0') setZoom(1);
  else if (k === 't' || k === 'T') $('btnThumbs').click();
  else if (k === 'f' || k === 'F') $('btnFull').click();
  else if (k === 'Escape') el.menu.hidden = true;
});

/* ───────────────────────── input: pointer gestures on the stage ───────────────────────── */
function setZoom(z, cx, cy) {
  z = clamp(z, 1, 4);
  const r = el.stage.getBoundingClientRect();
  if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  // keep the point under (cx,cy) fixed
  const ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2), k = z / S.zoom;
  S.panX = ox - (ox - S.panX) * k; S.panY = oy - (oy - S.panY) * k;
  S.zoom = z; clampPan(); applyZoom();
  clearTimeout(setZoom.t);
  setZoom.t = setTimeout(() => { const b = z > 1.5 ? 1.8 : 1; if (b !== S.boost) { S.boost = b; texKeyBump(); } }, 300);
}
function clampPan() {
  const r = el.stage.getBoundingClientRect(), mx = (S.zoom - 1) * r.width / 2 + 40, my = (S.zoom - 1) * r.height / 2 + 40;
  S.panX = clamp(S.panX, -mx, mx); S.panY = clamp(S.panY, -my, my);
  if (S.zoom < 1.02) { S.panX = S.panY = 0; }
}
function applyZoom() {
  el.zoomwrap.style.transform = `translate(${S.panX}px,${S.panY}px) scale(${S.zoom})`;
  $('btnZoomIn').classList.toggle('on', S.zoom > 1.02);
}

const ptrs = new Map();
let g = null, pinch = null, lastTurn = 0;
const spineX = () => { const r = $('spine').getBoundingClientRect(); return r.left; };

el.stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.side')) return;
  el.menu.hidden = true;
  el.stage.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.zoom };
    g = null; if (drag) endDrag(false);
    return;
  }
  g = { x0: e.clientX, y0: e.clientY, t0: performance.now(), px: S.panX, py: S.panY, moved: false, kind: null, hist: [[performance.now(), e.clientX]], side: e.clientX > spineX() ? 'R' : 'L' };
});
el.stage.addEventListener('pointermove', e => {
  // parallax tilt (mouse only)
  if (e.pointerType === 'mouse') {
    const r = el.stage.getBoundingClientRect();
    par.tx = ((e.clientX - r.left) / r.width - 0.5) * 2; par.ty = ((e.clientY - r.top) / r.height - 0.5) * 2; kick();
  }
  const pt = ptrs.get(e.pointerId); if (!pt) return;
  pt.x = e.clientX; pt.y = e.clientY;
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    setZoom(pinch.z * d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    return;
  }
  if (!g) return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.moved && Math.hypot(dx, dy) > 7) {
    g.moved = true;
    el.stage.classList.add('grabbing');
    if (S.zoom > 1.02) g.kind = 'pan';
    else if (S.mode === 'spread' && Math.abs(dx) > Math.abs(dy) * 0.7) {
      // grab the page on the side it belongs to
      if (g.side === 'R' && dx < 0 && S.pos < S.L) startDrag(S.pos, 'R');
      else if (g.side === 'L' && dx > 0 && S.pos > 0) startDrag(S.pos - 1, 'L');
      g.kind = drag ? 'drag' : 'none';
    } else g.kind = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'none';
  }
  if (g.kind === 'pan') { S.panX = g.px + dx; S.panY = g.py + dy; clampPan(); applyZoom(); }
  else if (g.kind === 'drag' && drag) moveDrag(e.clientX);
  g.hist.push([performance.now(), e.clientX]); if (g.hist.length > 6) g.hist.shift();
});
const up = e => {
  ptrs.delete(e.pointerId);
  if (pinch) { if (ptrs.size < 2) pinch = null; g = null; return; }
  if (!g) return;
  el.stage.classList.remove('grabbing');
  const dx = e.clientX - g.x0;
  if (g.kind === 'drag' && drag) {
    const h = g.hist, v = h.length > 1 ? (h[h.length - 1][1] - h[0][1]) / Math.max(1, h[h.length - 1][0] - h[0][0]) : 0;
    const fwd = drag.dir === 'R';
    const flick = fwd ? v < -0.35 : v > 0.35, back = fwd ? v > 0.35 : v < -0.35;
    const pr = p[drag.i];
    endDrag(flick || (!back && pr > 0.4));
  } else if (g.kind === 'swipe') {
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  } else if (!g.moved && S.zoom <= 1.02 && e.type === 'pointerup') {
    // a tap: right half → next, left half → previous
    const pivot = S.mode === 'single' ? el.stage.getBoundingClientRect().left + el.stage.clientWidth / 2 : spineX();
    step(e.clientX > pivot ? 1 : -1);
  }
  g = null;
};
el.stage.addEventListener('pointerup', up);
el.stage.addEventListener('pointercancel', e => { if (drag) endDrag(false); ptrs.delete(e.pointerId); g = null; pinch = null; });
el.stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { par.tx = par.ty = 0; kick(); } });

function startDrag(i, dir) {
  anim[i] = null;
  const sx = spineX(), W = S.W * (S.zoom);
  drag = { i, dir, sx, len: Math.max(W * 0.8, dir === 'R' ? g.x0 - (sx - W * 0.85) : (sx + W * 0.85) - g.x0), x0: g.x0, start: p[i] };
  kick();
}
function moveDrag(x) {
  const d = drag; if (!d) return;
  const pr = d.dir === 'R' ? clamp((d.x0 - x) / d.len, 0, 1) : 1 - clamp((x - d.x0) / d.len, 0, 1);
  p[d.i] = pr; applyLeaf(d.i);
}
function endDrag(commit) {
  const d = drag; drag = null;
  const to = d.dir === 'R' ? (commit ? 1 : 0) : (commit ? 0 : 1);
  S.pos = clamp(to === 1 ? (d.i + 1) : d.i, 0, S.L);
  anim[d.i] = null;
  apply(false);
  // retarget ignores leaves whose target is unchanged, so animate the dragged one explicitly
  const dur = 650 * Math.max(0.35, Math.abs(to - p[d.i]));
  if (p[d.i] !== to) anim[d.i] = { from: p[d.i], to, t0: performance.now(), delay: 0, dur };
  kick();
}

el.stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { setZoom(S.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY); return; }
  if (S.zoom > 1.02) { S.panX -= e.deltaX; S.panY -= e.deltaY; clampPan(); applyZoom(); return; }
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY, now = performance.now();
  if (Math.abs(d) > 12 && now - lastTurn > 480) { lastTurn = now; step(d > 0 ? 1 : -1); }
}, { passive: false });
['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
document.addEventListener('contextmenu', e => e.preventDefault());

/* ───────────────────────── choosing / reloading PDFs ───────────────────────── */
let available = [], current = null;
const pdfUrl = f => encodeURI(f.name) + '?v=' + Math.round(f.mtime || 0);

async function fetchList() {
  // live server first, then the static manifest written by publish.sh (GitHub Pages)
  for (const u of ['api/pdfs', 'pdfs.json']) {
    try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) { fetchList.live = u === 'api/pdfs'; return j; } } } catch {}
  }
  return null;
}
async function openByName(f, keepFace) {
  current = f;
  try { await loadSource({ url: pdfUrl(f), name: f.name }, keepFace); }
  catch (err) { console.error(err); showEmpty('Could not open “' + f.name + '”. ' + (err.message || '')); }
  renderMenu();
}
function showEmpty(msg) {
  el.loader.classList.remove('done'); el.loader.classList.add('empty');
  setLoad(msg || 'No PDF found. Tap to choose one, or drop a PDF here.');
}
function renderMenu() {
  el.menuList.innerHTML = '';
  available.forEach(f => {
    const b = document.createElement('button'); b.className = 'menuItem' + (current && current.name === f.name ? ' cur' : '');
    b.textContent = f.name; b.onclick = () => { el.menu.hidden = true; openByName(f); };
    el.menuList.appendChild(b);
  });
  if (!available.length) el.menuList.innerHTML = '<div class="menuItem" style="opacity:.6">No PDFs served from this folder</div>';
}
$('btnOpen').onclick = async e => {
  e.stopPropagation();
  if (el.menu.hidden) { const l = await fetchList(); if (l) { available = l; renderMenu(); } }
  el.menu.hidden = !el.menu.hidden;
};
async function openLocalFile(file) {
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  current = { name: file.name, local: true };
  el.menu.hidden = true;
  try { await loadSource({ data, name: file.name }); } catch (err) { showEmpty('That file could not be opened as a PDF.'); }
}
el.file.onchange = () => openLocalFile(el.file.files[0]);
el.loader.addEventListener('click', () => { if (el.loader.classList.contains('empty')) el.file.click(); });
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); openLocalFile(e.dataTransfer.files[0]); });

// pick up edits to the PDF automatically (keeps your current page)
setInterval(async () => {
  if (document.hidden || !current || current.local || !fetchList.live) return;
  const l = await fetchList(); if (!l) return;
  available = l;
  const f = l.find(x => x.name === current.name);
  if (f && f.mtime !== current.mtime) {
    const face = visibleFaces()[0] ?? 0;
    toast('Book updated — reloading…');
    openByName(f, face);
  }
}, 3000);

/* ───────────────────────── boot ───────────────────────── */
(async function boot() {
  const param = new URLSearchParams(location.search).get('pdf');
  const list = await fetchList();
  if (list) available = list;
  let target = null;
  if (param) target = (list || []).find(f => f.name === param) || { name: param };
  else if (list && list.length) target = list[0];
  else { // static hosting without the node server: try a few conventional names
    for (const n of ['book.pdf']) { try { const r = await fetch(n, { method: 'HEAD' }); if (r.ok) { target = { name: n }; break; } } catch {} }
  }
  if (!target) return showEmpty();
  await openByName(target);
})();

window.__book = { S, goPos, goFace, step, p, setZoom };
