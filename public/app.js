// FloodSafe HK – client
import { t, L, lang, setLang, applyStatic, locale } from './i18n.js';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const HK_CENTER = { lat: 22.3193, lng: 114.1694 };
const SEV_COLOR = ['#9aa5b1', '#7cc4f5', '#f5c542', '#f08c2e', '#e0452b', '#8e1b5f'];
const SEV_LABEL = ['None', 'Wet / puddles', 'Ankle-deep', 'Shin-to-knee', 'Knee-to-waist', 'Above waist / fast flow'];
const sevLabel = (s) => t(SEV_LABEL[s] || '');
// HKO district names in Chinese (for DSD records, which only list English districts)
const DISTRICT_ZH = { 'central & western': '中西區', 'central and western': '中西區', 'wan chai': '灣仔', 'eastern': '東區', 'southern': '南區', 'yau tsim mong': '油尖旺', 'sham shui po': '深水埗', 'kowloon city': '九龍城', 'wong tai sin': '黃大仙', 'kwun tong': '觀塘', 'kwai tsing': '葵青', 'tsuen wan': '荃灣', 'tuen mun': '屯門', 'yuen long': '元朗', 'north': '北區', 'tai po': '大埔', 'sha tin': '沙田', 'sai kung': '西貢', 'islands': '離島' };
const districtName = (d) => L(d, DISTRICT_ZH[String(d || '').toLowerCase().replace(/ district$/, '')]);

const state = {
  config: null, map: null, Adv: null,
  origin: null, originName: t('My location'), originMode: 'gps', dest: null, destName: '',
  me: null, meMarker: null, meCircle: null, pickCenter: null, reportLocLabel: null,
  optIndex: 0, briefings: {}, guide: null, shelterOn: false, shelterData: null, welcomeClosed: false,
  pref: 'balanced', showShortest: false, level: null, photo: null, reportLoc: null, reportLocSource: 'gps',
  reports: [], hazardLayers: new Map(), routeLines: [], endMarkers: [], rainData: null, rainLabels: [], rainOn: false,
  pick: null, lastPlan: null, weather: null,
  dsd: null, dsdOn: false, dsdMarkers: [], dsdAutoDone: false, dsdToast: false,
};
const KIND_LABEL = { blackspot: 'DSD flooding blackspot', underpass: 'Underpass prone to blockage', watercourse: 'Drain / watercourse prone to blockage', road: 'Road prone to drain blockage' };

// Appearance: Auto follows the phone's light/dark setting; Light or Dark can be forced in Settings.
// The Google map takes its colour scheme when it is created, so a change reloads the page.
const themePref = (() => { try { return localStorage.getItem('fs-theme') || 'auto'; } catch { return 'auto'; } })();
const darkMode = themePref === 'dark' || (themePref === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', darkMode ? '#101820' : '#0b3b5c');
function setTheme(pref) {
  try { localStorage.setItem('fs-theme', pref); } catch {}
  location.reload();
}

// Demo mode lives in this browser only: the server shows the simulated storm to this visitor alone
const demoPref = {
  get() { try { return localStorage.getItem('fs-demo') === '1'; } catch { return false; } },
  set(on) { try { localStorage.setItem('fs-demo', on ? '1' : '0'); } catch {} },
};
state.demo = demoPref.get();

const clientId = (() => {
  try {
    let id = localStorage.getItem('fs-client');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('fs-client', id); }
    return id;
  } catch { return 'anon-' + Math.random().toString(36).slice(2); }
})();

async function api(path, opts = {}) {
  // every request carries the UI language so Google / HKO text comes back in it
  path += `${path.includes('?') ? '&' : '?'}lang=${lang}`;
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId, ...(state.demo ? { 'X-Demo': '1' } : {}), ...(await authHeader()), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.rejected) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { data: json, status: res.status });
  return json;
}

function toast(msg, ms = 3200) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mins = (s) => Math.max(1, Math.round(s / 60));
const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const ago = (m) => (m < 1 ? t('just now') : m < 60 ? t('{n} min ago', { n: m }) : t('{n} h ago', { n: Math.round(m / 60) }));
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>${label}`; btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.disabled = false; }
}

// ---------------- boot ----------------
async function boot() {
  applyStatic();
  // offline: start from the last config so saved routes, settings and GPS guidance still work
  try { state.config = await api('/api/config'); try { localStorage.setItem('fs-config', JSON.stringify(state.config)); } catch {} }
  catch (e) { state.offline = true; try { state.config = JSON.parse(localStorage.getItem('fs-config') || 'null'); } catch {} state.config ||= {}; }
  setDemoUI(state.demo);
  const mapMsg = (txt) => { $('#map').innerHTML = `<div class="map-msg">${txt}</div>`; };
  if (state.offline || !navigator.onLine) mapMsg(`📴 ${esc(t("You're offline – the live map needs internet."))}<br><button class="btn" type="button" onclick="document.getElementById('settingsBtn').click()">⬇️ ${esc(t('Open my saved routes'))}</button>`);
  else if (!state.config.mapsBrowserKey) mapMsg('Set MAPS_BROWSER_KEY to load the map.');
  else {
    try { await loadMaps(state.config.mapsBrowserKey); await initMap(); }
    catch (e) { console.warn(e); mapMsg(`⚠️ ${esc(t('The map could not load. Your saved routes still work in Settings.'))}`); }
  }
  bindUI();
  window.addEventListener('offline', () => toast(t("You're offline. Saved routes and GPS guidance still work (Settings → Saved for offline)."), 5000));
  window.addEventListener('online', () => { toast(t('Back online – flood reports are live again.'), 2500); refreshReports(); });
  locate();
  refreshReports();
  refreshWeather();
  setInterval(refreshReports, 20000);
  if (new URLSearchParams(location.search).has('reroute')) resumeTripAfterAlert();
  initAuth();
  const sharedId = new URLSearchParams(location.search).get('share');
  if (sharedId) openSharedRoute(sharedId);
  setInterval(refreshWeather, 120000);
  if (!state.config.gemini && !state.offline) toast('Gemini not configured – add GEMINI_API_KEY to .env and restart', 6000);
}

function loadMaps(key) {
  return new Promise((resolve, reject) => {
    window.__mapsReady = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=marker&callback=__mapsReady&region=HK&language=${lang === 'zh' ? 'zh-HK' : 'en'}`;
    s.async = true; s.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(s);
  });
}

async function initMap() {
  const { Map } = await google.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
  state.Adv = AdvancedMarkerElement;
  const hkHour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Hong_Kong' }).format(new Date()));
  const night = hkHour >= 19 || hkHour < 6;
  state.map = new Map($('#map'), {
    center: HK_CENTER, zoom: 13, mapId: state.config.mapId,
    colorScheme: darkMode ? 'DARK' : 'LIGHT',
    disableDefaultUI: true, zoomControl: false, clickableIcons: true, gestureHandling: 'greedy',
    disableDoubleClickZoom: TOUCH, // on phones our own double-tap handler zooms (and supports double-tap + slide)
  });
  // While picking: a tap moves the pin there (the user still confirms with "Use this spot")
  const openTapped = tapSafe((placeId, latLng) => { if (!state.pick && !state.guide) openPlace(placeId, latLng); });
  state.map.addListener('click', (e) => {
    if (e.placeId) e.stop(); // our own card instead of Google's small info window
    if (state.pick) return state.map.panTo(e.latLng);
    if (e.placeId) openTapped(e.placeId, e.latLng);
  });
  state.map.addListener('idle', () => { if (state.pick) updatePickAddress(); });
  if (TOUCH) initOneHandZoom();
}

// One-hand zoom, as in the Google Maps app: double-tap and hold, then slide DOWN to zoom in or UP to zoom out.
// A quick double-tap still zooms in one step. Zooms around the point you tapped.
const TOUCH = matchMedia('(pointer: coarse)').matches;
// A double-tap starts with an ordinary tap. On phones, a tap on the map (a place, pin, station, route…) waits a moment
// and is dropped if it turns out to be the first half of a double-tap zoom, so zooming never opens something by mistake.
const DOUBLE_TAP_MS = 380;       // a second tap within this time (and 40 px) is a double-tap
const TAP_WAIT = 400;            // a single tap acts after this, once it can't be the start of a double-tap
let lastDoubleTap = 0;
function tapSafe(fn) {
  return (...args) => {
    if (!TOUCH) return fn(...args);
    const at = Date.now();
    // drop taps from either half of a double-tap (the map reports both), and the end of a slide-to-zoom
    setTimeout(() => { if (Math.abs(at - lastDoubleTap) > 450) fn(...args); }, TAP_WAIT);
  };
}
function initOneHandZoom() {
  const el = $('#map'); let last = { t: 0, x: 0, y: 0 }, g = null;
  const opt = { capture: true, passive: false };
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  // keep the tapped point under the finger while zooming
  const zoomAt = (z, px, py) => {
    const m = state.map, r = el.getBoundingClientRect(), c = m.getCenter(), z0 = m.getZoom();
    const s0 = 256 * 2 ** z0, s1 = 256 * 2 ** z, R = Math.PI / 180;
    const wx = (lng) => ((lng + 180) / 360);
    const wy = (lat) => { const s = Math.sin(lat * R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
    const cx = wx(c.lng()), cy = wy(c.lat());
    const dx = px - r.left - r.width / 2, dy = py - r.top - r.height / 2;
    const ax = cx + dx / s0, ay = cy + dy / s0;              // tapped point in world units
    const nx = ax - dx / s1, ny = ay - dy / s1;              // new centre keeps it under the finger
    m.moveCamera({ zoom: z, center: { lat: (2 * Math.atan(Math.exp((0.5 - ny) * 2 * Math.PI)) - Math.PI / 2) / R, lng: nx * 360 - 180 } });
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || state.pick || !state.map) { g = null; return; }
    const t = e.touches[0], now = Date.now();
    if (now - last.t < DOUBLE_TAP_MS && Math.hypot(t.clientX - last.x, t.clientY - last.y) < 40) {
      g = { y0: t.clientY, x: t.clientX, y: t.clientY, z0: state.map.getZoom(), moved: false };
      lastDoubleTap = now;   // cancels whatever the first tap was about to open
      stop(e);
    }
    last = { t: now, x: t.clientX, y: t.clientY };
  }, opt);
  el.addEventListener('touchmove', (e) => {
    if (!g) return;
    const dy = e.touches[0].clientY - g.y0;
    if (Math.abs(dy) > 8) g.moved = true;
    if (g.moved) zoomAt(Math.min(21, Math.max(10, g.z0 + dy / 110)), g.x, g.y);
    stop(e);
  }, opt);
  el.addEventListener('touchend', (e) => {
    if (!g) return;
    if (!g.moved) zoomAt(Math.min(21, Math.round(g.z0) + 1), g.x, g.y);
    g = null; last.t = 0; lastDoubleTap = Date.now(); stop(e);
    try { localStorage.setItem('fs-tip-zoom', '1'); } catch {}
  }, opt);
  // one-time tip
  let seen = false; try { seen = localStorage.getItem('fs-tip-zoom') === '1'; } catch {}
  if (!seen) setTimeout(() => { toast(t('Tip: double-tap and slide up or down to zoom with one hand'), 4500); try { localStorage.setItem('fs-tip-zoom', '1'); } catch {} }, 6000);
}

// ---------------- location ----------------
const inHK = (p) => p && p.lat > 22.13 && p.lat < 22.58 && p.lng > 113.82 && p.lng < 114.45;

