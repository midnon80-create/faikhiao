'use strict';
// ไฟเขียว — map with live traffic-light countdowns (learned from drivers), flood reports and flood-aware routes.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const START = [100.5383, 13.7649];                       // Victory Monument [lon, lat]

// ============================================================ map
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty',
  center: START, zoom: 15.5, attributionControl: { compact: true }, pitchWithRotate: false, dragRotate: false,
});
map.touchZoomRotate.disableRotation();
const layersOn = { traffic: true, lights: true, floods: true };
let firstSymbol;

map.on('load', () => {
  firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  map.addSource('roads', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'traffic', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.85,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 14, 3, 17, 6, 19, 10] } }, firstSymbol);
  map.addSource('flood-area', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'flood-area', type: 'circle', source: 'flood-area', paint: {
    'circle-color': ['match', ['get', 'level'], 3, '#d93025', 2, '#ef6c00', '#1e88e5'], 'circle-opacity': 0.18,
    'circle-stroke-color': ['match', ['get', 'level'], 3, '#d93025', 2, '#ef6c00', '#1e88e5'], 'circle-stroke-width': 1, 'circle-stroke-opacity': .5,
    'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['*', ['get', 'r'], 1024 / 152050], 20, ['*', ['get', 'r'], 1048576 / 152050]] } });
  map.addSource('routes', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'route-alt', type: 'line', source: 'routes', filter: ['!=', ['get', 'sel'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#9fbef5', 'line-width': 7 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'sel'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1558b0', 'line-width': 11 } });
  map.addLayer({ id: 'route-main', type: 'line', source: 'routes', filter: ['==', ['get', 'sel'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1a73e8', 'line-width': 7 } });
  map.on('click', 'route-alt', e => selectRoute(e.features[0].properties.idx));
  map.on('mouseenter', 'route-alt', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'route-alt', () => map.getCanvas().style.cursor = '');
  loadArea(); refreshFloods();
});
const fc = features => ({ type: 'FeatureCollection', features });

// ============================================================ helpers
const rad = d => d * Math.PI / 180;
function dist(a, b) {        // [lat, lon] metres
  const x = rad(b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2)), y = rad(b[0] - a[0]);
  return Math.hypot(x, y) * 6371000;
}
function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function hash(n) { let x = Number(n) % 2147483647; x = (x * 16807) % 2147483647; x = (x * 48271) % 2147483647; return x / 2147483647; }
function fmtTime(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
}
function ago(t) {
  const m = Math.round((Date.now() / 1000 - t) / 60);
  return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม. ที่แล้ว`;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3200);
}
async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (prem.session) headers['X-Session'] = prem.session;
  const r = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}

// ============================================================ premium subscription (Google Play Billing)
const PLAY = 'https://play.google.com/billing', SKU = 'faikhiao_monthly';
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.faikhiao.app';
const prem = { session: localStorage.getItem('premSession') || '', expires: +(localStorage.getItem('premExpires') || 0), price: '', dev: false };
const isPremium = () => !!prem.session && prem.expires * 1000 > Date.now();
async function playService() {
  if (!('getDigitalGoodsService' in window)) return null;          // only inside the Android app
  try { return await window.getDigitalGoodsService(PLAY); } catch { return null; }
}
async function verifyPurchase(purchaseToken, sku) {
  const d = await api('/api/premium/verify', { purchaseToken, sku });
  prem.session = d.session; prem.expires = d.expires;
  localStorage.setItem('premSession', d.session); localStorage.setItem('premExpires', d.expires);
  onPremiumChange();
}
async function restorePurchases(quiet) {
  const svc = await playService();
  if (!svc) return false;
  try {
    for (const p of await svc.listPurchases()) if (p.itemId === SKU) { await verifyPurchase(p.purchaseToken, p.itemId); return true; }
  } catch (e) { if (!quiet) toast('กู้คืนไม่สำเร็จ: ' + e.message); }
  if (!quiet) toast('ไม่พบการสมัครสมาชิกในบัญชี Google Play นี้');
  return false;
}
async function subscribe() {
  const svc = await playService();
  if (svc) {
    try {
      const req = new PaymentRequest([{ supportedMethods: PLAY, data: { sku: SKU } }],
        { total: { label: 'ไฟเขียว พรีเมียม', amount: { currency: 'THB', value: '0' } } });
      const res = await req.show();
      await verifyPurchase(res.details.purchaseToken, SKU);
      await res.complete('success');
      toast('สมัครสำเร็จ! ตอนนี้เห็นวินาทีไฟแดง/เขียวทุกแยกแล้ว');
    } catch (e) { if (e.name !== 'AbortError') toast('สมัครไม่สำเร็จ: ' + e.message); }
    return;
  }
  if (prem.dev) {                                                   // test server only
    try { await verifyPurchase('dev-' + Math.random().toString(36).slice(2), SKU); toast('เปิดพรีเมียมแล้ว (โหมดทดสอบ)'); }
    catch (e) { toast(e.message); }
    return;
  }
  openSheet('premium-web', `
    <button class="icon-btn close-x" data-close><span class="ms">close</span></button>
    <h2>สมัครผ่านแอปไฟเขียว</h2>
    <div class="sub">การสมัครสมาชิกทำผ่าน Google Play ในแอปไฟเขียวบนมือถือ Android</div>
    <div class="row"><a class="pill primary" href="${PLAY_URL}" target="_blank" style="text-decoration:none"><span class="ms">shop</span>เปิดใน Google Play</a></div>`, 'peek');
}
function onPremiumChange() {
  document.body.classList.toggle('premium', isPremium());
  est.clear(); for (const mk of markers.values()) mk.last = '';
  refreshEstimates(); tick();
  if (sheetKind === 'light') openLight(lightId);
  if (sheetKind === 'premium') openPremium();
}
function paywallHtml() {
  return `<div class="paywall">
    <div class="pw-title"><span class="ms fill">timer</span>รู้ก่อนว่าไฟแดงเหลืออีกกี่วินาที</div>
    <ul><li>วินาทีไฟแดง/ไฟเขียวแบบเรียลไทม์ทุกแยก</li><li>คำนวณจากรถจริงของผู้ใช้ แม่นขึ้นทุกวัน</li><li>ยกเลิกได้ทุกเมื่อใน Google Play</li></ul>
    <button class="pill primary wide" data-sub><span class="ms fill">workspace_premium</span>ทดลองฟรี 7 วัน${prem.price ? ' แล้ว ' + prem.price + '/เดือน' : ''}</button>
  </div>`;
}
function openPremium() {
  const on = isPremium();
  openSheet('premium', `
    <button class="icon-btn close-x" data-close><span class="ms">close</span></button>
    <div class="brand"><img src="icon-192.png" alt=""><div><h2>ไฟเขียว พรีเมียม</h2>
      <div class="sub">${on ? `ใช้งานอยู่ · ถึง ${new Date(prem.expires * 1000).toLocaleDateString('th-TH')}` : 'ยังไม่ได้สมัคร'}</div></div></div>
    ${on ? '<div class="alert ok"><span class="ms fill">check_circle</span><div>คุณเห็นวินาทีไฟจราจรทุกแยกแล้ว ขอบคุณที่สนับสนุน!</div></div>' : paywallHtml()}
    <div class="row">
      <button class="pill" id="restoreBtn"><span class="ms">restore</span>กู้คืนการสมัคร</button>
      <a class="pill" href="privacy.html" target="_blank" style="text-decoration:none"><span class="ms">policy</span>ความเป็นส่วนตัว</a>
    </div>`, 'peek');
  $('#restoreBtn').onclick = () => restorePurchases(false);
}
document.getElementById('sheetBody').addEventListener('click', e => { if (e.target.closest('[data-sub]')) subscribe(); });
document.querySelector('.logo').addEventListener('click', openPremium);
(async () => {
  try { const s = await api('/api/premium/status'); prem.dev = s.dev; if (prem.session && !s.premium) { prem.expires = 0; } } catch {}
  const svc = await playService();
  if (svc) {
    try { const [d] = await svc.getDetails([SKU]); if (d?.price) prem.price = new Intl.NumberFormat('th-TH', { style: 'currency', currency: d.price.currency, maximumFractionDigits: 0 }).format(+d.price.value); } catch {}
    await restorePurchases(true);                                    // renewals: re-check on every start
  }
  onPremiumChange();
})();

// ============================================================ bottom sheet
const sheet = $('#sheet'), sheetBody = $('#sheetBody');
let sheetKind = null, sheetOnClose = null;
function openSheet(kind, html, size = 'peek', onClose = null) {
  if (sheetOnClose && sheetKind !== kind) { const f = sheetOnClose; sheetOnClose = null; f(); }
  sheetKind = kind; sheetOnClose = onClose;
  sheetBody.innerHTML = html; sheet.dataset.size = size; sheetBody.scrollTop = 0;
  placeFabs();
}
function closeSheet() {
  sheet.dataset.size = 'hidden'; sheetKind = null;
  if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
  placeFabs();
}
function placeFabs() {
  requestAnimationFrame(() => {
    const h = sheet.dataset.size === 'hidden' ? 0 : sheet.getBoundingClientRect().height;
    $('#fabs').style.bottom = (h ? h + 14 : 28) + 'px';
  });
}
// drag the handle up/down (mobile)
(() => {
  let y0 = null;
  $('#handle').addEventListener('pointerdown', e => { y0 = e.clientY; e.target.setPointerCapture(e.pointerId); });
  $('#handle').addEventListener('pointerup', e => {
    if (y0 == null) return;
    const dy = e.clientY - y0; y0 = null;
    const s = sheet.dataset.size;
    if (Math.abs(dy) < 8) sheet.dataset.size = s === 'peek' ? 'full' : 'peek';
    else if (dy < 0) sheet.dataset.size = 'full';
    else if (s === 'full') sheet.dataset.size = 'peek';
    else closeSheet();
    placeFabs();
  });
})();
sheetBody.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });

// ============================================================ road traffic (simulated colours)
function rushFactor(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60, peak = (c, w) => Math.exp(-((h - c) ** 2) / (2 * w * w));
  return 0.25 + 0.75 * Math.max(peak(8, 1.2), peak(17.75, 1.6));
}
const roadWeight = { motorway: 1.0, trunk: 0.95, primary: 0.85, secondary: 0.65, tertiary: 0.45 };
function congestion(w, t) {
  const r = hash(w.id), wave = 0.5 + 0.5 * Math.sin(t / 90000 + r * 6.28);
  const base = (roadWeight[w.h] || 0.5) * rushFactor();
  return Math.min(1, base * (0.55 + 0.6 * r) + 0.3 * wave * base);
}
const trafficColor = c => c < 0.35 ? '#1ea362' : c < 0.55 ? '#f5a623' : c < 0.75 ? '#e8453c' : '#8c1c13';
const ways = new Map();       // id -> {id, h, n, g:[[lat,lon]]}
function paintRoads() {
  if (!map.getSource('roads')) return;
  const t = Date.now();
  map.getSource('roads').setData(fc([...ways.values()].map(w => ({ type: 'Feature',
    properties: { color: trafficColor(congestion(w, t)) }, geometry: { type: 'LineString', coordinates: w.g.map(([a, b]) => [b, a]) } }))));
}
setInterval(paintRoads, 30000);

// ============================================================ OSM data (roads + signals)
const signals = new Map();    // id -> [lat, lon]
let cacheBox = null;
const OVERPASS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const cacheReady = fetch('bangkok.json').then(r => r.json()).then(d => {
  cacheBox = d.bbox; ingest(d.el);
}).catch(() => {});
function ingest(els) {
  for (const e of els) {
    if (e.t === 'n') signals.set(e.id, [e.lat, e.lon]);
    else if (!ways.has(e.id)) ways.set(e.id, e);
  }
}
const loadedBoxes = [];
const inBox = (b, bb) => b.getSouth() >= bb[0] && b.getWest() >= bb[1] && b.getNorth() <= bb[2] && b.getEast() <= bb[3];
let overpassBusy = false;
async function loadArea() {
  await cacheReady;
  const b = map.getBounds();
  if (map.getZoom() >= 13.5 && !(cacheBox && inBox(b, cacheBox)) && !loadedBoxes.some(bb => inBox(b, bb)) && !overpassBusy) {
    overpassBusy = true;
    const p = 0.01, bb = [b.getSouth() - p, b.getWest() - p, b.getNorth() + p, b.getEast() + p];
    const q = `[out:json][timeout:25];(node["highway"="traffic_signals"](${bb});way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](${bb}););out geom;`;
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 30000);
    try {
      const d = await Promise.any(OVERPASS.map(ep => fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrl.signal })
        .then(r => { if (!r.ok) throw 0; return r.json(); })));
      ctrl.abort();
      ingest(d.elements.map(e => e.type === 'node' ? { t: 'n', id: e.id, lat: e.lat, lon: e.lon }
        : e.geometry && { t: 'w', id: e.id, h: e.tags?.highway, n: e.tags?.name || '', g: e.geometry.map(p => [p.lat, p.lon]) }).filter(Boolean));
      loadedBoxes.push(bb);
    } catch { setTimeout(loadArea, 8000); }
    overpassBusy = false;
  }
  paintRoads(); syncLightMarkers();
}
let moveT;
map.on('moveend', () => { clearTimeout(moveT); moveT = setTimeout(loadArea, 400); });

// ============================================================ traffic lights
const ARROW = ['↑', '→', '↓', '←'];
let timeOffset = 0;
const nowS = () => Date.now() / 1000 + timeOffset;
fetch('/api/time').then(r => r.json()).then(d => timeOffset = d.t - Date.now() / 1000).catch(() => {});
function guessPlan(id) {
  const r = hash(id), cycle = 60 + Math.round(r * 120);
  return { cycle, green: Math.round(cycle * (0.3 + 0.25 * hash(id * 7))), g0: Math.round(hash(id * 13) * cycle), guess: true };
}
function stateOf(p, t) {
  const rel = ((t - p.g0) % p.cycle + p.cycle) % p.cycle;
  if (rel < p.green - 3) return { c: 'g', left: Math.ceil(p.green - 3 - rel) };
  if (rel < p.green) return { c: 'y', left: Math.ceil(p.green - rel) };
  return { c: 'r', left: Math.ceil(p.cycle - rel) };
}
const est = new Map();        // id -> {dir: estimate}
let heading = null, reportDir = 0;
function planFor(id) {
  const e = est.get(id);
  if (e) {
    const ok = Object.entries(e).filter(([, v]) => v.conf >= 0.35);
    if (ok.length) {
      const pick = ok.find(([d]) => +d === heading) || ok.sort((a, b) => b[1].conf - a[1].conf)[0];
      return { ...pick[1], dir: +pick[0] };
    }
  }
  return guessPlan(id);
}
const markers = new Map();    // id -> {m, el, last}
function syncLightMarkers() {
  const show = layersOn.lights && map.getZoom() >= 15;
  const b = map.getBounds(), pad = 0.002;
  for (const [id, [la, lo]] of signals) {
    const vis = show && la > b.getSouth() - pad && la < b.getNorth() + pad && lo > b.getWest() - pad && lo < b.getEast() + pad;
    const have = markers.get(id);
    if (vis && !have) {
      const wrap = document.createElement('div'), el = document.createElement('div');
      el.className = 'tl'; wrap.appendChild(el);              // style the inner div; MapLibre owns the wrapper's classes
      wrap.addEventListener('click', e => { e.stopPropagation(); openLight(id); });
      markers.set(id, { m: new maplibregl.Marker({ element: wrap }).setLngLat([lo, la]).addTo(map), el, last: '' });
    } else if (!vis && have) { have.m.remove(); markers.delete(id); }
  }
  tick(); refreshEstimates();
}
function tick() {
  const t = nowS();
  for (const [id, mk] of markers) {
    if (!isPremium()) {                       // free: show where the lights are, the seconds are premium
      if (mk.last !== 'lock') { mk.last = 'lock'; mk.el.className = 'tl lock'; mk.el.innerHTML = '<span class="ms fill">traffic</span>'; }
      continue;
    }
    const p = planFor(id), s = stateOf(p, t), key = s.c + s.left + p.guess;
    if (p.guess) {                            // no real reports for this light yet: never show a made-up number
      if (mk.last !== 'nodata') { mk.last = 'nodata'; mk.el.className = 'tl lock'; mk.el.innerHTML = '<span class="ms">traffic</span>'; }
      continue;
    }
    if (key === mk.last) continue;
    mk.last = key;
    mk.el.className = `tl ${s.c} ${p.guess ? 'guess' : 'live'}`;
    mk.el.innerHTML = `<i></i>${p.guess ? '~' : ''}${s.left}`;
  }
  if (sheetKind === 'light') updateLightSheet();
}
setInterval(tick, 1000);
let estBusy = false;
async function refreshEstimates() {
  if (estBusy || !markers.size || !isPremium()) return;
  estBusy = true;
  try {
    const d = await api('/api/estimates', { nodes: [...markers.keys()] });
    est.clear();
    if (d.locked) { if (isPremium()) { prem.expires = 0; onPremiumChange(); } estBusy = false; return; }
    for (const [id, v] of Object.entries(d)) est.set(+id, v);
    for (const mk of markers.values()) mk.last = '';
    tick();
  } catch {}
  estBusy = false;
}
setInterval(refreshEstimates, 20000);

let lightId = null;
function openLight(id) {
  lightId = id;
  const e = est.get(id) || {}, rows = Object.entries(e), locked = !isPremium();
  openSheet('light', `
    <button class="icon-btn close-x" data-close><span class="ms">close</span></button>
    <div class="muted">สัญญาณไฟจราจร</div>
    ${locked ? paywallHtml() : ''}
    <div class="light-hero" ${locked ? 'hidden' : ''}>
      <div class="lamp"><i class="r"></i><i class="y"></i><i class="g"></i></div>
      <div><div class="state-name" id="lsName"></div><div class="count" id="lsCount"></div><div id="lsBadge" style="margin-top:6px"></div></div>
    </div>
    ${rows.length ? `<table class="dir-table">${rows.map(([d, v]) => `<tr><td><b>${ARROW[d]}</b></td><td>รอบไฟ ${Math.round(v.cycle)} วิ</td>
      <td>เขียว ${Math.round(v.green)}${v.greenKnown ? '' : '?'} วิ</td><td>มั่นใจ ${Math.round(v.conf * 100)}%</td><td class="muted">${v.n} รายงาน</td></tr>`).join('')}</table>` : ''}
    <hr class="sep">
    <b>อยู่ที่แยกนี้ไหม?</b> <span class="muted">บอกจังหวะไฟ ช่วยให้ทุกคนเห็นเวลาที่แม่นขึ้น</span><br>
    <div class="muted" style="margin-top:8px">ทิศที่คุณกำลังขับไป</div>
    <div class="seg" id="segDir">${ARROW.map((a, i) => `<button data-dir="${i}" class="${i === reportDir ? 'sel' : ''}">${a}</button>`).join('')}</div>
    <div class="row">
      <button class="pill green" data-rep="green"><span class="ms fill">circle</span>ไฟเพิ่งเขียว</button>
      <button class="pill red" data-rep="red"><span class="ms fill">circle</span>ไฟเพิ่งแดง</button>
    </div>`, 'peek');
  sheetBody.querySelector('#segDir').onclick = ev => {
    const b = ev.target.closest('button'); if (!b) return;
    reportDir = +b.dataset.dir; sheetBody.querySelectorAll('#segDir button').forEach(x => x.classList.toggle('sel', x === b));
  };
  sheetBody.querySelectorAll('[data-rep]').forEach(b => b.onclick = () => {
    queueEvent(id, reportDir, b.dataset.rep, nowS()); flushEvents();
    toast('ขอบคุณ! ยิ่งหลายคนช่วย ตัวเลขยิ่งแม่น');
  });
  updateLightSheet();
}
function updateLightSheet() {
  if (lightId == null || !$('#lsCount') || !isPremium()) return;
  const p = planFor(lightId), s = stateOf(p, nowS());
  sheetBody.querySelectorAll('.lamp i').forEach(i => i.classList.toggle('on', i.classList.contains(s.c)));
  if (p.guess) {
    sheetBody.querySelectorAll('.lamp i').forEach(i => i.classList.remove('on'));
    $('#lsName').textContent = 'ยังไม่มีข้อมูลแยกนี้'; $('#lsName').style.color = 'var(--text-2)';
    $('#lsCount').innerHTML = '<small style="margin:0">เปิด "ช่วยวัดไฟ" ตอนขับผ่าน หรือกดบอกจังหวะไฟด้านล่าง</small>';
    $('#lsBadge').innerHTML = '<span class="badge guess"><span class="ms">hourglass_empty</span>รอรถผู้ใช้ผ่านแยกนี้</span>';
    return;
  }
  $('#lsName').textContent = { g: 'ไฟเขียว', y: 'ไฟเหลือง', r: 'ไฟแดง' }[s.c] + ' อีก';
  $('#lsName').style.color = { g: 'var(--green)', y: '#b06000', r: 'var(--red)' }[s.c];
  $('#lsCount').innerHTML = `${s.left}<small>วินาที</small>`;
  $('#lsBadge').innerHTML = p.guess
    ? '<span class="badge guess"><span class="ms">help</span>ค่าเดา · ยังไม่มีรถผู้ใช้ผ่านแยกนี้</span>'
    : `<span class="badge live"><span class="ms">sensors</span>จากรถจริงของผู้ใช้ · ทิศ ${ARROW[p.dir]}</span>`;
}

// ============================================================ reporting stop/go events
let outbox = [];
function queueEvent(node, dir, kind, t) { outbox.push({ node, dir, kind, t: Math.round(t * 10) / 10 }); }
async function flushEvents() {
  if (!outbox.length) return;
  const batch = outbox.splice(0, 50);
  try { await api('/api/events', { events: batch }); setTimeout(refreshEstimates, 400); }
  catch { outbox.unshift(...batch); }
}
setInterval(flushEvents, 10000);

// ============================================================ GPS: my location + stop/go detection
let me = null, meMarker = null, watchId = null, follow = false, contributing = false;
const dirOf = h => Math.round(h / 90) % 4;
function signalAhead(pos, hdg, maxD) {
  let best = null;
  for (const [id, p] of signals) {
    if (Math.abs(p[0] - pos[0]) > 0.001 || Math.abs(p[1] - pos[1]) > 0.001) continue;
    const d = dist(pos, p);
    if (d > maxD) continue;
    const diff = Math.abs(((bearing(pos, p) - hdg) + 540) % 360 - 180);
    if ((d < 15 || diff < 60) && (!best || d < best.d)) best = { id, d };
  }
  return best;
}
const trk = { prev: null, hdg: null, slowSince: null, stopped: null, goAt: null, passed: new Map() };
function onPosition(pos) {
  const p = [pos.coords.latitude, pos.coords.longitude], t = pos.timestamp / 1000 + timeOffset;
  me = p;
  if (!meMarker) { const el = document.createElement('div'); el.className = 'me'; meMarker = new maplibregl.Marker({ element: el }).setLngLat([p[1], p[0]]).addTo(map); }
  meMarker.setLngLat([p[1], p[0]]);
  if (follow) map.easeTo({ center: [p[1], p[0]], duration: 500 });
  if (!contributing) return;
  let v = pos.coords.speed;
  if (trk.prev) {
    const d = dist(trk.prev.p, p), dt = t - trk.prev.t;
    if (dt <= 0) return;
    if (v == null || isNaN(v)) v = d / dt;
    if (v > 3 && d > 3) { trk.hdg = bearing(trk.prev.p, p); heading = dirOf(trk.hdg); }
  }
  trk.prev = { p, t };
  if (v == null || trk.hdg == null) return;
  if (!trk.stopped) {
    if (v < 1) {                                     // waiting in front of a light => red
      trk.slowSince ??= t;
      if (t - trk.slowSince >= 3) {
        const s = signalAhead(p, trk.hdg, 70);
        if (s) { trk.stopped = { id: s.id, dir: dirOf(trk.hdg), p, t: trk.slowSince }; queueEvent(s.id, trk.stopped.dir, 'stop', trk.slowSince); }
      }
    } else trk.slowSince = null;
    if (v > 4) {                                     // crossing the signal without stopping => green
      const s = signalAhead(p, trk.hdg, 12);
      if (s && t - (trk.passed.get(s.id) || 0) > 90) { queueEvent(s.id, dirOf(trk.hdg), 'pass', t); trk.passed.set(s.id, t); }
    }
  } else {                                           // pulled away (>35 m, not queue creep) => green just started
    if (v > 2 && trk.goAt == null) trk.goAt = t;
    if (v < 1) trk.goAt = null;
    if (trk.goAt != null && dist(trk.stopped.p, p) > 35) {
      queueEvent(trk.stopped.id, trk.stopped.dir, 'go', trk.goAt);
      trk.passed.set(trk.stopped.id, t); trk.stopped = trk.goAt = trk.slowSince = null;
    } else if (t - trk.stopped.t > 600) trk.stopped = null;
  }
}
window.__feedPosition = (lat, lon, ms, speed = null) => onPosition({ coords: { latitude: lat, longitude: lon, speed }, timestamp: ms });
function startWatch() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onPosition, () => {}, { enableHighAccuracy: true, maximumAge: 0 });
}
function getMe(timeout = 6000) {
  if (me) return Promise.resolve(me);
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => { onPosition(p); startWatch(); res(me); }, () => res(null), { enableHighAccuracy: true, timeout });
  });
}
$('#locate').onclick = async () => {
  const p = await getMe();
  if (!p) return toast('เปิดตำแหน่งไม่ได้ กรุณาอนุญาตการเข้าถึงตำแหน่ง');
  follow = !follow || true; $('#locate').classList.add('on');
  map.easeTo({ center: [p[1], p[0]], zoom: Math.max(map.getZoom(), 16) });
};
map.on('dragstart', () => { follow = false; $('#locate').classList.remove('on'); });
$('#chipDrive').onclick = async () => {
  const c = $('#chipDrive');
  if (contributing) { contributing = false; c.classList.remove('live'); c.innerHTML = '<span class="ms">directions_car</span>ช่วยวัดไฟ'; flushEvents(); return toast('หยุดวัดไฟแล้ว'); }
  const p = await getMe();
  if (!p) return toast('ต้องอนุญาตตำแหน่งก่อน จึงจะช่วยวัดไฟได้');
  contributing = true; follow = true; startWatch();
  c.classList.add('live'); c.innerHTML = '<span class="ms">sensors</span>กำลังวัดไฟ';
  toast('กำลังช่วยวัดไฟ · ส่งแค่ รหัสไฟ ทิศ และเวลา ไม่ส่งเส้นทางของคุณ');
};

// ============================================================ floods
const FLOOD = {
  1: { name: 'น้ำท่วมขัง', desc: 'ระดับข้อเท้า รถผ่านได้ ขับช้าๆ', short: 'ข้อเท้า · ผ่านได้', icon: 'water', r: 50 },
  2: { name: 'น้ำท่วมสูง', desc: 'ระดับเข่า รถเก๋ง/มอเตอร์ไซค์เสี่ยง', short: 'เข่า · รถเล็กเสี่ยง', icon: 'flood', r: 70 },
  3: { name: 'ผ่านไม่ได้', desc: 'น้ำลึกเกินเข่า ควรเลี่ยงเส้นทางนี้', short: 'เกินเข่า · ควรเลี่ยง', icon: 'block', r: 90 },
};
let floods = [];
const floodMarkers = new Map();
async function refreshFloods() {
  try { floods = await api('/api/floods'); } catch { return; }
  drawFloods();
}
setInterval(refreshFloods, 30000);
function drawFloods() {
  const show = layersOn.floods;
  map.getSource('flood-area')?.setData(fc(show ? floods.map(f => ({ type: 'Feature', properties: { level: f.level, r: FLOOD[f.level].r },
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] } })) : []));
  const ids = new Set(show ? floods.map(f => f.id) : []);
  for (const [id, mk] of floodMarkers) if (!ids.has(id)) { mk.remove(); floodMarkers.delete(id); }
  for (const f of show ? floods : []) {
    const old = floodMarkers.get(f.id);
    if (old) { old.remove(); }
    const el = document.createElement('div');
    el.className = `fm l${f.level}`; el.innerHTML = `<span class="ms fill">${FLOOD[f.level].icon}</span>`;
    el.addEventListener('click', e => { e.stopPropagation(); openFlood(f.id); });
    floodMarkers.set(f.id, new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([f.lon, f.lat]).addTo(map));
  }
}
function openFlood(id) {
  const f = floods.find(x => x.id === id); if (!f) return;
  const L = FLOOD[f.level];
  openSheet('flood', `
    <button class="icon-btn close-x" data-close><span class="ms">close</span></button>
    <div class="muted">รายงานน้ำท่วมจากผู้ใช้</div>
    <h2 style="color:${f.level === 3 ? 'var(--red)' : f.level === 2 ? '#ef6c00' : 'var(--water)'}">${L.name}</h2>
    <div class="sub">${L.desc}</div>
    <div class="muted" style="margin-top:6px">อัปเดต ${ago(f.t)} · ยืนยันแล้ว ${f.confirms} ครั้ง</div>
    <div class="row">
      <button class="pill" data-vote="1"><span class="ms">water_drop</span>ยังท่วมอยู่</button>
      <button class="pill" data-vote="0"><span class="ms">check_circle</span>น้ำลดแล้ว</button>
    </div>`, 'peek');
  sheetBody.querySelectorAll('[data-vote]').forEach(b => b.onclick = async () => {
    await api('/api/floods/vote', { id, still: b.dataset.vote === '1' }).catch(() => {});
    toast('ขอบคุณที่ช่วยอัปเดต'); closeSheet(); refreshFloods();
  });
}
// report: move the map so the pin sits on the flooded spot, then pick a level
async function startFloodReport() {
  const p = me || await getMe(3000);
  if (p) map.easeTo({ center: [p[1], p[0]], zoom: Math.max(map.getZoom(), 17) });
  $('#centerPin').hidden = false;
  openSheet('report', `
    <button class="icon-btn close-x" data-close><span class="ms">close</span></button>
    <h2>แจ้งน้ำท่วม</h2>
    <div class="sub">เลื่อนแผนที่ให้หมุดตรงจุดที่น้ำท่วม แล้วเลือกระดับน้ำ</div>
    <div class="levels">${[1, 2, 3].map(l => `<button class="level lv${l}" data-lv="${l}">
      <span class="ico"><span class="ms fill">${FLOOD[l].icon}</span></span>
      <b>${FLOOD[l].name}</b><small>${FLOOD[l].short}</small></button>`).join('')}</div>`, 'peek',
    () => { $('#centerPin').hidden = true; map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
            Object.assign($('#centerPin').style, { top: '', left: '' }); });
  // keep the pin in the middle of the part of the map that is still visible
  requestAnimationFrame(() => {
    const desktop = innerWidth >= 820, top = desktop ? 0 : 130;
    const pad = desktop ? { left: 440, top: 0, bottom: 0, right: 0 } : { top, bottom: sheet.getBoundingClientRect().height, left: 0, right: 0 };
    const c = map.getCenter(); map.setPadding(pad); map.jumpTo({ center: c });
    const pin = $('#centerPin');
    pin.style.top = (pad.top + (innerHeight - pad.top - pad.bottom) / 2) + 'px';
    pin.style.left = (pad.left + (innerWidth - pad.left) / 2) + 'px';
  });
  sheetBody.querySelectorAll('[data-lv]').forEach(b => b.onclick = async () => {
    const c = map.getCenter();
    try {
      await api('/api/floods', { lat: c.lat, lon: c.lng, level: +b.dataset.lv });
      toast('ขอบคุณ! แจ้งน้ำท่วมแล้ว คนที่ใช้เส้นทางนี้จะได้รับคำเตือน');
    } catch { toast('ส่งไม่สำเร็จ ลองใหม่อีกครั้ง'); }
    closeSheet(); refreshFloods();
    if (routeState.to) planRoute();
  });
}
$('#chipReport').onclick = startFloodReport;

// ============================================================ layer chips
document.querySelectorAll('[data-layer]').forEach(b => b.onclick = () => {
  const k = b.dataset.layer; layersOn[k] = !layersOn[k]; b.classList.toggle('on', layersOn[k]);
  if (k === 'traffic') map.setLayoutProperty('traffic', 'visibility', layersOn.traffic ? 'visible' : 'none');
  if (k === 'lights') syncLightMarkers();
  if (k === 'floods') drawFloods();
});

// ============================================================ search (Photon geocoder)
let sugItems = [], sugTarget = null, sugT;
function bindSearch(input, onPick) {
  input.addEventListener('input', () => {
    clearTimeout(sugT);
    if (input === $('#q')) $('#qClear').hidden = !input.value;
    const q = input.value.trim();
    if (q.length < 2) return hideSug();
    sugT = setTimeout(async () => {
      const c = map.getCenter();
      // Photon is fast for partial/English names; Nominatim understands Thai names. Ask both, merge.
      const photon = fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lng}&limit=5`)
        .then(r => r.json()).then(d => d.features.map(f => { const p = f.properties;
          return { name: p.name || p.street || q, sub: [p.street, p.district || p.locality, p.city].filter(Boolean).join(' · '),
            lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }; })).catch(() => []);
      const vb = [c.lng - 0.3, c.lat + 0.3, c.lng + 0.3, c.lat - 0.3].join(',');
      const nomi = fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=th&accept-language=th&viewbox=${vb}&q=${encodeURIComponent(q)}`)
        .then(r => r.json()).then(d => d.map(x => { const parts = x.display_name.split(', ');
          return { name: x.name || parts[0], sub: parts.slice(1, 4).join(' · '), lat: +x.lat, lon: +x.lon }; })).catch(() => []);
      const [a, b] = await Promise.all([nomi, photon]);
      if (input.value.trim() !== q) return;                     // user kept typing
      sugItems = [];
      for (const it of [...a, ...b]) if (!sugItems.some(s => dist([s.lat, s.lon], [it.lat, it.lon]) < 150)) sugItems.push(it);
      sugItems = sugItems.slice(0, 6);
      sugTarget = onPick; showSug();
    }, 450);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && sugItems[0] && !$('#suggest').hidden) { e.preventDefault(); pickSug(0); } });
}
function showSug() {
  const s = $('#suggest');
  s.innerHTML = sugItems.length ? sugItems.map((it, i) => `<div class="sug" data-i="${i}"><span class="ms">location_on</span>
    <div><b>${esc(it.name)}</b><small>${esc(it.sub)}</small></div></div>`).join('') : '<div class="sug"><small>ไม่พบสถานที่</small></div>';
  s.hidden = false; $('#chips').style.visibility = 'hidden';
}
function hideSug() { $('#suggest').hidden = true; $('#chips').style.visibility = ''; }
function pickSug(i) { const it = sugItems[i]; hideSug(); if (it && sugTarget) sugTarget(it); }
$('#suggest').addEventListener('click', e => { const el = e.target.closest('[data-i]'); if (el) pickSug(+el.dataset.i); });
map.on('click', hideSug);
$('#qClear').onclick = () => { $('#q').value = ''; $('#qClear').hidden = true; hideSug(); clearDest(); closeSheet(); };

let destMarker = null, place = null;
function setDest(it) {
  place = it;
  if (!destMarker) { const el = document.createElement('span'); el.className = 'ms fill dest'; el.textContent = 'location_on';
    destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }); }
  destMarker.setLngLat([it.lon, it.lat]).addTo(map);
}
function clearDest() { destMarker?.remove(); place = null; }
bindSearch($('#q'), it => {
  $('#q').value = it.name; $('#qClear').hidden = false; setDest(it);
  map.flyTo({ center: [it.lon, it.lat], zoom: 16 });
  openSheet('place', `
    <button class="icon-btn close-x" data-close><span class="ms">close</span></button>
    <h2>${esc(it.name)}</h2><div class="sub">${esc(it.sub)}</div>
    <div class="row">
      <button class="pill primary" id="goDir"><span class="ms fill">directions</span>เส้นทาง</button>
      <button class="pill" id="goFlood"><span class="ms">add_location_alt</span>แจ้งน้ำท่วมแถวนี้</button>
    </div>`, 'peek');
  $('#goDir').onclick = () => openDirections(it);
  $('#goFlood').onclick = startFloodReport;
});

// ============================================================ directions
const routeState = { from: null, to: null, routes: [], sel: 0 };
function openDirections(dest) {
  $('#searchbar').hidden = true; $('#dirbar').hidden = false; $('#chips').hidden = true; hideSug();
  routeState.to = dest || place || null; routeState.from = null;
  $('#to').value = routeState.to?.name || ''; $('#from').value = '';
  if (!routeState.to) { $('#to').focus(); openSheet('routes', '<div class="muted" style="padding:8px 0">เลือกปลายทางเพื่อดูเส้นทาง</div>', 'peek'); return; }
  planRoute();
}
function closeDirections() {
  $('#dirbar').hidden = true; $('#searchbar').hidden = false; $('#chips').hidden = false; hideSug();
  routeState.routes = []; map.getSource('routes')?.setData(fc([])); closeSheet();
}
$('#dirBtnTop').onclick = () => openDirections();
$('#dirBack').onclick = closeDirections;
$('#dirSwap').onclick = async () => {
  const from = routeState.from || (await getMe(3000) && { name: 'ตำแหน่งของคุณ', lat: me[0], lon: me[1] });
  if (!from || !routeState.to) return;
  routeState.from = routeState.to; routeState.to = from;
  $('#from').value = routeState.from.name; $('#to').value = routeState.to.name; planRoute();
};
bindSearch($('#from'), it => { routeState.from = it; $('#from').value = it.name; planRoute(); });
bindSearch($('#to'), it => { routeState.to = it; $('#to').value = it.name; setDest(it); planRoute(); });

async function planRoute() {
  if (!routeState.to) return;
  let from = routeState.from, usedCenter = false;
  if (!from) {
    const p = await getMe(5000);
    if (p) from = { lat: p[0], lon: p[1], name: 'ตำแหน่งของคุณ' };
    else { const c = map.getCenter(); from = { lat: c.lat, lon: c.lng, name: 'จุดกลางแผนที่' }; usedCenter = true; }
  }
  $('#from').placeholder = from.name;
  openSheet('routes', '<div class="skeleton"></div><div class="skeleton"></div>', 'peek');
  try {
    const d = await api('/api/route', { from: [from.lat, from.lon], to: [routeState.to.lat, routeState.to.lon] });
    routeState.routes = d.routes; routeState.sel = 0; routeState.fromUsed = from;
    if (!d.routes.length) return openSheet('routes', '<div class="muted" style="padding:8px 0">ไม่พบเส้นทาง</div>', 'peek');
    drawRoutes(); renderRoutes(usedCenter);
    const pts = d.routes.flatMap(r => r.shape);
    const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
    const desktop = innerWidth >= 820;
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: desktop ? { top: 80, bottom: 60, left: 460, right: 80 } : { top: 190, bottom: innerHeight * 0.42, left: 40, right: 40 }, duration: 600 });
  } catch (e) {
    openSheet('routes', `<div class="muted" style="padding:8px 0">หาเส้นทางไม่สำเร็จ (${esc(e.message)})</div>
      <button class="pill" id="retry"><span class="ms">refresh</span>ลองใหม่</button>`, 'peek');
    $('#retry').onclick = planRoute;
  }
}
function drawRoutes() {
  map.getSource('routes')?.setData(fc(routeState.routes.map((r, i) => ({ type: 'Feature', properties: { idx: i, sel: i === routeState.sel },
    geometry: { type: 'LineString', coordinates: r.shape.map(([a, b]) => [b, a]) } }))
    .sort((a, b) => a.properties.sel - b.properties.sel)));
}
function selectRoute(i) {
  routeState.sel = i; drawRoutes();
  sheetBody.querySelectorAll('.route').forEach(el => el.classList.toggle('sel', +el.dataset.i === i));
}
function renderRoutes(usedCenter) {
  const rs = routeState.routes, fastest = rs.find(r => r.tags?.includes('fastest')) || rs[0];
  const safe = rs.find(r => r.tags?.includes('least_flood'));
  const worst = r => Math.max(0, ...r.floods.map(f => f.level));
  let alert = '';
  if (fastest.floods.length) {
    alert = `<div class="alert"><span class="ms fill">flood</span><div><b>เส้นทางปกติมีน้ำท่วม ${fastest.floods.length} จุด</b>${worst(fastest) === 3 ? ' (มีจุดที่ผ่านไม่ได้)' : ''}<br>
      ${safe ? `แนะนำเส้นทางเลี่ยงน้ำท่วม ช้ากว่าประมาณ ${fmtTime(safe.sec - fastest.sec)}` : 'ยังไม่พบเส้นทางที่เลี่ยงได้ทั้งหมด ขับด้วยความระมัดระวัง'}</div></div>`;
  }
  openSheet('routes', `${usedCenter ? '<div class="muted">ไม่ได้รับตำแหน่งของคุณ ใช้จุดกลางแผนที่เป็นจุดเริ่มต้น</div>' : ''}${alert}
    ${rs.map((r, i) => `<div class="route ${i === routeState.sel ? 'sel' : ''}" data-i="${i}">
      <div class="top"><span class="time ${r === fastest ? 'fast' : ''}">${fmtTime(r.sec)}</span><span class="dist">${r.km} กม.</span></div>
      <div class="tags">
        ${r === fastest ? '<span class="badge fast"><span class="ms">bolt</span>เร็วที่สุด</span>' : ''}
        ${r.tags?.includes('least_flood') ? '<span class="badge flood"><span class="ms">verified_user</span>เลี่ยงน้ำท่วม</span>' : ''}
        ${r.floods.length ? `<span class="badge ${worst(r) === 3 ? 'danger' : 'flood'}"><span class="ms fill">water_drop</span>ผ่านน้ำท่วม ${r.floods.length} จุด</span>`
                          : '<span class="badge fast"><span class="ms">check</span>ไม่มีน้ำท่วม</span>'}
        ${r.lights ? `<span class="badge guess"><span class="ms">traffic</span>ไฟแดง ${r.lights} จุด</span>` : ''}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="pill primary" data-go="${i}"><span class="ms fill">navigation</span>เริ่ม</button>
        <button class="pill" data-steps="${i}"><span class="ms">format_list_bulleted</span>ขั้นตอน</button>
      </div>
      <ul class="steps" id="steps${i}" hidden>${r.steps.map(s => `<li><span class="ms">${stepIcon(s.type)}</span><span>${esc(s.text)}</span>
        <small>${s.km >= 1 ? s.km.toFixed(1) + ' กม.' : Math.round(s.km * 1000) + ' ม.'}</small></li>`).join('')}</ul>
    </div>`).join('')}
    <div class="muted" style="margin-top:12px">เวลาเดินทางเป็นค่าประมาณจากความเร็วถนน ยังไม่รวมรถติดจริง</div>`, 'peek');
  sheetBody.querySelectorAll('.route').forEach(el => el.onclick = e => { if (!e.target.closest('button')) selectRoute(+el.dataset.i); });
  sheetBody.querySelectorAll('[data-steps]').forEach(b => b.onclick = () => {
    const i = +b.dataset.steps; selectRoute(i); const ul = $('#steps' + i); ul.hidden = !ul.hidden; if (!ul.hidden) sheet.dataset.size = 'full'; placeFabs();
  });
  sheetBody.querySelectorAll('[data-go]').forEach(b => b.onclick = () => startNav(+b.dataset.go));
}
function stepIcon(t) {
  return { 4: 'flag', 5: 'flag', 6: 'flag', 9: 'turn_slight_right', 10: 'turn_right', 11: 'turn_sharp_right', 12: 'u_turn_right', 13: 'u_turn_left',
    14: 'turn_sharp_left', 15: 'turn_left', 16: 'turn_slight_left', 23: 'fork_right', 24: 'fork_left', 26: 'roundabout_right', 27: 'roundabout_right',
    18: 'ramp_right', 19: 'ramp_left', 20: 'ramp_right', 21: 'ramp_left', 25: 'merge', 37: 'merge', 38: 'merge' }[t] || 'straight';
}
// hand the chosen route to Google Maps for voice navigation (waypoints keep it on our flood-free path)
function startNav(i) {
  const r = routeState.routes[i], f = routeState.fromUsed, to = routeState.to;
  let url = `https://www.google.com/maps/dir/?api=1&origin=${f.lat},${f.lon}&destination=${to.lat},${to.lon}&travelmode=driving`;
  if (!r.tags?.includes('fastest')) {
    const wp = [0.3, 0.55, 0.8].map(k => r.shape[Math.floor(r.shape.length * k)]).map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`);
    url += '&waypoints=' + encodeURIComponent(wp.join('|'));
  }
  window.open(url, '_blank');
}

// keep the sheet / buttons tidy on resize
addEventListener('resize', placeFabs);
placeFabs();
