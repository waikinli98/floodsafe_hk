// "Stay dry" analysis on the Lands Department 3D Pedestrian Network (CSDI open data, updated quarterly).
// We load only the sheltered parts of the network around a trip:
//   Location 2/3 = Indoor / Paid area (malls, MTR concourses)   FeatureType 4 = Subway (underground)
//   FeatureType 2 = Footbridge (above any flooding)              WeatherProof 1 = Covered walkway
// then measure, every ~10 m along a route, which kind of shelter the route is following.
// Domain codes come from the layer's metadata:
//   .../landsd_rcd_1637222018065_52265/MapServer/0?f=pjson
import { haversine } from './geo.js';

const LAYER = 'https://portal.csdi.gov.hk/server/rest/services/common/landsd_rcd_1637222018065_52265/MapServer/0/query';
const WHERE = 'WeatherProof=1 OR Location IN (2,3) OR FeatureType IN (2,4)';
const TILE = 0.01;            // ~1.1 km tiles, cached
const TILE_TTL = 24 * 3600e3; // data changes quarterly
const MATCH_M = 12;           // route point counts as sheltered if within this distance of a sheltered segment
const STEP_M = 10;            // sampling interval

// Shelter classes, best first
export const CLASSES = ['indoor', 'underground', 'footbridge', 'covered', 'open'];
// Order matters: in the live data, subways are FeatureType 4 AND Location 2 (indoor), and enclosed
// footbridges are FeatureType 2 + Location 2 – so check the feature type before the indoor flag.
function classify(p) {
  if (p.FeatureType === 4) return 'underground';
  if (p.FeatureType === 2) return 'footbridge';
  if (p.Location === 2 || p.Location === 3) return 'indoor';
  if (p.WeatherProof === 1) return 'covered';
  return null;
}

const tiles = new Map(); // key -> { at, data: { points: [{lat,lng,cls,name,nameZh}], lines: [{cls,name,nameZh,coords,bbox}] }, promise }
let lastError = null;

export function shelterStatus() {
  return { tilesCached: tiles.size, lastError };
}

