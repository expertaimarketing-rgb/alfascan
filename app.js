'use strict';
/* AlfaScan: сканер документов. Всё считается на телефоне, сервер не нужен. */

const $ = s => document.querySelector(s);
const CV_URL = 'opencv.js'; // OpenCV 4.9 (@techstark/opencv-js 4.9.0-release.2), лежит рядом с приложением
const WORK_MAX = 2200;   // макс. сторона рабочего снимка
const OUT_MAX = 2400;    // макс. сторона итоговой страницы

const state = { pages: [], queue: [], edit: null, view: -1 };

/* ---------- утилиты ---------- */
const toBlob = (c, t = 'image/jpeg', q = 0.9) => new Promise(r => c.toBlob(r, t, q));
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3200);
}
function busy(on, txt) { $('#busy').hidden = !on; if (txt) $('#busyTxt').textContent = txt; }

async function fileToCanvas(file, maxSide) {
  let bm;
  try { bm = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bm = await createImageBitmap(file); }
  const k = Math.min(1, maxSide / Math.max(bm.width, bm.height));
  const c = mkCanvas(Math.round(bm.width * k), Math.round(bm.height * k));
  c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
  if (bm.close) bm.close();
  return c;
}
async function blobToCanvas(b) {
  const bm = await createImageBitmap(b);
  const c = mkCanvas(bm.width, bm.height);
  c.getContext('2d').drawImage(bm, 0, 0);
  if (bm.close) bm.close();
  return c;
}

/* ---------- OpenCV ---------- */
let cvPromise = null;
function loadCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CV_URL; s.async = true;
    s.onload = () => {
      // Не делаем await на самом cv: у него бывает свой then, и промис зацикливается
      const done = m => { window.cv = m; resolve(true); };
      const c = window.cv;
      if (!c) return reject(new Error('cv не найден'));
      if (typeof c.then === 'function') c.then(m => done(m), reject);
      else if (c.Mat) done(c);
      else c.onRuntimeInitialized = () => done(c);
    };
    s.onerror = () => reject(new Error('opencv не загрузился'));
    document.head.appendChild(s);
  }).catch(e => { cvPromise = null; throw e; });
  return cvPromise;
}
const cvOk = () => !!(window.cv && window.cv.Mat);

function setChip(ok, txt) {
  const c = $('#cvChip'); c.textContent = txt; c.classList.toggle('ok', ok);
}
function startCV() {
  setChip(false, 'края: загрузка…');
  loadCV().then(() => setChip(true, 'края: авто'))
    .catch(() => setChip(false, 'края: вручную'));
}

/* порядок точек: левая-верхняя, правая-верхняя, правая-нижняя, левая-нижняя */
function orderPts(p) {
  const bySum = [...p].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...p].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function defaultPts(w, h) {
  const m = 0.06;
  return [{ x: w * m, y: h * m }, { x: w * (1 - m), y: h * m }, { x: w * (1 - m), y: h * (1 - m) }, { x: w * m, y: h * (1 - m) }];
}

function detectCorners(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!cvOk()) return defaultPts(w, h);
  const cv = window.cv;
  const mats = [];
  const M = m => (mats.push(m), m);
  try {
    const src = M(cv.imread(canvas));
    const k = 600 / Math.max(w, h);
    const small = M(new cv.Mat());
    cv.resize(src, small, new cv.Size(Math.round(w * k), Math.round(h * k)), 0, 0, cv.INTER_AREA);
    const gray = M(new cv.Mat()); cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const edges = M(new cv.Mat()); cv.Canny(gray, edges, 40, 140);
    const kern = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    cv.dilate(edges, edges, kern);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kern);
    const contours = M(new cv.MatVector()), hier = M(new cv.Mat());
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const total = small.cols * small.rows;
    let best = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > total * 0.12 && area > bestArea) {
        const peri = cv.arcLength(c, true);
        const ap = new cv.Mat();
        cv.approxPolyDP(c, ap, 0.02 * peri, true);
        if (ap.rows === 4 && cv.isContourConvex(ap)) {
          best = []; for (let j = 0; j < 4; j++) best.push({ x: ap.data32S[j * 2] / k, y: ap.data32S[j * 2 + 1] / k });
          bestArea = area;
        }
        ap.delete();
      }
      c.delete();
    }
    return best ? orderPts(best) : defaultPts(w, h);
  } catch (e) {
    console.warn('detect', e); return defaultPts(w, h);
  } finally { mats.forEach(m => m.delete && m.delete()); }
}

