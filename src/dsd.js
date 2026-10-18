// Drainage Services Department (DSD) official flood-risk data, used as a *prior* that
// switches on with the HKO rainstorm signal, before any crowd report exists.
//   1. Flooding Blackspots – live from the CSDI WFS (GeoJSON, WGS84), snapshot fallback.
//   2. District Locations Prone to Blockage (~230) – transcribed from the DSD PDF,
//      geocoded once with the Geocoding API and cached (file or Firestore).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { haversine, distToPolyline, inHongKong } from './geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');

export const SOURCES = {
  blackspots: 'https://www.dsd.gov.hk/EN/Flood_Prevention/Our_Flooding_Situation/Flooding_Blackspots/',
  blockage: 'https://www.dsd.gov.hk/EN/Flood_Prevention/Our_Flooding_Situation/Flood_Prone_Areas/Locations_Prone_To_Blockage/index.html',
};

// ---------- 1. Flooding blackspots ----------
const WFS = 'https://portal.csdi.gov.hk/server/services/common/dsd_rcd_1728891975004_392/MapServer/WFSServer'
  + '?service=wfs&request=GetFeature&typenames=csdi:FloodingBlackspots&outputFormat=geojson';

// Snapshot of the CSDI feed (retrieved 14 Oct 2026) used if the live feed is unreachable.
const BLACKSPOT_SNAPSHOT = [
  { id: 'dsd-bs-1', name: 'Shek Wu Wai, San Tin', nameZh: '新田石湖圍', district: 'Yuen Long', scale: 3, lat: 22.49164416, lng: 114.07501080, cause: 'Low-lying area; inadequate capacity of existing drainage channels', causeZh: '地勢低窪；現有排水渠道容量不足' },
  { id: 'dsd-bs-2', name: 'Lam Tsuen Valley Basin', nameZh: '林村谷盆地', district: 'Tai Po', scale: 2, lat: 22.44861292, lng: 114.13368860, cause: 'Inadequate capacity of Lam Tsuen River and She Shan River', causeZh: '林村河及蛇山河容量不足' },
  { id: 'dsd-bs-3', name: 'Chatham Road South between Granville Road and Austin Avenue', nameZh: '漆咸道南（介乎加連威老道與柯士甸路之間）', district: 'Yau Tsim Mong', scale: 1, lat: 22.30343114, lng: 114.17623730, cause: 'Inadequate capacity of existing drainage system', causeZh: '現有排水系統容量不足' },
  { id: 'dsd-bs-4', name: 'Pok Fu Lam Village', nameZh: '薄扶林村', district: 'Southern', scale: 1, lat: 22.26075778, lng: 114.13855990, cause: 'Inadequate capacity of existing drainage system', causeZh: '現有排水系統容量不足' },
];

let blackspotCache = { at: 0, data: null, live: false };

const pick = (props, re) => {
  const k = Object.keys(props || {}).find((key) => re.test(key) && props[key] != null && props[key] !== '');
  return k ? props[k] : undefined;
};

export async function blackspots() {
  if (blackspotCache.data && Date.now() - blackspotCache.at < 6 * 3600e3) return blackspotCache.data;
  try {
    const res = await fetch(WFS, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`CSDI ${res.status}`);
    const gj = await res.json();
    const items = (gj.features || []).map((f, i) => {
      const [lng, lat] = f.geometry?.coordinates || [];
      if (!inHongKong(lat, lng)) return null;
      const p = f.properties || {};
      const snap = BLACKSPOT_SNAPSHOT.find((s) => haversine(s, { lat, lng }) < 300);
      return {
        id: `dsd-bs-${p.RECORD_ID ?? p.OBJECTID ?? i + 1}`,
        name: pick(p, /(LOCATION|NAME).*(_E|ENG|EN)$/i) || snap?.name || `Flooding blackspot ${i + 1}`,
        district: pick(p, /DISTRICT.*(_E|ENG|EN)$/i) || snap?.district || '',
        scale: Number(pick(p, /SCALE/i)) || snap?.scale || 1,
        cause: pick(p, /CAUSE.*(_E|ENG|EN)$/i) || snap?.cause || '',
        nameZh: pick(p, /(LOCATION|NAME).*(_C|_TC|CHI|_ZH)$/i) || snap?.nameZh || null,
        causeZh: pick(p, /CAUSE.*(_C|_TC|CHI|_ZH)$/i) || snap?.causeZh || null,
        lat, lng,
      };
    }).filter(Boolean);
    if (!items.length) throw new Error('empty feed');
    blackspotCache = { at: Date.now(), data: items, live: true };
  } catch (e) {
    console.warn('DSD blackspots: using snapshot –', e.message);
    blackspotCache = { at: Date.now() - 5 * 3600e3, data: BLACKSPOT_SNAPSHOT, live: false };
  }
  return blackspotCache.data;
}

