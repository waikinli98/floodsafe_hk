import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import * as store from './src/store.js';
import * as gemini from './src/gemini.js';
import { planRoute, routingEnabled } from './src/routing.js';
import { liveWeather, demoWeather, SIGNAL_INFO, withIcons } from './src/hko.js';
import { decorate, routingHazards, setDryFade, isDryFade } from './src/hazards.js';
import { forecastAt, demoForecast, recentRain, weatherEnabled } from './src/gweather.js';
import { shelterIndex, shelterLines, CLASSES as SHELTER_CLASSES } from './src/shelter.js';
import { findShelters, autocomplete, placeDetails, placeInfo, findPlace, reverseGeocode } from './src/places.js';
import { createChat } from './src/chat.js';
import { demoReports, DEMO_TRIP, DEMO_TRIPS } from './src/demo.js';
import { haversine, inHongKong } from './src/geo.js';
import * as dsd from './src/dsd.js';
import * as abuse from './src/abuse.js';
import * as push from './src/push.js';
import { userOf, publicConfig } from './src/auth.js';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '12mb' }));
app.get('/sw.js', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'sw.js')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

// UI language from the client (?lang=zh for Traditional Chinese)
const langOf = (req) => (req.query.lang === 'zh' ? 'zh' : 'en');
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status || e.status >= 500) console.error(e);
  res.status(e.status || 500).json({ error: e.publicMessage || e.message || 'Server error' });
});
const httpError = (status, msg) => Object.assign(new Error(msg), { status, publicMessage: msg });

// Simple per-IP rate limit for writes
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const k = `${req.ip}|${req.path}`;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests – please wait a moment.' });
    arr.push(now); hits.set(k, arr); next();
  };
}

function parseDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) throw httpError(400, 'Photo must be a JPEG/PNG/WebP data URL');
  if (m[2].length > 4_000_000) throw httpError(413, 'Photo too large');
  return { mimeType: m[1], base64: m[2] };
}
// ---------- demo mode: a private sandbox per visitor ----------
// Demo mode is switched on in the visitor's own browser (header X-Demo: 1). Only that visitor sees the simulated
// black rainstorm, the sample flood reports and anything they report or vote on while in demo mode; everyone
// else keeps seeing live data. The sandbox is one small document per visitor (photos are stored separately).
const clientIdOf = (req) => String(req.get('x-client-id') || req.ip).slice(0, 64);
const isDemoReq = (req) => req.get('x-demo') === '1';
const sandboxKey = (req) => (isDemoReq(req) ? 'sandbox_' + createHash('sha256').update(clientIdOf(req)).digest('hex').slice(0, 24) : null);
const SANDBOX_MAX = 30;
async function loadSandbox(req) {
  const v = await store.getMeta(sandboxKey(req)).catch(() => null);
  return v && typeof v === 'object' && v.reports ? v : { reports: {} };
}
async function saveSandbox(req, sb) {
  const list = Object.values(sb.reports).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, SANDBOX_MAX);
  await store.setMeta(sandboxKey(req), { reports: Object.fromEntries(list.map((r) => [r.id, r])), at: Date.now() });
}
// All reports this request may see: live reports, plus the visitor's sandbox in demo mode
async function reportsFor(req) {
  const live = (await store.listReports()).filter((r) => !r.demo && !r.sandbox);
  if (!isDemoReq(req)) return live;
  const sb = await loadSandbox(req);
  const seeds = demoReports().map((d) => sb.reports[d.id] || d);
  const own = Object.values(sb.reports).filter((r) => !String(r.id).startsWith('demo-'));
  return [...live, ...seeds, ...own];
}
async function getReportFor(req, id) {
  if (isDemoReq(req)) {
    const sb = await loadSandbox(req);
    if (sb.reports[id]) return sb.reports[id];
    const seed = demoReports().find((d) => d.id === id);
    if (seed) return seed;
  }
  const r = await store.getReport(id);
  return r && !r.demo && !r.sandbox ? r : null;
}
async function saveReportFor(req, r) {
  if (r.demo || r.sandbox) {
    const sb = await loadSandbox(req);
    sb.reports[r.id] = r;
    return saveSandbox(req, sb);
  }
  return store.saveReport(r);
}
const currentWeather = async (req) => (req && isDemoReq(req) ? demoWeather() : liveWeather().catch(() => null));

// Google forecast for a point (demo mode returns a simulated stormy evening)
async function forecastFor(lat, lng, req) {
  if (req && isDemoReq(req)) return demoForecast();
  if (!weatherEnabled()) return null;
  return forecastAt(lat, lng).catch((e) => { console.warn('weather:', e.message); return null; });
}

// Without an official signal, a heavy-rain forecast or soaked ground (Google Weather) still flags
// DSD flood-prone spots at the lowest ("amber" = advisory) level – labelled as forecast-based.
function effectiveLevel(weather, forecast) {
  if (weather?.rainstorm) return { level: weather.rainstorm, basis: 'hko' };
  if (forecast && (forecast.nextHourHeavy || forecast.soaked)) return { level: 'amber', basis: 'forecast' };
  return { level: null, basis: null };
}

async function allHazards(req, weather, forecast = null) {
  const raw = await reportsFor(req);
  const reports = raw.map((r) => decorate(r));
  const crowd = routingHazards(raw);
  const eff = effectiveLevel(weather, forecast);
  const priors = await dsd.priorHazards(eff.level, reports);
  return { crowd, priors, all: [...crowd, ...priors], level: eff };
}