function warp(srcCanvas, pts) {
  let p = orderPts(pts);
  // чуть сжимаем рамку к центру, чтобы в кадр не попадал тёмный край стола
  const cx = p.reduce((s, q) => s + q.x, 0) / 4, cy = p.reduce((s, q) => s + q.y, 0) / 4;
  p = p.map(q => ({ x: cx + (q.x - cx) * 0.992, y: cy + (q.y - cy) * 0.992 }));
  let w =Math.max(dist(p[0], p[1]), dist(p[3], p[2]));
  let h = Math.max(dist(p[0], p[3]), dist(p[1], p[2]));
  const k = Math.min(1, OUT_MAX / Math.max(w, h));
  w = Math.max(10, Math.round(w * k)); h = Math.max(10, Math.round(h * k));
  if (!cvOk()) { // запасной вариант: просто вырезаем прямоугольник
    const xs = p.map(a => a.x), ys = p.map(a => a.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    const c = mkCanvas(Math.round(x1 - x0), Math.round(y1 - y0));
    c.getContext('2d').drawImage(srcCanvas, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
    return c;
  }
  const cv = window.cv;
  const src = cv.imread(srcCanvas), dst = new cv.Mat();
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, p.flatMap(q => [q.x, q.y]));
  const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const T = cv.getPerspectiveTransform(a, b);
  cv.warpPerspective(src, dst, T, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  const out = mkCanvas(w, h); cv.imshow(out, dst);
  [src, dst, a, b, T].forEach(m => m.delete());
  return out;
}

/* фильтры: orig / doc / gray / bw */
function applyFilter(base, mode) {
  if (mode === 'orig' || !cvOk()) return base;
  const cv = window.cv;
  const mats = []; const M = m => (mats.push(m), m);
  try {
    const rgba = M(cv.imread(base));
    const rgb = M(new cv.Mat()); cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    // оценка фона (освещения): уменьшить, стереть текст расширением, размыть, вернуть
    const sm = M(new cv.Mat());
    const f = 1 / 8;
    cv.resize(rgb, sm, new cv.Size(Math.max(4, Math.round(rgb.cols * f)), Math.max(4, Math.round(rgb.rows * f))), 0, 0, cv.INTER_AREA);
    const kn = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.dilate(sm, sm, kn);
    cv.GaussianBlur(sm, sm, new cv.Size(0, 0), 4);
    const bg = M(new cv.Mat());
    cv.resize(sm, bg, new cv.Size(rgb.cols, rgb.rows), 0, 0, cv.INTER_LINEAR);
    const flat = M(new cv.Mat());
    cv.divide(rgb, bg, flat, 255, -1);
    let out = M(new cv.Mat());
    if (mode === 'doc') {
      flat.convertTo(out, -1, 1.12, -14);
    } else {
      const g = M(new cv.Mat()); cv.cvtColor(flat, g, cv.COLOR_RGB2GRAY);
      if (mode === 'gray') g.convertTo(out, -1, 1.15, -16);
      else cv.threshold(g, out, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    }
    const c = mkCanvas(base.width, base.height);
    cv.imshow(c, out);
    return c;
  } finally { mats.forEach(m => m.delete && m.delete()); }
}

function rotateCanvas(c, rot) {
  if (!rot) return c;
  const sw = rot % 2 === 1;
  const o = mkCanvas(sw ? c.height : c.width, sw ? c.width : c.height);
  const x = o.getContext('2d');
  x.translate(o.width / 2, o.height / 2); x.rotate(rot * Math.PI / 2);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  return o;
}
function renderResult(p) { return rotateCanvas(applyFilter(p.base, p.mode), p.rot); }

function makeThumb(canvas) {
  const k = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
  const t = mkCanvas(Math.round(canvas.width * k), Math.round(canvas.height * k));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

/* ---------- хранилище (чтобы страницы не терялись при перезапуске) ---------- */
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('alfascan', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pages', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function dbDo(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction('pages', mode); const st = tx.objectStore('pages');
      const rq = fn(st); tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('idb', e); return null; }
}
async function savePage(p) {
  const [baseBlob, srcBlob] = await Promise.all([toBlob(p.base, 'image/jpeg', 0.92), p.src ? toBlob(p.src, 'image/jpeg', 0.88) : null]);
  await dbDo('readwrite', st => st.put({ id: p.id, order: p.order, mode: p.mode, rot: p.rot, pts: p.pts, baseBlob, srcBlob }));
}
const delPage = id => dbDo('readwrite', st => st.delete(id));
const clearPages = () => dbDo('readwrite', st => st.clear());

async function restore() {
  const rows = (await dbDo('readonly', st => st.getAll())) || [];
  rows.sort((a, b) => a.order - b.order);
  for (const r of rows) {
    const base = await blobToCanvas(r.baseBlob);
    const src = r.srcBlob ? await blobToCanvas(r.srcBlob) : null;
    const p = { id: r.id, order: r.order, mode: r.mode, rot: r.rot, pts: r.pts, base, src, thumb: '' };
    p.thumb = makeThumb(renderResult(p));
    state.pages.push(p);
  }
  renderGrid();
}

/* ---------- сетка страниц ---------- */
function renderGrid() {
  const g = $('#grid'); g.innerHTML = '';
  state.pages.forEach((p, i) => {
    const d = document.createElement('button'); d.className = 'thumb';
    d.innerHTML = `<img alt=""><span class="n">${i + 1}</span>`;
    d.querySelector('img').src = p.thumb;
    d.onclick = () => openPage(i);
    g.appendChild(d);
  });
  $('#empty').hidden = state.pages.length > 0;
  $('#btnDone').disabled = state.pages.length === 0;
  $('#btnDone').classList.toggle('primary', state.pages.length > 0);
}

/* ---------- ввод фото ---------- */
async function takeFiles(files) {
  if (!files || !files.length) return;
  state.queue.push(...files);
  if (!state.edit) nextInQueue();
}
async function nextInQueue() {
  const f = state.queue.shift();
  if (!f) return;
  busy(true, 'Открываю снимок…');
  try {
    const src = await fileToCanvas(f, WORK_MAX);
    busy(false);
    if (!cvOk()) {
      busy(true, 'Ищу края…');
      await Promise.race([loadCV().catch(() => {}), sleep(10000)]); // ждём библиотеку, но не вечно
    }
    await sleep(30);
    const pts = detectCorners(src);
    busy(false);
    openEditor({ src, pts, pageId: null });
  } catch (e) { busy(false); toast('Не удалось открыть фото'); console.error(e); nextInQueue(); }
}

/* ---------- редактор краёв ---------- */
const ed = { s: 1, w: 0, h: 0, drag: -1, dpr: 1 };
function openEditor(e) {
  state.edit = e;
  $('#ovEdit').hidden = false;
  requestAnimationFrame(() => { layoutEditor(); drawEditor(); });
  $('#edInfo').textContent = state.queue.length ? `ещё в очереди: ${state.queue.length}` : '';
}
function layoutEditor() {
  const e = state.edit, stage = $('#edStage'), cvs = $('#edCanvas');
  const maxW = stage.clientWidth - 16, maxH = stage.clientHeight - 16;
  ed.s = Math.min(maxW / e.src.width, maxH / e.src.height);
  ed.w = Math.round(e.src.width * ed.s); ed.h = Math.round(e.src.height * ed.s);
  ed.dpr = window.devicePixelRatio || 1;
  cvs.width = ed.w * ed.dpr; cvs.height = ed.h * ed.dpr;
  cvs.style.width = ed.w + 'px'; cvs.style.height = ed.h + 'px';
}
function drawEditor() {
  const e = state.edit; if (!e) return;
  const cvs = $('#edCanvas'), x = cvs.getContext('2d');
  x.setTransform(ed.dpr, 0, 0, ed.dpr, 0, 0);
  x.clearRect(0, 0, ed.w, ed.h);
  x.drawImage(e.src, 0, 0, ed.w, ed.h);
  const P = orderPts(e.pts).map(p => ({ x: p.x * ed.s, y: p.y * ed.s }));
  x.fillStyle = 'rgba(0,0,0,.45)';
  x.beginPath(); x.rect(0, 0, ed.w, ed.h);
  x.moveTo(P[0].x, P[0].y); P.slice(1).forEach(p => x.lineTo(p.x, p.y)); x.closePath();
  x.fill('evenodd');
  x.strokeStyle = '#4d8dff'; x.lineWidth = 2.5;
  x.beginPath(); x.moveTo(P[0].x, P[0].y); P.slice(1).forEach(p => x.lineTo(p.x, p.y)); x.closePath(); x.stroke();
  e.pts.forEach(p => {
    x.beginPath(); x.arc(p.x * ed.s, p.y * ed.s, 13, 0, Math.PI * 2);
    x.fillStyle = 'rgba(255,255,255,.9)'; x.fill();
    x.lineWidth = 3; x.strokeStyle = '#1f6feb'; x.stroke();
  });
}
function edPoint(ev) {
  const r = $('#edCanvas').getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
const edCanvas = $('#edCanvas');
edCanvas.addEventListener('pointerdown', ev => {
  const e = state.edit; if (!e) return;
  const m = edPoint(ev);
  let bi = -1, bd = 56;
  e.pts.forEach((p, i) => { const d = Math.hypot(p.x * ed.s - m.x, p.y * ed.s - m.y); if (d < bd) { bd = d; bi = i; } });
  ed.drag = bi;
  if (bi >= 0) edCanvas.setPointerCapture(ev.pointerId);
});
edCanvas.addEventListener('pointermove', ev => {
  const e = state.edit; if (!e || ed.drag < 0) return;
  const m = edPoint(ev);
  e.pts[ed.drag] = {
    x: Math.min(e.src.width, Math.max(0, m.x / ed.s)),
    y: Math.min(e.src.height, Math.max(0, m.y / ed.s)),
  };
  drawEditor();
});
const endDrag = () => { ed.drag = -1; };
edCanvas.addEventListener('pointerup', endDrag);
edCanvas.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if (state.edit) { layoutEditor(); drawEditor(); } });

$('#edAuto').onclick = () => {
  const e = state.edit; if (!e) return;
  if (!cvOk()) { toast('Авто-поиск краёв ещё не загрузился'); return; }
  e.pts = detectCorners(e.src); drawEditor();
};
$('#edCancel').onclick = () => {
  state.edit = null; $('#ovEdit').hidden = true; nextInQueue();
};
$('#edOk').onclick = async () => {
  const e = state.edit; if (!e) return;
  busy(true, 'Обрезаю и выравниваю…'); await sleep(30);
  try {
    const base = warp(e.src, e.pts);
    if (e.pageId) {
      const p = state.pages.find(q => q.id === e.pageId);
      p.base = base; p.pts = e.pts.map(q => ({ ...q })); p.thumb = makeThumb(renderResult(p));
      await savePage(p);
      state.edit = null; $('#ovEdit').hidden = true; renderGrid(); busy(false);
      openPage(state.pages.indexOf(p)); return;
    }
    const p = { id: uid(), order: Date.now(), mode: 'doc', rot: 0, pts: e.pts.map(q => ({ ...q })), base, src: e.src, thumb: '' };
    p.thumb = makeThumb(renderResult(p));
    state.pages.push(p);
    await savePage(p);
    state.edit = null; $('#ovEdit').hidden = true; renderGrid(); busy(false);
    if (state.queue.length) nextInQueue();
  } catch (err) { busy(false); toast('Ошибка обработки'); console.error(err); }
};

/* ---------- просмотр страницы ---------- */
let viewUrl = null;
async function refreshView() {
  const p = state.pages[state.view]; if (!p) return;
  $('#pgTitle').textContent = `Страница ${state.view + 1} из ${state.pages.length}`;
  document.querySelectorAll('#pgModes button').forEach(b => b.classList.toggle('on', b.dataset.m === p.mode));
  const c = renderResult(p);
  const blob = await toBlob(c, 'image/jpeg', 0.85);
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = URL.createObjectURL(blob);
  $('#pgImg').src = viewUrl;
  p.thumb = makeThumb(c);
}
function openPage(i) { state.view = i; $('#ovPage').hidden = false; refreshView(); }
function closePage() { $('#ovPage').hidden = true; state.view = -1; renderGrid(); }
$('#pgClose').onclick = closePage;
$('#pgModes').onclick = async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  const p = state.pages[state.view]; p.mode = b.dataset.m;
  busy(true, 'Применяю…'); await sleep(20);
  await refreshView(); busy(false); savePage(p);
};
$('#pgRot').onclick = async () => {
  const p = state.pages[state.view]; p.rot = (p.rot + 1) % 4;
  await refreshView(); savePage(p);
};
// «Раньше» / «Позже»: двигают страницу в списке; листать страницы можно свайпом по картинке
async function saveOrder() {
  try {
    const db = await idb();
    const tx = db.transaction('pages', 'readwrite'), st = tx.objectStore('pages');
    state.pages.forEach((p, i) => {
      p.order = i;
      const rq = st.get(p.id);
      rq.onsuccess = () => { if (rq.result) { rq.result.order = i; st.put(rq.result); } };
    });
  } catch (e) { console.warn('saveOrder', e); }
}
async function moveView(d) {
  const i = state.view, j = i + d;
  if (j < 0 || j >= state.pages.length) return;
  const [p] = state.pages.splice(i, 1); state.pages.splice(j, 0, p);
  state.view = j; await refreshView(); saveOrder();
}
$('#pgPrev').onclick = () => moveView(-1);
$('#pgNext').onclick = () => moveView(1);
(() => {
  let x0 = null; const img = $('#pgImg');
  img.addEventListener('pointerdown', e => { x0 = e.clientX; });
  img.addEventListener('pointerup', e => {
    if (x0 === null) return; const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) < 60) return;
    const j = state.view + (dx < 0 ? 1 : -1);
    if (j >= 0 && j < state.pages.length) { state.view = j; refreshView(); }
  });
})();
$('#pgDel').onclick = async () => {
  const p = state.pages[state.view]; if (!p) return;
  if (!confirm('Удалить эту страницу?')) return;
  state.pages.splice(state.view, 1); await delPage(p.id);
  if (!state.pages.length) closePage();
  else { state.view = Math.min(state.view, state.pages.length - 1); refreshView(); renderGrid(); }
};
$('#pgCrop').onclick = () => {
  const p = state.pages[state.view];
  if (!p.src) { toast('Для этой страницы исходник не сохранён'); return; }
  $('#ovPage').hidden = true;
  openEditor({ src: p.src, pts: p.pts.map(q => ({ ...q })), pageId: p.id });
};

