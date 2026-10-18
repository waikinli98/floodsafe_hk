// One-off: geocode DSD "Locations Prone to Blockage" and save data/dsd_blockage_geocoded.json
// Usage: MAPS_SERVER_KEY=... node scripts/geocode-dsd.mjs   (needs Geocoding API enabled; ~231 requests)
// Review the output on the map (Demo → DSD layer) and fix any obviously wrong points by hand.
import { readFile, writeFile } from 'node:fs/promises';
import { geocodeAll, GEOCODER_VERSION } from '../src/dsd.js';

if (!process.env.MAPS_SERVER_KEY) { console.error('Set MAPS_SERVER_KEY'); process.exit(1); }
const src = JSON.parse(await readFile(new URL('../data/dsd_blockage.json', import.meta.url), 'utf8'));
const located = await geocodeAll(src.locations);
const stats = located.reduce((a, r) => ((a[r.lat ? r.precision : r.geocodeStatus] = (a[r.lat ? r.precision : r.geocodeStatus] || 0) + 1), a), {});
await writeFile(new URL('../data/dsd_blockage_geocoded.json', import.meta.url),
  JSON.stringify({ ...src, geocoderVersion: GEOCODER_VERSION, geocodedAt: new Date().toISOString(), locations: located }, null, 1));
console.log('Saved data/dsd_blockage_geocoded.json', stats);
console.log('Locations that could not be placed precisely are left off the map and out of routing.');
