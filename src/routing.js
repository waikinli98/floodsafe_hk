// Flood-aware routing on top of the Google Routes API.
// Routes API has no "avoid this polygon" option, so we:
//   1. ask for the normal route + alternatives,
//   2. score each against active flood hazards,
//   3. if every route crosses a blocking hazard, generate detour waypoints
//      beside each blocking hazard and re-query, then pick the safest/fastest.
import { distToPolyline, offset, direction, haversine } from './geo.js';
import { shelterIndex, analyseRoute, shelterWaypoints, floodedUnderground, bboxOf } from './shelter.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = [
  'routes.duration', 'routes.distanceMeters', 'routes.polyline.geoJsonLinestring',
  'routes.legs.steps.navigationInstruction', 'routes.legs.steps.distanceMeters', 'routes.legs.steps.startLocation',
].join(',');

// blockAt = minimum hazard severity that makes a route segment unacceptable
// Walking only: ankle-deep (severity 2) or worse blocks a route segment
export const PROFILES = {
  walk: { travelMode: 'WALK', blockAt: 2, label: 'Walking' },
};
// CoolMap-style preference: which option comes first, and how much longer a route may be
export const PREFERENCES = {
  shortest: { first: ['fastest'], maxStretch: 1.25 },
  balanced: { first: ['balanced', 'driest', 'fastest'], maxStretch: 1.5 },
  covered: { first: ['driest', 'balanced', 'fastest'], maxStretch: 2.0 },
};

export function routingEnabled() {
  return Boolean(process.env.MAPS_SERVER_KEY);
}

const ll = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