function locate(cb) {
  if (!navigator.geolocation) { toast(t('Location is not available in this browser')); return cb?.(null); }
  navigator.geolocation.getCurrentPosition((p) => {
    const loc = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    state.me = loc;
    drawMe();
    renderRainPill();
    if (!inHK(loc)) { toast(t('You seem to be outside Hong Kong – search or pick a start point instead.')); return cb?.(null); }
    if (state.originMode === 'gps') { state.origin = loc; setOriginField(t('My location'), 'gps'); }
    if (state.reportLocSource === 'gps') { state.reportLoc = loc; setReportLoc(t('Using your GPS'), null); }
    cb?.(loc);
  }, (err) => {
    if (err.code === 1) toast(t('Location permission denied – allow it in your browser settings, or search instead.'), 5000);
    cb?.(null);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

// "Locate me" button: blue dot + accuracy ring, zoom in like Google Maps
function drawMe() {
  if (!state.map || !state.me) return;
  if (!state.meMarker) {
    const el = document.createElement('div'); el.className = 'me-dot';
    state.meMarker = new state.Adv({ map: state.map, position: state.me, content: el, title: t('You are here'), zIndex: 50 });
    state.meCircle = new google.maps.Circle({ map: state.map, center: state.me, radius: state.me.accuracy || 30, clickable: false, strokeOpacity: 0, fillColor: '#0a84ff', fillOpacity: 0.12 });
  } else {
    state.meMarker.position = state.me;
    state.meCircle.setCenter(state.me); state.meCircle.setRadius(Math.min(state.me.accuracy || 30, 500));
  }
}
function locateMe() {
  const btn = $('#locateBtn'); btn.classList.add('busy');
  locate((loc) => {
    btn.classList.remove('busy');
    const target = loc || state.me;
    if (!target || !state.map) return;
    state.map.panTo(target);
    state.map.setZoom(Math.max(state.map.getZoom(), 17));
    btn.classList.add('on'); setTimeout(() => btn.classList.remove('on'), 1500);
  });
}

// ---------------- address lookup ----------------
const revCache = new Map();
async function addressFor(p) {
  const k = `${lang}|${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  if (revCache.has(k)) return revCache.get(k);
  try {
    const r = await api(`/api/revgeo?lat=${p.lat}&lng=${p.lng}`);
    const label = r.outside ? null : r.label;
    revCache.set(k, label);
    return label;
  } catch { return null; }
}
const coordLabel = (p) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

// ---------------- search fields (From / To) ----------------
function makeSearch({ box, onPick, withMyLocation }) {
  const input = box.querySelector('input');
  const list = box.querySelector('.suggest');
  const clear = box.querySelector('.clear');
  let token = crypto.randomUUID?.() || String(Math.random());
  let timer = null; let items = []; let seq = 0;

  const close = () => { list.hidden = true; list.innerHTML = ''; };
  const showClear = () => { clear.hidden = !input.value; };
  const render = () => {
    const rows = [];
    if (withMyLocation) rows.push(`<li role="option" data-i="me" class="me">📍 <b>${esc(t('My current location'))}</b></li>`);
    items.forEach((s, i) => rows.push(`<li role="option" data-i="${i}"><b>${esc(s.main)}</b><small>${esc(s.secondary)}</small></li>`));
    list.innerHTML = rows.join('');
    list.hidden = rows.length === 0;
  };
  async function query(q) {
    const my = ++seq;
    try {
      const near = state.me && inHK(state.me) ? state.me : (state.map ? { lat: state.map.getCenter().lat(), lng: state.map.getCenter().lng() } : HK_CENTER);
      const r = await api('/api/places/autocomplete', { method: 'POST', body: { input: q, sessionToken: token, lat: near.lat, lng: near.lng } });
      if (my !== seq) return;
      items = r.suggestions || []; render();
    } catch (e) { console.warn(e); }
  }
  async function choose(i) {
    close(); input.blur();
    if (i === 'me') {
      input.value = t('Locating…');
      locate((loc) => { if (loc) onPick(loc, t('My location'), 'gps'); else { input.value = ''; showClear(); } });
      return;
    }
    const s = items[+i]; if (!s) return;
    input.value = s.main;
    try {
      const p = await api(`/api/places/${encodeURIComponent(s.placeId)}?sessionToken=${encodeURIComponent(token)}`);
      token = crypto.randomUUID?.() || String(Math.random()); // a session ends when a place is chosen
      onPick({ lat: p.lat, lng: p.lng }, s.main, 'place');
    } catch (e) { toast(e.message); }
  }

  input.addEventListener('focus', () => { input.select(); if (withMyLocation && !input.value.trim()) { items = []; render(); } });
  input.addEventListener('input', () => {
    showClear();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { items = []; if (withMyLocation) render(); else close(); return; }
    timer = setTimeout(() => query(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (items.length) choose(0); }
    if (e.key === 'Escape') close();
  });
  list.addEventListener('pointerdown', (e) => { // pointerdown fires before the input loses focus
    const li = e.target.closest('li'); if (!li) return;
    e.preventDefault(); choose(li.dataset.i);
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  clear.addEventListener('click', () => { input.value = ''; showClear(); input.focus(); items = []; if (withMyLocation) render(); });
  return { set(text) { input.value = text || ''; showClear(); } };
}

function setOriginField(text, mode) {
  state.originName = text; state.originMode = mode;
  state.originSearch?.set(text);
  drawEndpoints();
}
function setOrigin(loc, name, mode = 'place') { state.origin = loc; setOriginField(name, mode); }
function setDest(loc, name) {
  state.dest = loc; state.destName = name;
  state.destSearch?.set(name);
  drawEndpoints();
}
function setReportLoc(text, label) {
  $('#reportLocText').textContent = text;
  state.reportLocLabel = label || null;
}

// Start / destination pins, visible as soon as they are chosen
// Start / End: a map pin with a coloured label under it (起點 / 終點 in Chinese), so the two ends of the trip
// stand out among flood pins, bubbles and stations. The pin's tip sits exactly on the point.
const PIN_SVG = '<svg class="ep-pin" viewBox="0 0 30 40" width="30" height="40" aria-hidden="true"><path d="M15 1.5C7.6 1.5 1.5 7.5 1.5 15c0 9.8 13.5 23.5 13.5 23.5S28.5 24.8 28.5 15C28.5 7.5 22.4 1.5 15 1.5Z" fill="currentColor" stroke="#fff" stroke-width="2.2"/><circle cx="15" cy="14.5" r="5.2" fill="#fff"/></svg>';
function drawEndpoints() {
  if (!state.map || !state.Adv) return;
  state.endMarkers.forEach((m) => (m.map = null)); state.endMarkers = [];
  const pts = [];
  if (state.origin && (state.originMode !== 'gps' || state.lastPlan)) pts.push([state.origin, 'from', state.originName]);
  if (state.dest) pts.push([state.dest, 'to', state.destName]);
  for (const [p, kind, title] of pts) {
    const el = document.createElement('div'); el.className = `ep ${kind}`;
    el.innerHTML = `${PIN_SVG}<span class="ep-label">${esc(t(kind === 'from' ? 'Start' : 'End'))}</span>`;
    state.endMarkers.push(new state.Adv({ map: state.map, position: p, content: el, title: `${t(kind === 'from' ? 'Start' : 'End')}: ${title || ''}`, zIndex: 60 }));
  }
}

// ---------------- pick on map (bottom bar, one-handed) ----------------
const PICK_TEXT = { origin: 'Set start point', dest: 'Set destination', report: 'Where is the flooding?' };
function startPick(kind) {
  if (!state.map) { toast(t('Map not loaded')); return; }
  state.pick = kind;
  $('#pickKind').textContent = t(PICK_TEXT[kind]);
  $('#pickAddr').textContent = t('Move the map or tap a spot');
  const current = kind === 'origin' ? state.origin : kind === 'dest' ? state.dest : state.reportLoc;
  if (current) { state.map.panTo(current); state.map.setZoom(Math.max(state.map.getZoom(), 16)); }
  document.body.classList.add('picking');
  $('#crosshair').hidden = false; $('#pickBar').hidden = false;
  updatePickAddress();
}
function endPick() {
  state.pick = null;
  document.body.classList.remove('picking');
  $('#crosshair').hidden = true; $('#pickBar').hidden = true;
}
let pickTimer = null;
function updatePickAddress() {
  clearTimeout(pickTimer);
  const c = state.map.getCenter(); const p = { lat: c.lat(), lng: c.lng() };
  state.pickCenter = p;
  if (!inHK(p)) { $('#pickAddr').textContent = t('Outside Hong Kong'); $('#crosshairOk').disabled = true; return; }
  $('#crosshairOk').disabled = false;
  $('#pickAddr').innerHTML = `<span class="muted">${esc(t('Finding address…'))}</span>`;
  pickTimer = setTimeout(async () => {
    const label = await addressFor(p);
    if (state.pick && state.pickCenter === p) $('#pickAddr').textContent = label || t('Pinned spot ({c})', { c: coordLabel(p) });
  }, 350);
}
async function applyPick() {
  const kind = state.pick; const p = state.pickCenter;
  if (!kind || !p) return endPick();
  endPick();
  const label = (await addressFor(p)) || t('Pinned spot ({c})', { c: coordLabel(p) });
  if (kind === 'origin') setOrigin(p, label, 'pin');
  if (kind === 'dest') setDest(p, label);
  if (kind === 'report') { state.reportLoc = p; state.reportLocSource = 'map'; setReportLoc(`📍 ${label}`, label); }
  toast(`${t(kind === 'origin' ? 'Start' : kind === 'dest' ? 'Destination' : 'Report location')}: ${label}`);
}

// ---------------- weather ----------------
async function refreshWeather() {
  try {
    const w = await api('/api/weather');
    const rank = { amber: 1, red: 2, black: 3 };
    if (state.guide && state.weather && (rank[w.rainstorm] || 0) > (rank[state.weather.rainstorm] || 0) && (rank[w.rainstorm] || 0) >= 2) signalAlert(w);
    state.weather = w;
    renderWarnStrip(w);
    renderRainPill();
    if (state.signalOpen) openSignalDetail(true);
    if (state.rainOn) drawRain();
    renderAdvisory(w);
    renderWelcome();
    // Like CoolMap switching behaviour by weather: under Red/Black, show official flood-prone spots automatically
    if ((w.rainstorm === 'red' || w.rainstorm === 'black') && !state.dsdOn && !state.dsdAutoDone) { state.dsdAutoDone = true; state.dsdToast = true; setDsd(true); }
    else if (state.dsdOn) loadDsd();
  } catch (e) { console.warn(e); }
}

// Rainstorm signal raised to Red / Black while walking: offer the most covered route
function signalAlert(w) {
  const el = $('#gAlert'); if (!el) return;
  el.innerHTML = `<div class="ra-head"><span class="ra-i" aria-hidden="true">⛈️</span><b>${esc(t('{s} issued', { s: L(w.signalInfo?.name, w.signalInfo?.zh) || t('Rainstorm signal') }))}</b></div>
    <div class="ra-body">${esc(t('Heavy rain now. A more covered route keeps you out of the worst of it.'))}</div>
    <div class="ra-actions"><button type="button" class="btn primary" id="raCover">☂️ ${esc(t('Switch to most covered'))}</button><button type="button" class="x" id="raX" aria-label="${esc(t('Dismiss'))}">✕</button></div>`;
  el.hidden = false;
  $('#raCover').onclick = () => rerouteNow('covered');
  $('#raX').onclick = () => { el.hidden = true; };
  try { navigator.vibrate?.([300, 120, 300]); } catch {}
}

const WARN_EMOJI = { WTCSGNL: '🌀', WTS: '⛈️', WL: '⛰️', WFNTSA: '🌊', WTMW: '🌊', WMSGNL: '💨', WHOT: '🌡️', WCOLD: '🥶', WFROST: '❄️', WFIRE: '🔥' };
// Official HKO warning icon; falls back to a drawn icon / text badge if the image can't load
function warnIcon(wn, size = 26) {
  const fallback = wn.type === 'WRAIN' ? signalIcon(({ WRAINA: 'amber', WRAINR: 'red', WRAINB: 'black' })[wn.code] || 'none', size)
    : `<span class="warn-emoji" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.6)}px" title="${esc(L(wn.name, wn.nameZh) || wn.short || '')}">${WARN_EMOJI[wn.type] || '⚠️'}</span>`;
  if (!wn.iconUrl) return fallback;
  return `<img class="hko-icon" src="${esc(wn.iconUrl)}" alt="${esc(L(wn.name, wn.nameZh) || wn.short)}" width="${size}" height="${size}" loading="lazy"
    referrerpolicy="no-referrer" onerror="this.outerHTML=this.dataset.fb" data-fb="${esc(fallback)}" />`;
}

// Phones show the four most important warnings plus a "+N" count; the full list is one tap away
const maxWarnIcons = () => (window.innerWidth < 360 ? 3 : window.innerWidth < 640 ? 4 : 6);
function renderWarnStrip(w) {
  const el = $('#signal'); el.hidden = false;
  const list = w.warnings || [];
  el.classList.toggle('none', !list.length);
  el.querySelector('.warn-icons').innerHTML = list.length
    ? list.slice(0, maxWarnIcons()).map((x) => warnIcon(x)).join('') + (list.length > maxWarnIcons() ? `<span class="warn-more">+${list.length - maxWarnIcons()}</span>` : '')
    : `<span class="ok-icon" aria-hidden="true">${signalIcon('none', 22)}</span>`;
  el.querySelector('.warn-text').textContent = list.length
    ? `${L(list[0].short, list[0].shortZh)}${list.length > 1 ? ` +${list.length - 1}` : ''}${w.demo ? ` · ${t('demo')}` : ''}`
    : t('No warnings');
  el.setAttribute('aria-label', `${list.length ? list.map((x) => L(x.name, x.nameZh)).join(', ') : t('No weather warnings in force')}${w.demo ? ` ${t('(demo)')}` : ''}. ${t('Tap for HKO details.')}`);
  el.title = `${w.demo ? t('Simulated for demo') : t('Hong Kong Observatory')} · ${t('updated {t}', { t: new Date(w.updated).toLocaleTimeString(locale()) })}`;
}

// CoolMap-style "rain near you" pill: nearest HKO weather station (updated every 15 min), else the district reading
function nearestRain() {
  const w = state.weather; if (!w?.rainfall?.length) return null;
  const at = state.me && inHK(state.me) ? state.me : (state.map ? { lat: state.map.getCenter().lat(), lng: state.map.getCenter().lng() } : HK_CENTER);
  const near = (list) => list.reduce((a, b) => (Math.hypot(b.lat - at.lat, b.lng - at.lng) < Math.hypot(a.lat - at.lat, a.lng - at.lng) ? b : a));
  const st = w.stations?.length ? near(w.stations) : null;
  if (st && Math.hypot(st.lat - at.lat, st.lng - at.lng) < 0.05) return { mm: st.mm, district: st.name, districtZh: st.nameZh };
  return near(w.rainfall);
}
function renderRainPill() {
  const r = nearestRain(); const el = $('#rainPill');
  if (!r) { el.hidden = true; return; }
  el.hidden = false;
  $('#rainMm').textContent = `${r.mm}`;
  setTimeout(placeUmbFilter, 0);
  const d = L(r.district, r.districtZh);
  $('#rainWhere').textContent = `mm · ${d}`;
  el.classList.toggle('heavy', r.mm >= 30);
  el.setAttribute('aria-label', t('{mm} mm of rain in the past hour in {d}', { mm: r.mm, d }));
  el.title = t('HKO: {mm} mm in the past hour, {d}', { mm: r.mm, d });
}

function renderAdvisory(w) {
  const el = $('#advisory');
  if (!w?.rainstorm) { el.innerHTML = ''; return; }
  const rainWarn = (w.warnings || []).find((x) => x.type === 'WRAIN');
  const txt = t({
    black: 'Stay indoors if you can. Routes favour covered, indoor and footbridge walkways and avoid flood-prone spots.',
    red: 'Flooding likely in low-lying areas. Routes favour sheltered walkways and avoid DSD blackspots and underpasses.',
    amber: 'Heavy rain. Routes show how much of your walk is sheltered.',
  }[w.rainstorm]);
  el.innerHTML = `<div class="advisory ${w.rainstorm}">
    <div class="adv-icon">${rainWarn ? warnIcon(rainWarn, 40) : ''}</div>
    <div class="adv-body"><b>${esc(L(w.signalInfo?.name, w.signalInfo?.zh) || t('Rainstorm signal'))}${w.demo ? ` · ${t('demo')}` : ''}</b><span>${esc(txt)}</span></div>
    <button id="advShelter" class="adv-btn" aria-label="${esc(t('Find shelter nearby'))}">🏢</button></div>`;
  $('#advShelter').onclick = () => { switchTab('shelter'); setShelterNear('me', { run: true }); };
}

// Drawn rainstorm icon, used only if HKO's image can't load
const SIGNAL_COLORS = { amber: ['#f6b800', '#c99400'], red: ['#e3141b', '#a80d12'], black: ['#141414', '#000'], none: ['#9aa5b1', '#7b8794'] };
function signalIcon(level, size = 22) {
  const [fill, stroke] = SIGNAL_COLORS[level] || SIGNAL_COLORS.none;
  const drops = level === 'none' ? '' : [10, 17, 24, 31, 38].map((x, i) =>
    `<path d="M${x} ${33 + (i % 2) * 4} q-2.2 3.4 0 5.2 q2.2 -1.8 0 -5.2z" fill="${fill}" stroke="${stroke}" stroke-width=".8"/>`).join('');
  return `<svg viewBox="0 0 48 44" width="${size}" height="${size * 44 / 48}" aria-hidden="true">
    <path d="M12 28h25a8 8 0 0 0 1-16 11 11 0 0 0-21-3 8 8 0 0 0-5 19z" fill="${fill}" stroke="${level === 'black' ? '#fff' : stroke}" stroke-width="1.6"/>${drops}</svg>`;
}

function openSignalDetail(refreshOnly = false) {
  const w = state.weather;
  if (!w) return;
  if (refreshOnly && $('.pane.active')?.dataset.pane !== 'detail') { state.signalOpen = false; return; }
  state.signalOpen = true;
  const level = w.rainstorm || 'none';
  const list = w.warnings || [];
  const rain = (w.rainfall || []).filter((r) => r.mm > 0).sort((a, b) => b.mm - a.mm).slice(0, 6);
  const fmt = (d) => (d ? new Date(d).toLocaleString(locale(), { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '');
  const RAIN_ICONS = { amber: 'WRAINA', red: 'WRAINR', black: 'WRAINB' };
  const scaleIcon = (l) => warnIcon({ type: 'WRAIN', code: RAIN_ICONS[l], iconUrl: `https://www.hko.gov.hk/en/wxinfo/dailywx/images/rain${l[0]}.gif`, short: t(l) }, 34);
  state.reopen = () => openSignalDetail();
  $('#detail').innerHTML = `
    <button class="link" id="detailBack">${esc(t('← Back'))}</button>
    <div class="detail-head"><h3>${esc(t('Weather warnings'))}</h3><span class="meta">${esc(t(w.demo ? 'Simulated for demo' : 'Hong Kong Observatory'))} · ${esc(fmt(w.updated))}</span></div>
    ${list.length ? list.map((x) => `
      <article class="warn-card ${x.type === 'WRAIN' ? level : ''}">
        <div class="warn-card-icon">${warnIcon(x, 52)}</div>
        <div class="warn-card-body">
          <b>${esc(L(x.name, x.nameZh) || x.short)}</b>
          ${x.type === 'WRAIN' && w.signalInfo ? `<div class="meta">${esc(L(w.signalInfo.threshold, w.signalInfo.thresholdZh))}</div>` : ''}
          ${x.issued ? `<div class="meta">${esc(t('Issued {t}', { t: fmt(x.issued) }))}</div>` : ''}
          ${L(x.details, x.detailsZh)?.length ? `<details ${x.type === 'WRAIN' ? 'open' : ''}><summary>${esc(t('HKO announcement'))}</summary>${L(x.details, x.detailsZh).map((p) => `<p>${esc(p)}</p>`).join('')}</details>` : ''}
        </div>
      </article>`).join('') : `<article class="warn-card"><div class="warn-card-icon">${signalIcon('none', 52)}</div><div class="warn-card-body"><b>${esc(t('No warnings in force'))}</b><div class="meta">${esc(t('FloodSafe checks HKO every 2 minutes. Under Red or Black rain, official flood-prone spots become routing hazards automatically.'))}</div></div></article>`}
    <div class="field-label">${esc(t('Next 12 hours near you'))}</div><div id="fcPanel"><div class="skeleton"><span></span></div></div>
    ${rain.length ? `<div class="field-label">${esc(t('Heaviest rain · past hour'))}</div><p class="meta">${esc(t('District maximum, refreshed with HKO station readings every 15 minutes.'))}</p><ul class="rain-list">${rain.map((r) => `<li><span>${esc(L(r.district, r.districtZh))}</span><span class="bar"><i style="width:${Math.min(100, r.mm)}%"></i></span><b>${r.mm} mm</b></li>`).join('')}</ul>` : ''}
    <div class="field-label">${esc(t('Rainstorm signals'))}</div>
    <div class="signal-scale">
      ${['amber', 'red', 'black'].map((l) => `<div class="${l === level ? 'on' : ''}">${scaleIcon(l)}<span>${{ amber: '>30', red: '>50', black: '>70' }[l]} mm/h</span></div>`).join('')}
    </div>
    <p class="meta" style="margin-top:12px">${esc(t('Icons and data:'))} <a href="https://www.hko.gov.hk/${lang === 'zh' ? 'tc' : 'en'}/wxinfo/dailywx/warnlegend.htm" target="_blank" rel="noopener">${esc(t('Hong Kong Observatory'))}</a></p>
    ${level === 'red' || level === 'black' ? `<button class="btn primary block" id="sigShelter">${esc(t('🏢 Find shelter nearby'))}</button>` : ''}`;
  switchTab('detail');
  loadForecastPanel();
  $('#detailBack').onclick = () => { state.signalOpen = false; goBack(); };
  $('#sigShelter')?.addEventListener('click', () => { state.signalOpen = false; switchTab('shelter'); setShelterNear('me', { run: true }); });
}

async function loadForecastPanel() {
  const at = state.me && inHK(state.me) ? state.me : (state.map ? { lat: state.map.getCenter().lat(), lng: state.map.getCenter().lng() } : HK_CENTER);
  try {
    const f = await api(`/api/forecast?lat=${at.lat}&lng=${at.lng}`);
    state.forecast = f;
    const el = $('#fcPanel'); if (el) el.innerHTML = forecastStrip(f, 12);
  } catch (e) { const el = $('#fcPanel'); if (el) el.innerHTML = `<div class="meta">${esc(t('Forecast unavailable: {e}', { e: e.message }))}</div>`; }
}

// CoolMap-style welcome card that adapts to the weather (first visit, dismissible)
function renderWelcome() {
  const el = $('#welcome');
  let seen = false; try { seen = localStorage.getItem('fs-welcome') === '1'; } catch {}
  if (seen || state.welcomeClosed || state.lastPlan) { el.hidden = true; return; }
  const w = state.weather || {};
  const head = t(w.rainstorm ? { black: 'Black rain. Find the driest, flood-free way', red: 'Red rain. Avoid flooded streets', amber: 'Amber rain. Stay under cover' }[w.rainstorm]
    : (w.warnings?.length ? 'Weather warning in force. Walk smart' : 'Walk dry in Hong Kong'));
  el.innerHTML = `<div class="welcome-card">
    <div class="welcome-top"><img src="/icon.svg" alt="" width="36" height="36"><b>${esc(head)}</b><button class="x" id="wClose" aria-label="${esc(t('Close'))}">×</button></div>
    <p>${esc(t("Enter where you're going. FloodSafe checks live flood reports and HKO warnings, and prefers covered walkways, footbridges and malls."))}</p>
    <p class="walk-only">🚶 ${esc(t('Walking routes only. For longer trips, take the MTR or a bus and use FloodSafe for the walk to and from the station.'))}</p>
    <div class="welcome-modes"><span>☂️ ${esc(t('Stay dry'))}</span><span>🌊 ${esc(t('Skip floods'))}</span><span>🌉 ${esc(t('Footbridges & malls'))}</span></div>
    <div class="welcome-actions"><button class="btn" id="wNear">📍 ${esc(t('Start near me'))}</button><button class="btn dark" id="wDemo">▶ ${esc(t('Try example'))}</button></div>
  </div>`;
  el.hidden = false;
  const close = () => { el.hidden = true; state.welcomeClosed = true; try { localStorage.setItem('fs-welcome', '1'); } catch {} };
  $('#wClose').onclick = close;
  $('#wNear').onclick = () => { close(); locateMe(); setTimeout(() => $('#mapSearchInput').focus(), 300); };
  $('#wDemo').onclick = async () => { close(); if (!state.demo) await toggleDemo(); demoTrip('mongkok'); };
}

// ---------------- DSD official layer ----------------
async function loadDsd() {
  try { state.dsd = await api('/api/dsd'); drawDsd(); } catch (e) { console.warn(e); }
}
function setDsd(on) {
  state.dsdOn = on;
  $('#dsdToggle').setAttribute('aria-pressed', String(on));
  if (on) loadDsd(); else drawDsd();
}
// The one symbol for every official DSD flood-prone spot (blackspots drawn larger than blockage-prone spots)
const WARN_TRI = (w) => `<svg viewBox="0 0 32 29" width="${w}" height="${Math.round(w * 0.9)}" aria-hidden="true"><path d="M16 2 30 27H2z" fill="#f6b800" stroke="#111" stroke-width="2.5" stroke-linejoin="round"/><path d="M16 10v8" stroke="#111" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="22.5" r="1.8" fill="#111"/></svg>`;
function drawDsd() {
  state.dsdMarkers.forEach((m) => (m.map = null)); state.dsdMarkers = [];
  if (!state.dsdOn || !state.map || !state.dsd) return;
  const active = state.dsd.activeSignal;
  const add = (pos, el, item) => {
    const m = new state.Adv({ map: state.map, position: pos, content: el, title: item.title, zIndex: item.z || 1 });
    m.addListener('click', tapSafe(() => openDsdDetail(item)));
    state.dsdMarkers.push(m);
  };
  const live = active === 'red' || active === 'black';
  document.querySelector('.dsd-legend')?.classList.toggle('live', live);
  for (const b of state.dsd.blackspots) {
    const el = document.createElement('div'); el.className = `dsd-bs${live ? ' live' : ''}`;
    el.innerHTML = WARN_TRI(30);
    add(b, el, { ...b, kind: 'blackspot', title: t('{kind}: {name}', { kind: t(KIND_LABEL.blackspot), name: L(b.name, b.nameZh) }), z: 3 });
  }
  for (const b of state.dsd.blockage) {
    const el = document.createElement('div');
    el.className = `dsd-dot ${b.kind}${b.approximate ? ' approx' : ''}${live && !b.approximate && b.kind !== 'watercourse' ? ' active' : ''}`;
    add(b, el, { ...b, name: b.location, title: t('{kind}: {name}', { kind: t(KIND_LABEL[b.kind]), name: b.location }) });
  }
  if (state.dsdToast && state.dsdMarkers.length) toast(`${active ? t('{s} rainstorm: ', { s: lang === 'zh' ? t(active) : active[0].toUpperCase() + active.slice(1) }) : ''}${t('showing {n} official DSD flood-prone locations', { n: state.dsdMarkers.length })}`);
  state.dsdToast = false;
}
function openDsdDetail(item) {
  state.signalOpen = false;
  const src = state.dsd?.sources || {};
  const active = state.dsd?.activeSignal;
  const name = L(item.name, item.nameZh);
  state.reopen = () => openDsdDetail(item);
  $('#detail').innerHTML = `
    <button class="link" id="detailBack">${esc(t('← Back'))}</button>
    <div class="official"><div class="tag">${esc(t('Official · Drainage Services Department'))}</div>
      <b>${esc(t(KIND_LABEL[item.kind] || 'DSD location'))}</b><br>${esc(name)}<div class="meta">${esc(districtName(item.district || ''))}</div>
      ${item.cause ? `<div class="meta">${esc(t('Cause: {c}', { c: L(item.cause, item.causeZh) }))}</div>` : ''}
      ${item.scale ? `<div class="meta">${esc(t('Blackspot scale: {s}', { s: item.scale }))}</div>` : ''}
    </div>
    <p class="hint" style="margin-top:10px">${esc(active ? t('With the {s} rainstorm signal in force, FloodSafe treats this spot as a precautionary hazard in routing. A crowd report here overrides it.', { s: t(active) }) : t('No rainstorm signal – shown for awareness only. It becomes a routing hazard under Red/Black signals.'))}</p>
    <p class="meta">${item.approximate ? esc(t('⚠ Location could only be placed approximately – not used for routing. ')) : ''}${esc(t('Locations are indicative only.'))}
      ${esc(t('Source:'))} <a href="${esc(item.kind === 'blackspot' ? src.blackspots : src.blockage)}" target="_blank" rel="noopener">DSD</a>. ${esc(t('Report blocked drains to 1823.'))}</p>
    <button class="btn primary block" id="dsdReport">${esc(t('📷 Report flooding here'))}</button>`;
  switchTab('detail');
  focusOn(item, 15);
  $('#detailBack').onclick = goBack;
  $('#dsdReport').onclick = () => {
    state.reportLoc = { lat: item.lat, lng: item.lng }; state.reportLocSource = 'map';
    setReportLoc(`📍 ${name}`, item.name); switchTab('report');
  };
}

// ---------------- any Google place on the map (shops, stations, buildings…), like Google Maps ----------------
var placeMarker = null;
function markPlace(p) {
  if (placeMarker) { placeMarker.map = null; placeMarker = null; }
  if (!p || !state.map) return;
  const el = document.createElement('div'); el.className = 'place-pin'; el.innerHTML = '<span></span>';
  placeMarker = new state.Adv({ map: state.map, position: p, content: el, zIndex: 40 });
}
async function openPlace(placeId, latLng) {
  state.signalOpen = false; state.umbOpen = null;
  const at = { lat: latLng.lat(), lng: latLng.lng() };
  markPlace(at);
  $('#detail').innerHTML = `<button class="link" id="detailBack">${esc(t('← Back'))}</button><div class="skeleton"><span></span><span></span><span></span></div>`;
  switchTab('detail');
  $('#detailBack').onclick = () => { markPlace(null); goBack(); };
  focusOn(at, Math.max(16, state.map.getZoom()));
  let p;
  try { p = await api(`/api/placeinfo/${encodeURIComponent(placeId)}`); }
  catch (e) { $('#detail').innerHTML = `<button class="link" id="detailBack">${esc(t('← Back'))}</button><div class="card danger">${esc(e.message)}</div>`; $('#detailBack').onclick = () => { markPlace(null); goBack(); }; return; }
  if (!$('#detail').contains($('#detailBack'))) return;
  state.reopen = () => openPlace(placeId, latLng);
  const near = (state.reports || []).filter((r) => (r.status === 'active' || r.status === 'fading') && geoDist(r, p) < 250).sort((a, b) => b.severity - a.severity)[0];
  const umb = UMB.data?.stations?.map((s) => ({ s, d: geoDist(s, p) })).sort((a, b) => a.d - b.d)[0];
  $('#detail').innerHTML = `
    <button class="link" id="detailBack">${esc(t('← Back'))}</button>
    <div class="place-head"><h3>${esc(p.name || t('Place'))}</h3>${p.type ? `<div class="meta">${esc(p.type)}</div>` : ''}</div>
    <div class="umb-actions"><button class="btn primary" id="plRoute" type="button">🧭 ${esc(t('Route here'))}</button><button class="btn" id="plFrom" type="button">📍 ${esc(t('Start from here'))}</button></div>
    <section class="umb-desc">
      ${p.address ? `<div class="umb-field"><span class="uf-l">${esc(t('Address'))}</span><span class="uf-v">${esc(p.address)}</span></div>` : ''}
      ${p.openNow != null ? `<div class="umb-field"><span class="uf-l">${esc(t('Hours'))}</span><span class="uf-v"><b class="${p.openNow ? 'ok-txt' : 'bad-txt'}">${esc(t(p.openNow ? 'Open now' : 'Closed now'))}</b>${p.hours ? `<details class="hours"><summary>${esc(t('All hours'))}</summary>${p.hours.map((h) => esc(h)).join('<br>')}</details>` : ''}</span></div>` : ''}
      ${p.phone ? `<div class="umb-field"><span class="uf-l">${esc(t('Phone'))}</span><span class="uf-v"><a href="tel:${esc(p.phone.replace(/\s/g, ''))}">${esc(p.phone)}</a></span></div>` : ''}
    </section>
    ${near ? `<div class="note red">${esc(t('🌊 Flooding reported {d} m from here · {s}', { d: Math.round(geoDist(near, p)), s: sevLabel(near.severity) }))}</div>` : ''}
    ${umb && umb.d < 600 ? `<button class="btn block" id="plUmb" type="button">☂️ ${esc(t('Nearest umbrella lending: {n} · {d}', { n: umbName(umb.s), d: km(Math.round(umb.d)) }))}</button>` : ''}
    <button class="btn block" id="plReport" type="button" style="margin-top:8px">📷 ${esc(t('Report flooding here'))}</button>
    ${p.mapsUri ? `<p class="meta" style="margin-top:10px"><a href="${esc(p.mapsUri)}" target="_blank" rel="noopener">↗ ${esc(t('Open in Google Maps'))}</a></p>` : ''}`;
  const label = p.name || p.address;
  $('#detailBack').onclick = () => { markPlace(null); goBack(); };
  $('#plRoute').onclick = () => {
    markPlace(null); setDest({ lat: p.lat, lng: p.lng }, label);
    if (!state.origin && state.me && inHK(state.me)) setOrigin(state.me, t('My location'), 'gps');
    switchTab('route');
    if (state.origin) findRoute(); else { toast(t('Choose a start point: search, “My current location”, or 🗺️ pick on map')); locate((loc) => { if (loc) findRoute(); }); }
  };
  $('#plFrom').onclick = () => { markPlace(null); setOrigin({ lat: p.lat, lng: p.lng }, label); switchTab('route'); if (state.dest) findRoute(); };
  $('#plReport').onclick = () => { markPlace(null); state.reportLoc = { lat: p.lat, lng: p.lng }; state.reportLocSource = 'map'; setReportLoc(`📍 ${label}`, label); switchTab('report'); };
  $('#plUmb')?.addEventListener('click', () => { markPlace(null); openUmbrella(umb.s.id); });
  focusOn(at, state.map.getZoom()); // the card is taller than the loading skeleton: re-centre in the map left visible
}

// ---------------- rainfall layer ----------------
// HKO publishes the highest past-hour rainfall recorded in each of the 18 districts, so the map shades each
// district (Home Affairs Department boundaries) with the HKO rainstorm colours: amber ≥30, red ≥50, black ≥70 mm/h.
const RAIN_STEPS = [[70, '#1b1b1b', '≥70'], [50, '#e3141b', '50–70'], [30, '#f6b800', '30–50'], [10, '#1e6fd9', '10–30'], [0.5, '#8cc4f5', '<10']];
const rainColor = (mm) => (RAIN_STEPS.find(([min]) => mm >= min) || [])[1] || null;
const normDistrict = (s) => String(s || '').toLowerCase().replace(/ district$/, '').replace(/\s+and\s+/, ' & ').trim();
let districtsGeo = null;
async function loadDistricts() {
  if (!districtsGeo) districtsGeo = await fetch('/hk_districts.geojson').then((r) => r.json());
  return districtsGeo;
}
function clearRain() {
  if (state.rainData) { state.rainData.setMap(null); state.rainData = null; }
  state.rainLabels.forEach((m) => (m.map = null)); state.rainLabels = [];
}
async function drawRain() {
  clearRain();
  renderRainLegend();
  if (!state.rainOn || !state.map || !state.weather) return;
  let gj;
  try { gj = await loadDistricts(); } catch (e) { toast(e.message); return; }
  if (!state.rainOn) return;
  clearRain();
  const byKey = new Map((state.weather.rainfall || []).map((r) => [r.key || normDistrict(r.district), r]));
  const data = state.rainData = new google.maps.Data({ map: state.map });
  data.addGeoJson(gj);
  data.setStyle((f) => {
    const c = rainColor(byKey.get(f.getProperty('key'))?.mm || 0);
    return { fillColor: c || '#ffffff', fillOpacity: c ? 0.34 : 0.04, strokeColor: '#ffffff', strokeWeight: 1.5, strokeOpacity: 0.95, zIndex: 0 };
  });
  data.addListener('click', (e) => {
    if (state.pick) { state.map.panTo(e.latLng); return; }
    tapSafe(() => rainToast(e))();
  });
  const rainToast = (e) => {
    const r = byKey.get(e.feature.getProperty('key'));
    toast(`${L(e.feature.getProperty('en'), e.feature.getProperty('zh'))}: ${t('{mm} mm in the past hour', { mm: r?.mm ?? 0 })}`);
  };
  drawRainLabels();
}
// Zoomed out: one reading per district. Zoomed in: each HKO weather station's own 15-minute reading.
function drawRainLabels() {
  state.rainLabels.forEach((m) => (m.map = null)); state.rainLabels = [];
  if (!state.rainOn || !state.map || !state.weather) return;
  const stations = state.map.getZoom() >= 13 && state.weather.stations?.length;
  const list = stations ? state.weather.stations : state.weather.rainfall || [];
  for (const r of list) {
    if (!(r.mm > 0) && !stations) continue;
    const el = document.createElement('div');
    el.className = `rain-label${r.mm >= 30 ? ' strong' : ''}${stations ? ' station' : ''}`;
    el.innerHTML = stations ? `<b>${r.mm}</b><small>${esc(L(r.name, r.nameZh))}</small>` : `${r.mm}`;
    const rm = new state.Adv({ map: state.map, position: r, content: el, zIndex: 2, title: `${stations ? L(r.name, r.nameZh) : L(r.district, r.districtZh)} ${r.mm} mm` });
    rm.addListener('click', tapSafe(() => toast(`🌧️ ${stations ? L(r.name, r.nameZh) : L(r.district, r.districtZh)}: ${r.mm} mm · ${t('HK Observatory, past hour')}`)));
    state.rainLabels.push(rm);
  }
  state.rainLabelMode = stations ? 'stations' : 'districts';
}
function renderRainLegend() {
  const el = $('#rainLegend');
  if (!state.rainOn) { el.hidden = true; return; }
  el.hidden = false;
  const w = state.weather;
  const at = w?.stationsTime ? new Date(w.stationsTime).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '';
  el.innerHTML = `<b>${esc(t('Past-hour rainfall · HKO'))}</b>${at ? `<span class="rl-time">${esc(t('stations {t} · every 15 min', { t: at }))}</span>` : ''}<div class="rl-steps">${RAIN_STEPS.slice().reverse().map(([, c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}<span class="unit">mm</span></div>`;
}
function setRain(on) {
  state.rainOn = on;
  $('#rainToggle').setAttribute('aria-pressed', String(on));
  $('#rainPill').setAttribute('aria-pressed', String(on));
  drawRain();
}

// Centre a point in the part of the map people can actually see: below the search bar and chips, above the open
// panel (or beside it on a desktop). Runs after the panel has finished sliding up.
function focusOn(p, minZoom = 16) {
  if (!state.map || !p) return;
  const go = (settled) => {
    const desktop = window.innerWidth >= 900;
    // phones: half-height panel = enough details AND enough map; the place is centred in the strip above it
    if (!desktop && panelOpen() && state.sheetSize !== 'half') setSheetSize('half');
    const W = window.innerWidth, H = window.innerHeight;
    const top = desktop ? 80 : panelOpen() ? 140 : 190; // map chips hide while a panel is open on phones
    const tabTop = $('#tabbar').getBoundingClientRect().top || H;
    // where the panel's top WILL be (its height animates, so measuring mid-slide is wrong): peek 26vh, half 56vh
    // max-height is a cap: short panels end lower, so the 2nd pass (after the slide) measures the real top
    const sheetH = { peek: 0.26, half: 0.56, full: 0.9 }[state.sheetSize || 'half'] * H;
    const sheetTop = !desktop && panelOpen() ? (settled ? $('#sheet').getBoundingClientRect().top : tabTop - sheetH) : tabTop;
    const left = desktop && panelOpen() ? 440 : 0;
    const bottom = Math.max(top + 80, Math.min(sheetTop, tabTop));
    const zoom = Math.max(state.map.getZoom(), minZoom);
    // put p at the centre of the visible strip: shift the map centre by that many pixels at the target zoom
    const dx = W / 2 - (left + (W - left) / 2), dy = H / 2 - (top + (bottom - top) / 2);
    // Web Mercator world coordinates (256 px tiles at zoom 0) – the same maths Google Maps uses
    const scale = 2 ** zoom, R = Math.PI / 180;
    const siny = Math.min(Math.max(Math.sin(p.lat * R), -0.9999), 0.9999);
    const wx = ((p.lng + 180) / 360) * 256 + dx / scale;
    const wy = (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * 256 + dy / scale;
    const center = { lat: (2 * Math.atan(Math.exp((0.5 - wy / 256) * 2 * Math.PI)) - Math.PI / 2) / R, lng: (wx / 256) * 360 - 180 };
    if (settled) state.map.panTo(center); else state.map.moveCamera({ center, zoom });
  };
  setTimeout(() => go(false), 60);
  clearTimeout(focusOn._t); focusOn._t = setTimeout(() => go(true), 380);
}

// ---------------- reports on map ----------------
async function refreshReports() {
  try {
    const { reports } = await api('/api/reports');
    state.reports = reports;
    drawReports();
    updatePhotoWallCount();
    checkRouteAlerts();
  } catch (e) { console.warn(e); }
}
function drawReports() {
  if (!state.map) return;
  const seen = new Set();
  for (const r of state.reports) {
    seen.add(r.id);
    const visible = r.status === 'active' || r.status === 'fading';
    let layer = state.hazardLayers.get(r.id);
    if (!visible) { if (layer) { layer.circle.setMap(null); layer.marker.map = null; state.hazardLayers.delete(r.id); } continue; }
    const color = SEV_COLOR[r.severity] || SEV_COLOR[0];
    if (!layer) {
      const el = document.createElement('div');
      el.className = 'flood-pin';
      const marker = new state.Adv({ map: state.map, position: r, content: el, title: L(r.ai?.description_en, r.ai?.description_zh) || t('Flood report') });
      marker.addListener('click', tapSafe(() => openDetail(r.id)));
      const circle = new google.maps.Circle({ map: state.map, center: r, clickable: false, strokeWeight: 1 });
      layer = { marker, circle, el };
      state.hazardLayers.set(r.id, layer);
    }
    // Crowd report = alarming map pin: wave symbol, severity badge, pulsing when serious
    layer.el.style.setProperty('--c', PIN_COLOR[r.severity] || PIN_COLOR[1]);
    layer.el.innerHTML = `<span class="fp-pulse"></span><span class="fp-body">${WAVE_SVG}</span><b class="fp-sev">${r.severity}</b>`;
    layer.el.classList.toggle('severe', r.severity >= 3 && r.status === 'active');
    layer.el.classList.toggle('fading', r.status === 'fading');
    layer.circle.setOptions({ radius: r.radius, fillColor: color, fillOpacity: r.status === 'fading' ? 0.12 : 0.25, strokeColor: color, strokeOpacity: 0.6 });
  }
  for (const [id, layer] of state.hazardLayers) {
    if (!seen.has(id)) { layer.circle.setMap(null); layer.marker.map = null; state.hazardLayers.delete(id); }
  }
}

// Gemini's hazard list in the UI language (falls back to English if the Chinese list doesn't line up)
function hazardTags(a) {
  const list = lang === 'zh' && a.hazards_zh?.length === a.hazards?.length ? a.hazards_zh : a.hazards;
  return list?.length ? `<div class="tags">${list.map((h) => `<span>⚠ ${esc(h)}</span>`).join('')}</div>` : '';
}
// Pin colours: amber for minor water, red for anything pedestrians should avoid
const PIN_COLOR = ['#9aa5b1', '#f2a900', '#f08c2e', '#e0452b', '#c1121f', '#7a0b2b'];
const WAVE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';
// How much evidence backs a report (from the anti-spam checks) – shown so people can judge it themselves
const EVIDENCE = {
  on_site: ['good', '📍', 'Reporter was on site'], fresh_photo: ['good', '🕒', 'Photo taken just now'], live_camera: ['good', '📷', 'Taken with the camera'],
  photo_gps_match: ['good', '🛰️', 'Photo location matches'], older_photo: ['warn', '🕒', 'Photo over 1 hour old'],
  photo_location_differs: ['warn', '⚠️', 'Photo location differs'], remote: ['warn', '📡', 'Reported from far away'],
};
function evidenceChips(r) {
  const list = (r.evidence || []).filter((f) => EVIDENCE[f]);
  if (!list.length) return '';
  return `<div class="evidence">${list.map((f) => `<span class="ev ${EVIDENCE[f][0]}">${EVIDENCE[f][1]} ${esc(t(EVIDENCE[f][2]))}</span>`).join('')}</div>`;
}
function sevBadge(s) { return `<span class="sev s${s}">${s} · ${esc(sevLabel(s))}</span>`; }

// ---------- report photos: full-screen viewer + gallery (busy areas can have 10+ reports) ----------
function reportPhotos(r) {
  const list = r.photos?.length ? r.photos.slice().reverse().map((p) => ({ k: `k=${encodeURIComponent(p.key)}`, at: p.at, change: p.change }))
    : r.hasPhoto ? [{ k: `v=${r.updatedAt}`, at: r.createdAt }] : [];
  return list.map((p) => ({ src: `/api/reports/${encodeURIComponent(r.id)}/photo?${p.k}`, reportId: r.id, severity: r.severity, age: Math.round((Date.now() - (p.at || r.createdAt)) / 60000),
    caption: `${sevLabel(r.severity)} · ${ago(Math.round((Date.now() - (p.at || r.createdAt)) / 60000))}${p.change ? ` · ${t(p.change)}` : ''}${r.placeHint ? ` · ${L(r.placeHint, r.placeHintZh)}` : ''}` }));
}
// other live reports within 400 m: most severe and newest first
function nearbyReports(r) {
  return state.reports.filter((x) => x.id !== r.id && x.hasPhoto && (x.status === 'active' || x.status === 'fading') && geoDist(x, r) < 400)
    .sort((a, b) => b.severity - a.severity || a.ageMin - b.ageMin);
}
function nearbyStrip(r) {
  const near = nearbyReports(r); if (!near.length) return '';
  return `<div class="field-label near-head"><span>${esc(t('Reports nearby ({n})', { n: near.length }))}</span>${near.length > 4 ? `<button type="button" class="link" id="nearAll">${esc(t('See all'))}</button>` : ''}</div>
    <div class="photo-strip">${near.slice(0, 4).map((x) => `<button type="button" class="ps-item" data-near-id="${esc(x.id)}"><img src="${esc(reportPhotos(x)[0].src)}" alt="" loading="lazy" /><small>${esc(sevLabel(x.severity))} · ${esc(km(Math.round(geoDist(x, r))))}</small></button>`).join('')}</div>`;
}
function openViewer(items, i = 0) {
  if (!items.length) return;
  let at = i;
  const el = document.createElement('div'); el.className = 'viewer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  const draw = () => {
    const it = items[at];
    el.innerHTML = `<button class="v-close" aria-label="${esc(t('Close'))}">×</button>
      <img src="${esc(it.src)}" alt="${esc(it.caption)}">
      <div class="v-bar"><span>${esc(it.caption)}</span><span class="v-n">${at + 1} / ${items.length}</span></div>
      ${items.length > 1 ? `<button class="v-nav prev" aria-label="${esc(t('Previous'))}">‹</button><button class="v-nav next" aria-label="${esc(t('Next'))}">›</button>` : ''}
      ${it.reportId && $('#detail')?.dataset.rid !== it.reportId ? `<button class="btn v-open">${esc(t('Open this report'))}</button>` : ''}`;
    el.querySelector('.v-close').onclick = close;
    el.querySelector('.prev')?.addEventListener('click', () => go(-1));
    el.querySelector('.next')?.addEventListener('click', () => go(1));
    el.querySelector('.v-open')?.addEventListener('click', () => { close(); openDetail(it.reportId); });
  };
  const go = (d) => { at = (at + d + items.length) % items.length; draw(); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };
  let x0 = null;
  el.addEventListener('pointerdown', (e) => (x0 = e.clientX));
  el.addEventListener('pointerup', (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 50) go(e.clientX < x0 ? 1 : -1); x0 = null; });
  function close() { document.removeEventListener('keydown', key); el.remove(); }
  document.addEventListener('keydown', key);
  document.body.appendChild(el); draw();
}
function openGallery(items, title, filters = false) {
  const el = document.createElement('div'); el.className = 'viewer gallery'; el.setAttribute('role', 'dialog');
  let f = 'all';
  const shown = () => items.filter((x) => f === 'all' || (f === 'severe' && x.severity >= 4) || (f === 'hour' && x.age < 60));
  const draw = () => {
    const list = shown();
    el.innerHTML = `<div class="g-head"><b>${esc(title)}</b><button class="v-close" aria-label="${esc(t('Close'))}">×</button></div>
      ${filters ? `<div class="g-filters">${[['all', 'All'], ['severe', 'Severe (4–5)'], ['hour', 'Last hour']].map(([k, n]) => `<button class="chip-f ${f === k ? 'active' : ''}" data-f="${k}">${esc(t(n))}</button>`).join('')}</div>` : ''}
      <div class="g-grid">${list.map((x, i) => `<button class="g-item sev${x.severity}" data-i="${i}"><img src="${esc(x.src)}" alt="" loading="lazy"><small>${esc(x.caption.split(' · ').slice(0, 2).join(' · '))}</small></button>`).join('') || `<p class="meta">${esc(t('No photos match'))}</p>`}</div>`;
    el.querySelector('.v-close').onclick = () => el.remove();
    el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { f = b.dataset.f; draw(); }));
    el.querySelectorAll('.g-item').forEach((b) => (b.onclick = () => openViewer(list, +b.dataset.i)));
  };
  document.body.appendChild(el); draw();
}

