// All Gemini calls live here.
//  1. analyzeFlood      – photo (+ optional note) -> structured flood assessment
//  2. compareUpdate     – new photo vs original -> has the flood cleared / worsened?
//  3. routeBriefing     – route + hazards + HKO warning -> short bilingual safety briefing
//
// Auth: on Cloud Run set GOOGLE_GENAI_USE_VERTEXAI=true (+ project/location) and the
// service account is used – no key needed. Locally you can set GEMINI_API_KEY instead.
import { GoogleGenAI, Type } from '@google/genai';

export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// LOW keeps photo analysis fast (~2-4 s). Set GEMINI_THINKING_LEVEL='' to use the model default.
const THINKING = (process.env.GEMINI_THINKING_LEVEL ?? 'LOW').toUpperCase();

let ai = null;
export function client() {
  if (ai) return ai;
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
    });
  } else if (process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return ai;
}

export function enabled() {
  return Boolean(process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || process.env.GEMINI_API_KEY);
}

// Backup models tried when the main one is overloaded (503) or rate-limited (429).
// "gemini-flash-latest" is Google's alias for the current Flash model.
// Live test (14 Oct): when 3.5 Flash was overloaded, 3.5 Flash-Lite answered – so it goes first.
export const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.5-flash-lite,gemini-flash-latest')
  .split(',').map((m) => m.trim()).filter((m) => m && m !== MODEL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (e) => /\b(503|429|500)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|INTERNAL/i.test(String(e?.message || e));
const isMissingModel = (e) => /\b404\b|NOT_FOUND|not found|is not supported/i.test(String(e?.message || e));

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`503 ${msg}`)), ms))]);

async function callModel(model, parts, schema) {
  const base = { responseMimeType: 'application/json', responseSchema: schema };
  const call = (config) => client().models.generateContent({ model, contents: [{ role: 'user', parts }], config });
  try {
    return await call(THINKING ? { ...base, thinkingConfig: { thinkingLevel: THINKING } } : base);
  } catch (e) {
    // Some models reject thinkingLevel – retry once without it.
    if (THINKING && /thinking/i.test(String(e?.message))) return call(base);
    throw e;
  }
}

// Tries the main model (with 2 quick retries on overload), then each backup model once.
async function generateJSON(parts, schema, meta = {}) {
  // One quick retry, then straight to the backups – a user standing in the rain shouldn't wait 30 s
  const plan = [[MODEL, 0], [MODEL, 700], ...FALLBACK_MODELS.map((m) => [m, 0])];
  let lastErr;
  for (const [model, wait] of plan) {
    if (wait) await sleep(wait);
    try {
      const res = await withTimeout(callModel(model, parts, schema), 15000, `${model} timed out`);
      meta.model = model;
      if (model !== MODEL) console.warn(`Gemini: ${MODEL} busy – answered by backup model ${model}`);
      return parseJSON(res.text || '');
    } catch (e) {
      lastErr = e;
      const busy = isBusy(e);
      const fallbackMissing = model !== MODEL && isMissingModel(e);
      if (!busy && !fallbackMissing) throw e;      // real error (bad key, bad request) – don't keep trying
      console.warn(`Gemini ${model}: ${busy ? 'busy' : 'not available'} – trying next`);
    }
  }
  throw lastErr;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Gemini returned non-JSON output');
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- 1. Flood photo / text assessment ----------
const floodSchema = {
  type: Type.OBJECT,
  properties: {
    is_flood_scene: { type: Type.BOOLEAN, description: 'True only for a real outdoor rain/flood scene' },
    severity: { type: Type.INTEGER, description: '0-5 per the severity scale' },
    depth_category: {
      type: Type.STRING,
      enum: ['none', 'puddle', 'ankle', 'shin_to_knee', 'knee_to_waist', 'above_waist'],
    },
    estimated_depth_cm: { type: Type.INTEGER },
    water_flow: { type: Type.STRING, enum: ['none', 'still', 'slow', 'fast'] },
    hazards: { type: Type.ARRAY, items: { type: Type.STRING } },
    hazards_zh: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'The same hazards in Traditional Chinese, same order' },
    passable_on_foot: { type: Type.BOOLEAN },
    passable_wheelchair: { type: Type.BOOLEAN },
    passable_by_car: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER, description: '0-1 confidence in the depth estimate' },
    depth_cues: { type: Type.STRING, description: 'Which visual references were used to judge depth' },
    description_en: { type: Type.STRING },
    description_zh: { type: Type.STRING },
    image_source: {
      type: Type.STRING, enum: ['live_photo', 'screenshot', 'photo_of_screen', 'stock_or_news', 'ai_generated', 'unclear', 'no_image'],
      description: 'Where the picture appears to come from (anti-spam check)',
    },
  },
  required: ['is_flood_scene', 'severity', 'image_source', 'depth_category', 'estimated_depth_cm', 'water_flow', 'hazards',
    'passable_on_foot', 'passable_wheelchair', 'passable_by_car', 'confidence', 'depth_cues',
    'description_en', 'description_zh', 'hazards_zh'],
};

