// Hong Kong Observatory open data: warning signals + past-hour rainfall by district.
// Docs: https://data.weather.gov.hk/weatherAPI/doc/HKO_Open_Data_API_Documentation.pdf
import { readFileSync } from 'node:fs';
const BASE = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php';
// Rainfall in the past hour at 36 automatic weather stations – HKO refreshes this every 15 minutes
// (data.gov.hk "Rainfall in the past hour from Automatic Weather Station"). Station positions come from
// the CSDI spatial version of the same dataset (hko_rcd_1666097185091_14408), saved in aws_stations.json.
const AWS_URL = 'https://data.weather.gov.hk/weatherAPI/opendata/hourlyRainfall.php?lang=en';

// Approximate district centroids for drawing the rainfall layer
export const DISTRICTS = {
  'central & western': [22.2826, 114.1452], 'wan chai': [22.2760, 114.1751], 'eastern': [22.2840, 114.2241],
  'southern': [22.2470, 114.1580], 'yau tsim mong': [22.3110, 114.1700], 'sham shui po': [22.3307, 114.1622],
  'kowloon city': [22.3282, 114.1916], 'wong tai sin': [22.3420, 114.1950], 'kwun tong': [22.3104, 114.2252],
  'kwai tsing': [22.3549, 114.1100], 'tsuen wan': [22.3707, 114.1135], 'tuen mun': [22.3918, 113.9772],
  'yuen long': [22.4445, 114.0222], 'north': [22.4940, 114.1380], 'tai po': [22.4500, 114.1688],
  'sha tin': [22.3830, 114.1880], 'sai kung': [22.3814, 114.2705], 'islands': [22.2610, 113.9460],
};
// Traditional Chinese district names (HKO's own wording)
export const DISTRICT_ZH = {
  'central & western': '中西區', 'wan chai': '灣仔', 'eastern': '東區', 'southern': '南區', 'yau tsim mong': '油尖旺',
  'sham shui po': '深水埗', 'kowloon city': '九龍城', 'wong tai sin': '黃大仙', 'kwun tong': '觀塘', 'kwai tsing': '葵青',
  'tsuen wan': '荃灣', 'tuen mun': '屯門', 'yuen long': '元朗', 'north': '北區', 'tai po': '大埔', 'sha tin': '沙田',
  'sai kung': '西貢', 'islands': '離島',
};
const norm = (s) => String(s).toLowerCase().replace(/ district$/, '').replace(/\s+and\s+/, ' & ').trim();

// Which district each station sits in (point-in-polygon on the HAD district boundaries)
const DGEO = JSON.parse(readFileSync(new URL('../public/hk_districts.geojson', import.meta.url), 'utf8'));
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function districtOf(lat, lng) {
  for (const f of DGEO.features) {
    const g = f.geometry; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    if (polys.some((p) => inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h)))) return f.properties.key;
  }
  return null;
}
export const STATIONS = JSON.parse(readFileSync(new URL('./aws_stations.json', import.meta.url), 'utf8'))
  .map((s) => ({ ...s, district: districtOf(s.lat, s.lng) }));
const STATION_BY_NAME = new Map(STATIONS.map((s) => [s.en.toLowerCase(), s]));