// every live report with a photo, most severe and newest first – the gallery has filters for busy storms (10+ reports)
function openPhotoWall() {
  const live = state.reports.filter((x) => x.hasPhoto && (x.status === 'active' || x.status === 'fading')).sort((a, b) => b.severity - a.severity || a.ageMin - b.ageMin);
  if (!live.length) return toast(t('No flood photos right now'));
  openGallery(live.flatMap((x) => reportPhotos(x).slice(0, 1)), t('Flood photos ({n})', { n: live.length }), true);
}
function updatePhotoWallCount() {
  const n = state.reports.filter((x) => x.hasPhoto && (x.status === 'active' || x.status === 'fading')).length;
  const b = $('#photoWallN'); if (b) b.textContent = n ? String(n) : '';
}
function openDetail(id) {
  state.signalOpen = false;
  const r = state.reports.find((x) => x.id === id);
  if (!r) return;
  const a = r.ai || {};
  state.reopen = () => openDetail(id);
  $('#detail').innerHTML = `
    <button class="link" id="detailBack">${esc(t('← Back'))}</button>
    <div style="margin-top:8px">${sevBadge(r.severity)}${r.demo || r.simulated ? `<span class="badge">${esc(t('Simulated'))}</span>` : r.sandbox ? `<span class="badge">${esc(t('Demo · only you see this'))}</span>` : ''}${r.status === 'fading' ? `<span class="badge">${esc(t('Fading – needs confirmation'))}</span>` : ''}</div>
    ${r.hasPhoto ? `<img class="detail-photo" id="detailPhoto" src="/api/reports/${encodeURIComponent(r.id)}/photo?${r.photos?.length ? `k=${encodeURIComponent(r.photos[r.photos.length - 1].key)}` : `v=${r.updatedAt}`}" alt="${esc(t('Flood photo'))}" />` : ''}
    ${evidenceChips(r)}
    ${r.photos?.length > 1 ? `<div class="field-label">${esc(t('Photos ({n})', { n: r.photos.length }))}</div><div class="photo-strip">${r.photos.slice().reverse().slice(0, 6).map((p, i) => `
      <button type="button" class="ps-item ${i === 0 ? 'on' : ''}" data-k="${esc(p.key)}"><img src="/api/reports/${encodeURIComponent(r.id)}/photo?k=${encodeURIComponent(p.key)}" alt="" loading="lazy" /><small>${esc(ago(Math.round((Date.now() - p.at) / 60000)))}${p.change ? ` · ${esc(t(p.change))}` : ''}</small></button>`).join('')}${r.photos.length > 6 ? `<button type="button" class="ps-item ps-more" id="psMore"><b>+${r.photos.length - 6}</b><small>${esc(t('See all'))}</small></button>` : ''}</div>` : ''}
    ${nearbyStrip(r)}
    ${r.expiresInMin != null ? `<div class="expiry ${r.status === 'fading' ? 'soon' : ''}">⏳ ${esc(t('Disappears in {n} min unless someone confirms it', { n: r.expiresInMin }))}</div>` : ''}
    ${r.placeHint ? `<div class="meta" style="margin-top:6px">${esc(L(r.placeHint, r.placeHintZh))}</div>` : ''}
    <div class="ai"><div class="tag">${esc(t('Gemini assessment'))}</div>${esc(L(a.description_en, a.description_zh))}
      <div class="meta" style="margin-top:6px">≈ ${a.estimated_depth_cm ?? '?'} cm · ${esc(t('flow: {f}', { f: t(a.water_flow || 'none') }))} · ${esc(t(a.passable_on_foot ? '🚶 passable with care' : '🚫 pedestrians should avoid'))}</div>
      ${a.depth_cues && lang === 'en' ? `<div class="meta">${esc(t('Depth cues: {c}', { c: a.depth_cues }))}</div>` : ''}
    </div>
    ${hazardTags(a)}
    ${r.knownRisk?.length ? `<div class="official"><div class="tag">${esc(t('Official DSD record nearby'))}</div>${esc(r.knownRisk[0].name)}</div>` : ''}
    <div class="stats"><div><b>${r.confirms || 0}</b>${esc(t('still there'))}</div><div><b>${r.clears || 0}</b>${esc(t('cleared'))}</div><div><b>${Math.round((r.trust || 0) * 100)}%</b>${esc(t('trust'))}</div></div>
    <div class="meta" style="margin-top:8px">${esc(t('Reported {ago}', { ago: ago(r.ageMin) }))}</div>
    <section class="action-card">
      <h4>${esc(t('Are you here now?'))}</h4>
      <p class="meta">${esc(t('One tap helps everyone nearby reroute.'))}</p>
      <div class="vote">
        <button class="btn bad" data-vote="confirm">${esc(t('🌊 Still flooded'))}</button>
        <button class="btn good" data-vote="clear">${esc(t('✅ Cleared'))}</button>
      </div>
    </section>
    <section class="action-card ai-check">
      <h4><span class="ai-badge">Gemini</span> ${esc(t('Photo check'))}</h4>
      <p class="meta">${esc(t('Snap the same spot. Gemini compares it with the original photo and decides if the water is gone, going down, the same, or worse.'))}</p>
      <button class="btn primary block" id="updatePhotoBtn">${esc(t('📷 Take a new photo'))}</button>
      <input type="file" accept="image/*" capture="environment" id="updatePhoto" hidden />
    </section>
    <div id="voteResult"></div>`;
  switchTab('detail');
  $('#detail').dataset.rid = r.id;
  $('#detailBack').onclick = goBack;
  $$('#detail [data-vote]').forEach((b) => (b.onclick = () => vote(r.id, b.dataset.vote, null, b)));
  $('#updatePhotoBtn').onclick = () => $('#updatePhoto').click();
  $$('#detail .ps-item[data-k]').forEach((b) => (b.onclick = () => {
    $('#detailPhoto').src = `/api/reports/${encodeURIComponent(r.id)}/photo?k=${encodeURIComponent(b.dataset.k)}`;
    $$('#detail .ps-item').forEach((x) => x.classList.toggle('on', x === b));
  }));
  // tap the big photo: full screen, swipe through this report's photos
  $('#detailPhoto')?.addEventListener('click', () => {
    const items = reportPhotos(r), cur = items.findIndex((x) => $('#detailPhoto').src.endsWith(x.src.split('?')[1]));
    openViewer(items, Math.max(0, cur));
  });
  $('#psMore')?.addEventListener('click', () => openGallery(reportPhotos(r), t('Photos ({n})', { n: r.photos.length })));
  $$('#detail [data-near-id]').forEach((b) => (b.onclick = () => openDetail(b.dataset.nearId)));
  $('#nearAll')?.addEventListener('click', () => openGallery(nearbyReports(r).flatMap((x) => reportPhotos(x).slice(0, 1)), t('Reports nearby ({n})', { n: nearbyReports(r).length }), true));
  $('#updatePhoto').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { vote(r.id, null, await resizeImage(f), $('#updatePhotoBtn')); }
    catch (err) { toast(err.message); }
    e.target.value = '';
  };
  focusOn(r, 15);
}

async function vote(id, v, photo, btn) {
  busy(btn, true, t(photo ? 'Gemini comparing…' : 'Sending…'));
  try {
    const out = await api(`/api/reports/${encodeURIComponent(id)}/vote`, { method: 'POST', body: { vote: v || 'confirm', photo } });
    const c = out.comparison;
    $('#voteResult').innerHTML = c
      ? `<div class="ai"><div class="tag">${esc(t('Gemini before/after'))}</div>${esc(t('Change:'))} <b>${esc(t(c.change))}</b>${c.same_place_likely ? '' : esc(t(' (photo may not match this spot – not applied)'))}<br>${esc(L(c.description_en, c.description_zh))}</div>`
      : `<div class="meta" style="margin-top:8px">${esc(t('Thanks – your update helps others route safely.'))}</div>`;
    await refreshReports();
    toast(t('Update recorded'));
  } catch (e) { toast(e.message); }
  finally { busy(btn, false); }
}

