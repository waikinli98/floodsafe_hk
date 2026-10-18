// Storage: Firestore when USE_FIRESTORE=true (Cloud Run), in-memory otherwise (local dev).
import { randomUUID } from 'node:crypto';

const useFirestore = process.env.USE_FIRESTORE === 'true';
let db = null;

async function fs() {
  if (!db) {
    const { Firestore } = await import('@google-cloud/firestore');
    db = new Firestore({ ignoreUndefinedProperties: true });
  }
  return db;
}

const mem = { reports: new Map(), photos: new Map(), meta: new Map(), watches: new Map() };

export const backend = useFirestore ? 'firestore' : 'memory';

export async function listReports(sinceMs = Date.now() - 24 * 3600e3) {
  if (!useFirestore) return [...mem.reports.values()].filter((r) => r.createdAt >= sinceMs || r.demo);
  const snap = await (await fs()).collection('reports').where('createdAt', '>=', sinceMs).get();
  const demoSnap = await (await fs()).collection('reports').where('demo', '==', true).get();
  const byId = new Map();
  for (const d of [...snap.docs, ...demoSnap.docs]) byId.set(d.id, d.data());
  return [...byId.values()];
}

export async function getReport(id) {
  if (!useFirestore) return mem.reports.get(id) || null;
  const d = await (await fs()).collection('reports').doc(id).get();
  return d.exists ? d.data() : null;
}

export async function saveReport(r) {
  if (!r.id) r.id = randomUUID();
  if (!useFirestore) { mem.reports.set(r.id, r); return r; }
  await (await fs()).collection('reports').doc(r.id).set(r);
  return r;
}

export async function deleteReport(id) {
  if (!useFirestore) { mem.reports.delete(id); mem.photos.delete(id); return; }
  const f = await fs();
  await Promise.all([f.collection('reports').doc(id).delete(), f.collection('photos').doc(id).delete()]);
}

// Photos are stored as small JPEGs (client resizes to ~1024px) in a separate collection
// so the report list stays light. For production, move these to Cloud Storage.
export async function savePhoto(id, mimeType, base64) {
  if (!useFirestore) { mem.photos.set(id, { mimeType, base64 }); return; }
  await (await fs()).collection('photos').doc(id).set({ mimeType, base64, at: Date.now() });
}

export async function getPhoto(id) {
  if (!useFirestore) return mem.photos.get(id) || null;
  const d = await (await fs()).collection('photos').doc(id).get();
  return d.exists ? d.data() : null;
}

export async function getMeta(key) {
  if (!useFirestore) return mem.meta.get(key) ?? null;
  const d = await (await fs()).collection('meta').doc(key).get();
  return d.exists ? d.data().value : null;
}

export async function setMeta(key, value) {
  if (!useFirestore) { mem.meta.set(key, value); return; }
  await (await fs()).collection('meta').doc(key).set({ value, at: Date.now() });
}

export async function deletePhoto(id) {
  if (!useFirestore) { mem.photos.delete(id); return; }
  await (await fs()).collection('photos').doc(id).delete();
}
export async function deleteMeta(key) {
  if (!useFirestore) { mem.meta.delete(key); return; }
  await (await fs()).collection('meta').doc(key).delete();
}

// Route watches: someone walking a route with alerts on (push subscription + simplified route line)
export async function saveWatch(w) {
  if (!useFirestore) { mem.watches.set(w.id, w); return w; }
  await (await fs()).collection('watches').doc(w.id).set(w);
  return w;
}
export async function getWatch(id) {
  if (!useFirestore) return mem.watches.get(id) || null;
  const d = await (await fs()).collection('watches').doc(id).get();
  return d.exists ? d.data() : null;
}
export async function listWatches(now = Date.now()) {
  if (!useFirestore) return [...mem.watches.values()].filter((w) => w.expiresAt > now);
  const snap = await (await fs()).collection('watches').where('expiresAt', '>', now).get();
  return snap.docs.map((d) => d.data());
}
export async function deleteWatch(id) {
  if (!useFirestore) { mem.watches.delete(id); return; }
  await (await fs()).collection('watches').doc(id).delete();
}

// Generic small collections (umbrella ratings, shared routes): Firestore on Cloud Run, memory locally.
// Queries are a single equality filter; sorting and limits happen here (avoids composite indexes).
const memCols = new Map();
const col = (name) => { if (!memCols.has(name)) memCols.set(name, new Map()); return memCols.get(name); };
export async function putDoc(name, id, data) {
  if (!useFirestore) { col(name).set(id, data); return data; }
  await (await fs()).collection(name).doc(id).set(data);
  return data;
}
export async function getDoc(name, id) {
  if (!useFirestore) return col(name).get(id) || null;
  const d = await (await fs()).collection(name).doc(id).get();
  return d.exists ? d.data() : null;
}
export async function delDoc(name, id) {
  if (!useFirestore) { col(name).delete(id); return; }
  await (await fs()).collection(name).doc(id).delete();
}
export async function findDocs(name, field = null, value = null, { orderBy = 'at', limit = 50 } = {}) {
  let rows;
  if (!useFirestore) rows = [...col(name).values()].filter((d) => field == null || d[field] === value);
  else {
    let q = (await fs()).collection(name);
    if (field != null) q = q.where(field, '==', value);
    else q = q.orderBy(orderBy, 'desc').limit(limit);
    rows = (await q.get()).docs.map((d) => d.data());
  }
  return rows.sort((a, b) => (b[orderBy] || 0) - (a[orderBy] || 0)).slice(0, limit);
}