// ---------- config & weather ----------
let pushReady = null; // set at start-up; /api/config waits for it so a cold start never hands out an empty push key
app.get('/api/config', wrap(async (req, res) => {
  res.json({
    mapsBrowserKey: process.env.MAPS_BROWSER_KEY || process.env.MAPS_SERVER_KEY || '',
    mapId: process.env.MAP_ID || 'DEMO_MAP_ID',
    gemini: gemini.enabled(), model: gemini.MODEL,
    routing: routingEnabled(), storage: store.backend,
    demoTrip: DEMO_TRIP, demoTrips: DEMO_TRIPS,
    firebase: publicConfig(),
    pushKey: (await Promise.race([pushReady, new Promise((r) => setTimeout(r, 4000))]), push.pushKey()),
  });
}));

app.get('/api/weather', wrap(async (req, res) => {
  const w = isDemoReq(req) ? demoWeather() : await liveWeather();
  res.json({ ...w, warnings: withIcons(w.warnings), signalInfo: w.rainstorm ? SIGNAL_INFO[w.rainstorm] : null });
}));

// ---------- reports ----------
app.get('/api/reports', wrap(async (req, res) => {
  const reports = (await reportsFor(req)).map((r) => decorate(r))
    .filter((r) => r.status !== 'expired' || r.ageMin < 360);
  res.json({ reports, now: Date.now(), demo: isDemoReq(req) });
}));

// Photo history: every photo of a report is kept (?k=<key> for an older one; default = latest)
async function latestPhotoKey(r) { return r?.photos?.length ? r.photos[r.photos.length - 1].key : r?.id; }
async function addPhoto(r, img, meta) {
  const key = `${r.id}_${meta.at}`;
  await store.savePhoto(key, img.mimeType, img.base64);
  if (!r.photos) r.photos = r.hasPhoto ? [{ key: r.id, at: r.createdAt, severity: r.severity, kind: 'report' }] : [];
  r.photos = [...r.photos, { key, ...meta }].slice(-8);
  r.hasPhoto = true;
}
app.get('/api/reports/:id/photo', wrap(async (req, res) => {
  // demo reports' photos are static files (public/demo/demo-N.jpg)
  if (/^demo-\d+$/.test(req.params.id) && (!req.query.k || req.query.k === req.params.id)) {
    const f = path.join(__dirname, 'public', 'demo', `${req.params.id}.jpg`);
    if (existsSync(f)) return res.set('Cache-Control', 'public, max-age=86400').sendFile(f);
  }
  const r = await store.getReport(req.params.id).catch(() => null);
  const k = String(req.query.k || '');
  const key = k && k.startsWith(req.params.id) ? k : await latestPhotoKey(r) || req.params.id;
  const p = await store.getPhoto(key);
  if (!p) return res.status(404).end();
  res.set('Content-Type', p.mimeType).set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(p.base64, 'base64'));
}));