async function fetchTile(tx, ty) {
  const minLng = tx * TILE, minLat = ty * TILE;
  const points = [];
  const lines = [];
  let offset = 0;
  for (let page = 0; page < 8; page++) {
    const params = new URLSearchParams({
      where: WHERE,
      geometry: `${minLng},${minLat},${minLng + TILE},${minLat + TILE}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'FeatureType,WeatherProof,Location,AliasNameEN,AliasNameTC',
      returnGeometry: 'true', outSR: '4326', f: 'geojson',
      resultOffset: String(offset), resultRecordCount: '3000',
    });
    const res = await fetch(`${LAYER}?${params}`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`CSDI pedestrian network ${res.status}`);
    const gj = await res.json();
    if (gj.error) throw new Error(`CSDI: ${gj.error.message || JSON.stringify(gj.error)}`);
    const feats = gj.features || [];
    for (const f of feats) {
      const p = f.properties || {};
      const cls = classify(p);
      if (!cls || !f.geometry) continue;
      const parts = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates
        : f.geometry.type === 'LineString' ? [f.geometry.coordinates] : [];
      for (const line of parts) {
        if (line.length < 2) continue;
        densify(line, cls, p.AliasNameEN || null, p.AliasNameTC || null, points);
        // keep the real path geometry for drawing the map layer
        const coords = line.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
        lines.push({ cls, name: p.AliasNameEN || null, nameZh: p.AliasNameTC || null, coords, bbox: bboxOf([coords]) });
      }
    }
    if (feats.length < 3000 && !gj.exceededTransferLimit && !gj.properties?.exceededTransferLimit) break;
    offset += feats.length;
  }
  return { points, lines };
}

// Turn line work into points every ~STEP_M metres for fast proximity lookups
function densify(line, cls, name, nameZh, out) {
  for (let i = 1; i < line.length; i++) {
    const a = { lng: line[i - 1][0], lat: line[i - 1][1] };
    const b = { lng: line[i][0], lat: line[i][1] };
    const n = Math.max(1, Math.ceil(haversine(a, b) / STEP_M));
    for (let k = 0; k <= n; k++) {
      if (k === 0 && i > 1) continue;
      out.push({ lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n, cls, name, nameZh });
    }
  }
}

async function tile(tx, ty) {
  const key = `${tx},${ty}`;
  const t = tiles.get(key);
  if (t?.data && Date.now() - t.at < TILE_TTL) return t.data;
  if (t?.promise) return t.promise;
  const promise = fetchTile(tx, ty)
    .then((data) => { tiles.set(key, { at: Date.now(), data }); lastError = null; return data; })
    .catch((e) => { tiles.delete(key); lastError = e.message; throw e; });
  tiles.set(key, { promise });
  return promise;
}

function tilesFor(bbox, pad) {
  const x0 = Math.floor((bbox.minLng - pad) / TILE), x1 = Math.floor((bbox.maxLng + pad) / TILE);
  const y0 = Math.floor((bbox.minLat - pad) / TILE), y1 = Math.floor((bbox.maxLat + pad) / TILE);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  if (jobs.length > 12) throw new Error('Trip too long for shelter analysis');
  return Promise.all(jobs.map(([x, y]) => tile(x, y)));
}

// Sheltered points covering a bounding box (+ margin). Max 12 tiles per request.
export async function shelterIndex(bbox) {
  const parts = await tilesFor(bbox, 0.002);
  return buildGrid(parts.flatMap((t) => t.points));
}

// The sheltered path segments themselves (LandsD centrelines) inside a bounding box, for the map layer.
export async function shelterLines(bbox) {
  const parts = await tilesFor(bbox, 0);
  const seen = new Set();
  const out = [];
  for (const t of parts) for (const l of t.lines) {
    const b = l.bbox;
    if (b.maxLat < bbox.minLat || b.minLat > bbox.maxLat || b.maxLng < bbox.minLng || b.minLng > bbox.maxLng) continue;
    const k = `${l.coords[0]}|${l.coords[l.coords.length - 1]}|${l.coords.length}`; // segments crossing a tile edge come back twice
    if (seen.has(k)) continue; seen.add(k);
    out.push(l);
  }
  return out;
}

// Simple spatial hash (~20 m cells)
const CELL = 0.0002;
function buildGrid(points) {
  const grid = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.lng / CELL)},${Math.floor(p.lat / CELL)}`;
    let arr = grid.get(k); if (!arr) grid.set(k, (arr = []));
    arr.push(p);
  }
  return { grid, count: points.length, points };
}
function nearest(index, pt, maxM) {
  const cx = Math.floor(pt.lng / CELL), cy = Math.floor(pt.lat / CELL);
  const r = Math.ceil(maxM / 20);
  let best = null, bestD = maxM;
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    const arr = index.grid.get(`${cx + dx},${cy + dy}`); if (!arr) continue;
    for (const p of arr) {
      const d = haversine(pt, p);
      // prefer the better shelter class when two are similarly close
      if (d < bestD - 2 || (d <= bestD + 2 && best && CLASSES.indexOf(p.cls) < CLASSES.indexOf(best.cls))) { best = p; bestD = Math.min(d, bestD); }
    }
  }
  return best;
}

export function bboxOf(coordsList) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const coords of coordsList) for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

// Sample a route every STEP_M metres -> [{lat,lng,d}] with cumulative distance
export function sampleRoute(coords) {
  const out = [];
  let dist = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = { lng: coords[i - 1][0], lat: coords[i - 1][1] };
    const b = { lng: coords[i][0], lat: coords[i][1] };
    const seg = haversine(a, b);
    const n = Math.max(1, Math.ceil(seg / STEP_M));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      out.push({ lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n, d: dist + seg * k / n });
    }
    dist += seg;
  }
  return out;
}

// LandsD labels some segments generically ("Lift", "First floor"…) – not useful as a place name
const GENERIC = /^(lift|lifts|staircase|stairs?|escalators?|ramp|podium|footbridge|subway|walkway|footway|footpath|pavement|passageway|corridor|entrance|exit|covered walkway|(ground|first|second|third|\d+(st|nd|rd|th)?) floor)( \(.*\))?$/i;

