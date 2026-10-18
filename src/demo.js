// Demo mode: simulated black-rainstorm reports so the prototype can be shown on a dry day.
// All demo reports are flagged demo:true and labelled "Simulated" in the UI.
const now = () => Date.now();

// The first three demo reports carry real photos (public/demo/*.jpg) and the assessment Gemini actually returned
// for each one (scripts/analyze-demo-photos.mjs), so the demo shows genuine AI output.
const PHOTO_SEEDS = [
  {"lat": 22.3191, "lng": 114.1695, "place": "Nathan Rd / Argyle St, Mong Kok", "placeZh": "旺角彌敦道／亞皆老街", "photo": "demo-1", "confirms": 4, "ai": {"is_flood_scene": true, "severity": 3, "image_source": "live_photo", "depth_category": "shin_to_knee", "estimated_depth_cm": 30, "water_flow": "slow", "hazards": ["submerged kerb", "stalled vehicles"], "passable_on_foot": false, "passable_wheelchair": false, "passable_by_car": false, "confidence": 0.85, "depth_cues": "Water covering vehicle lower wheel rims, submerged street curb, water reaching shin height on pedestrians with umbrellas.", "description_en": "Severe street flooding with brown muddy water covering roads and sidewalks in Mong Kok, disrupting traffic and pedestrians.", "description_zh": "旺角街道嚴重水浸，泥水淹沒馬路及行人路，交通及行人嚴重受阻。", "hazards_zh": ["淹沒的路緣", "故障/受阻車輛"], "model": "gemini-3.5-flash"}},
  {"lat": 22.3418, "lng": 114.1938, "place": "Wong Tai Sin MTR station, Exit E (Shatin Pass Rd)", "placeZh": "黃大仙站 E 出口（沙田坳道）", "photo": "demo-2", "confirms": 7, "ai": {"is_flood_scene": true, "severity": 5, "image_source": "live_photo", "depth_category": "above_waist", "estimated_depth_cm": 80, "water_flow": "fast", "hazards": ["strong current", "submerged escalators", "electrical equipment in water"], "passable_on_foot": false, "passable_wheelchair": false, "passable_by_car": false, "confidence": 0.9, "depth_cues": "Fast-flowing torrent pouring down escalators and submerging the lower concourse and station entrance structure.", "description_en": "Severe flooding at Wong Tai Sin MTR station Exit E with fast-flowing water pouring down the escalators.", "description_zh": "黃大仙站E出口發生嚴重水浸，急流沿扶手電梯湧入車站內部。", "hazards_zh": ["強勁水流", "淹沒的扶手電梯", "水中的電氣設備"], "model": "gemini-3.5-flash"}},
  {"lat": 22.2766, "lng": 114.24, "place": "Heng Fa Chuen Promenade", "placeZh": "杏花邨海濱長廊", "photo": "demo-3", "confirms": 3, "ai": {"is_flood_scene": true, "severity": 4, "image_source": "live_photo", "depth_category": "shin_to_knee", "estimated_depth_cm": 25, "water_flow": "fast", "hazards": ["strong current", "overtopping waves"], "passable_on_foot": false, "passable_wheelchair": false, "passable_by_car": false, "confidence": 0.85, "depth_cues": "Seawall railings, lamppost bases, and water surging over the promenade pavement.", "description_en": "Rough waves overtopping the seawall at Heng Fa Chuen Promenade, inundating the pedestrian area with fast-flowing seawater.", "description_zh": "海浪湧過杏花邨海濱長廊海堤，海水快速淹沒行人路。", "hazards_zh": ["強勁水流", "海浪越堤"], "model": "gemini-3.5-flash"}},
];