app.post('/api/reports', rateLimit(20, 10 * 60_000), wrap(async (req, res) => {
  const { lat, lng, photo, note, userLevel, placeHint, skipAi, photoMeta = {}, me = null } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inHongKong(lat, lng)) throw httpError(400, 'Location must be in Hong Kong');
  const img = parseDataUrl(photo);
  if (!img && !note && !userLevel) throw httpError(400, 'Add a photo, a note or a water level');
  const demo = isDemoReq(req);

  // ---- anti-spam: rate limits, photo age / place, re-used photos (before spending a Gemini call)
  abuse.checkCanReport(req);
  let ev, sha = null;
  try {
    ev = abuse.evidence({ lat, lng, photo: img, photoMeta, me });
    if (img) sha = abuse.checkDuplicate({ base64: img.base64, dhash: photoMeta.dhash, lat, lng });
  } catch (e) {
    if (e.code) abuse.strike(req, e.code);
    return res.status(e.status || 422).json({ rejected: true, reason: e.code, error: e.publicMessage, ...e.extra });
  }
  abuse.noteReport(req);

  const knownRisk = await dsd.nearbyKnown(lat, lng).catch(() => []);
  let analysis;
  if (gemini.enabled() && !skipAi) {
    try {
      analysis = await gemini.analyzeFlood({ photoBase64: img?.base64, mimeType: img?.mimeType, note, userLevel, locationHint: placeHint, knownRisk });
    } catch (e) {
      console.error('analyzeFlood failed', e.message);
      return res.status(503).json({ error: `Gemini could not check this photo: ${gemini.explainError(e)}`, canPostUnverified: Boolean(userLevel || note) });
    }
  } else analysis = gemini.fallbackAnalysis({ userLevel, note });

  if (img && abuse.FAKE_SOURCES.has(analysis.image_source)) {
    abuse.strike(req, 'fake_source');
    return res.status(422).json({ rejected: true, reason: 'not_live_photo', imageSource: analysis.image_source, analysis,
      error: 'Gemini thinks this is not a photo you just took (it looks like a screenshot, a photo of a screen, or a news / stock image). Please take a photo of the water in front of you.' });
  }
  if (!analysis.is_flood_scene || analysis.severity === 0) {
    abuse.strike(req, 'no_flood');
    return res.status(422).json({ rejected: true, analysis, knownRisk, error: 'Gemini did not detect flooding in this report.' });
  }

  const clientId = clientIdOf(req);
  const now = Date.now();
  const sbKey = sandboxKey(req);
  const visible = await reportsFor(req);

  // Merge into an existing nearby report instead of creating duplicates
  const existing = visible.map((r) => decorate(r))
    .filter((r) => r.status !== 'cleared' && r.status !== 'expired' && haversine(r, { lat, lng }) < 45)
    .sort((a, b) => haversine(a, { lat, lng }) - haversine(b, { lat, lng }))[0];

  if (existing) {
    const r = structuredClone(visible.find((x) => x.id === existing.id));
    const before = r.severity;
    r.voters = r.voters || {};
    if (r.voters[clientId] !== 'confirm') { r.confirms = (r.confirms || 0) + 1; r.voters[clientId] = 'confirm'; }
    r.severity = analysis.severity;
    r.ai = analysis;
    r.lastConfirmedAt = now; r.updatedAt = now;
    r.evidence = [...new Set([...(r.evidence || []), ...ev.flags])];
    r.history = [...(r.history || []), { at: now, type: 'merged-report', severity: analysis.severity, description_en: analysis.description_en, evidence: ev.flags }].slice(-20);
    if (img) { await addPhoto(r, img, { at: now, severity: analysis.severity, kind: 'report', hash: photoMeta.dhash || null }); abuse.rememberPhoto({ sha, dhash: photoMeta.dhash, lat, lng, reportId: r.id }); }
    await saveReportFor(req, r);
    if (r.severity > before) push.notifyWatchers(r, { sandbox: r.demo || r.sandbox ? sbKey : null, reason: 'worse' }).catch(() => {});
    return res.json({ merged: true, report: decorate(r), analysis, knownRisk, evidence: ev.flags });
  }

  const r = {
    id: randomUUID(), lat, lng, severity: analysis.severity, ai: analysis, placeHint: placeHint || '',
    note: String(note || '').slice(0, 500), userLevel: userLevel || null, hasPhoto: false, photos: [],
    createdAt: now, updatedAt: now, lastConfirmedAt: now, confirms: 0, clears: 0,
    voters: { [clientId]: 'reporter' }, history: [], demo: false, knownRisk,
    evidence: ev.flags, trustAdj: ev.trustAdj, ...(demo ? { sandbox: true } : {}),
  };
  if (img) { await addPhoto(r, img, { at: now, severity: analysis.severity, kind: 'report', hash: photoMeta.dhash || null }); abuse.rememberPhoto({ sha, dhash: photoMeta.dhash, lat, lng, reportId: r.id }); }
  await saveReportFor(req, r);
  // A fresh report close by shows the water is still around: keep neighbouring reports alive too
  if (!demo) {
    for (const n of (await store.listReports()).filter((x) => !x.demo && !x.sandbox && x.id !== r.id && haversine(x, r) < 80)) {
      const dn = decorate(n);
      if (dn.status === 'active' || dn.status === 'fading') { n.lastConfirmedAt = now; await store.saveReport(n); }
    }
  }
  // Anyone walking a route through here gets a push right away
  push.notifyWatchers(r, { sandbox: demo ? sbKey : null }).catch((e) => console.warn('notify', e.message));
  res.json({ merged: false, report: decorate(r), analysis, knownRisk, evidence: ev.flags });
}));

// Waze-style vote: "still there" / "cleared", optionally with a new photo Gemini compares
app.post('/api/reports/:id/vote', rateLimit(30, 10 * 60_000), wrap(async (req, res) => {
  const { vote, photo } = req.body || {};
  if (!['confirm', 'clear'].includes(vote) && !photo) throw httpError(400, 'vote must be confirm or clear');
  const found = await getReportFor(req, req.params.id);
  if (!found) throw httpError(404, 'Report not found');
  const r = structuredClone(found);
  const before = r.severity;
  const clientId = clientIdOf(req);
  r.voters = r.voters || {};
  const now = Date.now();
  let comparison = null;
  let effectiveVote = vote;

  const img = parseDataUrl(photo);
  if (img && gemini.enabled()) {
    const original = r.hasPhoto ? await store.getPhoto(await latestPhotoKey(r)) : null;
    comparison = await gemini.compareUpdate({ original, originalAnalysis: r.ai, update: img });
    if (comparison.same_place_likely || !original) {
      effectiveVote = comparison.change === 'cleared' ? 'clear' : 'confirm';
      if (comparison.change !== 'cleared') r.severity = comparison.severity || r.severity;
      r.ai = { ...r.ai, severity: r.severity, description_en: comparison.description_en, description_zh: comparison.description_zh };
      await addPhoto(r, img, { at: now, severity: r.severity, kind: 'update', change: comparison.change });
      if (comparison.change === 'cleared' && comparison.confidence >= 0.7) r.resolved = true;
    }
  }

  const prev = r.voters[clientId];
  if (prev === 'reporter' && effectiveVote === 'confirm') {
    // reporters can refresh their own report but not inflate it
    r.lastConfirmedAt = now;
  } else if (prev !== effectiveVote) {
    if (prev === 'confirm') r.confirms = Math.max(0, (r.confirms || 0) - 1);
    if (prev === 'clear') r.clears = Math.max(0, (r.clears || 0) - 1);
    if (effectiveVote === 'confirm') { r.confirms = (r.confirms || 0) + 1; r.lastConfirmedAt = now; }
    if (effectiveVote === 'clear') r.clears = (r.clears || 0) + 1;
    r.voters[clientId] = effectiveVote;
  }
  r.updatedAt = now;
  r.history = [...(r.history || []), { at: now, type: effectiveVote, change: comparison?.change, severity: r.severity }].slice(-20);
  await saveReportFor(req, r);
  if (r.severity > before && !r.resolved) push.notifyWatchers(r, { sandbox: r.demo || r.sandbox ? sandboxKey(req) : null, reason: 'worse' }).catch(() => {});
  res.json({ report: decorate(r), comparison });
}));