const SEVERITY_GUIDE = `Severity scale:
0 = no flooding, not a flood scene, or irrelevant image
1 = wet surface / shallow puddles (<5 cm) – normal walking OK
2 = ankle-deep (5–15 cm) – walkable with care; avoid for wheelchairs and strollers
3 = shin-to-knee (15–40 cm) – pedestrians should avoid; small cars at risk
4 = knee-to-waist (40–80 cm) – dangerous; vehicles may stall
5 = above waist, or fast-flowing water, landslide or heavy debris – life-threatening
Fast-flowing water raises severity by one level (max 5).`;

const DEPTH_CUES = `Estimate depth from visual references: Hong Kong kerbs are ~15 cm; car wheel ~65 cm diameter (hub ~33 cm);
bus first step ~35 cm; adult ankle ~10 cm, knee ~50 cm, waist ~100 cm; drain grates, road markings and bollard bases.`;

export async function analyzeFlood({ photoBase64, mimeType, note, userLevel, locationHint, knownRisk = [] }) {
  const prompt = `You are the flood assessment model for FloodSafe HK, a crowd-sourced urban flood map for Hong Kong.
A member of the public submitted a report${locationHint ? ` near ${locationHint}` : ''}.
${photoBase64 ? 'Assess the attached photo.' : 'No photo was provided: assess from the text only and keep confidence ≤ 0.5.'}
${note ? `Reporter's note: """${String(note).slice(0, 500)}"""` : ''}
${knownRisk.length ? `Context: this report is within ${knownRisk[0].distanceM} m of an official Drainage Services Department ${knownRisk[0].type === 'blackspot' ? 'flooding blackspot' : 'location prone to drain blockage'} ("${knownRisk[0].name}"). Flooding here is plausible, but still judge depth only from what you can see.` : ''}
${userLevel ? `Reporter's own depth estimate: ${userLevel} (treat as a hint, trust the image more).` : ''}

${DEPTH_CUES}

${SEVERITY_GUIDE}

List concrete visible hazards (e.g. "possible open manhole", "strong current", "floating debris", "submerged kerb",
"stalled vehicles", "electrical equipment in water", "landslide / mud"). Empty list if none.
Never identify or describe people's identity, faces, or licence plates; people are only a scale reference.
If the image is not a real outdoor rain/flood scene (screenshot, indoor, unrelated, meme, obviously synthetic),
set is_flood_scene=false and severity=0.
image_source (anti-spam): "live_photo" for an ordinary phone-camera photo; "screenshot" if app/browser UI, status bars or
chat bubbles are visible; "photo_of_screen" for a photo of a monitor/TV/phone (moiré, bezels, glare); "stock_or_news" for
watermarks, TV captions, news logos or professional stock framing; "ai_generated" for clear synthetic artefacts;
"unclear" if you cannot tell; "no_image" when there is no photo. Do not call ordinary night, blurry or rainy-lens photos fake.
description_en: ≤ 25 words, factual, written for a map pin. description_zh: the same in Traditional Chinese (Hong Kong usage). For place names use the official Chinese name only if you are sure of it
(e.g. Temple Mall = 黃大仙中心, Wong Tai Sin = 黃大仙); otherwise keep the English place name rather than translating it word by word.`;

  const parts = [{ text: prompt }];
  if (photoBase64) parts.push({ inlineData: { mimeType: mimeType || 'image/jpeg', data: photoBase64 } });
  const meta = {};
  const out = await generateJSON(parts, floodSchema, meta);
  out.severity = clamp(Math.round(Number(out.severity) || 0), 0, 5);
  out.confidence = clamp(Number(out.confidence) || 0.5, 0, 1);
  if (!photoBase64) out.confidence = Math.min(out.confidence, 0.5);
  out.hazards = Array.isArray(out.hazards) ? out.hazards.slice(0, 6) : [];
  if (!photoBase64) out.image_source = 'no_image';
  out.model = meta.model || MODEL;
  return out;
}

// ---------- 2. Update verification (before vs after) ----------
const compareSchema = {
  type: Type.OBJECT,
  properties: {
    same_place_likely: { type: Type.BOOLEAN },
    change: { type: Type.STRING, enum: ['cleared', 'receding', 'unchanged', 'worse'] },
    severity: { type: Type.INTEGER },
    confidence: { type: Type.NUMBER },
    description_en: { type: Type.STRING },
    description_zh: { type: Type.STRING },
  },
  required: ['same_place_likely', 'change', 'severity', 'confidence', 'description_en', 'description_zh'],
};

export async function compareUpdate({ original, originalAnalysis, update }) {
  const prompt = `You verify crowd updates for FloodSafe HK.
Image 1 is the ORIGINAL flood report (earlier assessment: severity ${originalAnalysis?.severity}, "${originalAnalysis?.description_en || ''}").
Image 2 is a NEW photo a different user just took at roughly the same location.
Decide whether image 2 plausibly shows the same place, and how the flooding has changed.
${DEPTH_CUES}
${SEVERITY_GUIDE}
"severity" is the CURRENT severity seen in image 2. Never identify people.
description_en ≤ 20 words; description_zh in Traditional Chinese.`;
  const parts = [{ text: prompt }];
  if (original) parts.push({ inlineData: { mimeType: original.mimeType || 'image/jpeg', data: original.base64 } });
  parts.push({ inlineData: { mimeType: update.mimeType || 'image/jpeg', data: update.base64 } });
  const out = await generateJSON(parts, compareSchema);
  out.severity = clamp(Math.round(Number(out.severity) || 0), 0, 5);
  out.confidence = clamp(Number(out.confidence) || 0.5, 0, 1);
  return out;
}

// ---------- 3. Route safety briefing ----------
const briefingSchema = {
  type: Type.OBJECT,
  properties: {
    risk_level: { type: Type.STRING, enum: ['low', 'moderate', 'high', 'extreme'] },
    headline_en: { type: Type.STRING },
    headline_zh: { type: Type.STRING },
    tips_en: { type: Type.ARRAY, items: { type: Type.STRING } },
    tips_zh: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['risk_level', 'headline_en', 'headline_zh', 'tips_en', 'tips_zh'],
};

export async function routeBriefing(ctx) {
  const prompt = `You are FloodSafe HK's route safety assistant. Write a short, calm, practical briefing for someone
about to travel in Hong Kong during heavy rain. Use ONLY the facts in the JSON context; do not invent street names,
shelters or hazards that are not in it. Mention the time cost of the detour if one was taken.
Timing: durationS is the TOTAL walking time of this route (it already includes any detour); extraSeconds is only how much
longer it is than the fastest route. Never add them together. Round minutes the same way the app does (durationS / 60, rounded).
Place names: in English text use "name"; in Chinese text use "nameZh" when it is given, otherwise keep the English name.
Do not mention generic places such as "Lift", "Staircase", "First floor" or "Podium" – only named buildings, malls or footbridges.
Walking advice: avoid underpasses/subways and kerb edges, watch for open manholes in standing water, prefer covered walkways,
footbridges and malls.
If routeOption is 'driest' or 'balanced', mention the sheltered share of the walk.
If shelter data is given, say how much of the walk is sheltered (covered / indoor / footbridge / underground) and name one sheltered place if listed.
Underground subways next to flooding were already avoided; still advise leaving any subway if water starts entering.
If googleForecastNextHours is given, use it for timing advice (e.g. rain easing at a given hour); call it a forecast, never an official warning.
Only mention rain "easing" or "stopping" if the forecast shows meaningful rain now that drops later; if no significant rain is forecast, say so plainly.
Mention underpasses, subways or manholes only if it is raining, a rainstorm signal is up, or a flood hazard is on or near the route.
If an HKO Black or Red Rainstorm signal is in force, say so first and advise staying indoors unless the trip is essential.
headline ≤ 15 words. Max 3 tips, each ≤ 18 words. Chinese versions in Traditional Chinese (Hong Kong usage).

Context:
${JSON.stringify(ctx, null, 1)}`;
  return generateJSON([{ text: prompt }], briefingSchema);
}

// ---------- Diagnostics ----------
export async function ping() {
  const meta = {};
  const out = await generateJSON([{ text: 'Reply with {"ok": true}.' }], { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } }, required: ['ok'] }, meta);
  return meta.model === MODEL ? `model ${MODEL} responded: ${JSON.stringify(out)}`
    : `${MODEL} busy – backup model ${meta.model} responded: ${JSON.stringify(out)}`;
}

// Turn SDK errors into something a human can act on
export function explainError(e) {
  const msg = String(e?.message || e);
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Gemini API key is invalid – create a new one in AI Studio and update .env';
  if (/not found|is not supported|404/i.test(msg) && /model/i.test(msg)) return `Model "${MODEL}" not available for this key – set GEMINI_MODEL in .env to a model listed in AI Studio`;
  if (/PERMISSION_DENIED|403/i.test(msg)) return `Permission denied – ${msg.slice(0, 160)}`;
  if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(msg)) return `Gemini is overloaded right now (tried ${MODEL} and backups ${FALLBACK_MODELS.join(', ') || 'none'}) – try again in a minute`;
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) return 'Gemini quota / rate limit reached – wait a minute or enable billing on the key\'s project';
  if (/thinking/i.test(msg)) return 'Model rejected the thinking setting – set GEMINI_THINKING_LEVEL= (empty) in .env';
  return msg.slice(0, 240);
}

// ---------- Fallbacks when Gemini isn't configured (local dev) ----------
const LEVEL_TO_SEV = { puddle: 1, ankle: 2, knee: 3, shin_to_knee: 3, waist: 4, knee_to_waist: 4, above_waist: 5 };
export function fallbackAnalysis({ userLevel, note }) {
  const sev = LEVEL_TO_SEV[userLevel] ?? 2;
  return {
    is_flood_scene: true, severity: sev, depth_category: userLevel || 'ankle', estimated_depth_cm: [0, 3, 10, 30, 60, 100][sev],
    water_flow: 'still', hazards: [], hazards_zh: [], passable_on_foot: sev <= 2, passable_wheelchair: sev <= 1, passable_by_car: sev <= 3,
    confidence: 0.3, depth_cues: 'Not checked by AI – based on the reporter\'s estimate only', unverified: true,
    description_en: note ? String(note).slice(0, 120) : 'Flooding reported by user (unverified).',
    description_zh: '用戶報告水浸（未經AI核實）。', model: 'fallback',
  };
}

export function fallbackBriefing(ctx) {
  const avoided = ctx.avoidedHazards?.length || 0;
  const remaining = ctx.remainingHazards?.length || 0;
  const risk = remaining ? (Math.max(...ctx.remainingHazards.map((h) => h.severity)) >= 4 ? 'high' : 'moderate') : 'low';
  return {
    risk_level: risk,
    headline_en: avoided ? `Route avoids ${avoided} reported flood zone(s).` : remaining ? 'Flooding reported on your route – take care.' : 'No reported flooding on this route.',
    headline_zh: avoided ? `路線已避開 ${avoided} 個水浸地點。` : remaining ? '路線上有水浸報告，請小心。' : '路線上暫無水浸報告。',
    tips_en: ['Avoid underpasses and kerb edges.', 'Watch for open manholes in standing water.'],
    tips_zh: ['避免使用行人隧道及靠近路邊。', '小心積水中可能有沙井蓋被沖開。'],
  };
}