const SEEDS = [
  {
    lat: 22.3306, lng: 114.1598, severity: 2, depth: 'ankle', cm: 10, flow: 'still',
    place: 'Cheung Sha Wan Rd, Sham Shui Po', placeZh: '深水埗長沙灣道',
    en: 'Ankle-deep standing water near drains; walkable with care, unsuitable for wheelchairs.',
    zh: '去水位附近積水及腳踝，小心可行，不宜輪椅通過。',
    hazards: ['blocked drain'], hazardsZh: ['渠道淤塞'], confirms: 2,
  },
  {
    lat: 22.3122, lng: 114.2243, severity: 3, depth: 'shin_to_knee', cm: 25, flow: 'slow',
    place: 'Hoi Yuen Rd, Kwun Tong', placeZh: '觀塘開源道',
    en: 'Low-lying section flooded to mid-shin; water entering ground-floor shops.',
    zh: '低窪路段水深至小腿中，水已湧入地舖。',
    hazards: ['water entering buildings'], hazardsZh: ['水湧入建築物'], confirms: 2,
  },
  {
    lat: 22.2864, lng: 114.1517, severity: 2, depth: 'ankle', cm: 8, flow: 'slow',
    place: "Des Voeux Rd Central, Sheung Wan", placeZh: '上環德輔道中',
    en: 'Ankle-deep runoff flowing across tram tracks and crossings.',
    zh: '電車路軌及過路處有及腳踝的流水。',
    hazards: ['slippery tram tracks'], hazardsZh: ['電車路軌濕滑'], confirms: 1,
  },
];

export function demoReports() {
  const photoReports = PHOTO_SEEDS.map((s, i) => {
    const created = now() - (8 + i * 9) * 60000;
    return {
      id: s.photo, demo: true, lat: s.lat, lng: s.lng, severity: s.ai.severity, placeHint: s.place, placeHintZh: s.placeZh,
      ai: { ...s.ai, model: `${s.ai.model} (demo photo)` }, note: '', hasPhoto: true,
      photos: [{ key: s.photo, at: created, severity: s.ai.severity, kind: 'report' }],
      createdAt: created, updatedAt: created, lastConfirmedAt: created, confirms: s.confirms, clears: 0, voters: {}, history: [],
      evidence: ['live_camera'],
    };
  });
  return [...photoReports, ...SEEDS.map((s, i) => {
    const created = now() - (10 + i * 7) * 60000;
    return {
      id: `demo-${i + 4}`,
      demo: true,
      lat: s.lat, lng: s.lng, severity: s.severity, placeHint: s.place, placeHintZh: s.placeZh,
      ai: {
        is_flood_scene: true, severity: s.severity, depth_category: s.depth, estimated_depth_cm: s.cm,
        water_flow: s.flow, hazards: s.hazards, hazards_zh: s.hazardsZh, passable_on_foot: s.severity <= 2, passable_wheelchair: s.severity <= 1,
        passable_by_car: s.severity <= 3, confidence: 0.8, depth_cues: 'Simulated demo data',
        description_en: s.en, description_zh: s.zh, model: 'demo',
      },
      note: '', hasPhoto: false, createdAt: created, updatedAt: created, lastConfirmedAt: created,
      confirms: s.confirms, clears: 0, voters: {}, history: [],
    };
  })];
}

// Suggested demo trip that crosses the Mong Kok hazard on the fastest walking route
export const DEMO_TRIP = {
  origin: { lat: 22.3247, lng: 114.1682, name: 'Prince Edward MTR', nameZh: '太子站' },
  destination: { lat: 22.3129, lng: 114.1706, name: 'Yau Ma Tei MTR', nameZh: '油麻地站' },
};
// Showcase trips (tested live): each shows a different strength
export const DEMO_TRIPS = [
  { id: 'mongkok', label: 'Mong Kok: avoid a flood', labelZh: '旺角：避開水浸', ...DEMO_TRIP },
  { id: 'central', label: 'Central: footbridges', labelZh: '中環：行人天橋',
    origin: { lat: 22.2866, lng: 114.1520, name: 'Sheung Wan MTR', nameZh: '上環站' },
    destination: { lat: 22.2853, lng: 114.1588, name: 'IFC, Central', nameZh: '中環國際金融中心' } },
  { id: 'wongtaisin', label: 'Wong Tai Sin: flood + cover', labelZh: '黃大仙：水浸＋遮蔽',
    origin: { lat: 22.3440, lng: 114.1918, name: 'Chuk Yuen South Estate', nameZh: '竹園南邨' },
    destination: { lat: 22.3408, lng: 114.1962, name: 'Muk Lun Street', nameZh: '木蘭街' } },
];