// ---------- routing ----------
app.post('/api/route', rateLimit(60, 10 * 60_000), wrap(async (req, res) => {
  if (!routingEnabled()) throw httpError(503, 'Routing not configured (MAPS_SERVER_KEY missing)');
  const { origin, destination, preference } = req.body || {};
  for (const p of [origin, destination]) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !inHongKong(p.lat, p.lng)) throw httpError(400, 'Origin and destination must be in Hong Kong');
  }
  const weather = await currentWeather(req);
  const mid = { lat: (origin.lat + destination.lat) / 2, lng: (origin.lng + destination.lng) / 2 };
  const forecast = await forecastFor(mid.lat, mid.lng, req);
  const { all, priors, level } = await allHazards(req, weather, forecast);
  const plan = await planRoute({ origin, destination, preference, hazards: all, lang: langOf(req) });
  const byId = new Map(all.map((h) => [h.id, h]));
  const info = (id) => { const h = byId.get(id); return h && { id, source: h.prior ? 'dsd' : 'crowd', severity: h.severity, kind: h.kind || 'report', description: h.ai?.description_en, place: h.placeHint }; };
  const ids = new Set(plan.endpointHazards.map((h) => h.id));
  for (const o of plan.options) { o.avoidedHazardIds.forEach((id) => ids.add(id)); o.remainingHazards.forEach((h) => ids.add(h.id)); }
  plan.hazardInfo = { ...Object.fromEntries([...ids].map((id) => [id, info(id)]).filter(([, v]) => v)), ...plan.extraHazardInfo };
  delete plan.extraHazardInfo;
  await Promise.all(plan.options.map(async (o) => { o.dsdAlongRoute = await dsd.alongRoute(o.coords).catch(() => []); }));
  plan.dsdAlongRoute = plan.options[0].dsdAlongRoute;
  plan.priorsActive = priors.length;
  plan.priorsBasis = level.basis;
  plan.forecast = forecast;
  plan.rainstorm = weather?.rainstorm || null;
  res.json(plan);
}));

app.post('/api/briefing', rateLimit(60, 10 * 60_000), wrap(async (req, res) => {
  const { mode, durationS, extraSeconds, avoidedHazardIds = [], remainingHazardIds = [], originName, destinationName, hazardInfo = {}, dsdAlongRoute = [], endpointHazardIds = [], shelter = null, option = null, forecast = null } = req.body || {};
  const all = new Map((await reportsFor(req)).map((r) => [r.id, decorate(r)]));
  const fromInfo = (id) => { const h = hazardInfo[id]; return h && { source: h.source === 'dsd' ? 'DSD official flood-prone location (precaution, not a live report)' : 'crowd report', severity: h.severity, description: String(h.description || '').slice(0, 200), place: String(h.place || '').slice(0, 120) }; };
  const brief = (h) => h && ({ severity: h.severity, depth: h.ai?.depth_category, flow: h.ai?.water_flow, description: h.ai?.description_en, place: h.placeHint || undefined, hazards: h.ai?.hazards });
  const weather = await currentWeather(req);
  const ctx = {
    mode, from: originName, to: destinationName,
    walkMinutes: Math.round((durationS || 0) / 60), detourExtraMinutes: Math.round((extraSeconds || 0) / 60),
    avoidedHazards: avoidedHazardIds.slice(0, 8).map((id) => brief(all.get(id)) || fromInfo(id)).filter(Boolean),
    remainingHazards: remainingHazardIds.slice(0, 8).map((id) => brief(all.get(id)) || fromInfo(id)).filter(Boolean),
    hazardsAtStartOrEnd: endpointHazardIds.slice(0, 4).map((id) => brief(all.get(id)) || fromInfo(id)).filter(Boolean),
    routeOption: option,
    googleForecastNextHours: Array.isArray(forecast?.hours) ? forecast.hours.slice(0, 4).map((h) => ({ time: String(h.label).slice(0, 5), rainChancePct: Number(h.chance) || 0, rainMm: Number(h.mm) || 0, thunderChancePct: Number(h.thunder) || 0 })) : null,
    rainPast24hMm: Number.isFinite(forecast?.rain24h) ? forecast.rain24h : null,
    departureAdvice: forecast?.advice?.text_en ? String(forecast.advice.text_en).slice(0, 160) : null,
    shelter: shelter ? {
      shelteredPercent: Number(shelter.shelteredPct) || 0,
      metres: shelter.metres, shelteredPlaces: (shelter.places || []).slice(0, 4).map((p) => ({ name: String(p.name || '').slice(0, 60), nameZh: p.nameZh ? String(p.nameZh).slice(0, 40) : null, type: p.cls })),
    } : null,
    officialFloodProneSpotsOnRoute: dsdAlongRoute.slice(0, 6).map((d) => ({ type: d.type, name: String(d.name || '').slice(0, 120) })),
    hkoRainstormSignal: weather?.rainstorm || 'none',
    floodingAnnouncementNorthernNT: Boolean(weather?.floodingNNT),
  };
  let out;
  try {
    out = gemini.enabled()
      ? { ...(await gemini.routeBriefing(ctx)), source: 'gemini' }
      : { ...gemini.fallbackBriefing(ctx), source: 'fallback', reason: 'Gemini not configured (no GEMINI_API_KEY / Vertex AI settings)' };
  } catch (e) {
    console.error('briefing failed', e.message);
    out = { ...gemini.fallbackBriefing(ctx), source: 'fallback', reason: gemini.explainError(e) };
  }
  res.json(out);
}));