// ---------------- routing ----------------
// n = English key; the getter returns it in the current UI language
const named = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, get n() { return t(v.en); } }]));
const SHELTER = named({
  indoor: { c: '#8e44ad', i: '🏬', en: 'Indoor / mall' },
  underground: { c: '#546e7a', i: '🚇', en: 'Underground' },
  footbridge: { c: '#00897b', i: '🌉', en: 'Footbridge' },
  covered: { c: '#1e88e5', i: '☂️', en: 'Covered' },
  open: { c: '#f5a623', i: '🌧️', en: 'Open-air' },
});
const TAGS = named({
  fastest: { i: '⚡', en: 'Fastest' }, balanced: { i: '⚖️', en: 'Balanced' }, driest: { i: '☂️', en: 'Driest' },
  alternative: { i: '↔️', en: 'Alternative' }, 'least-risk': { i: '⚠️', en: 'Least risk' },
});

async function findRoute() {
  const btn = $('#routeGo');
  if (!state.origin) { toast(t('Choose a start point: search, “My current location”, or 🗺️ pick on map')); return; }
  if (!state.dest) { toast(t('Choose a destination: search or 🗺️ pick on map')); $('#destInput').focus(); return; }
  stopGuide();
  busy(btn, true, '');
  $('#routeResult').innerHTML = '<div class="skeleton"><span></span><span></span><span></span></div>';
  $('#welcome').hidden = true;
  try {
    const plan = await api('/api/route', { method: 'POST', body: { origin: state.origin, destination: state.dest, preference: state.pref } });
    state.lastPlan = plan;
    drawEndpoints();
    renderResume();
    state.briefings = {};
    selectOption(plan.recommended || 0, true);
    const sheet = $('#sheet'); const res = $('#routeResult');
    sheet.scrollTo({ top: Math.max(0, res.offsetTop - 70), behavior: 'smooth' });
  } catch (e) { $('#routeResult').innerHTML = `<div class="card danger">${esc(e.message)}</div>`; }
  finally { busy(btn, false); }
}

function selectOption(i, fit = false) {
  const plan = state.lastPlan; if (!plan) return;
  state.optIndex = i;
  drawRoute(plan, i, fit);
  renderPlan(plan, i);
  renderResume();
  loadBriefing(plan, i);
}

function clearRoute() {
  state.routeLines.forEach((l) => l.setMap(null)); state.routeLines = [];
  (state.routeBubbles || []).forEach((m) => (m.map = null)); state.routeBubbles = [];
}

// Google-Maps-style labels on each route: time, difference and shelter. Tap a label (or its line) to switch.
// Where a route's label goes: the point of that route farthest from the other routes (within its middle 60 %),
// and which side of the line the label sits on: away from the nearest other route, so labels never cover a line.
function bubblePoint(coords, others, from = 0.2, to = 0.8) {
  const n = coords.length;
  let best = coords[Math.floor(n / 2)], bestD = -1, near = null;
  for (let i = Math.floor(n * from); i < Math.max(Math.ceil(n * to), Math.floor(n * from) + 1); i += Math.max(1, Math.floor(n / 40))) {
    const [x, y] = coords[i];
    let d = Infinity, nn = null;
    for (const oc of others) for (let j = 0; j < oc.length; j += 2) { const dd = (oc[j][0] - x) ** 2 + (oc[j][1] - y) ** 2; if (dd < d) { d = dd; nn = oc[j]; } }
    if (d > bestD) { bestD = d; best = coords[i]; near = nn; }
  }
  // side: opposite the nearest other route; with no other route, the side away from the line's own bend
  let side = 'right';
  if (near) side = near[0] > best[0] ? 'left' : 'right';
  else { const a = coords[0], b = coords[n - 1]; const mid = (a[0] + b[0]) / 2; side = best[0] >= mid ? 'right' : 'left'; }
  return { pos: { lat: best[1], lng: best[0] }, side };
}
function drawRouteBubbles(plan, sel) {
  (state.routeBubbles || []).forEach((m) => (m.map = null)); state.routeBubbles = [];
  if (!state.Adv) return;
  const o = plan.options[sel];
  const all = plan.options.map((x) => x.coords).concat(plan.fastest ? [plan.fastest.coords] : []);
  const used = [];
  const add = (coords, html, cls, onClick, z, range) => {
    let { pos, side } = bubblePoint(coords, all.filter((c) => c !== coords), ...range);
    // two labels anchored close together go on opposite sides
    const clash = used.find((u) => Math.abs(u.pos.lat - pos.lat) < 0.0025 && Math.abs(u.pos.lng - pos.lng) < 0.004);
    if (clash && clash.side === side) side = side === 'left' ? 'right' : 'left';
    used.push({ pos, side });
    const wrap = document.createElement('div');
    wrap.className = `rb-wrap ${side}`;
    const el = document.createElement('button');
    el.type = 'button'; el.className = `route-bubble ${cls}`; el.innerHTML = html;
    wrap.innerHTML = `<i class="rb-dot ${cls}"></i>`; wrap.appendChild(el);
    const m = new state.Adv({ map: state.map, position: pos, content: wrap, zIndex: z });
    if (onClick) { const tap = tapSafe(onClick); m.addListener('click', tap); el.addEventListener('click', (e) => { e.stopPropagation(); tap(); }); }
    state.routeBubbles.push(m);
  };
  const shelter = (x) => (x.shelter ? ` <span class="rb-sh">☂${x.shelter.shelteredPct}%</span>` : '');
  plan.options.forEach((x, i) => {
    if (i === sel) {
      add(x.coords, `<b>${mins(x.durationS)} ${esc(t('min'))}</b>${shelter(x)}`, 'sel', null, 60, [0.25, 0.55]);
    } else {
      const d = x.durationS - o.durationS;
      const diff = Math.abs(d) < 30 ? t('same time') : d > 0 ? t('{n} min slower', { n: mins(d) }) : t('{n} min faster', { n: mins(-d) });
      add(x.coords, `<b>${esc(diff)}</b>${shelter(x)}`, 'alt', () => selectOption(i, 'sel'), 55, [0.45, 0.8]);
    }
  });
  if (plan.fastest) add(plan.fastest.coords, `⚠ <b>${esc(t('Through flood'))}</b> · ${mins(plan.fastest.durationS)} ${esc(t('min'))}`, 'danger', () => toast(t('This route crosses a reported flood – FloodSafe avoids it.')), 50, [0.6, 0.9]);
}
function drawRoute(plan, sel = 0, fit = true) {
  if (!state.map) return;
  clearRoute();
  const path = (c) => c.map(([lng, lat]) => ({ lat, lng }));
  if (plan.fastest) {
    state.routeLines.push(new google.maps.Polyline({
      map: state.map, path: path(plan.fastest.coords), strokeOpacity: 0, zIndex: 1,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: '#e0452b', scale: 3 }, offset: '0', repeat: '12px' }],
    }));
  }
  // "Show shortest route" (CoolMap-style): the shortest flood-safe option as a dark dashed line
  const shortest = plan.options.find((x) => x.tag === 'fastest');
  if (state.showShortest && shortest && plan.options[sel] !== shortest) {
    state.routeLines.push(new google.maps.Polyline({
      map: state.map, path: path(shortest.coords), strokeOpacity: 0, zIndex: 2,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.85, strokeColor: '#1f2933', scale: 3 }, offset: '0', repeat: '10px' }],
    }));
  }
  // other options: thin grey, tap to select
  plan.options.forEach((o, i) => {
    if (i === sel || (state.showShortest && o === shortest)) return;
    const l = new google.maps.Polyline({ map: state.map, path: path(o.coords), strokeColor: '#7b8794', strokeOpacity: 0.85, strokeWeight: 6, zIndex: 2 });
    l.addListener('click', tapSafe(() => selectOption(i, 'sel')));
    state.routeLines.push(l);
  });
  const o = plan.options[sel];
  // white casing under the selected route (the coloured runs sit exactly on top of it)
  const casing = new google.maps.Polyline({ map: state.map, path: path(o.coords), strokeColor: '#ffffff', strokeWeight: 10, strokeOpacity: 0.95, zIndex: 3 });
  state.routeLines.push(casing);
  if (o.shelter?.runs?.length) {
    // colour by shelter, like CoolMap's shaded (blue) vs exposed (yellow) segments
    for (const r of o.shelter.runs) {
      state.routeLines.push(new google.maps.Polyline({ map: state.map, path: path(r.coords), strokeColor: SHELTER[r.cls].c, strokeWeight: 6, zIndex: 4 }));
    }
  } else {
    state.routeLines.push(new google.maps.Polyline({ map: state.map, path: path(o.coords), strokeColor: o.safe ? '#0a84ff' : '#f08c2e', strokeWeight: 6, zIndex: 4 }));
  }
  drawEndpoints();
  drawRouteBubbles(plan, sel);
  if (!fit) return;
  // fit = true: show every option; fit = 'sel': zoom to the option just picked
  const b = new google.maps.LatLngBounds();
  (fit === 'sel' ? [o] : plan.options).forEach((x) => path(x.coords).forEach((p) => b.extend(p)));
  if (plan.fastest && fit !== 'sel') path(plan.fastest.coords).forEach((p) => b.extend(p));
  const desktop = window.innerWidth >= 900;
  const tabH = Math.round($('#tabbar').getBoundingClientRect().height);
  let sheetH = panelOpen() ? Math.round($('#sheet').getBoundingClientRect().height) : 0;
  // Picking a route on a phone: if the panel leaves too little map to see it, lower the panel to "peek"
  // (pull it up again for the details) – like Google Maps showing the chosen route
  if (fit === 'sel' && !desktop && sheetH && window.innerHeight - 150 - sheetH - tabH < 280) {
    setSheetSize('peek');
    sheetH = Math.round(window.innerHeight * 0.26); // .sheet.peek max-height (the panel is still animating)
  }
  state.map.fitBounds(b, desktop ? { left: 440, top: 140, right: 40, bottom: 40 }
    : { top: 150, bottom: Math.min(window.innerHeight - 330, (sheetH || 90) + tabH + 24), left: 36, right: 36 });
}

// stacked bar: indoor / underground / footbridge / covered / open
function exposureBar(sh, h = 8) {
  if (!sh?.totalM) return '';
  const order = ['indoor', 'underground', 'footbridge', 'covered', 'open'];
  return `<div class="xbar" style="height:${h}px" aria-hidden="true">${order.map((k) => {
    const w = (sh.metres[k] || 0) / sh.totalM * 100; return w > 0.5 ? `<i style="width:${w}%;background:${SHELTER[k].c}"></i>` : '';
  }).join('')}</div>`;
}

// Hour-by-hour rain strip (Google Weather API)
function forecastStrip(f, n = 8) {
  if (!f?.hours?.length) return '';
  const best = f.advice?.kind === 'wait' ? f.advice.at : null;
  const advIcon = { wait: '🕒', 'go-now': '🏃', wet: '☂️', ok: '✅' }[f.advice?.kind] || '🕒';
  return `<div class="fc">
    ${f.advice ? `<div class="fc-adv ${f.advice.kind}"><span>${advIcon}</span><div><b>${esc(L(f.advice.text_en, f.advice.text_zh))}</b></div></div>` : ''}
    <div class="fc-row" role="list">${f.hours.slice(0, n).map((h, i) => `
      <div class="fc-h ${h.label === best ? 'best' : ''} ${i === 0 ? 'now' : ''}" role="listitem" aria-label="${esc(t('{h}: {c}% chance of rain, {mm} millimetres', { h: h.label, c: h.chance, mm: h.mm }))}${h.thunder >= 40 ? esc(t(', thunderstorms likely')) : ''}">
        <span class="fc-t">${i === 0 ? esc(t('Now')) : esc(h.label)}</span>
        ${h.icon ? `<img src="${esc(h.icon)}" alt="" width="26" height="26" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
        <div class="fc-bar"><i style="height:${Math.min(100, Math.round(h.mm * 3))}%"></i></div>
        <b>${h.chance}%</b><small>${h.mm}mm</small>${h.thunder >= 40 ? '<em>⚡</em>' : ''}
      </div>`).join('')}</div>
    <div class="meta fc-src">${esc(t(f.demo ? 'Simulated forecast (demo)' : 'Forecast · Google Weather API'))}${f.rain24h != null ? ` · ${esc(t('{n} mm in past 24 h', { n: f.rain24h }))}` : ''}</div>
  </div>`;
}

const extraTxt = (sec) => (sec < 60 ? t('+{n} s', { n: sec }) : t('+{n} min', { n: mins(sec) }));

function renderPlan(plan, sel = 0) {
  const o = plan.options[sel];
  const info = plan.hazardInfo || {};
  const w = state.weather || {};
  const sh = o.shelter;
  const endpoint = plan.endpointHazards || [];
  const remaining = o.remainingHazards.length;
  const opts = plan.options.length > 1 ? `<div class="opts" role="radiogroup" aria-label="${esc(t('Route options'))}">${plan.options.map((x, i) => {
    const tg = TAGS[x.tag] || TAGS.alternative;
    return `<button class="opt ${i === sel ? 'selected' : ''} ${x.safe ? '' : 'unsafe'}" data-i="${i}" role="radio" aria-checked="${i === sel}"
      aria-label="${esc(tg.n)}: ${esc(t('{n} minutes', { n: mins(x.durationS) }))}${x.shelter ? `, ${esc(t('{p}% sheltered', { p: x.shelter.shelteredPct }))}` : ''}${x.avoidedHazardIds.length ? `, ${esc(t('avoids {n} floods', { n: x.avoidedHazardIds.length }))}` : ''}">
      <span class="opt-tag">${tg.i}<span>${esc(tg.n)}</span>${i === (plan.recommended || 0) ? '<em>★</em>' : ''}</span>
      <span class="opt-time">${mins(x.durationS)}<small>${esc(t('min'))}</small></span>
      ${exposureBar(x.shelter, 6)}
      <span class="opt-stats">${x.shelter ? `<span>☂️${x.shelter.shelteredPct}%</span>` : ''}${x.avoidedHazardIds.length ? `<span>🌊−${x.avoidedHazardIds.length}</span>` : ''}${!x.safe ? '<span>⚠️</span>' : ''}</span>
    </button>`;
  }).join('')}</div>` : '';

  const tile = (icon, val, unit, label, cls = '') => `<div class="tile ${cls}"><span class="tile-i">${icon}</span><b>${val}<small>${unit}</small></b><span class="tile-l">${esc(t(label))}</span></div>`;
  const tiles = [
    tile('📏', o.distanceM >= 1000 ? (o.distanceM / 1000).toFixed(2) : o.distanceM, o.distanceM >= 1000 ? 'km' : 'm', 'Distance'),
    tile('⏱️', mins(o.durationS), t('min'), 'Time'),
  ];
  if (sh) {
    tiles.push(tile('☂️', sh.shelteredPct, '%', 'Sheltered', 'blue'), tile('🌧️', sh.openM, 'm', 'Open-air', 'amber'));
    if (sh.metres.indoor) tiles.push(tile('🏬', sh.metres.indoor, 'm', 'Indoor'));
    if (sh.metres.footbridge) tiles.push(tile('🌉', sh.metres.footbridge, 'm', 'Footbridge'));
    if (sh.metres.underground) tiles.push(tile('🚇', sh.metres.underground, 'm', 'Underground'));
  }
  tiles.push(tile('🌊', o.avoidedHazardIds.length, '', 'Floods avoided', o.avoidedHazardIds.length ? 'green' : ''));
  const subwayAvoided = o.avoidedHazardIds.filter((id) => info[id]?.source === 'subway').length;

  $('#routeResult').innerHTML = `
    ${opts}
    <section class="route-detail">
      <div class="verdict ${o.safe ? (o.avoidedHazardIds.length ? 'avoid' : 'ok') : 'bad'}" role="status">
        <b>${esc(!o.safe ? t('⚠️ Passes flooding – lowest-risk option') : o.avoidedHazardIds.length ? t(o.avoidedHazardIds.length > 1 ? '🌊 Avoids {n} floods' : '🌊 Avoids {n} flood', { n: o.avoidedHazardIds.length }) : t('✅ No floods on this route'))}</b>
        <span>${esc(t('⏱️ {n} min', { n: mins(o.durationS) }))}${o.extraSeconds ? ` (${esc(extraTxt(o.extraSeconds))})` : ''}${sh ? ` · ${esc(t('☂️ {p}% sheltered', { p: sh.shelteredPct }))}` : ''}</span>
      </div>
      ${o.distanceM > 3000 || o.durationS > 45 * 60 ? `<div class="transit-hint"><b>🚇 ${esc(t('Long walk: {d} · about {m} min', { d: km(o.distanceM), m: mins(o.durationS) }))}</b>
        <span>${esc(t('FloodSafe plans walking routes only. In heavy rain, consider the MTR or a bus for most of this trip and plan just the walk to the station here.'))}</span>
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${plan.origin?.lat ?? state.origin?.lat},${plan.origin?.lng ?? state.origin?.lng}&destination=${plan.destination?.lat ?? state.dest?.lat},${plan.destination?.lng ?? state.dest?.lng}&travelmode=transit">↗ ${esc(t('Public transport options (Google Maps)'))}</a></div>` : ''}
      ${plan.priorsBasis === 'forecast' && plan.priorsActive ? `<div class="note purple">${esc(t('📌 No official signal yet, but heavy rain is forecast or the ground is soaked, so {n} DSD flood-prone spots are flagged.', { n: plan.priorsActive }))}</div>` : ''}
      ${!o.safe ? `<div class="card danger" style="margin-top:10px">${esc(t('⚠️ No fully flood-free route found. This is the lowest-risk option.'))}</div>` : ''}
      ${plan.preference && plan.preference !== 'shortest' && !plan.preferenceMet && sel === 0 ? `<div class="pref-note">${esc(t('☂️ No more-covered route nearby – this is the best flood-safe option'))}${o.shelter ? esc(t(' ({p}% sheltered)', { p: o.shelter.shelteredPct })) : ''}${lang === 'zh' ? '。' : '.'}</div>` : ''}
      ${plan.fastest ? `<div class="note red">${esc(t('— — Red dashed = fastest route through flooding.'))} ${o.extraSeconds ? esc(t('This route adds {x}.', { x: extraTxt(o.extraSeconds).replace('+', '') })) : ''}</div>` : ''}
      ${plan.forecast ? `<h4 class="sec">${esc(t('Rain next hours'))}</h4>${forecastStrip(plan.forecast)}` : ''}
      ${sh ? `<h4 class="sec">${esc(t('Rain exposure'))}</h4>
        <div class="expo"><div class="expo-head"><span>☂️ ${esc(t('Sheltered'))}</span><b>${sh.shelteredPct}<small>%</small></b></div>${exposureBar(sh, 12)}
        <div class="legend">${['indoor', 'underground', 'footbridge', 'covered', 'open'].filter((k) => sh.metres[k] > 0).map((k) => `<span><i style="background:${SHELTER[k].c}"></i>${SHELTER[k].i} ${SHELTER[k].n}</span>`).join('')}</div></div>`
      : (plan.shelter && !plan.shelter.available ? `<div class="note">${esc(t('☂️ Shelter data unavailable right now'))}${plan.shelter.error ? ` (${esc(plan.shelter.error)})` : ''}.</div>` : '')}
      <details class="route-data" ${state.routeDataOpen ? 'open' : ''}><summary><span>${esc(t('Route data'))}</span><small>${esc(t('distance, time, shelter, places on the way'))}</small></summary>
        <div class="tiles">${tiles.join('')}</div>
        ${sh?.places?.length ? `<h4 class="sec">${esc(t('Along the way'))}</h4><div class="places">${sh.places.map((p) => `<span>${SHELTER[p.cls]?.i || '📍'} ${esc(L(p.name, p.nameZh))}</span>`).join('')}</div>` : ''}
      </details>
      ${subwayAvoided ? `<div class="note">${esc(t('🚇 Skips {n} pedestrian subway(s) next to flooding – subways flood first.', { n: subwayAvoided }))}</div>` : ''}
      ${endpoint.some((h) => info[h.id]?.source === 'crowd') ? `<div class="note red">${esc(t('⚠️ Flooding reported at your start or destination.'))}</div>` : ''}
      ${endpoint.some((h) => info[h.id]?.source === 'dsd') ? `<div class="note purple">${esc(t('📌 Start or destination is a DSD flood-prone spot.'))}</div>` : ''}
      ${o.dsdAlongRoute?.length ? `<div class="official"><div class="tag">${esc(t('📌 Known flood-prone spots on route'))}</div>${o.dsdAlongRoute.slice(0, 3).map((d) => esc(d.name)).join('<br>')}</div>` : ''}
      ${remaining ? `<div class="note">${esc(t('Passes {n} minor report(s) – see briefing.', { n: remaining }))}</div>` : ''}
      <div id="briefing" class="ai"><div class="tag">${esc(t('✨ Gemini briefing'))}</div><span class="meta">${esc(t('Generating…'))}</span></div>
      ${o.steps?.length ? `<details class="steps-box"><summary>${esc(t('🧭 {n} steps', { n: o.steps.length }))}</summary><ol class="steps">${o.steps.map((s) => `<li>${esc(s.text)} <span class="meta">${s.distanceM ? km(s.distanceM) : ''}</span></li>`).join('')}</ol></details>` : ''}
      <p class="meta src">${esc(t('Shelter: {src} · {n} routes checked', { src: t(plan.shelter?.source || ''), n: plan.candidatesEvaluated }))}</p>
      <div class="start-bar"><button class="btn share-btn save-btn" id="saveRoute" type="button" aria-label="${esc(t('Save for offline'))}" title="${esc(t('Save for offline'))}">⬇️</button><button class="btn share-btn" id="shareRoute" type="button" aria-label="${esc(t('Share this route'))}">🔗 ${esc(t('Share'))}</button><button class="btn primary block" id="startGuide">${esc(t('▶ Start'))}</button></div>
    </section>`;
  $$('#routeResult .opt').forEach((b) => (b.onclick = () => selectOption(+b.dataset.i, 'sel')));
  $('#startGuide').onclick = () => startGuide(o);
  $('#shareRoute').onclick = () => shareRoute(o);
  $('#saveRoute').onclick = () => saveRouteOffline(o, plan);
  $('#routeResult .route-data')?.addEventListener('toggle', (e) => (state.routeDataOpen = e.target.open));
}

async function loadBriefing(plan, sel = 0) {
  const o = plan.options[sel];
  const render = (b) => {
    const el = $('#briefing'); if (!el || state.optIndex !== sel) return;
    const fb = b.source === 'fallback';
    const tips = lang === 'zh' && b.tips_zh?.length ? b.tips_zh : (b.tips_en || []);
    el.innerHTML = `<div class="tag">${esc(t(fb ? '⚠️ Basic briefing (Gemini unavailable)' : '✨ Gemini briefing'))} · ${esc(t('risk {r}', { r: t(b.risk_level || '') }))}</div>
      ${fb ? `<div class="meta" style="color:#9b2316;margin-bottom:6px">${esc(b.reason || 'Gemini error')}</div>` : ''}
      <b>${esc(L(b.headline_en, b.headline_zh))}</b>
      <ul>${tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  };
  if (state.briefings?.[sel]) return render(state.briefings[sel]);
  try {
    const b = await api('/api/briefing', {
      method: 'POST',
      body: {
        mode: 'walk', durationS: o.durationS, extraSeconds: o.extraSeconds, option: o.tag,
        avoidedHazardIds: o.avoidedHazardIds, remainingHazardIds: o.remainingHazards.map((h) => h.id),
        originName: state.originName, destinationName: state.destName,
        hazardInfo: plan.hazardInfo, dsdAlongRoute: o.dsdAlongRoute, endpointHazardIds: (plan.endpointHazards || []).map((h) => h.id),
        shelter: o.shelter ? { shelteredPct: o.shelter.shelteredPct, metres: o.shelter.metres, places: o.shelter.places } : null,
        forecast: plan.forecast ? { hours: plan.forecast.hours.slice(0, 4), rain24h: plan.forecast.rain24h, advice: plan.forecast.advice } : null,
      },
    });
    state.briefings[sel] = b;
    render(b);
  } catch (e) { const el = $('#briefing'); if (el) el.innerHTML = `<span class="meta">${esc(t('Briefing unavailable: {e}', { e: e.message }))}</span>`; }
}

