// Small geometry helpers (metres, WGS84). Good enough at city scale.
const R = 6371000;
const RAD = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Local equirectangular projection around lat0 -> [x, y] in metres
function proj(lat, lng, lat0) {
  return [lng * RAD * R * Math.cos(lat0 * RAD), lat * RAD * R];
}

// Minimum distance (m) from point {lat,lng} to a polyline given as [[lng,lat], ...]
export function distToPolyline(pt, coords) {
  if (!coords || !coords.length) return Infinity;
  const [px, py] = proj(pt.lat, pt.lng, pt.lat);
  let best = Infinity;
  let prev = proj(coords[0][1], coords[0][0], pt.lat);
  if (coords.length === 1) return Math.hypot(prev[0] - px, prev[1] - py);
  for (let i = 1; i < coords.length; i++) {
    const cur = proj(coords[i][1], coords[i][0], pt.lat);
    const dx = cur[0] - prev[0], dy = cur[1] - prev[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - prev[0]) * dx + (py - prev[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(prev[0] + t * dx - px, prev[1] + t * dy - py);
    if (d < best) best = d;
    prev = cur;
  }
  return best;
}

// Move a point by (east, north) metres
export function offset(lat, lng, east, north) {
  return {
    lat: lat + (north / R) / RAD,
    lng: lng + (east / (R * Math.cos(lat * RAD))) / RAD,
  };
}

// Unit vector (east, north) from a to b
export function direction(a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const [ax, ay] = proj(a.lat, a.lng, lat0);
  const [bx, by] = proj(b.lat, b.lng, lat0);
  const len = Math.hypot(bx - ax, by - ay) || 1;
  return [(bx - ax) / len, (by - ay) / len];
}

// Rough Hong Kong bounding box
export function inHongKong(lat, lng) {
  return lat > 22.13 && lat < 22.58 && lng > 113.82 && lng < 114.45;
}