app.get('/api/shelters', wrap(async (req, res) => {
  if (!routingEnabled()) throw httpError(503, 'Places not configured (MAPS_SERVER_KEY missing)');
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!inHongKong(lat, lng)) throw httpError(400, 'Location must be in Hong Kong');
  const { all: hazards } = await allHazards(req, await currentWeather(req));
  res.json(await findShelters({ lat, lng, hazards, lang: langOf(req) }));
}));

// ---------- Google Weather forecast at a point ----------
app.get('/api/forecast', rateLimit(120, 10 * 60_000), wrap(async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!inHongKong(lat, lng)) throw httpError(400, 'Location must be in Hong Kong');
  const f = await forecastFor(lat, lng, req);
  if (!f) throw httpError(503, 'Weather forecast unavailable');
  res.set('Cache-Control', 'public, max-age=300');
  res.json(f);
}));

// ---------- sheltered walkways map layer (LandsD 3D Pedestrian Network) ----------
app.get('/api/shelter', rateLimit(120, 10 * 60_000), wrap(async (req, res) => {
  const b = ['minLat', 'minLng', 'maxLat', 'maxLng'].map((k) => Number(req.query[k]));
  if (b.some((v) => !Number.isFinite(v))) throw httpError(400, 'bbox required');
  const [minLat, minLng, maxLat, maxLng] = b;
  if ((maxLat - minLat) * (maxLng - minLng) > 0.0004) throw httpError(400, 'Zoom in to see sheltered walkways');
  // LandsD stores walkways as path centrelines (polylines), so the layer draws lines, not areas
  const lines = await shelterLines({ minLat, minLng, maxLat, maxLng });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ classes: SHELTER_CLASSES, source: 'Lands Department 3D Pedestrian Network (CSDI)', lines: lines.map((l) => [SHELTER_CLASSES.indexOf(l.cls), l.coords, l.name, l.nameZh]) });
}));

// ---------- search & address lookup ----------
app.post('/api/places/autocomplete', rateLimit(300, 10 * 60_000), wrap(async (req, res) => {
  if (!routingEnabled()) throw httpError(503, 'Search not configured (MAPS_SERVER_KEY missing)');
  const { input, sessionToken, lat, lng } = req.body || {};
  if (!input || String(input).trim().length < 2) return res.json({ suggestions: [] });
  res.json({ suggestions: await autocomplete({ input: String(input).trim(), sessionToken, lat, lng, lang: langOf(req) }) });
}));

// ---------- Ask Me: Gemini assistant limited to FloodSafe topics, grounded on the app's own data ----------
const chat = createChat({
  findPlace: (q) => (routingEnabled() ? findPlace(q) : null),
  reports: async (req) => (await reportsFor(req)).map((r) => decorate(r)),
  weather: (req) => currentWeather(req),
  forecast: (lat, lng, req) => forecastFor(lat, lng, req),
  blackspots: () => dsd.blackspots(),
  saveFeedback: (doc) => store.putDoc('feedback', doc.id, doc),
});
const chatDaily = new Map(); // clientId -> { day, n }
app.post('/api/chat', rateLimit(20, 10 * 60_000), wrap(async (req, res) => {
  if (!gemini.enabled()) throw httpError(503, 'Ask Me needs Gemini, which is not configured');
  const b = req.body || {};
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-10)
    .map((m) => ({ role: m?.role === 'model' ? 'model' : 'user', text: String(m?.text || '').slice(0, 800).trim() })).filter((m) => m.text);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw httpError(400, 'Ask a question');
  const id = clientIdOf(req), day = new Date().toISOString().slice(0, 10);
  const used = chatDaily.get(id); const n = used?.day === day ? used.n : 0;
  if (n >= 60) throw httpError(429, 'Daily question limit reached – please try again tomorrow');
  chatDaily.set(id, { day, n: n + 1 }); if (chatDaily.size > 20000) chatDaily.clear();
  const out = await chat({ messages: msgs, lat: Number(b.lat), lng: Number(b.lng), atLabel: b.atLabel ? String(b.atLabel).slice(0, 80) : null,
    lang: langOf(req), req, clientId: id, demo: isDemoReq(req) });
  res.json(out);
}));

app.get('/api/placeinfo/:id', rateLimit(120, 10 * 60_000), wrap(async (req, res) => {
  if (!routingEnabled()) throw httpError(503, 'Search not configured (MAPS_SERVER_KEY missing)');
  if (!/^[\w-]{10,300}$/.test(req.params.id)) throw httpError(400, 'Bad place id');
  const p = await placeInfo(req.params.id, langOf(req));
  if (!inHongKong(p.lat, p.lng)) throw httpError(400, 'That place is outside Hong Kong');
  res.json(p);
}));

app.get('/api/places/:id', rateLimit(120, 10 * 60_000), wrap(async (req, res) => {
  const p = await placeDetails(req.params.id, req.query.sessionToken, langOf(req));
  if (!inHongKong(p.lat, p.lng)) throw httpError(400, 'That place is outside Hong Kong');
  res.json(p);
}));

app.get('/api/revgeo', rateLimit(200, 10 * 60_000), wrap(async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!inHongKong(lat, lng)) return res.json({ label: null, outside: true });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(await reverseGeocode(lat, lng, langOf(req)));
}));

