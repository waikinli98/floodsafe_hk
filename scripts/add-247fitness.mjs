// Adds every 24/7 Fitness branch in Hong Kong to public/umbrellas.json as a members-only umbrella point.
// Branch locations come from Google Places Text Search; the service rules are 24/7 Fitness's own notice.
// Run: node --env-file=.env scripts/add-247fitness.mjs   (safe to re-run: replaces the previous 24/7 entries)
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.MAPS_SERVER_KEY;
const FILE = new URL('../public/umbrellas.json', import.meta.url);
const REGIONS = [ // bias boxes so each search returns the branches of one area (Places caps a query at 60 results)
  { name: 'HK Island', low: [22.19, 114.10], high: [22.30, 114.26] },
  { name: 'Kowloon', low: [22.29, 114.13], high: [22.35, 114.24] },
  { name: 'NT East', low: [22.34, 114.15], high: [22.55, 114.30] },
  { name: 'NT West & Islands', low: [22.20, 113.82], high: [22.55, 114.15] },
];
const inHK = (lat, lng) => lat > 22.13 && lat < 22.58 && lng > 113.82 && lng < 114.45;

const found = new Map();
for (const r of REGIONS) {
  let pageToken;
  for (let page = 0; page < 3; page++) {
    const res = await (await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,nextPageToken' },
      body: JSON.stringify({ textQuery: '24/7 Fitness', languageCode: 'zh-HK', regionCode: 'HK', pageSize: 20, pageToken,
        locationRestriction: { rectangle: { low: { latitude: r.low[0], longitude: r.low[1] }, high: { latitude: r.high[0], longitude: r.high[1] } } } }),
    })).json();
    for (const p of res.places || []) {
      const name = p.displayName?.text || '';
      if (!/24\s*\/\s*7\s*fitness/i.test(name) || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
      if (!inHK(p.location.latitude, p.location.longitude)) continue;
      found.set(p.id, { id: p.id, name, address: (p.formattedAddress || '').replace(/^香港(?!島)/, ''), lat: p.location.latitude, lng: p.location.longitude });
    }
    pageToken = res.nextPageToken;
    if (!pageToken) break;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  console.log(`${r.name}: ${found.size} branches so far`);
}

// English branch names (Places returns the listing's English name with languageCode=en)
for (const b of found.values()) {
  try {
    const d = await (await fetch(`https://places.googleapis.com/v1/places/${b.id}?languageCode=en`, { headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'displayName' } })).json();
    b.nameEn = d.displayName?.text || null;
  } catch { b.nameEn = null; }
}

const SERVICE = '借遮服務暫時支援單店借、單店還，會員須於借出嘅分店歸還，不設跨店歸還。';
const TERMS = '📍 服務時間：\n▫️ 星期一至五：12:00 - 21:00\n▫️ 星期六：12:00 - 18:00\n（星期日及公眾假期休息）';
const data = JSON.parse(readFileSync(FILE, 'utf8'));
data.stations = data.stations.filter((s) => !s.source247);
let i = 0;
for (const b of found.values()) {
  i++;
  data.stations.push({
    id: `f247-${i}`, source247: true,
    name: b.name, nameEn: /[\u4e00-\u9fff]/.test(b.nameEn || '') || !b.nameEn ? b.name : b.nameEn,
    address: b.address, lat: Math.round(b.lat * 1e6) / 1e6, lng: Math.round(b.lng * 1e6) / 1e6,
    category: '健身中心', categoryEn: 'Fitness centre', eligibility: '24/7 Fitness 會員', eligibilityEn: '24/7 Fitness members',
    service: SERVICE, serviceEn: 'Umbrellas can be borrowed and returned at the same branch only: members must return the umbrella to the branch they borrowed it from (no cross-branch returns).',
    terms: TERMS, termsEn: 'Service hours:\n▫️ Monday to Friday: 12:00 – 21:00\n▫️ Saturday: 12:00 – 18:00\n(Closed on Sundays and public holidays)',
    link: 'https://247.fitness/',
  });
}
writeFileSync(FILE, JSON.stringify(data));
console.log(`added ${found.size} 24/7 Fitness branches; ${data.stations.length} stations in total`);
