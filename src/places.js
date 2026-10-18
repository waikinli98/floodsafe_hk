// "Find shelter": nearby indoor places (MTR stations, malls, libraries, community centres)
// via Places API (New) searchNearby, excluding anything inside an active flood zone.
import { haversine } from './geo.js';

// lang: 'en' | 'zh' (Traditional Chinese, Hong Kong)
const gLang = (lang) => (lang === 'zh' ? 'zh-HK' : 'en');

// Only places whose MAIN type is an indoor public space. (includedTypes would also match any shop that merely
// sits inside a mall – e.g. a beauty salon tagged "shopping_mall" – so we filter on the primary type.)
// (sports_complex and ferry_terminal are left out: in HK many are open-air – water-sports centres, pitches, village piers.)
export const SHELTER_TYPES = ['subway_station', 'train_station', 'light_rail_station', 'shopping_mall',
  'department_store', 'library', 'community_center'];
const MALLISH = new Set(['shopping_mall', 'department_store']);
// A single shop inside a mall that Google also types as a mall: its address has a shop/unit number
const SHOP_ADDR = /\b(shop|unit|kiosk)\s*[a-z]?\d|[舖铺]/i;

async function nearbyShelters(lat, lng, radius, lang, types = SHELTER_TYPES, rank = 'DISTANCE') {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.MAPS_SERVER_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType,places.primaryTypeDisplayName,places.formattedAddress,places.shortFormattedAddress,places.businessStatus,places.userRatingCount',
    },
    body: JSON.stringify({
      includedPrimaryTypes: types,
      maxResultCount: 20,
      rankPreference: rank,
      languageCode: gLang(lang),
      regionCode: 'hk',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Places API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).places || [];
}

export async function findShelters({ lat, lng, hazards = [], lang = 'en' }) {
  // 1.2 km first (a short walk in the rain); widen to 3 km in quieter areas (outlying islands, country parks)
  // Two searches: stations / libraries / community halls by distance, and malls by popularity – in busy districts
  // the 20 nearest "malls" are mostly single shops, while the well-known malls rank first by popularity.
  const NON_MALL = SHELTER_TYPES.filter((t) => !MALLISH.has(t));
  const search = (r) => Promise.all([nearbyShelters(lat, lng, r, lang, NON_MALL), nearbyShelters(lat, lng, r, lang, [...MALLISH], 'POPULARITY')]).then(([a, b]) => [...a, ...b]);
  let radiusM = 1200;
  let places = await search(radiusM);
  if (places.length < 3) { radiusM = 3000; places = await search(radiusM); }
  const seen = new Set();
  const ok = places.filter((p) => p.location && p.displayName?.text && SHELTER_TYPES.includes(p.primaryType)
    && (!p.businessStatus || p.businessStatus === 'OPERATIONAL')
    && !(MALLISH.has(p.primaryType) && SHOP_ADDR.test(`${p.formattedAddress || ''} ${p.shortFormattedAddress || ''}`))
    // a real mall has many Google reviews; a lone shop typed as a "mall" has a handful
    && !(MALLISH.has(p.primaryType) && (p.userRatingCount || 0) < 40));
  // Shops inside a big mall often come back as "malls" too: within 150 m keep only the best-known mall
  const malls = ok.filter((p) => MALLISH.has(p.primaryType)).sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));
  const keptMalls = [];
  for (const m of malls) {
    const at = { lat: m.location.latitude, lng: m.location.longitude };
    if (!keptMalls.some((k) => haversine(at, { lat: k.location.latitude, lng: k.location.longitude }) < 150)) keptMalls.push(m);
  }
  const shelters = ok
    .filter((p) => !MALLISH.has(p.primaryType) || keptMalls.includes(p))
    .map((p) => {
      const loc = { lat: p.location.latitude, lng: p.location.longitude };
      const flooded = hazards.find((h) => h.severity >= 2 && haversine(loc, h) <= (h.radius || 40) + 20);
      return {
        id: p.id, name: p.displayName.text, type: p.primaryType, typeLabel: p.primaryTypeDisplayName?.text || null,
        address: p.shortFormattedAddress || p.formattedAddress, ...loc,
        distanceM: Math.round(haversine({ lat, lng }, loc)), floodedNearby: Boolean(flooded),
      };
    })
    // MTR stations come back once per exit/platform entry with the same name – keep the nearest
    .filter((s) => { const k = s.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.floodedNearby - b.floodedNearby || a.distanceM - b.distanceM)
    .slice(0, 12);
  return { shelters, radiusM };
}

// ---------- Search box (Places API New: Autocomplete + Place Details) ----------
// Server-side so the app controls the input text (e.g. it can show a picked address in the same box).
const hasChinese = (s) => /[㐀-鿿]/.test(s);