// ---------------- guidance + real-time route alerts ----------------
// While walking, the phone follows the route. Two alert paths run side by side:
//  • push: the route is registered with the server, which pushes a notification the moment someone reports
//    (or worsens) a flood on it ahead of you – works with the screen off or the app closed;
//  • in-app: every 8 s the app re-checks reports against the route (covers browsers without push, e.g. iPhone Safari
//    unless FloodSafe is added to the Home Screen).
// Either way the alert offers a one-tap reroute from where you are now.
const RAD = Math.PI / 180;
const geoDist = (a, b) => 2 * 6371000 * Math.asin(Math.sqrt(Math.sin((b.lat - a.lat) * RAD / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin((b.lng - a.lng) * RAD / 2) ** 2));
// same thinning as the server (so progress indexes match)
function thinRoute(coords, max = 300) {
  const pts = (coords || []).filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const step = Math.max(1, Math.ceil(pts.length / max));
  const out = pts.filter((_, i) => i % step === 0);
  if (pts.length && out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out.map(([lng, lat]) => ({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }));
}
function nearRoute(p, pts) {
  let best = { d: Infinity, idx: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], kx = Math.cos(a.lat * RAD) * 111320, ky = 110540;
    const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky, px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
    const L2 = bx * bx + by * by, tt = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
    const d = Math.hypot(px - tt * bx, py - tt * by);
    if (d < best.d) best = { d, idx: tt > 0.5 ? i + 1 : i };
  }
  return best;
}
const alongRoute = (pts, from, to) => { let m = 0; for (let i = Math.max(0, from); i < Math.min(to, pts.length - 1); i++) m += geoDist(pts[i], pts[i + 1]); return m; };
const onRoute = (r, pts) => nearRoute(r, pts).d <= (r.radius || 40) + 40;

function saveTrip() {
  try { localStorage.setItem('fs-trip', JSON.stringify({ dest: state.dest, destName: state.destName, pref: state.pref, at: Date.now() })); } catch {}
}
function savedTrip() {
  try { const v = JSON.parse(localStorage.getItem('fs-trip') || 'null'); return v && Date.now() - v.at < 3 * 3600e3 ? v : null; } catch { return null; }
}

function startGuide(o, { sim = false } = {}) {
  if (!navigator.geolocation && !state.demo) { toast(t('Location not available')); return; }
  stopGuide();
  const pts = thinRoute(o.coords);
  const g = state.guide = { o, pts, watch: null, progress: 0, alerted: new Set(), watchId: null, synced: 0, sim, simTimer: null, poll: null };
  // floods already on this route were shown when it was chosen – alert only for new or worse ones
  for (const r of state.reports) if ((r.status === 'active' || r.status === 'fading') && onRoute(r, pts)) g.alerted.add(`${r.id}:${r.severity}`);
  saveTrip();
  closePanel();
  document.body.classList.add('guiding');
  const el = $('#guide'); el.hidden = false;
  el.innerHTML = `<div class="guide-card"><div class="guide-i">🧭</div><div class="guide-body"><b id="gStep">${esc(o.steps?.[0]?.text || t('Head to the route'))}</b><span id="gMeta" class="meta">${esc(t('Waiting for GPS…'))}</span></div><button id="gStop" class="x" aria-label="${esc(t('Stop guidance'))}">✕</button></div>
    <div class="guide-tools"><span id="gAlerts" class="g-alerts">🔔 ${esc(t('Setting up flood alerts…'))}</span>${state.demo ? `<button type="button" id="gSim" class="g-sim">🧪 ${esc(t('Simulate a flood report ahead'))}</button>
      <span class="seg g-speed" role="radiogroup" aria-label="${esc(t('Demo walk speed'))}">${[0.5, 1, 2].map((v) => `<button type="button" role="radio" data-speed="${v}" aria-checked="${simSpeed() === v}" class="${simSpeed() === v ? 'on' : ''}">${v}×</button>`).join('')}</span>` : ''}</div>
    <div id="gAlert" class="route-alert" role="alert" hidden></div>`;
  $('#gStop').onclick = stopGuide;
  $('#gSim')?.addEventListener('click', simulateFloodAhead);
  $$('#guide [data-speed]').forEach((b) => (b.onclick = () => {
    try { localStorage.setItem('fs-sim-speed', b.dataset.speed); } catch {}
    $$('#guide [data-speed]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
  }));
  g.poll = setInterval(refreshReports, 8000);
  setupRouteAlerts(g);
  if (sim) return startSimWalk(g);
  g.watch = navigator.geolocation.watchPosition((p) => {
    if (state.guide !== g || g.sim) return;
    const me = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    // demo far from the route (e.g. presenting from another district): walk a simulated position instead
    if (state.demo && nearRoute(me, pts).d > 1000) return startSimWalk(g);
    state.me = me; drawMe();
    state.map?.panTo(me);
    updateGuide(me);
  }, () => { if (state.demo) startSimWalk(g); else $('#gMeta').textContent = t('GPS unavailable'); }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
}
function simSpeed() { try { const v = +localStorage.getItem('fs-sim-speed'); return [0.5, 1, 2].includes(v) ? v : 1; } catch { return 1; } }
// Demo: a dot walks the route (about 5× walking speed) so the alert → reroute flow can be shown anywhere
function startSimWalk(g) {
  if (g.simTimer || state.guide !== g) return;
  g.sim = true;
  if (g.watch != null) { navigator.geolocation.clearWatch(g.watch); g.watch = null; }
  g.simM = alongRoute(g.pts, 0, g.progress);
  const tick = () => {
    if (state.guide !== g || g.simPaused) return;
    g.simM += 7 * simSpeed(); // 1× = ~7 m per second (about 5× walking pace); 0.5× / 2× chosen on the guide card
    let i = 0, m = g.simM;
    while (i < g.pts.length - 1) { const seg = geoDist(g.pts[i], g.pts[i + 1]); if (m <= seg) break; m -= seg; i++; }
    const a = g.pts[i], b = g.pts[Math.min(i + 1, g.pts.length - 1)], seg = geoDist(a, b) || 1, f = Math.min(1, m / seg);
    const me = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, accuracy: 5 };
    g.progress = i;
    state.me = me; drawMe(); state.map?.panTo(me);
    updateGuide(me);
  };
  tick();
  g.simTimer = setInterval(tick, 1000);
  state.map?.setZoom(17);
}
function stopGuide() {
  const g = state.guide;
  document.body.classList.remove('guiding');
  if (g?.watch != null) navigator.geolocation.clearWatch(g.watch);
  if (g?.simTimer) clearInterval(g.simTimer);
  if (g?.poll) clearInterval(g.poll);
  if (g?.watchId) api(`/api/watch/${g.watchId}`, { method: 'DELETE' }).catch(() => {});
  state.guide = null;
  const el = $('#guide'); if (el) { el.hidden = true; el.innerHTML = ''; }
  if (document.getElementById('resumeCard')) renderResume();
}
function updateGuide(me) {
  const g = state.guide; if (!g) return;
  const { o, pts } = g;
  const { d: off, idx } = nearRoute(me, pts);
  if (off < 60 && !g.sim) g.progress = Math.max(g.progress, idx);
  const remain = alongRoute(pts, g.progress, pts.length - 1);
  const ahead = (o.steps || []).find((s) => s.lat != null && pts.findIndex((p) => geoDist(p, s) < 15) > g.progress);
  if (ahead) $('#gStep').textContent = ahead.text;
  const card = $('#guide .guide-card');
  const nextFlood = state.reports.filter((r) => r.status === 'active' && r.severity >= 2).map((r) => ({ r, ...nearRoute(r, pts) }))
    .filter((x) => x.d <= (x.r.radius || 40) + 40 && x.idx >= g.progress).map((x) => ({ ...x, m: alongRoute(pts, g.progress, x.idx) })).sort((a, b) => a.m - b.m)[0];
  card.classList.toggle('alert', Boolean(nextFlood && nextFlood.m < 200));
  $('#gMeta').textContent = nextFlood && nextFlood.m < 200
    ? t('🌊 Flood report {d} m ahead · {s}', { d: Math.round(nextFlood.m), s: sevLabel(nextFlood.r.severity) })
    : off > 60 && !g.sim ? t('Off route by {d} m · {r} to go', { d: Math.round(off), r: km(Math.round(remain)) })
    : `${t('{r} · ~{m} min to go', { r: km(Math.round(remain)), m: Math.max(1, Math.round(remain / 75)) })}${g.sim ? ` · ${t('demo walk')}` : ''}`;
  // tell the server how far along we are (so pushes only cover floods still ahead)
  if (g.watchId && Date.now() - g.synced > 20000) { g.synced = Date.now(); api(`/api/watch/${g.watchId}`, { method: 'POST', body: { progress: g.progress } }).catch(() => {}); }
  if (remain < 25) { $('#gStep').textContent = t('🏁 You have arrived'); try { localStorage.removeItem('fs-trip'); } catch {} setTimeout(stopGuide, 4000); }
}

// Ask for notification permission (only when someone starts walking), subscribe to Web Push, register the route
const b64ToBytes = (b64) => { const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function setupRouteAlerts(g) {
  let mode = 'app';
  try {
    if ('Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window && state.config.pushKey) {
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm === 'granted') {
        const reg = await navigator.serviceWorker.ready;
        const key = b64ToBytes(state.config.pushKey);
        let sub = await reg.pushManager.getSubscription();
        const same = sub?.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).every((b, i) => b === key[i]);
        if (sub && !same) { await sub.unsubscribe(); sub = null; }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const w = await api('/api/watch', { method: 'POST', body: { subscription: sub.toJSON(), coords: g.o.coords, destName: state.destName, durationS: g.o.durationS } });
        if (state.guide !== g) { api(`/api/watch/${w.id}`, { method: 'DELETE' }).catch(() => {}); return; }
        g.watchId = w.id; mode = 'push';
      } else if (perm === 'denied') mode = 'denied';
    }
  } catch (e) { console.warn('push setup', e); }
  const el = $('#gAlerts'); if (!el || state.guide !== g) return;
  el.textContent = { push: t('🔔 Flood alerts on – even with the screen off'), app: t('🔔 Flood alerts while FloodSafe is open'), denied: t('🔕 Notifications blocked – alerts show in the app only') }[mode];
  el.classList.toggle('on', mode === 'push');
}

// New or worse flood on the route ahead → banner + vibration (+ system notification if the app is in the background)
function checkRouteAlerts() {
  const g = state.guide; if (!g) return;
  for (const r of state.reports) {
    if (!(r.status === 'active' || r.status === 'fading') || r.severity < 2) continue;
    const key = `${r.id}:${r.severity}`;
    if (g.alerted.has(key)) continue;
    const { d, idx } = nearRoute(r, g.pts);
    if (d > (r.radius || 40) + 40 || idx < g.progress - 2) continue;
    const worse = [...g.alerted].some((k) => k.startsWith(`${r.id}:`));
    g.alerted.add(key);
    showRouteAlert(r, alongRoute(g.pts, g.progress, idx), worse);
    break;
  }
}
async function showRouteAlert(r, aheadM, worse = false) {
  const el = $('#gAlert'); if (!el) return;
  const ahead = Math.max(10, Math.round(aheadM / 10) * 10);
  const place = L(r.placeHint, r.placeHintZh);
  const title = t(worse ? 'Flooding on your route got worse' : 'New flood reported on your route');
  const body = t('About {m} m ahead: {s}', { m: ahead, s: sevLabel(r.severity) }) + (place ? ` · ${place}` : '');
  el.innerHTML = `<div class="ra-head"><span class="ra-i" aria-hidden="true">🌊</span><b>${esc(title)}</b></div>
    <div class="ra-body">${esc(body)}</div>
    <div class="ra-actions"><button type="button" class="btn primary" id="raGo">↪ ${esc(t('Reroute now'))}</button><button type="button" class="btn" id="raView">${esc(t('View report'))}</button><button type="button" class="x" id="raX" aria-label="${esc(t('Dismiss'))}">✕</button></div>`;
  el.hidden = false;
  const g = state.guide;
  if (g) g.lastAlert = r.id;
  if (g?.sim) g.simPaused = true; // demo walker stops, like a person reading the alert
  $('#raGo').onclick = () => rerouteNow();
  $('#raView').onclick = () => openDetail(r.id);
  $('#raX').onclick = () => { el.hidden = true; if (g) g.simPaused = false; };
  try { navigator.vibrate?.([300, 120, 300, 120, 300]); } catch {}
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    // same tag as the server push, so the phone never shows the same alert twice
    (await navigator.serviceWorker?.ready)?.showNotification(`🌊 ${title}`, { body: `${body}. ${t('Tap to reroute.')}`, tag: `route-${r.id}`, icon: '/icon-192.png', badge: '/icon-192.png',
      data: { url: `/?reroute=1&alert=${encodeURIComponent(r.id)}`, reportId: r.id }, requireInteraction: true, vibrate: [300, 120, 300] });
  }
}
async function rerouteNow(pref) {
  const g = state.guide;
  const sim = Boolean(g?.sim);
  const alertId = g?.lastAlert;
  const from = sim ? state.me : (state.me && inHK(state.me) ? state.me : state.origin);
  if (!from || !state.dest) { toast(t('Choose a destination: search or 🗺️ pick on map')); return; }
  if (pref) {
    state.pref = pref;
    $$('.prefs [data-pref]').forEach((x) => { x.classList.toggle('active', x.dataset.pref === pref); x.setAttribute('aria-checked', String(x.dataset.pref === pref)); });
  }
  setOrigin({ lat: from.lat, lng: from.lng }, t(sim ? 'Current position (demo)' : 'My location'), sim ? 'pin' : 'gps');
  toast(t('Finding a way around the flood…'));
  await findRoute();
  if (!state.lastPlan) return;
  const o = state.lastPlan.options[state.optIndex || 0];
  startGuide(o, { sim });
  const flood = state.reports.find((x) => x.id === alertId);
  toast(!flood || !onRoute(flood, thinRoute(o.coords)) ? t('Rerouted – the new route avoids the flood') : t('Rerouted – check the briefing for remaining water'), 4200);
}
async function simulateFloodAhead() {
  const g = state.guide; if (!g) return;
  const btn = $('#gSim'); busy(btn, true, t('Reporting…'));
  try {
    await api('/api/demo/flood-ahead', { method: 'POST', body: { coords: g.o.coords, progress: g.progress } });
    await refreshReports(); // the in-app check fires straight away; the push arrives in parallel
  } catch (e) { toast(e.message); }
  finally { if ($('#gSim')) busy(btn, false); }
}

// Tapping a push notification: if the app is open, the service worker passes the tap here
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'route-alert') return;
  if (state.guide) rerouteNow(); else resumeTripAfterAlert();
});
// Opened from a notification with the app closed: plan again from here to the saved destination
async function resumeTripAfterAlert() {
  const trip = savedTrip();
  history.replaceState(null, '', location.pathname);
  if (!trip?.dest) return;
  state.pref = trip.pref || state.pref;
  $$('.prefs [data-pref]').forEach((x) => { x.classList.toggle('active', x.dataset.pref === state.pref); x.setAttribute('aria-checked', String(x.dataset.pref === state.pref)); });
  setDest(trip.dest, trip.destName);
  switchTab('route');
  toast(t('Finding a way around the flood…'));
  locate(async (loc) => { if (loc) { setOrigin(loc, t('My location'), 'gps'); await findRoute(); } });
}

// ---------------- sheltered walkways layer ----------------
async function loadShelterLayer() {
  if (!state.map || !state.shelterOn) return;
  const z = state.map.getZoom();
  if (z < 15) { toast(t('Zoom in to see sheltered walkways')); clearShelterLayer(); return; }
  const b = state.map.getBounds(); if (!b) return;
  const ne = b.getNorthEast(), sw = b.getSouthWest();
  try {
    const r = await api(`/api/shelter?minLat=${sw.lat()}&minLng=${sw.lng()}&maxLat=${ne.lat()}&maxLng=${ne.lng()}`);
    clearShelterLayer();
    // LandsD publishes walkways as path centrelines, so draw the actual paths (not areas):
    // a coloured line means "this stretch of the walking path is covered / indoor / a footbridge / a subway".
    const data = state.shelterData = new google.maps.Data({ map: state.map });
    data.addGeoJson({ type: 'FeatureCollection', features: r.lines.map(([c, coords, name, nameZh]) => ({ type: 'Feature', properties: { c, name: L(name, nameZh) }, geometry: { type: 'LineString', coordinates: coords } })) });
    const weight = z >= 18 ? 6 : z >= 17 ? 5 : 4;
    data.setStyle((f) => {
      const cls = r.classes[f.getProperty('c')];
      return { clickable: Boolean(f.getProperty('name')), strokeColor: SHELTER[cls]?.c || '#1e88e5', strokeOpacity: 0.85, strokeWeight: weight, zIndex: 1 };
    });
    data.addListener('click', tapSafe((e) => { const n = e.feature.getProperty('name'); if (n) toast(`${SHELTER[r.classes[e.feature.getProperty('c')]]?.i || '☂️'} ${n}`); }));
  } catch (e) { toast(t('Sheltered walkways unavailable: {e}', { e: e.message })); }
}
function clearShelterLayer() { if (state.shelterData) { state.shelterData.setMap(null); state.shelterData = null; } }
function setShelterLayer(on) {
  state.shelterOn = on;
  $('#shelterToggle').setAttribute('aria-pressed', String(on));
  if (on) loadShelterLayer(); else clearShelterLayer();
}

// ---------------- reporting ----------------
// Reads DateTimeOriginal and GPS from a JPEG's EXIF block (no library). Returns {} when absent –
// many phones strip location from photos shared with a browser, so missing data is never held against anyone.
async function readExif(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off), size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + size;
    }
  } catch {}
  return {};
}
function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le), u32 = (o) => v.getUint32(start + o, le);
  const ifd = (o) => { const n = u16(o), out = {}; for (let i = 0; i < n; i++) { const e = o + 2 + i * 12; out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 }; } return out; };
  const ascii = (e) => { const o = e.count > 4 ? u32(e.at) : e.at; let s = ''; for (let i = 0; i < e.count - 1; i++) s += String.fromCharCode(v.getUint8(start + o + i)); return s; };
  const rats = (e) => { const o = u32(e.at); return [0, 1, 2].slice(0, e.count).map((i) => u32(o + i * 8) / (u32(o + i * 8 + 4) || 1)); };
  const out = {};
  const ifd0 = ifd(u32(4));
  if (ifd0[0x8769]) {
    const ex = ifd(u32(ifd0[0x8769].at));
    const dt = ex[0x9003] || ex[0x9004];
    if (dt) {
      const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(ascii(dt));
      // EXIF time has no zone: phones in Hong Kong write local time (UTC+8)
      if (m) out.takenAt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
    }
  }
  if (ifd0[0x8825]) {
    const g = ifd(u32(ifd0[0x8825].at));
    if (g[2] && g[4]) {
      const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
      const lat = dms(rats(g[2])) * (g[1] && ascii(g[1]) === 'S' ? -1 : 1);
      const lng = dms(rats(g[4])) * (g[3] && ascii(g[3]) === 'W' ? -1 : 1);
      if (lat && lng) { out.lat = Math.round(lat * 1e6) / 1e6; out.lng = Math.round(lng * 1e6) / 1e6; }
    }
  }
  return out;
}
// 64-bit difference hash of the picture: the same photo re-posted elsewhere is caught even after re-compression
function dHash(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 9; c.height = 8;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 9, 8);
      const d = x.getImageData(0, 0, 9, 8).data; let bits = '';
      const g = (i) => d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
      for (let y = 0; y < 8; y++) for (let k = 0; k < 8; k++) bits += g(y * 9 + k) > g(y * 9 + k + 1) ? '1' : '0';
      resolve(BigInt('0b' + bits).toString(16).padStart(16, '0'));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
async function photoEvidence(file, source) {
  const exif = await readExif(file);
  // a photo just taken with the camera has no EXIF on some phones, but its file time is "now"
  if (!exif.takenAt && source === 'camera' && file.lastModified) exif.takenAt = file.lastModified;
  return { ...exif, source };
}

function resizeImage(file, max = 1024, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error(t('Could not read that image')));
    img.src = URL.createObjectURL(file);
  });
}

