// Report spam / abuse controls.
//  1. Rate limits per device AND per network (IP): a shared Wi-Fi isn't punished for one person, and one
//     person can't flood the map by clearing their browser storage.
//  2. Strikes: Gemini rejections, re-used or screenshot photos and impossible locations count as strikes;
//     3 strikes in an hour pause new reports from that device for 30 minutes.
//  3. Photo checks: when the photo was taken (EXIF / camera file time), where it was taken (EXIF GPS) and
//     where the reporter is (phone GPS) are compared with the reported spot. Stale or far-away photos are
//     rejected; weaker evidence only lowers the report's trust score so it needs a confirmation sooner.
//  4. Duplicate photos: the same picture (exact hash, or a near-identical 64-bit difference hash) can't be
//     posted again at another place.
// State lives in memory per Cloud Run instance (max 3); for production move it to Firestore/Redis and add
// Firebase App Check (reCAPTCHA Enterprise / Play Integrity) so only the real app can post.
import { createHash } from 'node:crypto';
import { haversine } from './geo.js';

const MIN = 60_000;
export const LIMITS = {
  devicePer10Min: 3, devicePerDay: 20, networkPer10Min: 15,
  strikesToPause: 3, strikeWindowMin: 60, pauseMin: 30,
  maxPhotoAgeH: 6, stalePhotoMin: 60,
  photoFarRejectM: 3000, photoFarFlagM: 500, onSiteM: 300, remoteM: 5000,
};

const devices = new Map(); // deviceKey -> { reports: [t], strikes: [{t, reason}], pausedUntil }
const networks = new Map(); // ip -> [t]
const recentHashes = []; // { sha, dh, lat, lng, reportId, at }

export const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
export const deviceKey = (req) => hash(`dev|${req.get('x-client-id') || req.ip}`).slice(0, 20);
const dev = (k) => { if (!devices.has(k)) devices.set(k, { reports: [], strikes: [], pausedUntil: 0 }); return devices.get(k); };

const err = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, publicMessage: message, code, extra });

// Called before a new report is analysed. Throws a 429 with a friendly message when limited.
export function checkCanReport(req, now = Date.now()) {
  const d = dev(deviceKey(req));
  if (d.pausedUntil > now) {
    const m = Math.ceil((d.pausedUntil - now) / MIN);
    throw err(429, 'paused', `Reporting is paused for ${m} min on this device after several reports were rejected.`, { retryMin: m });
  }
  const last10 = d.reports.filter((t) => now - t < 10 * MIN).length;
  if (last10 >= LIMITS.devicePer10Min) throw err(429, 'device_rate', 'You have sent several reports in the last 10 minutes. Please confirm existing pins instead, or try again shortly.');
  if (d.reports.filter((t) => now - t < 24 * 60 * MIN).length >= LIMITS.devicePerDay) throw err(429, 'device_day', 'Daily report limit reached on this device.');
  const net = (networks.get(req.ip) || []).filter((t) => now - t < 10 * MIN);
  if (net.length >= LIMITS.networkPer10Min) throw err(429, 'network_rate', 'Too many reports from this network right now – please try again in a few minutes.');
}

export function noteReport(req, now = Date.now()) {
  const d = dev(deviceKey(req));
  d.reports = [...d.reports.filter((t) => now - t < 24 * 60 * MIN), now];
  networks.set(req.ip, [...(networks.get(req.ip) || []).filter((t) => now - t < 10 * MIN), now]);
}

export function strike(req, reason, now = Date.now()) {
  const d = dev(deviceKey(req));
  d.strikes = [...d.strikes.filter((s) => now - s.t < LIMITS.strikeWindowMin * MIN), { t: now, reason }];
  if (d.strikes.length >= LIMITS.strikesToPause) d.pausedUntil = now + LIMITS.pauseMin * MIN;
  return d.strikes.length;
}

// Evidence checks on the photo and the reporter's position.
// photoMeta = { takenAt, lat, lng, source: 'camera'|'album', sha?, dhash? } (read on the phone before resizing,
// because resizing strips EXIF); me = reporter's GPS { lat, lng, accuracy } or null.
export function evidence({ lat, lng, photo, photoMeta = {}, me = null, now = Date.now() }) {
  const flags = [];
  let adj = 0;
  if (photo) {
    const taken = Number(photoMeta.takenAt);
    if (Number.isFinite(taken) && taken > 0) {
      const ageMin = (now - taken) / MIN;
      if (ageMin > LIMITS.maxPhotoAgeH * 60) {
        throw err(422, 'old_photo', `This photo was taken about ${Math.round(ageMin / 60)} hours ago. Please send a photo of the water now – old photos can send people the wrong way.`, { ageMin: Math.round(ageMin) });
      }
      if (ageMin > LIMITS.stalePhotoMin) { flags.push('older_photo'); adj -= 0.1; }
      else if (ageMin > -10) { flags.push('fresh_photo'); adj += 0.05; }
    }
    const pLat = Number(photoMeta.lat), pLng = Number(photoMeta.lng);
    if (Number.isFinite(pLat) && Number.isFinite(pLng) && (pLat || pLng)) {
      const d = haversine({ lat: pLat, lng: pLng }, { lat, lng });
      if (d > LIMITS.photoFarRejectM) throw err(422, 'photo_far', `The photo's location is ${(d / 1000).toFixed(1)} km from the spot you marked. Please move the pin to where the photo was taken.`, { distanceM: Math.round(d) });
      if (d > LIMITS.photoFarFlagM) { flags.push('photo_location_differs'); adj -= 0.15; }
      else { flags.push('photo_gps_match'); adj += 0.05; }
    }
    if (photoMeta.source === 'camera') { flags.push('live_camera'); adj += 0.05; }
  }
  if (me && Number.isFinite(me.lat) && Number.isFinite(me.lng)) {
    const d = haversine(me, { lat, lng });
    if (d <= LIMITS.onSiteM + Math.min(Number(me.accuracy) || 0, 200)) { flags.push('on_site'); adj += 0.1; }
    else if (d > LIMITS.remoteM) { flags.push('remote'); adj -= 0.1; }
  }
  return { flags, trustAdj: Math.max(-0.25, Math.min(0.2, Math.round(adj * 100) / 100)) };
}

// Same photo already used somewhere else? Exact SHA-256 of the upload, or a near-identical dHash.
const hamming = (a, b) => {
  if (!/^[0-9a-f]{16}$/.test(a || '') || !/^[0-9a-f]{16}$/.test(b || '')) return 99;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};
export function checkDuplicate({ base64, dhash, lat, lng, now = Date.now() }) {
  const sha = hash(base64);
  while (recentHashes.length && now - recentHashes[0].at > 24 * 60 * MIN) recentHashes.shift();
  const hit = recentHashes.find((h) => (h.sha === sha || hamming(h.dh, dhash) <= 5) && haversine(h, { lat, lng }) > 300);
  if (hit) throw err(422, 'duplicate_photo', 'This photo was already used for a report at a different place. Please take a new photo of the water where you are.');
  return sha;
}
export function rememberPhoto({ sha, dhash, lat, lng, reportId, now = Date.now() }) {
  recentHashes.push({ sha, dh: /^[0-9a-f]{16}$/.test(dhash || '') ? dhash : null, lat, lng, reportId, at: now });
  if (recentHashes.length > 5000) recentHashes.shift();
}

// Gemini also judges where the picture came from (schema field image_source)
export const FAKE_SOURCES = new Set(['screenshot', 'photo_of_screen', 'stock_or_news', 'ai_generated']);

export function _reset() { devices.clear(); networks.clear(); recentHashes.length = 0; }
