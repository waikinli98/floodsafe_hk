// Turns raw crowd reports into "hazards" with a trust score that decays over time
// and responds to Waze-style confirm / clear votes.

// Hazard radius in metres by severity 0..5
export const RADIUS = [0, 25, 40, 60, 90, 130];
const HALF_LIFE_MIN = 90; // routing weight halves every 90 min
// A report disappears 90 min after anyone last reported or confirmed water there (45 min if the last 3 h were dry).
// It shows as "fading" for its last 30 min so people nearby are prompted to confirm or clear it.
export const TTL_MIN = 90;
const FADE_WINDOW_MIN = 30;
// When Google Weather shows it has been dry for the past few hours, water drains: fade reports twice as fast
let dryFade = false;
export function setDryFade(on) { dryFade = Boolean(on); }
export function isDryFade() { return dryFade; }

export const SEVERITY_LABEL = [
  'No flooding', 'Wet / puddles', 'Ankle-deep', 'Shin-to-knee', 'Knee-to-waist', 'Above waist / fast flow',
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function decorate(r, now = Date.now()) {
  const last = Math.max(r.createdAt || 0, r.lastConfirmedAt || 0);
  const ageMin = (now - last) / 60000;
  const decay = r.demo ? 1 : Math.pow(0.5, ageMin / (dryFade ? HALF_LIFE_MIN / 2 : HALF_LIFE_MIN));
  const c = r.confirms || 0;
  const d = r.clears || 0;
  const aiConf = typeof r.ai?.confidence === 'number' ? r.ai.confidence : 0.5;
  // Reports at official DSD flood-prone spots get a small credibility boost
  const official = r.knownRisk?.length ? 0.1 : 0;
  // Evidence from the anti-spam checks (on site, fresh camera photo, photo GPS matches…) nudges trust ±0.25
  const evidence = clamp(Number(r.trustAdj) || 0, -0.25, 0.2);
  const trust = clamp(0.25 + 0.45 * aiConf + 0.15 * c - 0.25 * d + official + evidence, 0.05, 1);
  const score = trust * decay;

  const ttl = dryFade ? TTL_MIN / 2 : TTL_MIN;
  const leftMin = r.demo ? null : Math.max(0, Math.round(ttl - ageMin));
  let status = 'active';
  if (r.resolved || (d >= 2 && d > c)) status = 'cleared';
  else if (!r.demo && ageMin >= ttl) status = 'expired';
  else if (!r.demo && (ageMin >= ttl - Math.min(FADE_WINDOW_MIN, ttl / 3) || trust < 0.3)) status = 'fading';

  const { voters, ...pub } = r; // never expose voter ids
  return {
    ...pub,
    radius: RADIUS[r.severity] || 0,
    severityLabel: SEVERITY_LABEL[r.severity] || 'Unknown',
    trust: Math.round(trust * 100) / 100,
    score: Math.round(score * 100) / 100,
    status,
    expiresInMin: leftMin,
    ageMin: Math.round((now - (r.createdAt || now)) / 60000),
  };
}

// Hazards that routing should consider: active or fading but still plausible
export function routingHazards(reports) {
  return reports.map((r) => decorate(r))
    .filter((h) => (h.status === 'active' || h.status === 'fading') && h.severity >= 1);
}
