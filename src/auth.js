// Google sign-in (Firebase Authentication). The browser signs in with Google through Firebase and sends its
// Firebase ID token; the server verifies it with Google's public keys before saving ratings or shared routes.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'floodsafehk';
export const authEnabled = () => Boolean(process.env.FIREBASE_API_KEY);
export const publicConfig = () => (authEnabled() ? {
  apiKey: process.env.FIREBASE_API_KEY, authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${PROJECT}.firebaseapp.com`,
  projectId: PROJECT, appId: process.env.FIREBASE_APP_ID,
} : null);

function app() { return getApps()[0] || initializeApp({ projectId: PROJECT }); }

// Returns { uid, name, picture } or null. Never throws for a bad / missing token.
export async function userOf(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  try {
    const t = await getAuth(app()).verifyIdToken(m[1]);
    return { uid: t.uid, name: String(t.name || t.email?.split('@')[0] || 'FloodSafe user').slice(0, 40), picture: t.picture || null };
  } catch (e) { console.warn('auth:', e.code || e.message); return null; }
}