async function submitReport(skipAi = false, noPhotoOk = false) {
  const btn = $('#reportGo');
  const loc = state.reportLoc || state.origin;
  if (!loc) { toast(t('Set the location (GPS or adjust on map)')); return; }
  if (!state.photo && !noPhotoOk && !skipAi) {
    showDialog({
      title: t('Add a photo?'),
      body: t('A photo lets Gemini check how deep the water is, and neighbours trust photo reports more.'),
      actions: [
        { label: t('📷 Take photo'), primary: true, onClick: () => $('#photoCam').click() },
        { label: t('🖼️ Choose from album'), onClick: () => $('#photoLib').click() },
        { label: t('Post without photo'), onClick: () => submitReport(false, true) },
      ],
    });
    return;
  }
  if (!state.photo && !state.level && !$('#noteInput').value.trim()) { toast(t('Add a photo, water level or note')); return; }
  busy(btn, true, t(state.photo && !skipAi ? 'Gemini is analysing the photo…' : 'Posting…'));
  $('#reportResult').innerHTML = '';
  try {
    const out = await api('/api/reports', {
      method: 'POST',
      body: {
        lat: loc.lat, lng: loc.lng, photo: state.photo, note: $('#noteInput').value.trim(), userLevel: state.level, placeHint: state.reportLocLabel || undefined, skipAi,
        photoMeta: state.photo ? state.photoMeta || {} : {},
        me: state.me && inHK(state.me) ? { lat: state.me.lat, lng: state.me.lng, accuracy: state.me.accuracy } : null,
      },
    });
    const a = out.analysis || {};
    if (out.rejected) {
      const why = {
        old_photo: t('This photo was taken about {h} hours ago. Please send a photo of the water now – old photos can send people the wrong way.', { h: Math.round((out.ageMin || 0) / 60) }),
        photo_far: t("The photo's location is {k} km from the spot you marked. Please move the pin to where the photo was taken.", { k: ((out.distanceM || 0) / 1000).toFixed(1) }),
        duplicate_photo: t('This photo was already used for a report at a different place. Please take a new photo of the water where you are.'),
        not_live_photo: t('Gemini thinks this is not a photo you just took (it looks like a screenshot, a photo of a screen, or a news / stock image). Please take a photo of the water in front of you.'),
      }[out.reason];
      $('#reportResult').innerHTML = `<div class="card warn"><h3>${esc(t('Not posted'))}</h3>${esc(why || t("Gemini didn't see flooding in this photo."))}${!why && a.description_en ? `<div class="ai">${esc(L(a.description_en, a.description_zh))}</div>` : ''}
        ${out.reason !== 'photo_far' ? `<button class="btn primary block" style="margin-top:10px" id="retakePhoto">${esc(t('📷 Take a new photo'))}</button>` : ''}</div>`;
      $('#retakePhoto')?.addEventListener('click', () => $('#photoCam').click());
      return;
    }
    $('#reportResult').innerHTML = `
      <div class="card safe">
        <h3>${esc(t(out.merged ? 'Added to an existing report nearby' : 'Report posted'))}${esc(t(' – thank you!'))}</h3>
        ${sevBadge(a.severity)}
        <div class="ai"><div class="tag">${esc(a.unverified ? t('Not AI-checked · based on your estimate') : t('Gemini assessment · {p}% confident', { p: Math.round((a.confidence || 0) * 100) }))}</div>
          ${esc(L(a.description_en, a.description_zh))}
          <div class="meta" style="margin-top:6px">≈ ${a.estimated_depth_cm} cm · ${esc(t(a.passable_on_foot ? 'passable on foot with care' : 'pedestrians should avoid'))}</div>
        </div>
        ${hazardTags(a)}
        ${evidenceChips({ evidence: out.evidence })}
        ${out.knownRisk?.length ? `<div class="official"><div class="tag">${esc(t('Matches official DSD record'))}</div>${esc(out.knownRisk[0].name)} ${esc(t('({d} m away) – report weighted as more credible.', { d: out.knownRisk[0].distanceM }))}</div>` : ''}
      </div>`;
    resetReportForm();
    await refreshReports();
    state.map?.panTo(loc);
  } catch (e) {
    const canSkip = e.data?.canPostUnverified;
    $('#reportResult').innerHTML = `<div class="card danger"><b>${esc(t(e.status === 503 ? 'Gemini is busy right now' : 'Could not post'))}</b><div class="meta" style="margin-top:4px">${esc(e.message)}</div>
      <div class="vote" style="margin-top:10px"><button class="btn" id="retryReport">${esc(t('↻ Try again'))}</button>
      ${canSkip ? `<button class="btn primary" id="postUnverified">${esc(t('Post without AI check'))}</button>` : ''}</div>
      ${!canSkip && e.status === 503 ? `<div class="meta" style="margin-top:8px">${esc(t('Tip: pick a water level above to be able to post without the AI check.'))}</div>` : ''}</div>`;
    $('#retryReport').onclick = () => submitReport(false, true);
    if (canSkip) $('#postUnverified').onclick = () => submitReport(true, true);
  }
  finally { busy(btn, false); }
}
function setReportPhoto(dataUrl, meta = null) {
  state.photo = dataUrl || null;
  state.photoMeta = dataUrl ? meta : null;
  $('#photoPreview').src = dataUrl || ''; $('#photoPreview').hidden = !dataUrl;
  $('#photoEmpty').hidden = Boolean(dataUrl); $('#photoRemove').hidden = !dataUrl;
  renderResume();
}
// Small modal with up to three actions (used for "Add a photo?")
function showDialog({ title, body, actions }) {
  const d = $('#dialog');
  $('#dialogTitle').textContent = title; $('#dialogBody').textContent = body;
  $('#dialogActions').innerHTML = actions.map((a, i) => `<button type="button" class="btn ${a.primary ? 'primary' : ''} block" data-i="${i}">${esc(a.label)}</button>`).join('');
  const close = () => { d.hidden = true; };
  $$('#dialogActions button').forEach((b) => (b.onclick = () => { close(); actions[+b.dataset.i].onClick?.(); }));
  d.onclick = (e) => { if (e.target === d) close(); };
  d.hidden = false;
  $('#dialogActions button')?.focus();
}
function resetReportForm() {
  state.level = null;
  setReportPhoto(null);
  $('#noteInput').value = '';
  $$('#levelChips button').forEach((b) => b.classList.remove('active'));
  renderResume();
}

// ---------------- shelter ----------------
// Where to look: 'me' = live GPS (never the route's start point), 'dest' = the trip's destination,
// 'place' = any place the user searches for.
const SHELTER_ICON = { subway_station: '🚇', train_station: '🚆', light_rail_station: '🚈', ferry_terminal: '⛴️', shopping_mall: '🛍️', department_store: '🛍️', library: '📚', community_center: '🏛️', sports_complex: '🏟️' };
const SHELTER_BTN = { me: 'Find shelter near me', dest: 'Find shelter near my destination', place: 'Find shelter near this place' };
function setShelterNear(mode, { run = false } = {}) {
  if (mode === 'dest' && !state.dest) mode = 'me';
  state.shelterNear = mode;
  $$('.shelter-near [data-near]').forEach((b) => { const on = b.dataset.near === mode; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
  $('#shelterSearch').hidden = mode !== 'place';
  $('#shelterGo').textContent = t(SHELTER_BTN[mode]);
  if (mode === 'place' && !state.shelterPlace) { $('#shelterInput').focus(); return; }
  if (run) findShelter();
}
function renderShelterNear() {
  const destBtn = $('.shelter-near [data-near="dest"]');
  destBtn.hidden = !state.dest;
  if (state.dest) destBtn.title = state.destName || '';
  if (!state.dest && state.shelterNear === 'dest') setShelterNear('me');
  else setShelterNear(state.shelterNear || 'me');
}
function clearShelterPins() { (state.shelterPins || []).forEach((m) => (m.map = null)); state.shelterPins = []; }
function drawShelterPins(center, shelters) {
  clearShelterPins();
  if (!state.map || !state.Adv) return;
  const c = document.createElement('div'); c.className = 'sh-center';
  state.shelterPins.push(new state.Adv({ map: state.map, position: center, content: c, title: t('Searching around here'), zIndex: 40 }));
  const b = new google.maps.LatLngBounds(center);
  shelters.forEach((s, i) => {
    const el = document.createElement('button'); el.type = 'button'; el.className = `sh-pin${s.floodedNearby ? ' flooded' : ''}`;
    el.innerHTML = `<span>${SHELTER_ICON[s.type] || '🏢'}</span><b>${i + 1}</b>`;
    const m = new state.Adv({ map: state.map, position: s, content: el, title: s.name, zIndex: 45 });
    m.addListener?.('click', tapSafe(() => goToShelter(s)));
    state.shelterPins.push(m);
    if (i < 6) b.extend(s);
  });
  state.map.fitBounds(b, { top: 80, bottom: Math.round(window.innerHeight * 0.5), left: 30, right: 30 });
}
function goToShelter(s) {
  clearShelterPins();
  // walking there from where you are now (GPS) when we know it, otherwise from the trip's start point
  if (state.shelterNear === 'me' && state.shelterFrom) setOrigin(state.shelterFrom, t('My location'), 'gps');
  setDest(s, s.name); switchTab('route'); findRoute();
}
async function findShelter(again) {
  const btn = $('#shelterGo');
  const mode = state.shelterNear || 'me';
  const out = $('#shelterResult');
  const run = async (at, label) => {
    if (!at) { busy(btn, false); return; }
    state.shelterAt = { at, label, mode };
    try {
      const { shelters, radiusM } = await api(`/api/shelters?lat=${at.lat}&lng=${at.lng}`);
      $('#shelterAt').hidden = false;
      $('#shelterAt').textContent = t('Indoor places near: {p}', { p: label });
      if (!shelters.length) { out.innerHTML = `<p class="meta">${esc(t('No indoor public places found within {d}. Try another place.', { d: km(radiusM) }))}</p>`; clearShelterPins(); return; }
      out.innerHTML = `<ul class="list shelter-list">${shelters.map((s, i) => `
        <li data-i="${i}" role="button" tabindex="0"><span><span class="sh-n">${i + 1}</span>${SHELTER_ICON[s.type] || '🏢'} ${esc(s.name)}<small>${esc([s.typeLabel, s.address].filter(Boolean).join(' · '))}</small>${s.floodedNearby ? `<small class="sh-warn">${esc(t('⚠ flooding reported nearby'))}</small>` : ''}</span><b>${km(s.distanceM)}</b></li>`).join('')}</ul>
        <p class="meta">${esc(t('Tap a place for a flood-safe walking route there.'))}</p>`;
      $$('#shelterResult li').forEach((li) => {
        const pick = () => goToShelter(shelters[+li.dataset.i]);
        li.onclick = pick; li.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
      });
      drawShelterPins(at, shelters);
    } catch (e) { out.innerHTML = `<div class="card danger">${esc(e.message)}</div>`; }
    finally { busy(btn, false); }
  };
  if (again === true && state.shelterAt) { busy(btn, true, t('Searching…')); return run(state.shelterAt.at, state.shelterAt.mode === 'me' ? t('My location') : state.shelterAt.label); }
  if (mode === 'place') {
    if (!state.shelterPlace) { $('#shelterInput').focus(); return; }
    busy(btn, true, t('Searching…'));
    return run(state.shelterPlace, state.shelterPlace.name);
  }
  if (mode === 'dest' && state.dest) { busy(btn, true, t('Searching…')); return run(state.dest, state.destName || t('Your destination')); }
  busy(btn, true, t('Finding your location…'));
  locate((loc) => {
    if (!loc) {
      busy(btn, false);
      $('#shelterAt').hidden = true; clearShelterPins();
      out.innerHTML = `<div class="card">${esc(t("Couldn't get your location. Allow location access for this site, or choose \"Near another place\"."))}</div>`;
      return;
    }
    state.shelterFrom = loc;
    btn.innerHTML = `<span class="spinner"></span>${esc(t('Searching…'))}`;
    run(loc, loc.accuracy && loc.accuracy > 150 ? t('My location (±{m} m)', { m: Math.round(loc.accuracy) }) : t('My location'));
  });
}

// ---------------- demo ----------------
function setDemoUI(on) {
  $('#demoToggle').setAttribute('aria-pressed', String(on));
  $('#demoToggle').title = t(on ? 'Demo mode on – tap to turn off' : 'Demo mode');
  $('#demoTrip').hidden = !on;
  renderDemoTrips();
  state.demo = on;
  document.body.classList.toggle('demo-on', on);
}
// Demo trips: three tested showcases (flood avoided / footbridges / both)
function renderDemoTrips() {
  const box = $('#demoTrip'); if (!box || !state.config) return;
  const trips = state.config.demoTrips || [];
  box.innerHTML = `<span class="dt-label">${esc(t('Demo trips'))}</span>${trips.map((x) => `<button type="button" class="dt-chip" data-trip="${esc(x.id)}">${esc(L(x.label, x.labelZh))}</button>`).join('')}`;
  box.querySelectorAll('[data-trip]').forEach((b) => (b.onclick = () => demoTrip(b.dataset.trip)));
}
async function toggleDemo() {
  const on = !state.demo;
  try {
    stopGuide();
    await api('/api/demo', { method: 'POST', body: { active: on } }); // resets this visitor's sandbox
    demoPref.set(on);
    setDemoUI(on);
    toast(t(on ? 'Demo on – only you see the simulated black rainstorm and sample reports' : 'Demo off – back to live data'), 4200);
    // nothing simulated may survive the switch: drop what was built from the other mode, then reload it all
    state.forecast = null; state.briefings = {};
    if (!on && state.dsdAutoDone) { state.dsdAutoDone = false; if (state.dsdOn) setDsd(false); }   // only if demo's signal switched it on
    await Promise.all([refreshReports(), refreshWeather()]);   // also reloads flood-prone spots and an open warnings panel
    if (UMB.data) { try { UMB.ratings = (await api('/api/umbrellas/ratings')).ratings || {}; } catch {} if (UMB.on) drawUmbMarkers(); }
    if (state.shelterAt) findShelter(true);
    if (state.lastPlan && state.origin && state.dest) {
      // the planned route was scored against the other mode's floods and rain: plan it again with the current data
      clearRoute(); state.lastPlan = null;
      await findRoute();
      toast(t(on ? 'Route re-planned with the simulated rainstorm' : 'Route re-planned with live data'), 3200);
    } else if (state.lastPlan) clearTrip();
    if (on && state.map) { state.map.setCenter({ lat: 22.322, lng: 114.18 }); state.map.setZoom(13); }
  } catch (e) { toast(e.message); }
}
function demoTrip(id) {
  const trips = state.config.demoTrips || [state.config.demoTrip];
  const trip = trips.find((x) => x.id === id) || trips[0];
  switchTab('route');
  setOrigin(trip.origin, L(trip.origin.name, trip.origin.nameZh), 'place');
  setDest(trip.destination, L(trip.destination.name, trip.destination.nameZh));
  findRoute();
}

// ---------------- UI wiring ----------------
// The map is the home screen. A tab opens its panel above the tab bar; "Map" closes it again.
// Closing keeps what you entered (trip, route, report draft): the route stays on the map with a small card to
// reopen or clear it, and a dot on the tab shows unfinished work – no "Clear input?" interruption mid-storm.
const panelOpen = () => document.body.classList.contains('panel-open');
const TAB_TITLE = { route: 'Route', report: 'Report', umbrella: 'Umbrella lending', shelter: 'Shelter', ask: 'Ask Me', settings: 'Settings' };
function switchTab(name) {
  if (name !== 'detail' && UMB.sel) { state.umbOpen = null; markUmbSel(null); }
  if (name !== 'detail') { markPlace(null); state.savedLine?.setMap(null); }
  const cur = panelOpen() ? $('.pane.active')?.dataset.pane : null;
  if (name === 'detail') state.prevTab = cur && cur !== 'detail' ? cur : (cur === 'detail' ? state.prevTab : null);
  $$('.tab').forEach((tb) => { const on = tb.dataset.tab === name; tb.classList.toggle('active', on); tb.setAttribute('aria-selected', String(on)); });
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  $('#sheetTitle').textContent = TAB_TITLE[name] ? t(TAB_TITLE[name]) : '';
  if (name === 'detail') {
    // detail pages put "← Back" in the panel header instead of an empty title row
    $('#sheetTitle').innerHTML = `<button type="button" class="link head-back">${esc(t('← Back'))}</button>`;
    $('#sheetTitle .head-back').onclick = () => $('#detailBack')?.click();
  }
  document.body.classList.add('panel-open');
  $('#welcome').hidden = true;
  if (name === 'umbrella') renderUmbrellaTab();
  if (name === 'settings') renderSettings();
  if (name === 'shelter') renderShelterNear(); else clearShelterPins();
  if (name === 'ask') { renderAsk(); if (window.innerWidth < 900) setSheetSize('full'); }
  renderResume();
}
function closePanel() {
  document.body.classList.remove('panel-open');
  $$('.tab').forEach((tb) => { tb.classList.remove('active'); tb.setAttribute('aria-selected', 'false'); });
  $$('.pane').forEach((p) => p.classList.remove('active'));
  state.signalOpen = false;
  renderResume();
}
// Drag the panel up to full screen or down to a peek (phones). Tap the grip to toggle half / full.
const SHEET_SNAPS = ['peek', 'half', 'full'];
function setSheetSize(size) {
  const sh = $('#sheet');
  sh.classList.remove('peek', 'half', 'full');
  sh.classList.add(size);
  sh.style.maxHeight = '';
  state.sheetSize = size;
}
function initSheetDrag() {
  const sh = $('#sheet'), grip = $('#sheetGrip'), head = $('.sheet-head');
  setSheetSize('half');
  let startY = 0, startH = 0, dragging = false, moved = false;
  const heights = () => {
    const vh = window.innerHeight, tb = $('#tabbar').getBoundingClientRect().height;
    return { peek: Math.round(vh * 0.26), half: Math.round(vh * 0.56), full: Math.round(vh - tb - 64) };
  };
  const down = (e) => {
    if (window.innerWidth >= 900 || e.target.closest('.sheet-close, .head-back')) return;
    dragging = true; moved = false; startY = e.clientY; startH = sh.getBoundingClientRect().height;
    head.setPointerCapture?.(e.pointerId);
    sh.style.transition = 'none';
  };
  const move = (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const hs = heights();
    sh.style.maxHeight = `${Math.max(90, Math.min(hs.full, startH + dy))}px`;
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false; sh.style.transition = '';
    if (!moved) { setSheetSize(state.sheetSize === 'full' ? 'half' : 'full'); return; }
    const hs = heights(), h = sh.getBoundingClientRect().height;
    // a quick downward drag from the smallest size goes back to the map
    if (h < hs.peek * 0.7) { setSheetSize('half'); closePanel(); return; }
    const near = SHEET_SNAPS.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a));
    setSheetSize(near);
  };
  head.addEventListener('pointerdown', down);
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', up);
  head.addEventListener('pointercancel', up);
  grip?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheetSize(state.sheetSize === 'full' ? 'half' : 'full'); } });
}

// "← Back" inside a detail page: back to the tab it came from, or to the map
function goBack() { if (state.prevTab) switchTab(state.prevTab); else closePanel(); }

// Route card on the map (panel closed) + dots on tabs that hold unfinished input
function renderResume() {
  const card = $('#resumeCard');
  const plan = state.lastPlan;
  const routeTab = $('.tab[data-tab="route"] .tab-dot'), reportTab = $('.tab[data-tab="report"] .tab-dot');
  if (routeTab) routeTab.hidden = !plan;
  if (reportTab) reportTab.hidden = !(state.photo || state.level || $('#noteInput')?.value.trim());
  const show = Boolean(plan) && !panelOpen() && !state.pick && !state.guide;
  document.body.classList.toggle('has-resume', show);
  if (!show) { card.hidden = true; return; }
  const o = plan.options[state.optIndex || 0] || plan.options[0];
  const avoided = o.avoidedHazardIds.length;
  card.hidden = false;
  card.innerHTML = `<button class="rc-open" id="rcOpen" type="button">
      <span class="rc-i" aria-hidden="true">🧭</span>
      <span class="rc-body"><b>${esc(state.destName || t('Destination'))}</b>
      <small>${esc(t('⏱️ {n} min', { n: mins(o.durationS) }))}${o.shelter ? ` · ${esc(t('☂️ {p}% sheltered', { p: o.shelter.shelteredPct }))}` : ''}${avoided ? ` · ${esc(t('🌊 Avoids {n} flood', { n: avoided }))}` : ''}</small></span>
    </button>
    <button class="rc-x" id="rcClear" type="button" aria-label="${esc(t('Clear route'))}" title="${esc(t('Clear route'))}">×</button>`;
  $('#rcOpen').onclick = () => switchTab('route');
  $('#rcClear').onclick = clearTrip;
}
function clearTrip() {
  stopGuide();
  clearRoute();
  state.lastPlan = null; state.briefings = {};
  $('#routeResult').innerHTML = '';
  state.dest = null; state.destName = ''; state.destSearch?.set(''); state.mapSearch?.set('');
  drawEndpoints();
  renderResume();
  toast(t('Route cleared'));
}

function bindUI() {
  // tapping the open tab again goes back to the map
  $$('.tab').forEach((tb) => (tb.onclick = () => (panelOpen() && tb.classList.contains('active') ? closePanel() : switchTab(tb.dataset.tab))));
  $('#sheetClose').onclick = closePanel;
  initSheetDrag();
  // "Search the map": pick a place -> it becomes the destination and the route is planned straight away
  state.mapSearch = makeSearch({ box: $('#mapSearch'), onPick: (loc, name) => {
    setDest(loc, name);
    state.map?.panTo(loc);
    switchTab('route');
    if (state.origin) findRoute(); else setTimeout(() => $('#originInput').focus(), 200);
  } });
  $('#noteInput').addEventListener('input', () => renderResume());
  state.originSearch = makeSearch({ box: $('#originSearch'), withMyLocation: true, onPick: (loc, name, mode) => setOrigin(loc, name, mode) });
  state.destSearch = makeSearch({ box: $('#destSearchBox'), onPick: (loc, name) => setDest(loc, name) });
  state.originSearch.set(t('My location'));
  $('#swapBtn').onclick = () => {
    const o = [state.origin, state.originName, state.originMode], d = [state.dest, state.destName];
    if (!d[0]) { toast(t('Choose a destination first')); return; }
    setOrigin(d[0], d[1], 'place');
    if (o[0]) setDest(o[0], o[2] === 'gps' ? t('My location') : o[1]); else { state.dest = null; state.destName = ''; state.destSearch.set(''); drawEndpoints(); }
  };
  $('#locateBtn').onclick = locateMe;
  // keep the locate button just above the bottom sheet
  const sheet = $('#sheet'), tabbar = $('#tabbar');
  const syncSheet = () => {
    const tb = Math.round(tabbar.getBoundingClientRect().height);
    const sh = panelOpen() ? Math.round(sheet.getBoundingClientRect().height) : 0;
    const h = window.innerWidth >= 900 ? tb : tb + sh;
    document.documentElement.style.setProperty('--tabbar-h', `${tb}px`);
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
    // hide the locate button when the panel covers most of the screen (phones only)
    $('#locateBtn').classList.toggle('tucked', window.innerWidth < 900 && h > window.innerHeight * 0.6);
  };
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(syncSheet); ro.observe(sheet); ro.observe(tabbar); }
  new MutationObserver(syncSheet).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', syncSheet);
  syncSheet();
  $('#signal').onclick = () => openSignalDetail();
  $('#originPick').onclick = () => startPick('origin');
  $('#destPick').onclick = () => startPick('dest');
  $('#reportPick').onclick = () => startPick('report');
  $('#crosshairOk').onclick = () => applyPick();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.pick) endPick(); });
  $('#crosshairCancel').onclick = endPick;
  // Route preference (Shortest / Balanced / Most covered) – re-plans if a route is showing
  $$('.prefs [data-pref]').forEach((b) => (b.onclick = () => {
    state.pref = b.dataset.pref;
    $$('.prefs [data-pref]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); });
    if (state.lastPlan) findRoute();
  }));
  $('#showShortest').onchange = (e) => { state.showShortest = e.target.checked; if (state.lastPlan) drawRoute(state.lastPlan, state.optIndex || 0, false); };
  $('#routeGo').onclick = findRoute;
  renderDemoTrips();
  // Report photo: camera or album, with a preview and a remove button
  const takePhoto = (source) => async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    try {
      const [dataUrl, meta] = await Promise.all([resizeImage(f), photoEvidence(f, source)]);
      meta.dhash = await dHash(dataUrl);
      setReportPhoto(dataUrl, meta);
      if (meta.takenAt && Date.now() - meta.takenAt > 6 * 3600e3) toast(t('This photo looks older than 6 hours – please take a new one.'), 5000);
    } catch (err) { toast(err.message); }
  };
  $('#photoCam').onchange = takePhoto('camera');
  $('#photoLib').onchange = takePhoto('album');
  $('#photoCamBtn').onclick = () => $('#photoCam').click();
  $('#photoLibBtn').onclick = () => $('#photoLib').click();
  $('#photoRemove').onclick = () => setReportPhoto(null);
  $$('#levelChips button').forEach((b) => (b.onclick = () => {
    const on = !b.classList.contains('active');
    $$('#levelChips button').forEach((x) => x.classList.remove('active'));
    if (on) b.classList.add('active');
    state.level = on ? b.dataset.level : null;
    renderResume();
  }));
  $('#reportGo').onclick = () => submitReport(false);
  $('#shelterGo').onclick = () => findShelter();
  $$('.shelter-near [data-near]').forEach((b) => (b.onclick = () => setShelterNear(b.dataset.near, { run: true })));
  state.shelterSearch = makeSearch({ box: $('#shelterSearch'), onPick: (loc, name) => { state.shelterPlace = { ...loc, name }; setShelterNear('place', { run: true }); } });
  $('#demoToggle').onclick = toggleDemo;
  $('#photoWallBtn').onclick = openPhotoWall;
  $('#settingsBtn').onclick = () => (panelOpen() && $('.pane.active')?.dataset.pane === 'settings' ? closePanel() : switchTab('settings'));
  $('#umbToggle').onclick = () => setUmbLayer(!UMB.on);
  $$('[data-umb]').forEach((b) => (b.onclick = () => setUmbFilter(b.dataset.umb)));
  $('#dsdToggle').onclick = () => setDsd(!state.dsdOn);
  $('#shelterToggle').onclick = () => setShelterLayer(!state.shelterOn);
  // the rain pill shows / hides the rainfall map (warning details stay on the warning icons)
  $('#rainPill').onclick = () => setRain(!state.rainOn);
  // Layers menu
  const menu = $('#layersMenu');
  $('#layersBtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; $('#layersBtn').setAttribute('aria-expanded', String(!menu.hidden)); };
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) { menu.hidden = true; $('#layersBtn').setAttribute('aria-expanded', 'false'); } });
  if (state.map) {
    let idleT = null;
    state.map.addListener('idle', () => { clearTimeout(idleT); idleT = setTimeout(() => { if (state.shelterOn) loadShelterLayer(); if (!state.me) renderRainPill(); }, 400); });
    state.map.addListener('zoom_changed', () => { if (state.rainOn && (state.map.getZoom() >= 13) !== (state.rainLabelMode === 'stations')) drawRainLabels(); });
  }
  $('#langBtn').onclick = () => switchLang(lang === 'zh' ? 'en' : 'zh');
  $('#rainToggle').onclick = () => setRain(!state.rainOn);
}

