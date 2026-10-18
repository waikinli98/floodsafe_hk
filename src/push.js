// Real-time route alerts.
// While someone walks a route with alerts on, their phone registers a "watch": a Web Push subscription plus a
// simplified copy of the route line. Every new or worsening flood report is checked against all active watches;
// if it lies on a watched route ahead of the walker, a push notification goes out at once – even with the phone
// locked or the app closed – and tapping it reroutes around the new flood.
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import * as store from './store.js';
import { RADIUS, SEVERITY_LABEL } from './hazards.js';

const SEV_ZH = ['沒有水浸', '濕滑／水氹', '水深及腳踝', '水深及小腿至膝', '水深及膝至腰', '水深過腰／急流'];
let publicKey = null;

export async function initPush() {
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    // One key pair per deployment, kept in the database so every Cloud Run instance signs with the same key
    const saved = await store.getMeta('vapid').catch(() => null);
    if (saved?.publicKey && saved?.privateKey) ({ publicKey: pub, privateKey: priv } = saved);
    else { ({ publicKey: pub, privateKey: priv } = webpush.generateVAPIDKeys()); await store.setMeta('vapid', { publicKey: pub, privateKey: priv }); }
  }
  webpush.setVapidDetails(process.env.PUSH_CONTACT || 'https://floodsafe-hk-485437365057.asia-east2.run.app', pub, priv);
  publicKey = pub;
  return pub;
}
export const pushKey = () => publicKey;

// ---------- geometry on the flat [lng, lat, lng, lat, …] line ----------
const R = 6371000, rad = Math.PI / 180;
const dist = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2));
const pt = (line, i) => ({ lng: line[2 * i], lat: line[2 * i + 1] });
// distance from p to the route, the nearest vertex index, and metres along the route to that vertex
export function nearRoute(p, line) {
  const n = line.length / 2;
  let best = { d: Infinity, idx: 0 };
  for (let i = 0; i < n - 1; i++) {
    const a = pt(line, i), b = pt(line, i + 1);
    // project p onto segment a-b in a local metric frame
    const kx = Math.cos(a.lat * rad) * R * rad, ky = R * rad;
    const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky, px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
    const L2 = bx * bx + by * by;
    const tt = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
    const d = Math.hypot(px - tt * bx, py - tt * by);
    if (d < best.d) best = { d, idx: tt > 0.5 ? i + 1 : i };
  }
  return best;
}
export function along(line, from, to) {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(to, line.length / 2 - 1); i++) m += dist(pt(line, i), pt(line, i + 1));
  return m;
}
export function simplify(coords, max = 300) {
  const pts = (coords || []).filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const step = Math.max(1, Math.ceil(pts.length / max));
  const out = pts.filter((_, i) => i % step === 0);
  if (pts.length && out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out.flatMap(([lng, lat]) => [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
}

// ---------- watches ----------
export async function createWatch({ subscription, coords, destName, lang, durationS, sandbox }) {
  if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint)) throw Object.assign(new Error('Invalid push subscription'), { status: 400, publicMessage: 'Invalid push subscription' });
  const line = simplify(coords);
  if (line.length < 4) throw Object.assign(new Error('Route missing'), { status: 400, publicMessage: 'Route missing' });
  const now = Date.now();
  const w = {
    id: randomUUID(), sub: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys?.p256dh, auth: subscription.keys?.auth } },
    line, progress: 0, destName: String(destName || '').slice(0, 80), lang: lang === 'zh' ? 'zh' : 'en', sandbox: sandbox || null,
    notified: [], createdAt: now,
    expiresAt: now + Math.min(3 * 3600e3, Math.max(30 * 60e3, 2.5 * (Number(durationS) || 1200) * 1000)),
  };
  await store.saveWatch(w);
  return w;
}

// A report on a watched route, ahead of the walker → push. `sandbox` = demo visitor the report belongs to (or null).
export async function notifyWatchers(report, { sandbox = null, reason = 'new' } = {}) {
  if (!publicKey || !(report.severity >= 2)) return 0;
  const watches = await store.listWatches().catch(() => []);
  let sent = 0;
  for (const w of watches) {
    if (sandbox && w.sandbox !== sandbox) continue; // a demo report only alerts its own visitor
    if ((w.notified || []).includes(`${report.id}:${report.severity}`)) continue;
    const { d, idx } = nearRoute(report, w.line);
    if (d > (RADIUS[report.severity] || 40) + 40) continue;
    if (idx < (w.progress || 0) - 2) continue; // already walked past it
    const ahead = Math.round(along(w.line, w.progress || 0, idx) / 10) * 10;
    const zh = w.lang === 'zh';
    const place = zh ? (report.placeHintZh || report.placeHint) : report.placeHint;
    const sev = zh ? SEV_ZH[report.severity] : SEVERITY_LABEL[report.severity];
    const payload = {
      title: zh ? (reason === 'worse' ? '🌊 路線上的水浸惡化' : '🌊 你的路線前方有新水浸報告') : (reason === 'worse' ? '🌊 Flooding on your route got worse' : '🌊 New flood reported on your route'),
      body: zh ? `約 ${ahead} 米前方：${sev}${place ? `（${place}）` : ''}。按此改道。` : `About ${ahead} m ahead: ${sev}${place ? ` at ${place}` : ''}. Tap to reroute.`,
      tag: `route-${report.id}`, reportId: report.id, aheadM: ahead, severity: report.severity, url: `/?reroute=1&alert=${encodeURIComponent(report.id)}`,
    };
    try {
      await webpush.sendNotification(w.sub, JSON.stringify(payload), { TTL: 600, urgency: 'high', topic: `r${String(report.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}` });
      sent++;
      w.notified = [...(w.notified || []), `${report.id}:${report.severity}`].slice(-30);
      await store.saveWatch(w);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await store.deleteWatch(w.id); // subscription gone
      else console.warn('push failed', e.statusCode || '', e.body || e.message);
    }
  }
  return sent;
}
