// One-off: run Gemini's flood assessment on the demo photos so the demo pins show real AI output.
// Run: node --env-file=.env scripts/analyze-demo-photos.mjs
import { readFileSync } from 'node:fs';
import { analyzeFlood } from '../src/gemini.js';
const items = [
  ['demo-1', 'Mong Kok, Kowloon'],
  ['demo-2', 'Wong Tai Sin MTR station, Exit E (Shatin Pass Road)'],
  ['demo-3', 'Heng Fa Chuen Promenade, Eastern District'],
];
const out = {};
for (const [id, place] of items) {
  const b64 = readFileSync(new URL(`../public/demo/${id}.jpg`, import.meta.url)).toString('base64');
  for (let i = 0; i < 4 && !out[id]; i++) {
    try { out[id] = await analyzeFlood({ photoBase64: b64, mimeType: 'image/jpeg', locationHint: place }); }
    catch (e) { console.error(id, e.message); await new Promise((r) => setTimeout(r, 2000)); }
  }
}
console.log(JSON.stringify(out));