// How sheltered is this route? Also returns colour runs for drawing and notable named places.
export function analyseRoute(index, coords) {
  const samples = sampleRoute(coords);
  const metres = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const runs = [];
  const places = new Map();
  let prev = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const hit = index ? nearest(index, s, MATCH_M) : null;
    const cls = hit?.cls || 'open';
    if (i > 0) metres[cls] += s.d - samples[i - 1].d;
    if (hit?.name && cls !== 'covered' && !GENERIC.test(hit.name) && !places.has(hit.name)) places.set(hit.name, { cls, nameZh: hit.nameZh || null });
    if (!prev || prev.cls !== cls) {
      if (prev) prev.coords.push([s.lng, s.lat]);
      prev = { cls, coords: [[s.lng, s.lat]] };
      runs.push(prev);
    } else prev.coords.push([s.lng, s.lat]);
  }
  // merge tiny runs (<25 m) into neighbours to avoid speckle
  const total = samples.length ? samples[samples.length - 1].d : 0;
  const sheltered = total - metres.open;
  return {
    totalM: Math.round(total),
    metres: Object.fromEntries(Object.entries(metres).map(([k, v]) => [k, Math.round(v)])),
    shelteredPct: total ? Math.round((sheltered / total) * 100) : 0,
    openM: Math.round(metres.open),
    // full resolution so the coloured runs follow the route exactly (thinned runs cut corners)
    runs: runs.filter((r) => r.coords.length > 1).map((r) => ({ cls: r.cls, coords: r.coords.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]) })),
    places: [...places.entries()].slice(0, 5).map(([name, v]) => ({ name, nameZh: v.nameZh, cls: v.cls })),
    samples: samples.length,
  };
}

// Pick waypoints that pull a walking route onto nearby sheltered infrastructure.
// Looks along the fastest route for sheltered stretches within `reach` metres that the route doesn't already use.
export function shelterWaypoints(index, coords, { reach = 220, max = 3, avoid = [], hazards = [] } = {}) {
  if (!index?.count) return [];
  const samples = sampleRoute(coords);
  if (samples.length < 6) return [];
  const total = samples[samples.length - 1].d;
  const picks = [];
  const sections = Math.min(4, Math.max(2, Math.round(total / 350)));
  for (let s = 0; s < sections; s++) {
    const mid = samples[Math.floor(((s + 0.5) / sections) * (samples.length - 1))];
    let best = null, bestScore = 0;
    const cx = Math.floor(mid.lng / CELL), cy = Math.floor(mid.lat / CELL), r = Math.ceil(reach / 20);
    for (let dx = -r; dx <= r; dx += 2) for (let dy = -r; dy <= r; dy += 2) {
      const arr = index.grid.get(`${cx + dx},${cy + dy}`); if (!arr || arr.length < 3) continue;
      const p = arr[Math.floor(arr.length / 2)];
      if (avoid.includes(p.cls)) continue;
      // skip shelter inside or right next to a flood (subways there are already treated as flooded)
      if (hazards.some((h) => haversine(p, h) < (h.radius || 40) + 50)) continue;
      const d = haversine(mid, p);
      if (d > reach || d < 20) continue;
      // density of shelter around the candidate, weighted by class quality, minus distance
      const weight = { indoor: 1.4, underground: 1.1, footbridge: 1.2, covered: 1 }[p.cls] || 1;
      const score = Math.min(arr.length, 12) * weight - d / 40;
      if (score > bestScore) { bestScore = score; best = { lat: p.lat, lng: p.lng, cls: p.cls, name: p.name, along: mid.d }; }
    }
    if (best && !picks.some((q) => haversine(q, best) < 120)) picks.push(best);
  }
  return picks.sort((a, b) => a.along - b.along).slice(0, max);
}

// Underground points close to a flood hazard: subways flood first, so treat them as dangerous
export function floodedUnderground(index, hazards) {
  if (!index?.count) return [];
  const out = [];
  for (const h of hazards) {
    if (h.severity < 1) continue;
    const r = (h.radius || 40) + 40;
    const cx = Math.floor(h.lng / CELL), cy = Math.floor(h.lat / CELL), n = Math.ceil(r / 20);
    let found = null;
    for (let dx = -n; dx <= n && !found; dx++) for (let dy = -n; dy <= n && !found; dy++) {
      for (const p of index.grid.get(`${cx + dx},${cy + dy}`) || []) {
        if (p.cls === 'underground' && haversine(p, h) <= r) { found = p; break; }
      }
    }
    if (found) out.push({ hazardId: h.id, lat: found.lat, lng: found.lng, severity: h.severity });
  }
  return out;
}