// ---------- self-check: open /api/selftest in the browser ----------
app.get('/api/selftest', wrap(async (req, res) => {
  const check = async (fn) => { const t = Date.now(); try { const detail = await fn(); return { ok: true, ms: Date.now() - t, detail }; } catch (e) { return { ok: false, ms: Date.now() - t, error: gemini.explainError(e) }; } };
  const key = process.env.MAPS_SERVER_KEY;
  const results = {
    gemini: gemini.enabled() ? await check(() => gemini.ping()) : { ok: false, error: 'Not configured: set GEMINI_API_KEY in .env (local) or Vertex AI env vars (Cloud Run)' },
    routes: key ? await check(async () => {
      const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.duration' },
        body: JSON.stringify({ origin: { location: { latLng: { latitude: 22.3247, longitude: 114.1682 } } }, destination: { location: { latLng: { latitude: 22.3129, longitude: 114.1706 } } }, travelMode: 'WALK' }) });
      if (!r.ok) throw new Error(`Routes API ${r.status}: ${(await r.text()).slice(0, 200)}`); return 'ok';
    }) : { ok: false, error: 'MAPS_SERVER_KEY missing' },
    geocoding: key ? await check(async () => {
      const r = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent('Nathan Road & Argyle Street, Hong Kong')}&key=${key}`)).json();
      if (r.status !== 'OK') throw new Error(`Geocoding API: ${r.status} ${r.error_message || ''}`); return 'ok';
    }) : { ok: false, error: 'MAPS_SERVER_KEY missing' },
    places: key ? await check(async () => (await findShelters({ lat: 22.3193, lng: 114.1694 })).shelters.length + ' places') : { ok: false, error: 'MAPS_SERVER_KEY missing' },
    hko: await check(async () => { const w = await liveWeather(); return `signal: ${w.rainstorm || 'none'}, ${w.rainfall.length} districts`; }),
    googleWeather: weatherEnabled() ? await check(async () => { const f = await forecastAt(22.3193, 114.1694); return `${f.now?.condition || '?'} · rain past 24 h ${f.rain24h ?? '?'} mm · ${f.hours.length} forecast hours · reports fade ${isDryFade() ? 'fast (dry)' : 'normally'}`; }) : { ok: false, error: 'MAPS_SERVER_KEY missing' },
    dsd: { ok: true, detail: dsd.status() },
    shelter: await check(async () => { const { shelterIndex } = await import('./src/shelter.js'); const i = await shelterIndex({ minLat: 22.318, maxLat: 22.319, minLng: 114.168, maxLng: 114.169 }); return `${i.count} sheltered walkway points near Mong Kok`; }),
    storage: { ok: true, detail: store.backend },
    model: gemini.MODEL,
  };
  res.json(results);
}));

// ---------- DSD official layer ----------
app.get('/api/dsd', wrap(async (req, res) => {
  const weather = await currentWeather(req);
  res.set('Cache-Control', 'private, max-age=120');
  res.json({
    blackspots: await dsd.blackspots(),
    blockage: dsd.blockageList().filter((b) => Number.isFinite(b.lat)).map(({ id, district, location, kind, lat, lng, precision }) => ({ id, district, location, kind, lat, lng, approximate: precision === 'APPROXIMATE' })),
    activeSignal: weather?.rainstorm || null,
    status: dsd.status(),
    sources: dsd.SOURCES,
  });
}));

// ---------- accounts: Google sign-in via Firebase ----------
const needUser = async (req) => {
  const u = await userOf(req);
  if (!u) throw httpError(401, 'Please sign in with Google first');
  return u;
};
app.get('/api/me', wrap(async (req, res) => res.json({ user: await userOf(req) })));

// ---------- umbrella lending stations (community map) + ratings ----------
const UMB_FILE = path.join(__dirname, 'public', 'umbrellas.json');
const umbIds = new Set(existsSync(UMB_FILE) ? JSON.parse(readFileSync(UMB_FILE, 'utf8')).stations.map((s) => s.id) : []);
let ratingCache = { at: 0, data: null };
// Demo mode only: a few clearly-labelled SAMPLE reviews per station (with illustrations), so the rating feature can be
// shown on a fresh install. They never appear for real visitors and are never mixed into the real averages.
const SAMPLE_REVIEWS = [
  { stars: 5, en: 'Borrowed one when the amber signal went up. Quick at the counter, deposit back the next day.', zh: '黃雨時借咗把遮，櫃位好快手，第二日還遮即退按金。', name: 'Ka Yan C.' },
  { stars: 4, en: 'Only three umbrellas left at 6 pm. On stormy days, come early.', zh: '傍晚六點得返三把，落大雨記得早啲嚟。', name: 'Michael W.' },
  { stars: 5, en: 'Saved my suit on the way to a job interview!', zh: '見工途中救咗我套西裝！', name: 'Siu Ming' },
  { stars: 3, en: 'Umbrella was a bit small, but much better than getting soaked.', zh: '把遮細咗啲，但總好過成身濕。', name: 'Joyce L.' },
  { stars: 5, en: 'Easy to find: the counter is right by the entrance.', zh: '好易搵，櫃位就喺入口側邊。', name: 'Ah Fai' },
  { stars: 4, en: 'Had to show my membership card and return it to the same branch. Fair enough.', zh: '要出示會員卡，借完要喺同一間分店還，都合理。', name: 'Priya S.' },
];
const sampleFor = (id) => {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return [0, 1, 2].map((k) => {
    const r = SAMPLE_REVIEWS[(h + k * 2) % SAMPLE_REVIEWS.length];
    return { ...r, sample: true, photo: `/demo/umb-${((h + k) % 3) + 1}.svg`, at: Date.now() - ((h % 50) + 20 + k * 37) * 3600e3 };
  }).slice(0, 2 + (h % 2));
};
app.get('/api/umbrellas/ratings', wrap(async (req, res) => {
  if (!ratingCache.data || Date.now() - ratingCache.at > 60_000) {
    const all = await store.findDocs('umbrellaRatings', null, null, { limit: 5000 });
    const sum = {};
    for (const r of all) { const x = sum[r.stationId] ||= { n: 0, total: 0 }; x.n++; x.total += r.stars; }
    ratingCache = { at: Date.now(), data: Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, { avg: Math.round((v.total / v.n) * 10) / 10, count: v.n }])) };
  }
  if (!isDemoReq(req)) return res.json({ ratings: ratingCache.data });
  // demo: show sample averages for stations that have no real ratings yet
  const ratings = { ...ratingCache.data };
  for (const id of umbIds) if (!ratings[id]) { const rs = sampleFor(id); ratings[id] = { avg: Math.round((rs.reduce((a, r) => a + r.stars, 0) / rs.length) * 10) / 10, count: rs.length, sample: true }; }
  res.json({ ratings });
}));
app.get('/api/umbrellas/:id/reviews', wrap(async (req, res) => {
  const me = await userOf(req);
  const rows = await store.findDocs('umbrellaRatings', 'stationId', req.params.id, { limit: 30 });
  const samples = isDemoReq(req) && umbIds.has(req.params.id) ? sampleFor(req.params.id).map((r) => ({ stars: r.stars, comment: r.en, commentZh: r.zh, name: r.name, at: r.at, sample: true, photo: r.photo })) : [];
  res.json({
    reviews: [...rows.map((r) => ({ stars: r.stars, comment: r.comment, name: r.name, picture: r.picture, at: r.at, mine: me?.uid === r.uid })), ...samples],
    mine: me ? rows.find((r) => r.uid === me.uid) || null : null,
  });
}));
app.post('/api/umbrellas/:id/rate', rateLimit(20, 10 * 60_000), wrap(async (req, res) => {
  const u = await needUser(req);
  if (!umbIds.has(req.params.id)) throw httpError(404, 'Unknown station');
  const stars = Math.round(Number(req.body?.stars));
  if (!(stars >= 1 && stars <= 5)) throw httpError(400, 'Choose 1 to 5 stars');
  const comment = String(req.body?.comment || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const doc = { stationId: req.params.id, uid: u.uid, name: u.name, picture: u.picture, stars, comment, at: Date.now() };
  await store.putDoc('umbrellaRatings', `${u.uid}_${req.params.id}`, doc); // one rating per person per station
  ratingCache.at = 0;
  res.json({ ok: true, rating: { stars, comment } });
}));

// ---------- shared routes ----------
const cleanPt = (p) => (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && inHongKong(p.lat, p.lng) ? { lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 } : null);
const publicRoute = (r) => ({ id: r.id, origin: r.origin, destination: r.destination, originName: r.originName, destName: r.destName, pref: r.pref, note: r.note, name: r.name, picture: r.picture, at: r.at, minutes: r.minutes, shelteredPct: r.shelteredPct });
app.post('/api/routes/share', rateLimit(20, 10 * 60_000), wrap(async (req, res) => {
  const u = await needUser(req);
  const b = req.body || {};
  const origin = cleanPt(b.origin), destination = cleanPt(b.destination);
  if (!origin || !destination) throw httpError(400, 'Plan a route in Hong Kong first');
  const r = {
    id: randomUUID().slice(0, 8), uid: u.uid, name: u.name, picture: u.picture, origin, destination,
    originName: String(b.originName || '').slice(0, 80), destName: String(b.destName || '').slice(0, 80),
    pref: ['shortest', 'balanced', 'covered'].includes(b.pref) ? b.pref : 'balanced', note: String(b.note || '').slice(0, 200),
    minutes: Number.isFinite(b.minutes) ? Math.round(b.minutes) : null, shelteredPct: Number.isFinite(b.shelteredPct) ? Math.round(b.shelteredPct) : null,
    public: b.public !== false, at: Date.now(),
  };
  await store.putDoc('sharedRoutes', r.id, r);
  res.json({ route: publicRoute(r) });
}));
app.get('/api/routes/shared', wrap(async (req, res) => {
  const me = await userOf(req);
  const mine = req.query.mine === '1';
  if (mine && !me) throw httpError(401, 'Please sign in with Google first');
  const rows = mine ? await store.findDocs('sharedRoutes', 'uid', me.uid, { limit: 30 }) : (await store.findDocs('sharedRoutes', 'public', true, { limit: 20 }));
  res.json({ routes: rows.map(publicRoute) });
}));
app.get('/api/routes/shared/:id', wrap(async (req, res) => {
  const r = await store.getDoc('sharedRoutes', String(req.params.id).slice(0, 20));
  if (!r) throw httpError(404, 'This shared route no longer exists');
  res.json({ route: publicRoute(r) });
}));
app.delete('/api/routes/shared/:id', wrap(async (req, res) => {
  const u = await needUser(req);
  const r = await store.getDoc('sharedRoutes', String(req.params.id).slice(0, 20));
  if (!r) throw httpError(404, 'Not found');
  if (r.uid !== u.uid) throw httpError(403, 'Only the person who shared it can delete it');
  await store.delDoc('sharedRoutes', r.id);
  res.json({ ok: true });
}));

// ---------- demo mode (per visitor) ----------
// Turning demo on or off resets only this visitor's sandbox: fresh sample reports, nothing left over.
app.post('/api/demo', rateLimit(30, 10 * 60_000), wrap(async (req, res) => {
  const on = Boolean(req.body?.active);
  const key = 'sandbox_' + createHash('sha256').update(clientIdOf(req)).digest('hex').slice(0, 24);
  const old = await store.getMeta(key).catch(() => null);
  for (const r of Object.values(old?.reports || {})) for (const p of r.photos || []) await store.deletePhoto(p.key).catch(() => {});
  await store.deleteMeta(key).catch(() => {});
  res.json({ demo: on, scope: 'this-device' });
}));

// Demo helper for presentations: drop a simulated flood a few hundred metres ahead on the route being walked,
// exactly as if another person had just reported it (goes through the same push alert path).
app.post('/api/demo/flood-ahead', rateLimit(20, 10 * 60_000), wrap(async (req, res) => {
  if (!isDemoReq(req)) throw httpError(403, 'Only available in demo mode');
  const { coords, progress = 0 } = req.body || {};
  const line = push.simplify(coords);
  const n = line.length / 2;
  if (n < 3) throw httpError(400, 'Route missing');
  // ~40 % of the remaining route ahead, at least 2 points ahead of the walker
  const from = Math.min(Math.max(0, Number(progress) || 0), n - 2);
  const idx = Math.min(n - 2, Math.max(from + 2, Math.round(from + (n - from) * 0.4)));
  const lat = line[2 * idx + 1], lng = line[2 * idx];
  const now = Date.now();
  const [place, placeZh] = await Promise.all([reverseGeocode(lat, lng, 'en').catch(() => null), reverseGeocode(lat, lng, 'zh').catch(() => null)]);
  const r = {
    id: randomUUID(), lat, lng, severity: 3, placeHint: place?.label || 'On your route', placeHintZh: placeZh?.label || '你的路線上',
    ai: { is_flood_scene: true, severity: 3, depth_category: 'shin_to_knee', estimated_depth_cm: 30, water_flow: 'slow', hazards: ['submerged kerb'], hazards_zh: ['行人路邊被淹沒'],
      passable_on_foot: false, passable_wheelchair: false, passable_by_car: true, confidence: 0.8, depth_cues: 'Simulated demo report',
      description_en: 'Simulated: shin-deep water across the pavement, reported by another walker just now.', description_zh: '模擬：行人路水深及小腿，剛由另一位途人報告。', model: 'demo', image_source: 'no_image' },
    note: '', hasPhoto: false, photos: [], createdAt: now, updatedAt: now, lastConfirmedAt: now, confirms: 0, clears: 0,
    voters: {}, history: [], demo: false, sandbox: true, simulated: true, evidence: ['on_site'], trustAdj: 0.1,
  };
  await saveReportFor(req, r);
  const sent = await push.notifyWatchers(r, { sandbox: sandboxKey(req) }).catch(() => 0);
  res.json({ report: decorate(r), pushed: sent });
}));

// ---------- route alerts (Web Push) ----------
app.post('/api/watch', rateLimit(30, 10 * 60_000), wrap(async (req, res) => {
  const { subscription, coords, destName, durationS } = req.body || {};
  const w = await push.createWatch({ subscription, coords, destName, durationS, lang: langOf(req), sandbox: sandboxKey(req) });
  res.json({ id: w.id, expiresAt: w.expiresAt });
}));
app.post('/api/watch/:id', rateLimit(120, 10 * 60_000), wrap(async (req, res) => {
  const w = await store.getWatch(req.params.id);
  if (!w) throw httpError(404, 'Watch ended');
  const p = Math.round(Number(req.body?.progress));
  if (Number.isFinite(p) && p >= 0) { w.progress = Math.min(p, w.line.length / 2 - 1); await store.saveWatch(w); }
  res.json({ ok: true });
}));
app.delete('/api/watch/:id', wrap(async (req, res) => {
  await store.deleteWatch(req.params.id).catch(() => {});
  res.json({ ok: true });
}));

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

// Every 10 min: if Google Weather shows < 0.5 mm in the past 3 h around Kowloon/HK Island, fade flood reports faster
async function updateDryFade() {
  if (!weatherEnabled()) return;
  try {
    const pts = [[22.3193, 114.1694], [22.2800, 114.1700]];
    const totals = await Promise.all(pts.map(([a, b]) => recentRain(a, b, 3)));
    setDryFade(Math.max(...totals) < 0.5);
  } catch (e) { console.warn('dry-fade check:', e.message); }
}
updateDryFade(); setInterval(updateDryFade, 10 * 60_000);

dsd.initBlockage().catch((e) => console.warn('DSD init failed', e.message));
pushReady = push.initPush().catch((e) => console.warn('push init failed', e.message));
// Demo mode used to be one global switch: clear any shared demo reports left from that version
(async () => {
  const old = (await store.listReports(0)).filter((r) => r.demo);
  await Promise.all(old.map((r) => store.deleteReport(r.id)));
  if ((await store.getMeta('demo')) === true) await store.setMeta('demo', false);
})().catch((e) => console.warn('legacy demo cleanup', e.message));
dsd.blackspots().catch(() => {});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FloodSafe HK on :${port}  storage=${store.backend}  gemini=${gemini.enabled() ? gemini.MODEL : 'off'}  routing=${routingEnabled() ? 'on' : 'off'}`);
});
