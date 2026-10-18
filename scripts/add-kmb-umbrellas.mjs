// Adds KMB's free "落雨唔使怕" umbrella lending points (launched Aug 2026) to public/umbrellas.json.
// Locations: the 20 termini / interchanges listed in the announcement (reported by U Lifestyle, 17 Aug 2026).
// Positions come from Google Places Text Search. Safe to re-run: replaces the previous KMB entries.
// Run: node --env-file=.env scripts/add-kmb-umbrellas.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.MAPS_SERVER_KEY;
const FILE = new URL('../public/umbrellas.json', import.meta.url);
const SOURCE = 'https://hk.ulifestyle.com.hk/topic/detail/20106345';
const STOPS = [
  ['屯門公路轉車站（往九龍）', 'Tuen Mun Road Bus-Bus Interchange (to Kowloon)'],
  ['大欖隧道轉車站（往元朗）', 'Tai Lam Tunnel Bus-Bus Interchange (to Yuen Long)'],
  ['屯門碼頭巴士總站', 'Tuen Mun Ferry Pier Bus Terminus'],
  ['天恆邨巴士總站', 'Tin Heng Estate Bus Terminus'],
  ['天水圍市中心巴士總站', 'Tin Shui Wai Town Centre Bus Terminus'],
  ['逸東巴士總站', 'Yat Tung Bus Terminus'],
  ['葵芳站巴士總站', 'Kwai Fong Station Bus Terminus'],
  ['葵盛東巴士總站', 'Kwai Shing East Bus Terminus'],
  ['沙田市中心巴士總站', 'Sha Tin Town Centre Bus Terminus'],
  ['馬鞍山市中心巴士總站', 'Ma On Shan Town Centre Bus Terminus'],
  ['烏溪沙站巴士總站', 'Wu Kai Sha Station Bus Terminus'],
  ['大埔市中心巴士總站', 'Tai Po Central Bus Terminus'],
  ['聯和墟巴士總站', 'Luen Wo Hui Bus Terminus'],
  ['柏景灣巴士總站', 'Park Avenue Bus Terminus (Tai Kok Tsui)'],
  ['尖沙咀碼頭客務站', 'Tsim Sha Tsui Ferry Customer Service Centre'],
  ['樂富巴士總站', 'Lok Fu Bus Terminus'],
  ['彩虹巴士總站', 'Choi Hung Bus Terminus'],
  ['寶達邨巴士總站', 'Po Tat Estate Bus Terminus'],
  ['寶林巴士總站', 'Po Lam Bus Terminus'],
  ['鯉魚門邨巴士總站', 'Lei Yue Mun Estate Bus Terminus'],
];
const inHK = (lat, lng) => lat > 22.13 && lat < 22.58 && lng > 113.82 && lng < 114.45;

async function locate(zh, en) {
  for (const q of [`${zh} 九巴`, zh, en + ' Hong Kong']) {
    const r = await (await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location' },
      body: JSON.stringify({ textQuery: q, languageCode: 'zh-HK', regionCode: 'HK', pageSize: 1 }),
    })).json();
    const p = r.places?.[0];
    if (p && inHK(p.location.latitude, p.location.longitude)) return { lat: p.location.latitude, lng: p.location.longitude, address: p.formattedAddress || zh, found: p.displayName?.text };
  }
  return null;
}

const data = JSON.parse(readFileSync(FILE, 'utf8'));
data.stations = data.stations.filter((s) => !s.sourceKmb);
let n = 0;
for (const [i, [zh, en]] of STOPS.entries()) {
  const loc = await locate(zh, en);
  if (!loc) { console.warn('not found:', zh); continue; }
  n++;
  console.log(`${zh} → ${loc.found} (${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)})`);
  data.stations.push({
    id: `kmb-${i + 1}`, sourceKmb: true, name: `九巴 ${zh}`, nameEn: `KMB ${en}`,
    address: loc.address.replace(/^香港(?!島)/, ''), lat: Math.round(loc.lat * 1e6) / 1e6, lng: Math.round(loc.lng * 1e6) / 1e6,
    category: '公共交通', categoryEn: 'Public transport', eligibility: '任何人', eligibilityEn: 'Anyone',
    service: '九巴「落雨唔使怕」借遮服務：乘客可於指定巴士站免費借用透明雨傘，不論年齡、身份或出行目的。',
    serviceEn: 'KMB "No fear of rain" umbrella lending: free transparent umbrellas at designated bus termini, for anyone, whatever their age or reason for travelling.',
    terms: '可於任何一個指定站點歸還，毋須返回原站借用地點。各站雨傘數量或會因天氣、人流及歸還情況而調整。',
    termsEn: 'Return it at any designated KMB point – it doesn\'t have to be where you borrowed it. Stock at each point may vary with the weather, passenger numbers and returns.',
    link: SOURCE,
  });
}
writeFileSync(FILE, JSON.stringify(data));
console.log(`added ${n}/${STOPS.length} KMB points; ${data.stations.length} stations in total`);