async function computeRoutes({ origin, destination, intermediates = [], travelMode, alternatives, lang = 'en' }) {
  const body = {
    origin: ll(origin),
    destination: ll(destination),
    travelMode,
    polylineEncoding: 'GEO_JSON_LINESTRING',
    languageCode: lang === 'zh' ? 'zh-HK' : 'en',
    regionCode: 'HK',
    units: 'METRIC',
  };
  if (intermediates.length) body.intermediates = intermediates.map(ll);
  else if (alternatives) body.computeAlternativeRoutes = true;
  if (travelMode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';

  const res = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.MAPS_SERVER_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Routes API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return (json.routes || []).map((r) => ({
    durationS: parseInt(String(r.duration || '0').replace('s', ''), 10) || 0,
    distanceM: r.distanceMeters || 0,
    coords: r.polyline?.geoJsonLinestring?.coordinates || [],
    steps: (r.legs || []).flatMap((l) => l.steps || [])
      .map((s) => ({ text: s.navigationInstruction?.instructions, distanceM: s.distanceMeters, lat: s.startLocation?.latLng?.latitude, lng: s.startLocation?.latLng?.longitude }))
      .filter((s) => s.text),
  }));
}

function score(route, hazards, profile) {
  const hits = [];
  for (const h of hazards) {
    const d = distToPolyline(h, route.coords);
    if (d <= h.radius) hits.push({ id: h.id, severity: h.severity, distanceM: Math.round(d) });
  }
  const blocking = hits.filter((x) => x.severity >= profile.blockAt);
  const hazardById = new Map(hazards.map((h) => [h.id, h]));
  const risk = hits.reduce((s, x) => s + x.severity ** 2 * (hazardById.get(x.id)?.trust ?? 0.5), 0);
  return { ...route, hits, blocking, risk: Math.round(risk * 100) / 100 };
}

// Candidate routes don't depend on the preference, so all three preferences share one pool
// (cached briefly: switching Shortest / Balanced / Most covered is instant and always consistent).
const POOL_TTL = 3 * 60_000;
const poolCache = new Map();
const poolKey = (o, d, hz, lang) => lang + '|' + [o.lat, o.lng, d.lat, d.lng].map((v) => v.toFixed(5)).join(',') + '|' +
  hz.map((h) => `${h.id}:${h.severity}:${h.radius}`).sort().join(';');

export async function planRoute({ origin, destination, preference = 'balanced', hazards: allHazards, lang = 'en' }) {
  const mode = 'walk';
  const profile = PROFILES.walk;
  const pref = PREFERENCES[preference] ? preference : 'balanced';
  const k = poolKey(origin, destination, allHazards, lang);
  let entry = poolCache.get(k);
  if (!entry || Date.now() - entry.at > POOL_TTL) {
    entry = { at: Date.now(), pool: buildPool({ origin, destination, allHazards, profile, lang }) };
    poolCache.set(k, entry);
    entry.pool.catch(() => poolCache.delete(k));
    for (const [kk, v] of poolCache) if (Date.now() - v.at > POOL_TTL) poolCache.delete(kk);
  }
  const { candidates, fastest, hazards, atEndpoint, index, shelterError, floodedSubways } = await entry.pool;
  return chooseOptions({ mode, profile, pref, candidates, fastest, hazards, atEndpoint, index, shelterError, floodedSubways });
}

async function buildPool({ origin, destination, allHazards, profile, lang }) {
  const walking = profile.travelMode === 'WALK';
  // A hazard covering the start or end can't be routed around – report it instead of failing every route.
  const atEndpoint = allHazards.filter((h) => haversine(h, origin) <= h.radius || haversine(h, destination) <= h.radius);
  const endpointIds = new Set(atEndpoint.map((h) => h.id));
  let hazards = allHazards.filter((h) => !endpointIds.has(h.id));

  const base = await computeRoutes({ origin, destination, travelMode: profile.travelMode, alternatives: true, lang });
  if (!base.length) throw new Error('No route found between these points');
  let candidates = base.map((r, i) => ({ ...score(r, hazards, profile), kind: i === 0 ? 'fastest' : 'alternative' }));
  const fastest = candidates[0];
  const seen = new Set(candidates.map(key));
  const add = (list) => { for (const r of list) { if (!seen.has(key(r))) { seen.add(key(r)); candidates.push(r); } } };

  // 1. Detours around blocking floods – always tried when the fastest route is flooded, so there is a real choice
  //    between "go round close to the flood" and Google's own alternatives
  if (fastest.blocking.length) {
    const haveSafe = candidates.some((c) => c.blocking.length === 0);
    add(await detours({ origin, destination, profile, hazards, fastest, lang, max: haveSafe ? 8 : 12 }));
  }

  // 2. Shelter: covered walkways, footbridges, malls and subways from the LandsD 3D Pedestrian Network
  let index = null, shelterError = null, floodedSubways = [];
  if (walking) {
    try {
      index = await shelterIndex(bboxOf([...candidates.map((c) => c.coords), [[origin.lng, origin.lat], [destination.lng, destination.lat]]]));
    } catch (e) { shelterError = e.message; console.warn('shelter index:', e.message); }
  }
  if (index?.count) {
    // Subways near a flood are treated as flooded (they fill first)
    floodedSubways = floodedUnderground(index, hazards);
    if (floodedSubways.length) {
      hazards = [...hazards, ...floodedSubways.map((f) => ({
        id: `subway-${f.hazardId}`, lat: f.lat, lng: f.lng, radius: 25, severity: Math.max(3, f.severity), trust: 0.8,
        kind: 'underground', placeHint: 'Pedestrian subway near reported flooding',
        ai: { description_en: 'Pedestrian subway next to a flood – underground passages flood first.' },
      }))];
      candidates = candidates.map((c) => ({ ...c, ...score(c, hazards, profile) }));
    }
    const safeNow = candidates.filter((c) => c.blocking.length === 0);
    const seedRoute = (safeNow.length ? safeNow.reduce((a, b) => (b.durationS < a.durationS ? b : a)) : fastest);
    // Never pull a route onto shelter that sits inside (or right next to) a flood
    const blockers = hazards.filter((h) => h.severity >= profile.blockAt);
    // Sheltered stretches near the safe route and near the direct (possibly flooded) line – short pulls and bigger detours
    const wps = [];
    const seenWp = new Set();
    for (const seed of [seedRoute, fastest]) {
      for (const reach of [180, 350]) {
        for (const w of shelterWaypoints(index, seed.coords, { reach, hazards: blockers })) {
          const wk = `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`;
          if (!seenWp.has(wk)) { seenWp.add(wk); wps.push(w); }
        }
      }
    }
    const tries = wps.slice(0, 5).map((w) => [w]);
    if (wps.length >= 2) tries.push(wps.slice(0, 2));
    if (wps.length >= 3) tries.push(wps.slice(0, 3), wps.slice(1, 3));
    const run = (list, kind) => Promise.all(list.map((pts) =>
      computeRoutes({ origin, destination, intermediates: pts, travelMode: profile.travelMode, lang })
        .then((rs) => rs.map((r) => ({ ...score(r, hazards, profile), kind, via: pts })))
        .catch(() => [])));
    const results = (await run(tries.slice(0, 8), 'sheltered')).flat();
    add(results);
    // Shelter routes that still cross a flood: keep the walkway, add the detour point that made a safe route
    const safeDetour = candidates.filter((c) => c.kind === 'detour' && c.blocking.length === 0)
      .sort((a, b) => a.durationS - b.durationS)[0];
    if (safeDetour?.via?.length) {
      const fromStart = (p) => haversine(origin, p);
      const fixes = results.filter((r) => r.blocking.length && r.via?.length).slice(0, 4)
        .map((r) => [...r.via, ...safeDetour.via].sort((a, b) => fromStart(a) - fromStart(b)));
      add((await run(fixes, 'sheltered')).flat());
    }
    for (const c of candidates) c.shelter = analyseRoute(index, c.coords);
  }
  return { candidates, fastest, hazards, atEndpoint, index, shelterError, floodedSubways };
}

function chooseOptions({ mode, profile, pref, candidates, fastest, hazards, atEndpoint, index, shelterError, floodedSubways }) {
  // 3. Choose up to three distinct options
  const options = pickOptions(candidates, fastest, { hasShelter: Boolean(index?.count), pref });
  const fastestHits = new Set();
  for (const h of fastest.hits) fastestHits.add(h.id);
  const decorate = (o) => {
    const own = new Set(o.hits.map((h) => h.id));
    return {
      ...slim(o, true), tag: o.tag, shelter: o.shelter || null, via: o.via,
      safe: o.blocking.length === 0,
      avoidedHazardIds: [...fastestHits].filter((id) => !own.has(id)),
      remainingHazards: o.hits,
      extraSeconds: Math.max(0, o.durationS - fastest.durationS),
    };
  };
  const out = options.map(decorate);
  const rec = out[0];
  const hazardInfo = Object.fromEntries(hazards.filter((h) => h.id.startsWith('subway-')).map((h) => [h.id, { source: 'subway', severity: h.severity, description: h.ai.description_en, place: h.placeHint }]));

  return {
    mode, profile: profile.label, preference: pref,
    options: out,
    recommended: 0,
    // met unless the user asked for cover but nothing more sheltered than the fastest route exists
    preferenceMet: pref === 'shortest' || out[0]?.tag !== 'fastest',
    // back-compat fields describe the recommended option
    safeRouteFound: rec.safe,
    chosen: rec,
    // the plain fastest route, drawn red-dashed only when it runs through flooding
    fastest: fastest.blocking.length && key(fastest) !== key(options[0]) ? slim(fastest, false) : null,
    fastestUnsafe: fastest.blocking.length > 0,
    avoidedHazardIds: rec.avoidedHazardIds,
    remainingHazards: rec.remainingHazards,
    endpointHazards: atEndpoint.map((h) => ({ id: h.id, severity: h.severity })),
    extraSeconds: rec.extraSeconds,
    candidatesEvaluated: candidates.length,
    // ?debug: every candidate's time, safety and shelter, to tune option picking
    debugCandidates: process.env.ROUTE_DEBUG === '1' ? candidates.map((c) => ({ kind: c.kind, min: Math.round(c.durationS / 6) / 10, m: c.distanceM, safe: c.blocking.length === 0, blocking: c.blocking.map((b) => b.id), pct: c.shelter?.shelteredPct })) : undefined,
    shelter: { available: Boolean(index?.count), error: shelterError, floodedSubways: floodedSubways.length, source: 'Lands Department 3D Pedestrian Network (CSDI)' },
    extraHazardInfo: hazardInfo,
  };
}

async function detours({ origin, destination, profile, hazards, fastest, lang, max = 12 }) {
  const byId = new Map(hazards.map((h) => [h.id, h]));
  const distToStart = (h) => Math.hypot(h.lat - origin.lat, h.lng - origin.lng);
  const blockers = fastest.blocking.map((b) => byId.get(b.id)).filter(Boolean).sort((a, b) => distToStart(a) - distToStart(b)).slice(0, 3);
  const [ex, ny] = direction(origin, destination);
  const perp = [-ny, ex]; // left-hand perpendicular (east, north)
  const tries = [];
  // Bypass on a parallel street: one point before and one after the flood, both off to the side,
  // so the walk never has to cross the flooded junction to reach the waypoint (tried first).
  for (const side of [1, -1]) {
    for (const h of blockers.slice(0, 2)) {
      const d = h.radius * 2.2 + 60;
      const at = (along) => offset(h.lat, h.lng, perp[0] * side * d + ex * along, perp[1] * side * d + ny * along);
      tries.push([at(-d), at(d)]);
    }
  }
  for (const side of [1, -1]) {
    for (const mult of [2.2, 4]) {
      for (const h of blockers) {
        const d = h.radius * mult + 40;
        tries.push([offset(h.lat, h.lng, perp[0] * side * d, perp[1] * side * d)]);
      }
      if (blockers.length > 1) {
        tries.push(blockers.map((h) => { const d = h.radius * mult + 40; return offset(h.lat, h.lng, perp[0] * side * d, perp[1] * side * d); }));
      }
    }
  }
  const results = await Promise.all(tries.slice(0, max).map((pts) =>
    computeRoutes({ origin, destination, intermediates: pts, travelMode: profile.travelMode, lang })
      .then((rs) => rs.map((r) => ({ ...score(r, hazards, profile), kind: 'detour', via: pts })))
      .catch(() => [])));
  return results.flat();
}

// Fastest safe · Balanced · Driest (most sheltered)
function pickOptions(candidates, fastest, { hasShelter, pref }) {
  const stretch = PREFERENCES[pref].maxStretch;
  let valid = candidates.filter((c) => c.blocking.length === 0 && c.durationS <= fastest.durationS * stretch + 240);
  if (!valid.length) valid = candidates.filter((c) => c.blocking.length === 0);
  if (!valid.length) {
    const least = candidates.reduce((a, b) => (b.risk < a.risk || (b.risk === a.risk && b.durationS < a.durationS) ? b : a));
    return [{ ...least, tag: 'least-risk' }];
  }
  const pct = (c) => c.shelter?.shelteredPct ?? 0;
  const quick = valid.reduce((a, b) => (b.durationS < a.durationS || (b.durationS === a.durationS && b.risk < a.risk) ? b : a));
  const picks = [{ ...quick, tag: 'fastest' }];
  if (hasShelter) {
    const driest = valid.reduce((a, b) => (pct(b) > pct(a) || (pct(b) === pct(a) && b.durationS < a.durationS) ? b : a));
    const base = quick.durationS || 1;
    const util = (c) => pct(c) / 100 - 0.6 * ((c.durationS - base) / base) - 0.05 * c.risk;
    const balancedPool = valid.filter((c) => c !== quick && c !== driest && pct(c) > pct(quick) + 4);
    const balanced = balancedPool.length ? balancedPool.reduce((a, b) => (util(b) > util(a) ? b : a)) : null;
    if (balanced && util(balanced) > util(quick)) picks.push({ ...balanced, tag: 'balanced' });
    const balPick = picks.find((p) => p.tag === 'balanced');
    if (driest !== quick && pct(driest) >= pct(quick) + 8 && (!balPick || (pct(driest) >= pct(balPick) + 5 && key(driest) !== key(balPick)))) picks.push({ ...driest, tag: 'driest' });
  } else {
    const alt = valid.filter((c) => c !== quick).sort((a, b) => a.risk - b.risk || a.durationS - b.durationS)[0];
    if (alt && alt.durationS <= quick.durationS * 1.4) picks.push({ ...alt, tag: 'alternative' });
  }
  // The user's preference decides which option is shown first
  for (const tag of [...PREFERENCES[pref].first].reverse()) {
    const p = picks.find((x) => x.tag === tag);
    if (p) { picks.splice(picks.indexOf(p), 1); picks.unshift(p); }
  }
  return picks.slice(0, 3);
}

function key(r) {
  const mid = r.coords[Math.floor(r.coords.length / 2)] || [];
  return `${r.durationS}|${r.distanceM}|${r.coords.length}|${mid.map((v) => v.toFixed(4)).join(',')}`;
}
function slim(r, withSteps) {
  return {
    kind: r.kind, durationS: r.durationS, distanceM: r.distanceM, coords: r.coords,
    hits: r.hits, blocking: r.blocking, risk: r.risk, steps: withSteps ? r.steps : undefined,
  };
}