// ---------------- account: Google sign-in (Firebase Authentication) ----------------
// The Firebase web config comes from /api/config (nothing hard-coded). Signing in lets people share routes and
// rate umbrella stations; everything else works without an account.
const FB_VER = '10.14.1';
let fb = null;
state.user = null;
async function authHeader() {
  const u = fb?.auth?.currentUser;
  if (!u) return {};
  try { return { Authorization: `Bearer ${await u.getIdToken()}` }; } catch { return {}; }
}
async function initAuth() {
  const cfg = state.config?.firebase; if (!cfg) return;
  try {
    const [{ initializeApp }, A] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-auth.js`),
    ]);
    const auth = A.getAuth(initializeApp(cfg));
    fb = { auth, A };
    A.onAuthStateChanged(auth, (u) => {
      state.user = u ? { uid: u.uid, name: u.displayName || u.email, email: u.email, photo: u.photoURL } : null;
      renderAvatar();
      const pane = panelOpen() ? $('.pane.active')?.dataset.pane : null;
      if (pane === 'settings') renderSettings();
      if (pane === 'detail' && state.umbOpen) openUmbrella(state.umbOpen);
      if (state.afterSignIn && u) { const f = state.afterSignIn; state.afterSignIn = null; f(); }
    });
  } catch (e) { console.warn('auth init', e); }
}
async function signIn(then) {
  if (!fb) { toast(t('Sign-in is not available right now')); return; }
  if (then) state.afterSignIn = then;
  const p = new fb.A.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  fb.auth.languageCode = lang === 'zh' ? 'zh-TW' : 'en';
  try { await fb.A.signInWithPopup(fb.auth, p); toast(t('Signed in')); }
  catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return fb.A.signInWithRedirect(fb.auth, p);
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    toast(e.code === 'auth/unauthorized-domain' || e.code === 'auth/configuration-not-found' || e.code === 'auth/operation-not-allowed'
      ? t('Google sign-in is not switched on for this site yet') : e.message, 5000);
  }
}
async function signOut() { if (fb) { await fb.A.signOut(fb.auth); toast(t('Signed out')); } }
function renderAvatar() {
  const a = $('#settingsAvatar'), g = $('#settingsBtn .gear');
  if (!a) return;
  const u = state.user;
  a.hidden = !u; g.style.display = u ? 'none' : '';
  a.innerHTML = u ? (u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer" />` : `<b>${esc((u.name || '?')[0].toUpperCase())}</b>`) : '';
  $('#settingsBtn').setAttribute('aria-label', u ? t('Settings – signed in as {n}', { n: u.name }) : t('Settings and account'));
}
// Asks to sign in first (dialog), then carries on with what the person was doing
function requireSignIn(reason, then) {
  if (state.user) return then();
  if (!state.config?.firebase) { toast(t('Sign-in is not available right now')); return; }
  showDialog({ title: t('Sign in with Google'), body: reason,
    actions: [{ label: `G  ${t('Continue with Google')}`, primary: true, onClick: () => signIn(then) }, { label: t('Not now') }] });
}

// ---------------- settings ----------------

// ---------------- saved routes: kept on the phone so they work with no signal ----------------
// Stored in localStorage (≈ 10–30 KB each). Google map tiles can't be stored, so offline the route is drawn
// as a simple self-made map: the line, start/end, floods known when saved, and turn-by-turn steps.
const SAVED_KEY = 'fs-saved';
function savedRoutes() { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch { return []; } }
function putSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 20))); return true; }
  catch { toast(t('Phone storage is full – delete an older saved route first.')); return false; }
}
function saveRouteOffline(o, plan) {
  const pts = thinRoute(o.coords, 400);
  const floods = state.reports.filter((r) => (r.status === 'active' || r.status === 'fading') && nearRoute(r, pts).d < 300)
    .map((r) => ({ lat: r.lat, lng: r.lng, severity: r.severity, place: r.placeHint || '', placeZh: r.placeHintZh || '', onRoute: nearRoute(r, pts).d < (r.radius || 40) + 20, demo: Boolean(r.demo || r.sandbox) }));
  const dsd = (state.dsd?.blackspots || []).filter((b) => Number.isFinite(b.lat) && nearRoute(b, pts).d < 150).slice(0, 10).map((b) => ({ lat: b.lat, lng: b.lng, name: b.name, nameZh: b.nameZh }));
  const w = state.weather || {};
  const entry = {
    id: Date.now().toString(36), at: Date.now(), originName: state.originName || t('Start'), destName: state.destName || t('End'),
    origin: state.origin, dest: state.dest, coords: pts.map((p) => [p.lng, p.lat]),
    steps: (o.steps || []).map((x) => ({ text: x.text, lat: x.lat, lng: x.lng, distanceM: x.distanceM })),
    distanceM: o.distanceM, durationS: o.durationS, shelteredPct: o.shelter?.shelteredPct ?? null, metres: o.shelter?.metres || null,
    avoided: o.avoidedHazardIds?.length || 0, safe: o.safe, floods, dsd,
    signal: w.signalInfo ? L(w.signalInfo.name, w.signalInfo.zh) : (w.warnings?.[0] ? L(w.warnings[0].name, w.warnings[0].nameZh) : null),
    forecast: plan?.forecast?.hours?.slice(0, 6).map((h) => ({ label: h.label, mm: h.mm, chance: h.chance })) || null,
    briefing: $('#briefing b')?.textContent || null,
  };
  const list = savedRoutes().filter((r) => !(r.destName === entry.destName && r.originName === entry.originName));
  if (putSaved([entry, ...list])) toast(t('Saved for offline ✓ Find it in Settings → Saved for offline.'), 3500);
}
function gpxFor(r) {
  const x = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FloodSafe HK" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${x(`${r.originName} → ${r.destName}`)}</name><time>${new Date(r.at).toISOString()}</time></metadata>
${(r.floods || []).map((f) => `<wpt lat="${f.lat}" lon="${f.lng}"><name>${x(`Flood report – severity ${f.severity}`)}</name><desc>${x(f.place)}</desc></wpt>`).join('\n')}
<trk><name>${x(`${r.originName} → ${r.destName}`)}</name><trkseg>
${r.coords.map(([lng, lat]) => `<trkpt lat="${lat}" lon="${lng}"/>`).join('\n')}
</trkseg></trk></gpx>`;
}
function downloadGpx(r) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpxFor(r)], { type: 'application/gpx+xml' }));
  a.download = `floodsafe-${(r.destName || 'route').replace(/[^\w一-鿿-]+/g, '-').slice(0, 40)}.gpx`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
// a small map drawn by us (no internet needed): route line, start/end, floods
function routeSvg(r, W = 340, H = 220) {
  const pts = r.coords.map(([lng, lat]) => ({ lat, lng }));
  const all = [...pts, ...(r.floods || []), ...(r.dsd || [])];
  const lat0 = Math.min(...all.map((p) => p.lat)), lat1 = Math.max(...all.map((p) => p.lat));
  const lng0 = Math.min(...all.map((p) => p.lng)), lng1 = Math.max(...all.map((p) => p.lng));
  const k = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180), pad = 18;
  const sx = (W - 2 * pad) / Math.max((lng1 - lng0) * k, 1e-6), sy = (H - 2 * pad) / Math.max(lat1 - lat0, 1e-6), sc = Math.min(sx, sy);
  const ox = (W - (lng1 - lng0) * k * sc) / 2, oy = (H - (lat1 - lat0) * sc) / 2;
  const P = (p) => [ox + (p.lng - lng0) * k * sc, H - (oy + (p.lat - lat0) * sc)].map((v) => v.toFixed(1));
  const line = pts.map((p) => P(p).join(',')).join(' ');
  const [sxp, syp] = P(pts[0]), [ex, ey] = P(pts[pts.length - 1]);
  return `<svg class="saved-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Route sketch'))}">
    <rect width="${W}" height="${H}" rx="12" class="sm-bg"/>
    <polyline points="${line}" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${line}" fill="none" stroke="#0a84ff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${(r.dsd || []).map((b) => { const [x, y] = P(b); return `<path d="M${x} ${+y - 7} l7 12 h-14z" fill="#f6b800" stroke="#111" stroke-width="1.2"/>`; }).join('')}
    ${(r.steps || []).filter((x) => x.lat != null).map((x) => { const [a, b] = P(x); return `<circle cx="${a}" cy="${b}" r="2.6" fill="#fff" stroke="#0a84ff" stroke-width="1.5"/>`; }).join('')}
    <circle cx="${sxp}" cy="${syp}" r="7" fill="#1e8e3e" stroke="#fff" stroke-width="2"/><circle cx="${ex}" cy="${ey}" r="7" fill="#c5221f" stroke="#fff" stroke-width="2"/>
    ${(r.floods || []).map((f) => { const [x, y] = P(f); return `<circle cx="${x}" cy="${y}" r="${5 + f.severity}" fill="${f.severity >= 4 ? '#c5221f' : '#f08c2e'}" fill-opacity=".55" stroke="${f.severity >= 4 ? '#c5221f' : '#f08c2e'}" stroke-width="2"/><text x="${x}" y="${+y + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">${f.severity}</text>`; }).join('')}
    <g class="sm-north"><text x="${W - 16}" y="20" text-anchor="middle" font-size="11" font-weight="700">N</text><path d="M${W - 16} 24 l-4 9 h8z"/></g>
    ${(() => { const m = (Math.PI / 180) * 6371000 / sc; const len = [50, 100, 200, 500, 1000, 2000].find((v) => v / m > 40) || 2000; const px = len / m; return `<g class="sm-scale"><path d="M12 ${H - 14} h${px.toFixed(1)}" stroke-width="3"/><text x="12" y="${H - 20}" font-size="10">${len >= 1000 ? len / 1000 + ' km' : len + ' m'}</text></g>`; })()}
  </svg>`;
}
function openSavedRoute(id) {
  const r = savedRoutes().find((x) => x.id === id); if (!r) return;
  state.signalOpen = false; state.reopen = () => openSavedRoute(id);
  const age = Math.round((Date.now() - r.at) / 60000);
  $('#detail').innerHTML = `
    <button class="link" id="detailBack">${esc(t('← Back'))}</button>
    <h3 class="saved-title">${esc(r.originName)} → ${esc(r.destName)}</h3>
    <div class="meta">${esc(t('Saved {ago}', { ago: ago(age) }))} · ${esc(km(r.distanceM))} · ${esc(t('{n} min', { n: mins(r.durationS) }))}${r.shelteredPct != null ? ` · ${esc(t('☂️ {p}% sheltered', { p: r.shelteredPct }))}` : ''}</div>
    ${age > 90 ? `<div class="note">${esc(t('⚠️ Flood info is from when you saved it. Re-check when you have signal.'))}</div>` : ''}
    ${routeSvg(r)}
    <div class="sm-legend"><span><i style="background:#1e8e3e"></i>${esc(t('Start'))}</span><span><i style="background:#c5221f"></i>${esc(t('End'))}</span>${r.floods?.length ? `<span><i style="background:#f08c2e"></i>${esc(t('Flood report'))}</span>` : ''}${r.dsd?.length ? `<span>⚠️ ${esc(t('Flooding blackspot'))}</span>` : ''}</div>
    ${r.signal ? `<p class="meta">${esc(t('When saved: {s}', { s: r.signal }))}</p>` : ''}
    ${r.briefing ? `<div class="ai"><div class="tag">${esc(t('✨ Gemini briefing'))}</div>${esc(r.briefing)}</div>` : ''}
    ${r.floods?.length ? `<h4 class="sec">${esc(t('Floods near this route (when saved)'))}</h4><ul class="saved-floods">${r.floods.map((f) => `<li>${esc(sevLabel(f.severity))}${f.onRoute ? ` · <b>${esc(t('on the route'))}</b>` : ''}${f.place ? ` · ${esc(L(f.place, f.placeZh))}` : ''}${f.demo ? ` · ${esc(t('Simulated'))}` : ''}</li>`).join('')}</ul>` : ''}
    ${r.steps?.length ? `<details class="steps-box" open><summary>${esc(t('🧭 {n} steps', { n: r.steps.length }))}</summary><ol class="steps">${r.steps.map((x) => `<li>${esc(x.text)} <span class="meta">${x.distanceM ? km(x.distanceM) : ''}</span></li>`).join('')}</ol></details>` : ''}
    <div class="saved-actions">
      <button class="btn primary" id="svStart" type="button">▶ ${esc(t('Start walking'))}</button>
      <button class="btn" id="svRecheck" type="button" ${navigator.onLine ? '' : 'disabled'}>🔄 ${esc(t('Re-check now'))}</button>
      <button class="btn" id="svGpx" type="button">⬇️ ${esc(t('Download GPX'))}</button>
    </div>
    <p class="meta">${esc(t('GPX works in offline map apps such as Organic Maps or OsmAnd.'))}</p>`;
  switchTab('detail');
  $('#detailBack').onclick = () => switchTab('settings');
  $('#svGpx').onclick = () => downloadGpx(r);
  $('#svStart').onclick = () => startGuide({ coords: r.coords, steps: r.steps, durationS: r.durationS, distanceM: r.distanceM, safe: r.safe, avoidedHazardIds: [] });
  $('#svRecheck').onclick = () => {
    if (!r.origin || !r.dest) return toast(t('This route has no saved start point'));
    setOrigin(r.origin, r.originName); setDest(r.dest, r.destName); switchTab('route'); findRoute();
  };
  if (state.map) {
    const b = new google.maps.LatLngBounds(); r.coords.forEach(([lng, lat]) => b.extend({ lat, lng }));
    state.savedLine?.setMap(null);
    state.savedLine = new google.maps.Polyline({ map: state.map, path: r.coords.map(([lng, lat]) => ({ lat, lng })), strokeColor: '#0a84ff', strokeWeight: 5, strokeOpacity: 0.8, zIndex: 3 });
    focusOn(b.getCenter().toJSON(), Math.min(16, state.map.getZoom()));
  }
}
function savedSection() {
  const list = savedRoutes();
  return `<section class="set-card"><h4>⬇️ ${esc(t('Saved for offline'))}</h4>
    ${list.length ? `<ul class="sr-list">${list.map((r) => `<li class="sr-item"><button type="button" class="sr-open" data-saved="${esc(r.id)}"><b>${esc(r.originName)} → ${esc(r.destName)}</b>
      <span class="meta">${esc(t('{n} min', { n: mins(r.durationS) }))} · ${esc(km(r.distanceM))}${r.floods?.length ? ` · 🌊 ${r.floods.length}` : ''} · ${esc(ago(Math.round((Date.now() - r.at) / 60000)))}</span></button>
      <button type="button" class="x" data-saved-del="${esc(r.id)}" aria-label="${esc(t('Delete'))}">✕</button></li>`).join('')}</ul>`
      : `<p class="meta">${esc(t('No saved routes yet. Plan a route and tap ⬇️ to keep it on this phone – it works with no signal.'))}</p>`}
  </section>`;
}

async function renderSettings() {
  const u = state.user, el = $('#settingsBody'); if (!el) return;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  el.innerHTML = `${savedSection()}
    <section class="set-card">
      <h4>${esc(t('Account'))}</h4>
      ${u ? `<div class="acct"><span class="acct-ava">${u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer" />` : esc((u.name || '?')[0])}</span>
          <div class="acct-who"><b>${esc(u.name || '')}</b><span class="meta">${esc(u.email || '')}</span></div>
          <button class="btn small" id="setSignOut" type="button">${esc(t('Sign out'))}</button></div>`
        : `<p class="meta">${esc(t('Sign in to share routes with friends and rate umbrella stations. Everything else works without an account.'))}</p>
           <button class="btn google-btn block" id="setSignIn" type="button" ${state.config?.firebase ? '' : 'disabled'}><span class="g-logo" aria-hidden="true">G</span>${esc(t('Continue with Google'))}</button>`}
    </section>
    ${u ? `<section class="set-card"><h4>${esc(t('My shared routes'))}</h4><div id="myRoutes" class="meta">${esc(t('Loading…'))}</div></section>` : ''}
    <section class="set-card"><h4>${esc(t('Routes shared by the community'))}</h4><div id="communityRoutes" class="meta">${esc(t('Loading…'))}</div></section>
    <section class="set-card">
      <h4>${esc(t('Preferences'))}</h4>
      <div class="set-row"><span>${esc(t('Language'))}</span><div class="seg"><button type="button" data-setlang="en" class="${lang === 'en' ? 'on' : ''}">English</button><button type="button" data-setlang="zh" class="${lang === 'zh' ? 'on' : ''}">繁體中文</button></div></div>
      <div class="set-row"><span>${esc(t('Appearance'))}</span><div class="seg">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-settheme="${k}" class="${themePref === k ? 'on' : ''}">${esc(t(l))}</button>`).join('')}</div></div>
      <div class="set-row"><span>${esc(t('Demo mode (only on this device)'))}</span><button type="button" class="switch" id="setDemo" role="switch" aria-checked="${state.demo}"><i></i></button></div>
      <div class="set-row"><span>${esc(t('Flood alerts while walking'))}</span><span class="meta">${esc(t({ granted: 'On', denied: 'Blocked in browser settings', default: 'Asked when you press Start', unsupported: 'In-app only on this browser' }[perm]))}</span></div>
    </section>
    <section class="set-card">
      <h4>${esc(t('Data sources'))}</h4>
      <ul class="src-list">
        <li>${esc(t('Hong Kong Observatory – warnings, 15-minute rainfall'))}</li>
        <li>${esc(t('Drainage Services Department – flood-prone spots'))}</li>
        <li>${esc(t('Lands Department – 3D pedestrian network'))}</li>
        <li>${esc(t('Google Maps Platform – maps, walking routes, places, weather'))}</li>
        <li>${esc(t('Gemini – photo checks, translations, route briefings'))}</li>
        <li>${esc(t('Community umbrella-lending map (2025香港借遮地圖)'))}</li>
      </ul>
    </section>`;
  $$('#settingsBody [data-saved]').forEach((b) => (b.onclick = () => openSavedRoute(b.dataset.saved)));
  $$('#settingsBody [data-saved-del]').forEach((b) => (b.onclick = () => { putSaved(savedRoutes().filter((r) => r.id !== b.dataset.savedDel)); renderSettings(); }));
  $('#setSignIn')?.addEventListener('click', () => signIn());
  $('#setSignOut')?.addEventListener('click', signOut);
  $('#setDemo').onclick = () => toggleDemo().then(() => renderSettings());
  $$('[data-settheme]').forEach((b) => (b.onclick = () => { if (b.dataset.settheme !== themePref) setTheme(b.dataset.settheme); }));
  $$('[data-setlang]').forEach((b) => (b.onclick = () => { if (b.dataset.setlang !== lang) { switchLang(b.dataset.setlang); renderSettings(); } }));
  const item = (r, mine) => `<li class="sr-item">
      <button type="button" class="sr-open" data-open="${esc(r.id)}"><b>${esc(r.originName || t('Start'))} → ${esc(r.destName || t('End'))}</b>
      <span class="meta">${r.minutes ? esc(t('{n} min', { n: r.minutes })) + ' · ' : ''}${r.shelteredPct != null ? esc(t('☂️ {p}% sheltered', { p: r.shelteredPct })) + ' · ' : ''}${mine ? '' : esc(r.name || '') + ' · '}${esc(ago(Math.round((Date.now() - r.at) / 60000)))}</span>
      ${r.note ? `<span class="sr-note">“${esc(r.note)}”</span>` : ''}</button>
      ${mine ? `<button type="button" class="x" data-del="${esc(r.id)}" aria-label="${esc(t('Delete'))}">✕</button>` : ''}</li>`;
  const fill = (box, routes, mine) => {
    if (!box) return;
    box.innerHTML = routes.length ? `<ul class="sr-list">${routes.map((r) => item(r, mine)).join('')}</ul>` : esc(t(mine ? 'You have not shared any routes yet. Plan a route and tap 🔗 Share.' : 'No shared routes yet.'));
    box.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openSharedRoute(b.dataset.open)));
    box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { try { await api(`/api/routes/shared/${b.dataset.del}`, { method: 'DELETE' }); renderSettings(); } catch (e) { toast(e.message); } }));
  };
  if (state.offline || !navigator.onLine) { ['#communityRoutes', '#myRoutes'].forEach((q) => { const b = $(q); if (b) b.textContent = t('Needs internet'); }); return; }
  api('/api/routes/shared').then((d) => fill($('#communityRoutes'), d.routes, false)).catch(() => fill($('#communityRoutes'), [], false));
  if (u) api('/api/routes/shared?mine=1').then((d) => fill($('#myRoutes'), d.routes, true)).catch((e) => { const b = $('#myRoutes'); if (b) b.textContent = e.message; });
}

// ---------------- share a route ----------------
function shareRoute(o) {
  requireSignIn(t('Sign in with Google to share this route. Friends who open the link get it re-planned around the latest floods.'), async () => {
    const btn = $('#shareRoute');
    try {
      if (btn) busy(btn, true, '');
      const { route } = await api('/api/routes/share', { method: 'POST', body: {
        origin: state.origin, destination: state.dest, originName: state.originName, destName: state.destName, pref: state.pref,
        minutes: Math.round(o.durationS / 60), shelteredPct: o.shelter?.shelteredPct ?? null } });
      const url = `${location.origin}/?share=${route.id}`;
      const text = t('My flood-safe walk: {a} → {b} (FloodSafe HK)', { a: state.originName, b: state.destName });
      if (navigator.share) { try { await navigator.share({ title: 'FloodSafe HK', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(url); toast(t('Link copied – paste it to share'), 4000); }
      catch { showDialog({ title: t('Share this route'), body: url, actions: [{ label: t('Done'), primary: true }] }); }
    } catch (e) { toast(e.message); }
    finally { if (btn && document.body.contains(btn)) busy(btn, false); }
  });
}
async function openSharedRoute(id) {
  try {
    const { route } = await api(`/api/routes/shared/${encodeURIComponent(id)}`);
    if (new URLSearchParams(location.search).has('share')) history.replaceState(null, '', location.pathname);
    state.pref = route.pref;
    $$('.prefs [data-pref]').forEach((x) => { x.classList.toggle('active', x.dataset.pref === route.pref); x.setAttribute('aria-checked', String(x.dataset.pref === route.pref)); });
    setOrigin(route.origin, route.originName || t('Start'), 'place');
    setDest(route.destination, route.destName || t('End'));
    switchTab('route');
    state.sharedRoute = route;
    await findRoute();
    toast(t('Shared by {n} – re-planned with live flood data', { n: route.name || '' }), 4500);
  } catch (e) { toast(e.message, 4500); }
}

// ---------------- umbrella lending (community map) ----------------
const UMB = { data: null, ratings: {}, markers: [], on: false, filter: 'all' };
const OPEN_TO_ALL = /任何人|公眾|街坊/;
const umbOpen = (s) => OPEN_TO_ALL.test(s.eligibility);
const umbName = (s) => (lang === 'zh' ? s.name : s.nameEn || s.name);
async function loadUmbrellas() {
  if (!UMB.data) UMB.data = await fetch('/umbrellas.json').then((r) => r.json());
  try { UMB.ratings = (await api('/api/umbrellas/ratings')).ratings || {}; } catch {}
  return UMB.data;
}
const umbVisible = () => (UMB.data?.stations || []).filter((s) => UMB.filter === 'all' || (UMB.filter === 'open' ? umbOpen(s) : !umbOpen(s)));
const UMB_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9Zm0 9v6.5a2 2 0 0 1-4 0" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Two kinds of station: teal = anyone can borrow (free or with a deposit), grey = customers / members only.
// A small filter on the map (shown while the layer is on) and the chips in the Umbrella panel stay in sync.
function setUmbFilter(f) {
  UMB.filter = f;
  $$('[data-umb]').forEach((x) => { x.classList.toggle('active', x.dataset.umb === f); x.setAttribute('aria-checked', String(x.dataset.umb === f)); });
  if (UMB.on) drawUmbMarkers();
  if (panelOpen() && $('.pane.active')?.dataset.pane === 'umbrella') renderUmbrellaTab();
}
function renderUmbMapFilter() {
  let el = $('#umbMapFilter');
  if (!el) { el = document.createElement('div'); el.id = 'umbMapFilter'; el.className = 'umb-mapfilter'; el.setAttribute('role', 'radiogroup'); document.body.appendChild(el); }
  el.hidden = !UMB.on;
  el.setAttribute('aria-label', t('Umbrella stations'));
  el.innerHTML = [['all', '', t('All')], ['open', 'open', t('Anyone')], ['customers', 'cust', t('Members')]]
    .map(([f, dot, label]) => `<button type="button" role="radio" data-umbmap="${f}" aria-checked="${UMB.filter === f}" class="${UMB.filter === f ? 'on' : ''}">${dot ? `<i class="ud ${dot}"></i>` : '☂'} ${esc(label)}</button>`).join('');
  el.querySelectorAll('[data-umbmap]').forEach((b) => (b.onclick = () => setUmbFilter(b.dataset.umbmap)));
  document.body.classList.toggle('umb-on', UMB.on);
  placeUmbFilter();
}
// beside the rainfall chip (which drops its station name while the umbrella layer is on, to make room)
function placeUmbFilter() {
  const el = $('#umbMapFilter'), rain = $('#rainPill');
  if (!el || el.hidden) return;
  requestAnimationFrame(() => {
    const r = rain && !rain.hidden ? rain.getBoundingClientRect() : null;
    if (window.innerWidth >= 900 || !r || !r.width) { el.style.left = ''; el.style.top = ''; return; }
    const left = r.right + 8;
    if (left + el.offsetWidth <= window.innerWidth - 8) { el.style.left = `${left}px`; el.style.top = `${r.top + (r.height - el.offsetHeight) / 2}px`; }
    else { el.style.left = '12px'; el.style.top = `${r.bottom + 8}px`; }
  });
}
window.addEventListener('resize', () => placeUmbFilter());
function clearUmbMarkers() { UMB.markers.forEach((m) => (m.map = null)); UMB.markers = []; }
function drawUmbMarkers() {
  clearUmbMarkers();
  renderUmbMapFilter();
  if (!UMB.on || !state.map || !UMB.data) return;
  for (const s of umbVisible()) {
    const el = document.createElement('div');
    el.className = `umb-pin${umbOpen(s) ? ' open' : ''}`; el.innerHTML = UMB_SVG;
    const m = new state.Adv({ map: state.map, position: s, content: el, title: `☂ ${umbName(s)}`, zIndex: 15 });
    m.addListener('click', tapSafe(() => openUmbrella(s.id)));
    UMB.markers.push(m);
  }
}
function markUmbSel(st) {
  if (UMB.sel) { UMB.sel.map = null; UMB.sel = null; }
  if (!st || !state.map) return;
  const el = document.createElement('div');
  el.className = `umb-pin sel${umbOpen(st) ? ' open' : ''}`; el.innerHTML = UMB_SVG;
  UMB.sel = new state.Adv({ map: state.map, position: st, content: el, title: `☂ ${umbName(st)}`, zIndex: 40 });
}
async function setUmbLayer(on) {
  UMB.on = on;
  $('#umbToggle')?.setAttribute('aria-pressed', String(on));
  if (on) { try { await loadUmbrellas(); } catch (e) { toast(e.message); return; } }
  drawUmbMarkers();
}
const stars = (avg) => '★★★★★'.slice(0, Math.round(avg)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(avg));
async function renderUmbrellaTab() {
  const box = $('#umbList');
  box.innerHTML = '<div class="skeleton"><span></span><span></span><span></span></div>';
  try { await setUmbLayer(true); } catch {}
  if (!UMB.data) { box.innerHTML = `<div class="card danger">${esc(t('Could not load umbrella stations'))}</div>`; return; }
  const from = state.me && inHK(state.me) ? state.me : (state.map ? { lat: state.map.getCenter().lat(), lng: state.map.getCenter().lng() } : HK_CENTER);
  const list = umbVisible().map((s) => ({ s, d: geoDist(from, s) })).sort((a, b) => a.d - b.d).slice(0, 12);
  box.innerHTML = `<div class="field-label">${esc(t(state.me && inHK(state.me) ? 'Nearest to you' : 'Nearest to the map centre'))}</div>
    <ul class="umb-list">${list.map(({ s, d }) => { const r = UMB.ratings[s.id]; return `<li><button type="button" class="umb-item" data-umb-id="${esc(s.id)}">
      <span class="umb-ic ${umbOpen(s) ? 'open' : ''}">${UMB_SVG}</span>
      <span class="umb-txt"><b>${esc(umbName(s))}</b><span class="meta">${esc(km(Math.round(d)))} · ${esc(L(s.categoryEn || s.category, s.category))} · ${esc(umbOpen(s) ? t('Anyone can borrow') : L(s.eligibilityEn || s.eligibility, s.eligibility))}</span></span>
      ${r ? `<span class="umb-rate" aria-label="${esc(t('{a} out of 5 from {n} ratings', { a: r.avg, n: r.count }))}">★ ${r.avg}<small>(${r.count})</small></span>` : ''}</button></li>`; }).join('')}</ul>`;
  box.querySelectorAll('[data-umb-id]').forEach((b) => (b.onclick = () => openUmbrella(b.dataset.umbId)));
  $('#umbSource').innerHTML = `${esc(t('Source:'))} <a href="${esc(UMB.data.source)}" target="_blank" rel="noopener">${esc(UMB.data.title)}</a> · ${esc(t('{n} stations', { n: UMB.data.stations.length }))} · ${esc(t('SF Express points left out: the source says that service ended in late 2025.'))}`;
}
async function openUmbrella(id) {
  if (!UMB.data) await loadUmbrellas();
  const s = UMB.data.stations.find((x) => x.id === id); if (!s) return;
  state.umbOpen = id; state.signalOpen = false;
  state.reopen = () => openUmbrella(id);
  const r = UMB.ratings[s.id];
  const field = (label, en, zh) => (zh && zh !== '/' ? `<div class="umb-field"><span class="uf-l">${esc(label)}</span><span class="uf-v">${esc(lang === 'zh' ? zh : en || zh).replace(/\n/g, '<br>')}</span></div>` : '');
  $('#detail').innerHTML = `
    <button class="link" id="detailBack">${esc(t('← Back'))}</button>
    <div class="umb-head"><span class="umb-ic big ${umbOpen(s) ? 'open' : ''}">${UMB_SVG}</span><div><h3>${esc(umbName(s))}</h3>${lang !== 'zh' && s.nameEn && s.nameEn !== s.name ? `<div class="meta">${esc(s.name)}</div>` : ''}</div></div>
    <div class="umb-actions"><button class="btn primary" id="umbRoute" type="button">🧭 ${esc(t('Route here'))}</button>${s.link ? `<a class="btn" href="${esc(s.link)}" target="_blank" rel="noopener">↗ ${esc(t('Website'))}</a>` : ''}</div>
    <div class="umb-badges"><span class="badge">${esc(L(s.categoryEn || s.category, s.category))}</span><span class="badge ${umbOpen(s) ? 'good' : ''}">${esc(umbOpen(s) ? t('Anyone can borrow') : L(s.eligibilityEn || s.eligibility, s.eligibility))}</span>
      ${r ? `<span class="badge star">★ ${r.avg} · ${esc(t('{n} ratings', { n: r.count }))}</span>` : ''}</div>
    <section class="umb-desc">
      <div class="tag">${esc(t(s.source247 ? 'Service details · from 24/7 Fitness' : s.sourceKmb ? 'Service details · from KMB (via U Lifestyle)' : 'Service details · from the community map'))}</div>
      ${field(L('Category', '類別'), s.categoryEn, s.category)}
      ${field(L('Who can borrow', '使用者範圍'), s.eligibilityEn, s.eligibility)}
      ${field(L('Service', '內容'), s.serviceEn, s.service)}
      ${field(L('Conditions', '限制及相關資訊'), s.termsEn, s.terms)}
      ${field(L('Location', '地點'), null, s.address)}
      ${s.link ? `<div class="umb-field"><span class="uf-l">Link</span><span class="uf-v"><a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.link)}</a></span></div>` : ''}
      ${lang !== 'zh' ? `<details class="umb-orig"><summary>${esc(t('Original text (Chinese)'))}</summary>
        <p>類別: ${esc(s.category)}<br>使用者範圍: ${esc(s.eligibility)}<br>內容: ${esc(s.service)}<br>限制及相關資訊: ${esc(s.terms).replace(/\n/g, '<br>')}<br>地點: ${esc(s.address)}</p>
        <p class="meta">${esc(t('English translated by Gemini.'))}</p></details>` : ''}
      ${s.approx ? `<p class="meta">${esc(t('📍 Map position is approximate – check the address.'))}</p>` : ''}
      <p class="meta">${esc(t('Services change – check with the venue before relying on it.'))} ${s.source247 ? `<a href="https://247.fitness/" target="_blank" rel="noopener">24/7 Fitness</a>` : s.sourceKmb ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">U Lifestyle · 九巴借遮</a>` : `<a href="${esc(UMB.data.source)}" target="_blank" rel="noopener">${esc(UMB.data.title)}</a>`}</p>
    </section>
    <section class="action-card" id="umbRateBox"><h4>${esc(t('Ratings'))}</h4><div class="meta">${esc(t('Loading…'))}</div></section>`;
  switchTab('detail');
  state.prevTab = 'umbrella'; // Back = the list of nearby stations, even when opened from a map pin
  $('#detailBack').onclick = () => { state.umbOpen = null; markUmbSel(null); goBack(); };
  $('#umbRoute').onclick = () => routeToUmbrella(s);
  markUmbSel(s);
  focusOn(s, 16);
  loadUmbReviews(s);
}
async function loadUmbReviews(s) {
  const box = $('#umbRateBox'); if (!box) return;
  let data = { reviews: [], mine: null };
  try { data = await api(`/api/umbrellas/${s.id}/reviews`); } catch {}
  if (state.umbOpen !== s.id || !document.body.contains(box)) return;
  const mine = data.mine;
  box.innerHTML = `<h4>${esc(t('Ratings'))}</h4>
    ${state.user ? `<div class="rate-form">
        <div class="star-input" role="radiogroup" aria-label="${esc(t('Your rating'))}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" data-star="${n}" aria-checked="${mine?.stars === n}" aria-label="${n}" class="${mine && n <= mine.stars ? 'on' : ''}">★</button>`).join('')}</div>
        <textarea id="umbComment" maxlength="280" rows="2" placeholder="${esc(t('Optional: was the umbrella available? Any tips?'))}">${esc(mine?.comment || '')}</textarea>
        <button class="btn primary block" id="umbSave" type="button">${esc(t(mine ? 'Update my rating' : 'Post rating'))}</button></div>`
      : `<p class="meta">${esc(t('Borrowed here? Sign in to rate it and help others.'))}</p><button class="btn google-btn block" id="umbSignIn" type="button"><span class="g-logo" aria-hidden="true">G</span>${esc(t('Continue with Google'))}</button>`}
    ${data.reviews.length ? `<ul class="reviews">${data.reviews.map((v) => `<li><span class="rv-stars" aria-label="${v.stars}/5">${stars(v.stars)}</span> <b>${esc(v.name || '')}</b> <span class="meta">${esc(ago(Math.round((Date.now() - v.at) / 60000)))}</span>${v.sample ? ` <span class="badge sample">${esc(t('Sample · demo'))}</span>` : ''}
        ${v.comment ? `<div>${esc(L(v.comment, v.commentZh))}</div>` : ''}${v.photo ? `<img class="rv-photo" src="${esc(v.photo)}" alt="${esc(t('Illustration: a person holding a borrowed umbrella'))}" loading="lazy" />` : ''}</li>`).join('')}</ul>` : `<p class="meta">${esc(t('No ratings yet – be the first.'))}</p>`}`;
  let chosen = mine?.stars || 0;
  box.querySelectorAll('[data-star]').forEach((b) => (b.onclick = () => {
    chosen = +b.dataset.star;
    box.querySelectorAll('[data-star]').forEach((x) => { x.classList.toggle('on', +x.dataset.star <= chosen); x.setAttribute('aria-checked', String(+x.dataset.star === chosen)); });
  }));
  $('#umbSignIn')?.addEventListener('click', () => signIn(() => openUmbrella(s.id)));
  $('#umbSave')?.addEventListener('click', async () => {
    if (!chosen) { toast(t('Tap the stars to choose 1 to 5')); return; }
    const btn = $('#umbSave'); busy(btn, true, '');
    try {
      await api(`/api/umbrellas/${s.id}/rate`, { method: 'POST', body: { stars: chosen, comment: $('#umbComment').value } });
      toast(t('Thanks for rating!'));
      try { UMB.ratings = (await api('/api/umbrellas/ratings')).ratings || {}; } catch {}
      openUmbrella(s.id);
    } catch (e) { toast(e.message); busy(btn, false); }
  });
}
function routeToUmbrella(s) {
  setDest({ lat: s.lat, lng: s.lng }, `☂ ${umbName(s)}`);
  if (!state.origin && state.me && inHK(state.me)) setOrigin(state.me, t('My location'), 'gps');
  state.umbOpen = null;
  switchTab('route');
  if (state.origin) findRoute();
  else { toast(t('Choose a start point: search, “My current location”, or 🗺️ pick on map')); locate((loc) => { if (loc) findRoute(); }); }
}

