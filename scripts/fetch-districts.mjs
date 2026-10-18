// Downloads the 18 District Council district boundaries (Home Affairs Department, via CSDI) as simplified WGS84 GeoJSON.
// Used by the rainfall layer: HKO reports past-hour rainfall per district.
import { writeFileSync } from 'node:fs';
const q = new URLSearchParams({ where: '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'geojson', maxAllowableOffset: '0.0006', geometryPrecision: '5' });
const url = 'https://portal.csdi.gov.hk/server/rest/services/common/had_rcd_1634523272907_75218/MapServer/0/query?' + q;
const g = await (await fetch(url)).json();
writeFileSync(new URL('../data/hk_districts_raw.geojson', import.meta.url), JSON.stringify(g));
console.log(g.features.length, JSON.stringify(g.features[0].properties));