export async function autocomplete({ input, sessionToken, lat, lng, lang = 'en' }) {
  const body = {
    input: String(input).slice(0, 120),
    includedRegionCodes: ['hk'],
    languageCode: hasChinese(input) || lang === 'zh' ? 'zh-HK' : 'en',
    sessionToken,
  };
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 20000 } };
  }
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.MAPS_SERVER_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Places autocomplete ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.suggestions || []).map((s) => s.placePrediction).filter(Boolean).slice(0, 6).map((p) => ({
    placeId: p.placeId,
    main: p.structuredFormat?.mainText?.text || p.text?.text,
    secondary: p.structuredFormat?.secondaryText?.text || '',
  }));
}

export async function placeDetails(id, sessionToken, lang = 'en') {
  const q = new URLSearchParams({ languageCode: gLang(lang) });
  if (sessionToken) q.set('sessionToken', sessionToken);
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?${q}`;
  const res = await fetch(url, {
    headers: { 'X-Goog-Api-Key': process.env.MAPS_SERVER_KEY, 'X-Goog-FieldMask': 'id,displayName,location,formattedAddress' },
  });
  if (!res.ok) throw new Error(`Place details ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const p = await res.json();
  return { id: p.id, name: p.displayName?.text, address: p.formattedAddress, lat: p.location.latitude, lng: p.location.longitude };
}

// Map tap on a Google place (POI icon): a short info card – name, type, address, open now, phone
export async function placeInfo(id, lang = 'en') {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=${gLang(lang)}`, {
    headers: { 'X-Goog-Api-Key': process.env.MAPS_SERVER_KEY, 'X-Goog-FieldMask': 'id,displayName,location,formattedAddress,primaryTypeDisplayName,nationalPhoneNumber,currentOpeningHours.openNow,currentOpeningHours.weekdayDescriptions,googleMapsUri' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Place details ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const p = await res.json();
  return {
    id: p.id, name: p.displayName?.text, address: (p.formattedAddress || '').replace(/^香港/, ''), lat: p.location.latitude, lng: p.location.longitude,
    type: p.primaryTypeDisplayName?.text || null, phone: p.nationalPhoneNumber || null,
    openNow: p.currentOpeningHours?.openNow ?? null, hours: p.currentOpeningHours?.weekdayDescriptions || null, mapsUri: p.googleMapsUri || null,
  };
}

// Free-text place -> coordinates (used by the Ask Me assistant). Cached; biased to Hong Kong.
const findCache = new Map();
export async function findPlace(text, lang = 'en') {
  const k = text.trim().toLowerCase();
  if (findCache.has(k)) return findCache.get(k);
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', signal: AbortSignal.timeout(6000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.MAPS_SERVER_KEY, 'X-Goog-FieldMask': 'places.displayName,places.location' },
    body: JSON.stringify({ textQuery: /hong kong|香港/i.test(text) ? text : `${text} Hong Kong`, languageCode: gLang(lang), regionCode: 'HK', pageSize: 1,
      locationBias: { rectangle: { low: { latitude: 22.13, longitude: 113.82 }, high: { latitude: 22.58, longitude: 114.45 } } } }),
  });
  if (!res.ok) throw new Error(`Places ${res.status}`);
  const p = (await res.json()).places?.[0];
  const out = p ? { lat: p.location.latitude, lng: p.location.longitude, label: p.displayName?.text || text } : null;
  if (findCache.size > 500) findCache.clear();
  findCache.set(k, out);
  return out;
}

// ---------- Reverse geocoding: coordinates -> short, human label ----------
const PREFERRED = ['point_of_interest', 'establishment', 'premise', 'street_address', 'intersection', 'route', 'neighborhood', 'sublocality'];
export async function reverseGeocode(lat, lng, lang = 'en') {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${gLang(lang)}&key=${process.env.MAPS_SERVER_KEY}`;
  const json = await (await fetch(url, { signal: AbortSignal.timeout(6000) })).json();
  if (json.status !== 'OK' || !json.results?.length) return { label: null, status: json.status };
  const pick = PREFERRED.map((t) => json.results.find((r) => r.types?.includes(t))).find(Boolean) || json.results[0];
  const comp = (type) => pick.address_components?.find((c) => c.types.includes(type))?.long_name;
  const area = comp('neighborhood') || comp('sublocality') || comp('administrative_area_level_1');
  const label = String(pick.formatted_address || '')
    .replace(/,?\s*Hong Kong$/i, '').replace(/^Hong Kong,?\s*/i, '').replace(/^香港/, '')
    .split(',').slice(0, 2).map((s) => s.trim()).filter(Boolean).join(', ');
  return { label: label || area || null, area };
}