async function stationRain() {
  const res = await fetch(AWS_URL, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HKO hourlyRainfall ${res.status}`);
  const j = await res.json();
  const stations = (j.hourlyRainfall || []).map((x) => {
    const st = STATION_BY_NAME.get(String(x.automaticWeatherStation || '').toLowerCase());
    const mm = Number(x.value);
    return st && Number.isFinite(mm) ? { id: st.id, name: st.en, nameZh: st.zh, lat: st.lat, lng: st.lng, district: st.district, mm } : null;
  }).filter(Boolean);
  return { obsTime: j.obsTime || null, stations };
}

const RAINSTORM = { WRAINA: 'amber', WRAINR: 'red', WRAINB: 'black' };

let cache = { at: 0, data: null };

async function get(dataType, lang = 'en') {
  const res = await fetch(`${BASE}?dataType=${dataType}&lang=${lang}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HKO ${dataType} ${res.status}`);
  return res.json();
}

export async function liveWeather() {
  if (cache.data && Date.now() - cache.at < 120_000) return cache.data;
  // English and Traditional Chinese versions (HKO publishes both)
  const [warn, now, info, warnZh, infoZh, aws] = await Promise.all([
    get('warnsum').catch(() => ({})), get('rhrread').catch(() => ({})), get('warningInfo').catch(() => ({})),
    get('warnsum', 'tc').catch(() => ({})), get('warningInfo', 'tc').catch(() => ({})),
    stationRain().catch((e) => { console.warn('AWS rainfall:', e.message); return null; }),
  ]);
  // Full HKO wording for each warning in force (e.g. what the Black Rainstorm signal means right now)
  const details = (src) => {
    const out = {};
    for (const d of src?.details || []) {
      const t = d.warningStatementCode || d.subtype;
      if (t) out[t] = (d.contents || []).filter(Boolean);
    }
    return out;
  };
  const detailByType = details(info), detailZh = details(infoZh);

  const warnings = Object.entries(warn || {}).map(([k, v]) => ({
    type: k, code: v.code, name: v.name, nameZh: warnZh?.[k]?.name || null,
    action: v.actionCode, issued: v.issueTime, updated: v.updateTime,
    details: detailByType[k] || [], detailsZh: detailZh[k] || [],
  })).filter((w) => w.action !== 'CANCEL');
  const rain = warnings.find((w) => w.type === 'WRAIN');
  const rainstorm = rain ? RAINSTORM[rain.code] || null : null;
  const floodingNNT = warnings.some((w) => w.type === 'WFNTSA');

  const stations = aws?.stations || [];
  const rainfall = mergeRain((now?.rainfall?.data || []).map((d) => ({ key: norm(d.place), mm: Number(d.max) || 0 })), stations);

  const data = {
    source: 'Hong Kong Observatory',
    rainstorm, floodingNNT, warnings, rainfall,
    rainfallPeriod: now?.rainfall ? { start: now.rainfall.startTime, end: now.rainfall.endTime } : null,
    stations, stationsTime: aws?.obsTime || null,
    updated: now?.updateTime || new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return data;
}

// District value = the higher of HKO's hourly district maximum and the latest 15-minute station readings in
// that district, so a burst of rain shows up within 15 min instead of waiting for the hourly report.
function mergeRain(districtRows, stations) {
  const byKey = new Map(districtRows.filter((d) => DISTRICTS[d.key]).map((d) => [d.key, { ...d, src: 'hourly' }]));
  for (const s of stations) {
    if (!s.district || !DISTRICTS[s.district]) continue;
    const cur = byKey.get(s.district);
    if (!cur || s.mm > cur.mm) byKey.set(s.district, { key: s.district, mm: s.mm, src: '15min', station: s.name });
    else if (cur.src === 'hourly') cur.checked15 = true;
  }
  return [...byKey.values()].map((d) => {
    const [lat, lng] = DISTRICTS[d.key];
    return { ...d, district: d.key.replace(/\b\w/g, (c) => c.toUpperCase()), districtZh: DISTRICT_ZH[d.key], lat, lng };
  });
}

// Synthetic black-rainstorm conditions for demo mode
export function demoWeather() {
  const heavy = { 'wong tai sin': 98, 'kowloon city': 82, 'yau tsim mong': 76, 'sham shui po': 71, 'kwun tong': 88, 'eastern': 92, 'wan chai': 64, 'central & western': 58 };
  return {
    source: 'DEMO (simulated)',
    rainstorm: 'black', floodingNNT: true,
    warnings: [{
      type: 'WRAIN', code: 'WRAINB', name: 'Black Rainstorm Warning Signal (simulated)', nameZh: '黑色暴雨警告信號（模擬）', action: 'ISSUE',
      issued: new Date(Date.now() - 25 * 60000).toISOString(),
      details: [
        'SIMULATED FOR DEMO – not a real HKO warning.',
        'Very heavy rain has fallen or is expected to fall generally over Hong Kong, exceeding 70 millimetres in an hour, and is likely to continue.',
        'Serious road flooding and traffic congestion are expected. Stay indoors or take shelter in a safe place until the heavy rain has passed.',
        'Avoid low-lying areas, underpasses and streams, and stay away from slopes and retaining walls.',
      ],
      detailsZh: [
        '示範模擬 – 並非天文台真實警告。',
        '香港廣泛地區已錄得或預料有超過70毫米的極大雨，雨勢可能持續。',
        '預料道路會出現嚴重水浸及交通擠塞。請留在室內或到安全地方暫避，直至大雨過去。',
        '避免前往低窪地區、隧道及溪澗，並遠離斜坡及擋土牆。',
      ],
    }, {
      type: 'WTS', code: 'WTS', name: 'Thunderstorm Warning (simulated)', nameZh: '雷暴警告（模擬）', action: 'ISSUE',
      details: ['SIMULATED FOR DEMO – thunderstorms are expected to occur over Hong Kong. Stay indoors and away from open areas.'],
      detailsZh: ['示範模擬 – 預料香港會有雷暴。請留在室內，遠離空曠地方。'],
    }, {
      type: 'WL', code: 'WL', name: 'Landslip Warning (simulated)', nameZh: '山泥傾瀉警告（模擬）', action: 'ISSUE',
      details: ['SIMULATED FOR DEMO – there is a high risk of landslips. Stay away from steep slopes and retaining walls.'],
      detailsZh: ['示範模擬 – 山泥傾瀉風險高。請遠離陡峭斜坡及擋土牆。'],
    }, {
      type: 'WFNTSA', name: 'Special Announcement on Flooding in the Northern New Territories (simulated)', nameZh: '新界北部水浸特別報告（模擬）', action: 'ISSUE',
      details: ['SIMULATED FOR DEMO – flooding is expected in low-lying parts of the northern New Territories.'],
      detailsZh: ['示範模擬 – 預料新界北部低窪地區會出現水浸。'],
    }],
    ...(() => {
      // stations vary ±25 % around their district's simulated total
      const stations = STATIONS.map((st, i) => ({ id: st.id, name: st.en, nameZh: st.zh, lat: st.lat, lng: st.lng, district: st.district,
        mm: Math.round((heavy[st.district] ?? 35) * (0.75 + ((i * 37) % 50) / 100)) }));
      return { stations, stationsTime: new Date().toISOString(), rainfall: mergeRain(Object.keys(DISTRICTS).map((k) => ({ key: k, mm: heavy[k] ?? 35 })), stations) };
    })(),
    updated: new Date().toISOString(),
    demo: true,
  };
}

// HKO definitions of the Rainstorm Warning Signals (hourly rainfall thresholds)
export const SIGNAL_INFO = {
  amber: { name: 'Amber Rainstorm Signal', zh: '黃色暴雨警告信號', threshold: 'Heavy rain has fallen or is expected, exceeding 30 mm in an hour, and is likely to continue.', thresholdZh: '已錄得或預料會有每小時雨量超過30毫米的大雨，且雨勢可能持續。' },
  red: { name: 'Red Rainstorm Signal', zh: '紅色暴雨警告信號', threshold: 'Heavy rain has fallen or is expected, exceeding 50 mm in an hour, and is likely to continue.', thresholdZh: '已錄得或預料會有每小時雨量超過50毫米的大雨，且雨勢可能持續。' },
  black: { name: 'Black Rainstorm Signal', zh: '黑色暴雨警告信號', threshold: 'Very heavy rain has fallen or is expected, exceeding 70 mm in an hour, and is likely to continue.', thresholdZh: '已錄得或預料會有每小時雨量超過70毫米的極大雨，且雨勢可能持續。' },
};

// Official HKO warning icons (https://www.hko.gov.hk/en/wxinfo/dailywx/warnlegend.htm)
const ICON_BASE = 'https://www.hko.gov.hk/en/wxinfo/dailywx/images/';
const ICONS = {
  WRAINA: 'raina.gif', WRAINR: 'rainr.gif', WRAINB: 'rainb.gif',
  TC1: 'tc1.gif', TC3: 'tc3.gif', TC8NE: 'tc8ne.gif', TC8SE: 'tc8b.gif', TC8SW: 'tc8c.gif', TC8NW: 'tc8d.gif', TC9: 'tc9.gif', TC10: 'tc10.gif',
  WTS: 'ts.gif', WFNTSA: 'ntfl.gif', WL: 'landslip.gif', WCOLD: 'cold.gif', WHOT: 'vhot.gif', WMSGNL: 'sms.gif',
  WFROST: 'frost.gif', WFIREY: 'firey.gif', WFIRER: 'firer.gif', WTMW: 'tsunami-warn.gif',
};
// Short labels for when there's room to show text next to the icon
const SHORT = {
  WRAINA: 'Amber rain', WRAINR: 'Red rain', WRAINB: 'Black rain', TC1: 'T1', TC3: 'T3', TC8NE: 'T8 NE', TC8SE: 'T8 SE', TC8SW: 'T8 SW', TC8NW: 'T8 NW',
  TC9: 'T9', TC10: 'T10', WTS: 'Thunderstorm', WFNTSA: 'NT flooding', WL: 'Landslip', WCOLD: 'Cold', WHOT: 'Very hot', WMSGNL: 'Monsoon',
  WFROST: 'Frost', WFIREY: 'Fire (yellow)', WFIRER: 'Fire (red)', WTMW: 'Tsunami',
};
const SHORT_ZH = {
  WRAINA: '黃雨', WRAINR: '紅雨', WRAINB: '黑雨', TC1: '一號', TC3: '三號', TC8NE: '八號東北', TC8SE: '八號東南', TC8SW: '八號西南', TC8NW: '八號西北',
  TC9: '九號', TC10: '十號', WTS: '雷暴', WFNTSA: '新界北水浸', WL: '山泥傾瀉', WCOLD: '寒冷', WHOT: '酷熱', WMSGNL: '強烈季候風',
  WFROST: '霜凍', WFIREY: '黃色火災', WFIRER: '紅色火災', WTMW: '海嘯',
};
// Display order: most relevant to flooding / safety first
const ORDER = ['WRAIN', 'WTCSGNL', 'WTS', 'WL', 'WFNTSA', 'WTMW', 'WMSGNL', 'WHOT', 'WCOLD', 'WFROST', 'WFIRE'];
export function withIcons(warnings = []) {
  return warnings.map((w) => {
    const code = w.code || w.type;
    return { ...w, iconUrl: ICONS[code] ? ICON_BASE + ICONS[code] : null, short: SHORT[code] || w.name || code, shortZh: SHORT_ZH[code] || w.nameZh || SHORT[code] || code };
  }).sort((a, b) => (ORDER.indexOf(a.type) + 99) % 99 - (ORDER.indexOf(b.type) + 99) % 99);
}
