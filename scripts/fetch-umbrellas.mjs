// Builds public/umbrellas.json from the community "2025香港借遮地圖" (Google My Maps).
// Run: node --env-file=.env scripts/fetch-umbrellas.mjs   (then re-run scripts/add-247fitness.mjs, which this overwrites)
//  1. downloads the map as KML (the stations have addresses only, no coordinates)
//  2. drops the folder of malls that cancelled the service, and SF Express points (the map notes SF's umbrella
//     lending ended at the end of 2025)
//  3. geocodes each address (Geocoding API, falls back to Places Text Search for names like "赤柱廣場")
//  4. Gemini translates names and service descriptions to English (the original Chinese is kept and shown too)
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { GoogleGenAI, Type } from '@google/genai';

const MID = '1WwnPb-zdv3BTyZoq-fhpb8AEfi2IBJs';
const SOURCE_URL = `https://www.google.com/maps/d/u/0/viewer?mid=${MID}`;
const KEY = process.env.MAPS_SERVER_KEY;
const OUT = new URL('../public/umbrellas.json', import.meta.url);
if (!KEY) throw new Error('MAPS_SERVER_KEY missing');

const unescape = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml); return m ? unescape(m[1]) : ''; };

const kml = await (await fetch(`https://www.google.com/maps/d/kml?mid=${MID}&forcekml=1`)).text();
const docName = tag(kml.split('<Folder>')[0], 'name');
const docNote = tag(kml.split('<Folder>')[0], 'description').replace(/<br>/g, '\n');
const folders = kml.split('<Folder>').slice(1);
const active = folders.find((f) => tag(f, 'name').includes('借遮站點')) || folders[0];
const placemarks = active.split('<Placemark>').slice(1).map((p) => {
  const data = {};
  for (const m of p.matchAll(/<Data name="([^"]+)">\s*<value>([\s\S]*?)<\/value>/g)) data[m[1]] = unescape(m[2]);
  return { name: tag(p, 'name'), address: tag(p, 'address'), data };
});
const isSF = (p) => /順豐|SFHK/i.test(`${p.name} ${p.data['使用者範圍']} ${p.data['內容']}`);
const keep = placemarks.filter((p) => !isSF(p));
console.log(`${docName}: ${placemarks.length} active points, ${placemarks.length - keep.length} SF Express points dropped, ${keep.length} kept`);

// ---------- geocoding (cached between runs) ----------
const CACHE = new URL('./umbrella-geocache.json', import.meta.url);
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const inHK = (lat, lng) => lat > 22.13 && lat < 22.58 && lng > 113.82 && lng < 114.45;
async function geocode(p) {
  const k = `${p.name}|${p.address}`;
  if (cache[k]) return cache[k];
  const q = /香港|Hong Kong/.test(p.address) ? p.address : `香港 ${p.address}`;
  const g = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=hk&language=zh-HK&components=country:HK&key=${KEY}`)).json();
  let best = g.results?.[0];
  let out = best && inHK(best.geometry.location.lat, best.geometry.location.lng) && best.geometry.location_type !== 'APPROXIMATE'
    ? { lat: best.geometry.location.lat, lng: best.geometry.location.lng, via: 'geocode', precision: best.geometry.location_type } : null;
  if (!out) {
    // building / mall names geocode badly: ask Places for "name + address"
    const r = await (await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'places.location,places.formattedAddress' },
      body: JSON.stringify({ textQuery: `${p.name} ${p.address}`, languageCode: 'zh-HK', regionCode: 'HK', locationBias: { rectangle: { low: { latitude: 22.13, longitude: 113.82 }, high: { latitude: 22.58, longitude: 114.45 } } } }),
    })).json();
    const pl = r.places?.[0];
    if (pl && inHK(pl.location.latitude, pl.location.longitude)) out = { lat: pl.location.latitude, lng: pl.location.longitude, via: 'places' };
    else if (best && inHK(best.geometry.location.lat, best.geometry.location.lng)) out = { lat: best.geometry.location.lat, lng: best.geometry.location.lng, via: 'geocode', precision: 'APPROXIMATE' };
  }
  if (out) { cache[k] = out; writeFileSync(CACHE, JSON.stringify(cache)); }
  return out;
}

const stations = [];
let missing = 0;
for (const [i, p] of keep.entries()) {
  const loc = await geocode(p);
  if (!loc) { missing++; console.warn('  not found:', p.name, p.address); continue; }
  const d = p.data;
  stations.push({
    id: `u${i + 1}`, name: p.name, address: d['地點'] || p.address, lat: Math.round(loc.lat * 1e6) / 1e6, lng: Math.round(loc.lng * 1e6) / 1e6,
    approx: loc.precision === 'APPROXIMATE' || undefined,
    category: d['類別'] || '', eligibility: d['使用者範圍'] || '', service: d['內容'] || '', terms: d['限制及相關資訊'] || '', link: d['Link'] || '',
  });
}
console.log(`${stations.length} geocoded, ${missing} not found`);

// ---------- English (Gemini, translated once here – never at request time) ----------
const uniq = [...new Set(stations.flatMap((s) => [s.name, s.category, s.eligibility, s.service, s.terms]).concat([docNote]).filter((x) => x && x !== '/'))];
const en = {};
if (process.env.GEMINI_API_KEY) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  for (let i = 0; i < uniq.length; i += 40) {
    const batch = uniq.slice(i, i + 40);
    // busy models (503 / 429): retry, then fall back to the lighter models
    const models = [process.env.GEMINI_MODEL || 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
    let res, lastErr;
    for (let attempt = 0; attempt < 9 && !res; attempt++) {
      try { res = await ai.models.generateContent({ ...req(batch), model: models[attempt % models.length] }); }
      catch (e) { lastErr = e; console.warn(`  retry (${e.status || e.message})`); await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
    }
    if (!res) throw lastErr;
    const arr = JSON.parse(res.text);
    batch.forEach((s, j) => { if (arr[j]) en[s] = arr[j]; });
    console.log(`  translated ${Math.min(i + 40, uniq.length)}/${uniq.length}`);
  }
}
function req(batch) {
  return {
      contents: [{ role: 'user', parts: [{ text: `Translate each Hong Kong Traditional Chinese / Cantonese string to natural English for a map app about free umbrella lending.
Keep brand and place names that already are English; for Chinese shop or mall names give the official English name if you are sure of it, otherwise a short romanised/translated name.
Keep HK$ amounts, hours and phone numbers exactly. Return the same number of items in the same order.
${JSON.stringify(batch)}` }] }],
      config: { responseMimeType: 'application/json', responseSchema: { type: Type.ARRAY, items: { type: Type.STRING } } },
  };
}
const E = (s) => en[s] || undefined;
for (const s of stations) Object.assign(s, { nameEn: E(s.name), categoryEn: E(s.category), eligibilityEn: E(s.eligibility), serviceEn: E(s.service), termsEn: E(s.terms) });

writeFileSync(OUT, JSON.stringify({
  title: docName, note: docNote, noteEn: E(docNote), source: SOURCE_URL, fetched: new Date().toISOString(),
  excluded: 'SF Express (順豐) points – the source notes that service ended at the end of 2025; malls marked as cancelled',
  stations,
}));
console.log('wrote public/umbrellas.json');