// ---------- 2. Locations prone to blockage ----------
let blockage = null;          // [{id, district, location, kind, lat?, lng?, precision?}]
let geocodeState = 'not-started';

async function loadJSON(file) {
  try { return JSON.parse(await readFile(path.join(DATA, file), 'utf8')); } catch { return null; }
}

function cleanForGeocode(s) {
  return s
    .replace(/\(?\s*near lamp post [A-Z]{0,2}\d+[^)]*\)?/gi, '')
    .replace(/lamp post [A-Z]{0,2}\d+/gi, '')
    .replace(/near lot no\.[^,]*/gi, '')
    .replace(/\((westbound|eastbound)\)/gi, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}

const GEOCODER_VERSION = 2;

async function geocodeQuery(q) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}`
    + `&components=country:HK&region=hk&language=en&key=${process.env.MAPS_SERVER_KEY}`;
  const json = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
  if (json.status !== 'OK' || !json.results?.length) return { status: json.status };
  const r = json.results[0];
  const { lat, lng } = r.geometry.location;
  if (!inHongKong(lat, lng)) return { status: 'OUTSIDE_HK' };
  const types = r.types || [];
  // A bare street ("route") result is the centre of the WHOLE street – useless for a specific spot.
  const wholeStreet = types.includes('route') && !types.includes('intersection');
  return { status: 'OK', lat, lng, types, precision: wholeStreet ? 'APPROXIMATE' : r.geometry.location_type };
}

// Turn DSD descriptions into geocodable queries.
//  "Junction of A and B"            -> "A & B"
//  "X Road (between A and B)"       -> midpoint of "X Road & A" and "X Road & B"
//  "X Road near Y" / anything else  -> cleaned text, then "Y" as a landmark fallback
function strategies(loc) {
  const text = cleanForGeocode(loc.location);
  const area = `${loc.district}, Hong Kong`;
  const out = [];
  let m = /^Junction of (.+?) and (.+?)(?:,.*)?$/i.exec(text);
  if (m) out.push({ q: [`${m[1]} & ${m[2]}, ${area}`] });
  m = /^(.+?)\s*\(between (.+?) and (.+?)\)/i.exec(text);
  if (m) out.push({ q: [`${m[1]} & ${m[2]}, ${area}`, `${m[1]} & ${m[3]}, ${area}`], mid: true });
  out.push({ q: [`${text}, ${area}`] });
  m = /^(.+?) (?:near|outside|adjoining) (.+?)(?:,.*)?$/i.exec(text);
  if (m) out.push({ q: [`${m[1]} & ${m[2]}, ${area}`] }, { q: [`${m[2]}, ${area}`] });
  return out;
}

export async function geocodeOne(loc) {
  let last = 'ZERO_RESULTS';
  for (const st of strategies(loc)) {
    const res = await Promise.all(st.q.map(geocodeQuery));
    const ok = res.filter((r) => r.status === 'OK' && r.precision !== 'APPROXIMATE');
    if (st.mid ? ok.length === 2 : ok.length === 1) {
      // two junctions of a "between" segment should be close to each other
      if (st.mid && haversine(ok[0], ok[1]) > 1500) { last = 'INCONSISTENT'; continue; }
      const lat = ok.reduce((a, r) => a + r.lat, 0) / ok.length;
      const lng = ok.reduce((a, r) => a + r.lng, 0) / ok.length;
      return { ...loc, lat, lng, precision: ok[0].precision, query: st.q.join(' | '), geocodeStatus: 'OK' };
    }
    last = res[0]?.status === 'OK' ? 'APPROXIMATE_ONLY' : res[0]?.status || last;
  }
  return { ...loc, geocodeStatus: last };
}

export async function geocodeAll(list, concurrency = 4) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < list.length) {
      const n = i++;
      try { out[n] = await geocodeOne(list[n]); } catch (e) { out[n] = { ...list[n], geocodeStatus: 'ERROR' }; }
    }
  }));
  return out;
}

// Load order: committed geocoded file → Firestore/memory cache → geocode in background.
export async function initBlockage() {
  const raw = await loadJSON('dsd_blockage.json');
  const base = raw?.locations || [];
  const file = await loadJSON('dsd_blockage_geocoded.json');
  if (file?.locations?.length && file.geocoderVersion === GEOCODER_VERSION) { blockage = file.locations; geocodeState = 'file'; return; }
  const cached = await store.getMeta(`dsd_blockage_geocoded_v${GEOCODER_VERSION}`).catch(() => null);
  if (Array.isArray(cached) && cached.length === base.length) { blockage = cached; geocodeState = 'cache'; return; }
  blockage = base;
  if (!process.env.MAPS_SERVER_KEY) { geocodeState = 'no-key'; return; }
  geocodeState = 'running';
  geocodeAll(base).then(async (res) => {
    blockage = res;
    geocodeState = 'done';
    await store.setMeta(`dsd_blockage_geocoded_v${GEOCODER_VERSION}`, res).catch((e) => console.warn('cache geocodes failed', e.message));
    // Locally, also save to data/ so restarts don't re-geocode (on Cloud Run the Firestore cache is used)
    if (store.backend === 'memory') {
      await writeFile(path.join(DATA, 'dsd_blockage_geocoded.json'), JSON.stringify({ geocoderVersion: GEOCODER_VERSION, geocodedAt: new Date().toISOString(), locations: res }, null, 1))
        .then(() => console.log('Saved data/dsd_blockage_geocoded.json')).catch(() => {});
    }
    console.log(`DSD blockage: geocoded ${res.filter((r) => r.lat).length}/${res.length}`);
  }).catch((e) => { geocodeState = 'error'; console.warn('DSD geocode failed', e.message); });
}

// Only reasonably precise geocodes are used as routing priors
const usable = (b) => Number.isFinite(b.lat) && b.precision !== 'APPROXIMATE';

export { GEOCODER_VERSION };
export function blockageList() { return blockage || []; }
export function status() { return { geocode: geocodeState, blackspotsLive: blackspotCache.live, blockageCount: (blockage || []).length, located: (blockage || []).filter(usable).length }; }

// ---------- Priors: official risk switched on by HKO rainstorm signal ----------
// severity by signal level: [blackspot, underpass, road blockage, watercourse]
const PRIOR_SEVERITY = {
  amber: [1, 1, 0, 0],
  red: [2, 2, 1, 1],
  black: [3, 3, 2, 1],
};

export async function priorHazards(rainstorm, crowdReports = []) {
  const table = PRIOR_SEVERITY[rainstorm];
  if (!table) return [];
  const crowd = crowdReports.filter((r) => r.status !== 'expired');
  // A crowd report (active OR cleared) within 60 m supersedes the prior: people on the ground know better.
  const supersededBy = (p) => crowd.some((r) => haversine(r, p) < 60);

  const out = [];
  for (const b of await blackspots()) {
    const sev = Math.min(5, table[0] + (b.scale >= 3 ? 1 : 0));
    if (sev < 1 || supersededBy(b)) continue;
    out.push(prior(b.id, b, sev, 70 + b.scale * 30, `DSD flooding blackspot: ${b.name}`, 'blackspot', b));
  }
  for (const b of blockageList()) {
    if (!usable(b)) continue;
    const sev = b.kind === 'underpass' ? table[1] : b.kind === 'watercourse' ? table[3] : table[2];
    if (sev < 1 || supersededBy(b)) continue;
    out.push(prior(b.id, b, sev, b.kind === 'underpass' ? 50 : 35, `DSD blockage-prone ${b.kind === 'underpass' ? 'underpass' : 'location'}: ${b.location}`, b.kind, b));
  }
  return out;
}

function prior(id, p, severity, radius, description, kind, src) {
  return {
    id, lat: p.lat, lng: p.lng, severity, radius, trust: 0.5, status: 'active', prior: true, kind,
    placeHint: src.location || src.name, district: src.district,
    ai: { description_en: description, depth_category: 'unknown', water_flow: 'unknown', hazards: kind === 'underpass' ? ['underpass – floods first'] : [] },
  };
}

// Official spots near a point (report enrichment)
export async function nearbyKnown(lat, lng, radius = 120) {
  const pt = { lat, lng };
  const hits = [];
  for (const b of await blackspots()) {
    const d = haversine(pt, b);
    if (d <= radius + 100) hits.push({ type: 'blackspot', name: b.name, district: b.district, distanceM: Math.round(d) });
  }
  for (const b of blockageList()) {
    if (!usable(b)) continue;
    const d = haversine(pt, b);
    if (d <= radius) hits.push({ type: b.kind === 'underpass' ? 'underpass' : 'blockage', name: b.location, district: b.district, distanceM: Math.round(d) });
  }
  return hits.sort((a, b) => a.distanceM - b.distanceM).slice(0, 3);
}

// Official spots along a route polyline (briefing context, even with no rain signal)
export async function alongRoute(coords, buffer = 50) {
  const hits = [];
  for (const b of await blackspots()) if (distToPolyline(b, coords) <= buffer + 50) hits.push({ type: 'blackspot', name: b.name });
  for (const b of blockageList()) if (usable(b) && distToPolyline(b, coords) <= buffer) hits.push({ type: b.kind, name: b.location });
  return hits.slice(0, 6);
}
