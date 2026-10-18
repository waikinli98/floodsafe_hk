// Google Maps Platform Weather API: hour-by-hour forecast + past-24h rain at any point.
// HKO stays the official source for warnings; this adds *forecasts* for "when should I leave?".
//   currentConditions:lookup -> now + currentConditionsHistory.qpf (rain in the past 24 h)
//   forecast/hours:lookup    -> next N hours: precipitation.probability.percent, precipitation.qpf.quantity (mm),
//                               thunderstormProbability, weatherCondition (iconBaseUri, description)
const BASE = 'https://weather.googleapis.com/v1/';
const TTL = 10 * 60_000;
const cache = new Map();

export function weatherEnabled() { return Boolean(process.env.MAPS_SERVER_KEY); }

async function call(path, lat, lng, extra = '') {
  const url = `${BASE}${path}?key=${process.env.MAPS_SERVER_KEY}&location.latitude=${lat}&location.longitude=${lng}${extra}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Weather API ${res.status}: ${json.error?.message || 'error'}`);
  return json;
}

const pad = (n) => String(n).padStart(2, '0');
const mm = (p) => Math.round((Number(p?.qpf?.quantity) || 0) * 10) / 10;

function hourRow(h) {
  const d = h.displayDateTime || {};
  return {
    start: h.interval?.startTime,
    label: d.hours != null ? `${pad(d.hours)}:00` : '',
    hour: d.hours ?? null,
    chance: h.precipitation?.probability?.percent ?? 0,
    mm: mm(h.precipitation),
    thunder: h.thunderstormProbability ?? 0,
    condition: h.weatherCondition?.description?.text || '',
    type: h.weatherCondition?.type || '',
    icon: h.weatherCondition?.iconBaseUri ? `${h.weatherCondition.iconBaseUri}.svg` : null,
    isDaytime: h.isDaytime,
  };
}

// Expected wetness of leaving at hour i (rain amount weighted by chance, thunder adds risk)
const wetness = (h) => h.mm * Math.max(0.3, h.chance / 100) + (h.thunder >= 40 ? 2 : 0);

export function summarise(now, hours, rain24h) {
  const next = hours.slice(0, 12);
  let advice = null;
  const window = next.slice(0, 4);
  if (window.length) {
    const scores = window.map(wetness);
    const best = scores.indexOf(Math.min(...scores));
    const saved = Math.round((scores[0] - scores[best]) * 10) / 10;
    const startsAt = next.findIndex((h) => h.chance >= 60 && h.mm >= 1);
    if (best > 0 && saved >= 2) {
      advice = { kind: 'wait', at: window[best].label, hoursFromNow: best, savedMm: saved,
        text_en: `Rain eases around ${window[best].label}. Waiting could mean about ${saved} mm less rain.`,
        text_zh: `${window[best].label} 左右雨勢減弱，稍後出發可少淋約 ${saved} 毫米雨。` };
    } else if (scores[0] < 0.5 && startsAt > 0 && startsAt <= 3) {
      advice = { kind: 'go-now', at: next[startsAt].label,
        text_en: `Dry for now. Rain likely from ${next[startsAt].label}, so leave now.`,
        text_zh: `現時未下雨，預計 ${next[startsAt].label} 起有雨，宜盡快出發。` };
    } else if (scores[0] >= 2) {
      advice = { kind: 'wet', text_en: 'Rain continues for the next few hours. Take the sheltered route.', text_zh: '未來數小時持續有雨，建議選擇有蓋路線。' };
    } else {
      advice = { kind: 'ok', text_en: 'No significant rain expected in the next few hours.', text_zh: '未來數小時預料沒有明顯降雨。' };
    }
  }
  const peak = next.reduce((a, b) => (b.mm > (a?.mm ?? -1) ? b : a), null);
  return {
    source: 'Google Weather API',
    now: now ? { condition: now.weatherCondition?.description?.text, icon: now.weatherCondition?.iconBaseUri ? `${now.weatherCondition.iconBaseUri}.svg` : null,
      chance: now.precipitation?.probability?.percent ?? 0, mm: mm(now.precipitation), thunder: now.thunderstormProbability ?? 0,
      tempC: now.temperature?.degrees ?? null } : null,
    rain24h,
    hours: next,
    peak: peak && peak.mm > 0 ? { label: peak.label, mm: peak.mm } : null,
    nextHourHeavy: Boolean(next[0] && (next[0].mm >= 20 || (next[0].mm >= 10 && next[0].chance >= 70))),
    soaked: rain24h != null && rain24h >= 50,
    advice,
  };
}

export async function forecastAt(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`; // ~1 km cells
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const [now, fc] = await Promise.all([
    call('currentConditions:lookup', lat, lng),
    call('forecast/hours:lookup', lat, lng, '&hours=12'),
  ]);
  const rain24h = now.currentConditionsHistory?.qpf ? Math.round(now.currentConditionsHistory.qpf.quantity * 10) / 10 : null;
  const data = summarise(now, (fc.forecastHours || []).map(hourRow), rain24h);
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

// Demo mode: heavy rain now, easing over the evening, so "when to leave" advice shows
export function demoForecast() {
  const base = new Date(); base.setMinutes(0, 0, 0);
  const hkHour = (i) => (Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Hong_Kong' }).format(base)) + i) % 24;
  const plan = [[95, 38, 70], [90, 26, 55], [75, 12, 30], [45, 3, 10], [25, 0.6, 0], [15, 0.2, 0], [10, 0, 0], [10, 0, 0], [20, 0.4, 0], [15, 0, 0], [10, 0, 0], [10, 0, 0]];
  const hours = plan.map(([chance, rain, thunder], i) => ({
    start: new Date(base.getTime() + i * 3600e3).toISOString(), label: `${pad(hkHour(i))}:00`, hour: hkHour(i),
    chance, mm: rain, thunder,
    condition: rain >= 20 ? 'Heavy rain' : rain >= 5 ? 'Rain' : rain > 0 ? 'Light rain' : 'Cloudy',
    type: rain >= 20 ? 'HEAVY_RAIN' : rain >= 5 ? 'RAIN' : rain > 0 ? 'LIGHT_RAIN' : 'CLOUDY',
    icon: `https://maps.gstatic.com/weather/v1/${thunder >= 50 ? 'strong_tstorms' : rain >= 20 ? 'heavy' : rain >= 5 ? 'showers' : rain > 0 ? 'drizzle' : 'cloudy'}.svg`,
  }));
  return { ...summarise({ weatherCondition: { description: { text: 'Heavy rain' }, iconBaseUri: 'https://maps.gstatic.com/weather/v1/strong_tstorms' }, precipitation: { probability: { percent: 95 }, qpf: { quantity: 41 } }, thunderstormProbability: 70 }, hours, 186), source: 'Simulated forecast (demo)', demo: true };
}

// Total rain over the past `hours` hours at a point (used to fade old flood reports once it has stopped raining)
export async function recentRain(lat, lng, hours = 3) {
  const h = await call('history/hours:lookup', lat, lng, `&hours=${hours}`);
  return (h.historyHours || []).reduce((s, x) => s + mm(x.precipitation), 0);
}