// ---------------- Ask Me: Gemini assistant (server keeps it to FloodSafe topics and the app's own data) ----------------
const ASK = { log: (() => { try { return JSON.parse(sessionStorage.getItem('fs-ask') || '[]'); } catch { return []; } })(), busy: false };
const ASK_SUGGEST = [
  'Where can I borrow an umbrella near me at 7pm on Saturday?',
  'Which umbrella stations near Mong Kok can anyone use without membership?',
  'Which number do I call to report a blocked drain or street flooding?',
  'Are there any flood reports near me right now?',
  'Will it keep raining in the next few hours?',
  'What does the Black Rainstorm signal mean if I have to walk?',
  'How do I report a flood with a photo?',
  'I want to report another issue (wrong umbrella info, app problem…)',
];
function saveAsk() { try { sessionStorage.setItem('fs-ask', JSON.stringify(ASK.log.slice(-20))); } catch {} }
// tiny, safe markdown: escape first, then **bold**, "- " lists and line breaks
function askMd(text) {
  const lines = esc(text).split('\n');
  let html = '', list = false;
  for (const raw of lines) {
    const ln = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)/.exec(ln);
    if (m) { if (!list) { html += '<ul>'; list = true; } html += `<li>${m[1]}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (ln.trim()) html += `<p>${ln}</p>`;
  }
  return html + (list ? '</ul>' : '');
}
function renderAsk() {
  const log = $('#askLog'); if (!log) return;
  const intro = `<div class="ask-msg bot"><p>${esc(t('Hi! I can answer questions about FloodSafe HK: umbrella lending, flood reports, rain and warnings, hotlines, and how to use the app.'))}</p><p class="meta">${esc(t('Answers by Gemini from the app\'s own data. In an emergency call 999.'))}</p></div>`;
  const msgs = ASK.log.map((m, i) => `<div class="ask-msg ${m.role === 'user' ? 'me' : 'bot'}">${m.role === 'user' ? `<p>${esc(m.text)}</p>` : askMd(m.text)}
    ${m.refs?.length ? `<div class="ask-refs">${m.refs.map((r, j) => `<button type="button" class="chip-f" data-ask-ref="${i}:${j}">${r.kind === 'umbrella' ? '☂️' : '🌊'} ${esc(r.name)}${r.distanceM != null ? ` · ${esc(km(r.distanceM))}` : ''}</button>`).join('')}</div>` : ''}</div>`).join('');
  const sugg = `<div class="ask-sugg"><div class="field-label ask-sugg-head">${esc(t(ASK.log.length ? 'More questions' : 'Try asking'))}${ASK.log.length ? `<button type="button" class="link ask-clear" id="askClear">${esc(t('Clear chat'))}</button>` : ''}</div>${ASK_SUGGEST.filter((q) => !ASK.log.some((m) => m.text === t(q))).slice(0, ASK.log.length ? 3 : 8)
    .map((q) => `<button type="button" class="ask-q" data-ask-q="${esc(t(q))}">${esc(t(q))}</button>`).join('')}</div>`;
  log.innerHTML = intro + msgs + (ASK.busy ? `<div class="ask-msg bot typing"><span></span><span></span><span></span></div>` : '') + (ASK.busy ? '' : sugg);
  log.querySelectorAll('[data-ask-q]').forEach((b) => (b.onclick = () => askSend(b.dataset.askQ)));
  log.querySelectorAll('[data-ask-ref]').forEach((b) => (b.onclick = () => {
    const [i, j] = b.dataset.askRef.split(':').map(Number); const r = ASK.log[i]?.refs?.[j]; if (!r) return;
    if (r.kind === 'umbrella') openUmbrella(r.id);
    else if (state.reports.some((x) => x.id === r.id)) openDetail(r.id); else focusOn(r, 16);
  }));
  $('#askClear')?.addEventListener('click', () => { ASK.log = []; saveAsk(); renderAsk(); });
  const form = $('#askForm');
  if (!form.dataset.bound) {
    form.dataset.bound = '1';
    form.onsubmit = (e) => { e.preventDefault(); const v = $('#askInput').value.trim(); if (v) askSend(v); };
  }
  $('#askSend').disabled = ASK.busy;
  requestAnimationFrame(() => log.lastElementChild?.scrollIntoView({ block: 'end' }));
}
async function askSend(text) {
  if (ASK.busy) return;
  ASK.log.push({ role: 'user', text: text.slice(0, 500) });
  $('#askInput').value = '';
  ASK.busy = true; renderAsk();
  const here = state.me && inHK(state.me) ? { ...state.me, label: t('your location') }
    : state.map ? { lat: state.map.getCenter().lat(), lng: state.map.getCenter().lng(), label: t('the map centre') } : null;
  try {
    const r = await api('/api/chat', { method: 'POST', body: {
      messages: ASK.log.slice(-10).map(({ role, text: x }) => ({ role, text: x })),
      lat: here?.lat, lng: here?.lng, atLabel: here?.label } });
    ASK.log.push({ role: 'model', text: r.reply, refs: r.refs || [] });
  } catch (e) {
    ASK.log.push({ role: 'model', text: `⚠️ ${e.message || t('Something went wrong – please try again.')}` });
  }
  ASK.busy = false; saveAsk(); renderAsk();
}

// EN ⇄ 繁中: re-render everything in place (no reload); a planned route is re-planned so steps come back translated
function switchLang(l) {
  setLang(l);
  if (state.originMode === 'gps') setOriginField(t('My location'), 'gps');
  if (state.reportLocSource === 'gps') setReportLoc(t('Using your GPS'), null);

  if (state.pick) { $('#pickKind').textContent = t(PICK_TEXT[state.pick]); updatePickAddress(); }
  setDemoUI(state.demo);
  drawEndpoints();
  renderAvatar();
  if (UMB.on) drawUmbMarkers();
  if (state.lastPlan) drawRouteBubbles(state.lastPlan, state.optIndex || 0);
  if (state.weather) { renderWarnStrip(state.weather); renderRainPill(); renderAdvisory(state.weather); renderWelcome(); }
  if (state.rainOn) renderRainLegend();
  if (state.shelterOn) loadShelterLayer();
  if (state.dsdOn) drawDsd();
  if ($('.pane.active')?.dataset.pane === 'detail') state.reopen?.();
  $('#shelterGo').textContent = t(SHELTER_BTN[state.shelterNear || 'me']);
  if (state.shelterAt) findShelter(true);
  if ($('.pane.active')?.dataset.pane === 'ask') renderAsk();
  if (state.lastPlan) findRoute();
  toast(l === 'zh' ? '已切換至繁體中文' : 'Switched to English', 1800);
}

boot().catch((e) => { console.error(e); toast(e.message, 6000); });

// Test hook: open the app with ?debug to inspect state from the console
if (new URLSearchParams(location.search).has('debug')) window.__fs = { state, stopGuide, selectOption, askSend, openPlace, setOrigin, setDest, findRoute, switchTab, demoTrip, startGuide, simulateFloodAhead, openPhotoWall, setSheetSize, openSavedRoute, saveRouteOffline, renderPlan, openSignalDetail, UMB, openUmbrella, openSharedRoute, openDetail, focusOn };

// Installable web app (Add to Home Screen)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW', e)));
}