/* ---------- PDF ---------- */
function buildPDF(pages) {
  const enc = new TextEncoder(); const chunks = []; let len = 0; const offs = [];
  const push = d => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); len += b.length; };
  const obj = (id, fn) => { offs[id] = len; push(`${id} 0 obj\n`); fn(); push('endobj\n'); };
  const n = pages.length;
  push('%PDF-1.4\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>\n'));
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\n`));
  pages.forEach((p, i) => {
    const W = 595.28, H = +(W * p.h / p.w).toFixed(2);
    const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
    obj(pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>\n`));
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(cid, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\n`));
    obj(iid, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpg.length} >>\nstream\n`);
      push(p.jpg); push('\nendstream\n');
    });
  });
  const xref = len; const total = 3 + n * 3;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offs[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

async function makePdfFile() {
  const out = [];
  for (let i = 0; i < state.pages.length; i++) {
    $('#expInfo').textContent = `Готовлю PDF: ${i + 1} из ${state.pages.length}…`; await sleep(10);
    const c = renderResult(state.pages[i]);
    const b = await toBlob(c, 'image/jpeg', 0.85);
    out.push({ jpg: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height });
  }
  return buildPDF(out);
}
// PDF собираем заранее, при открытии окна: иначе к моменту нажатия «Поделиться»
// браузер уже считает, что жест пользователя устарел, и share() отказывает
let pdfJob = 0;
function prepPdf() {
  const job = ++pdfJob, btns = [$('#btnShare'), $('#btnDownload')];
  state.pdfBlob = null; btns.forEach(b => (b.disabled = true));
  makePdfFile().then(blob => {
    if (job !== pdfJob) return;
    state.pdfBlob = blob; btns.forEach(b => (b.disabled = false));
    $('#expInfo').textContent = `Страниц: ${state.pages.length}, размер ${(blob.size / 1048576).toFixed(1)} МБ`;
  }).catch(e => { console.error(e); $('#expInfo').textContent = 'Ошибка сборки PDF'; });
}
function stamp() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `Скан_${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
}
const cleanName = s => (s.trim() || stamp()).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.pdf$/i, '') + '.pdf';

$('#btnDone').onclick = () => {
  $('#fname').value = stamp();
  $('#shExport').hidden = false;
  prepPdf();
};
const closeExport = () => { $('#shExport').hidden = true; pdfJob++; state.pdfBlob = null; };
$('#btnShClose').onclick = closeExport;
$('#shExport').addEventListener('click', e => { if (e.target.id === 'shExport') closeExport(); });

// без await до share(): иначе теряется «жест пользователя»
$('#btnShare').onclick = () => {
  const blob = state.pdfBlob; if (!blob) return;
  const file = new File([blob], cleanName($('#fname').value), { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    toast('Открываю «Поделиться»…');
    navigator.share({ files: [file], title: file.name })
      .then(() => toast('Отправлено'))
      .catch(e => {
        if (e.name === 'AbortError') toast('Отменено');
        else { toast('Не удалось поделиться: ' + e.name); console.error(e); }
      });
  } else { downloadBlob(blob, file.name); toast('Поделиться не поддерживается, файл скачан'); }
};
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}
$('#btnDownload').onclick = () => {
  if (!state.pdfBlob) return;
  downloadBlob(state.pdfBlob, cleanName($('#fname').value)); toast('Файл в Загрузках');
};
$('#btnClear').onclick = async () => {
  if (!confirm('Удалить все страницы? Это нельзя отменить.')) return;
  state.pages = []; await clearPages(); renderGrid(); closeExport();
};

/* ---------- старт ---------- */
$('#btnShoot').onclick = () => $('#inCam').click();
$('#btnGallery').onclick = () => $('#inGal').click();
['#inCam', '#inGal'].forEach(id => {
  $(id).addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; takeFiles(f); });
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
// фото, присланные через «Поделиться» из галереи (service worker кладёт их в кеш)
async function takeShared() {
  try {
    if (!('caches' in window)) return;
    const c = await caches.open('alfascan-share');
    const keys = (await c.keys()).sort((a, b) => a.url.localeCompare(b.url));
    if (!keys.length) return;
    const files = [];
    for (const k of keys) {
      const r = await c.match(k); const b = await r.blob();
      files.push(new File([b], decodeURIComponent(r.headers.get('X-Name') || 'photo.jpg'), { type: b.type }));
      await c.delete(k);
    }
    if (location.search) history.replaceState(null, '', location.pathname);
    takeFiles(files);
  } catch (e) { console.warn('takeShared', e); }
}

renderGrid();
restore().catch(console.warn).then(takeShared);
startCV();
