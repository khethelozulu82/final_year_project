/**
 * Central local taxi fare table (bidirectional) — original themba-search-first.
 * Prefer backend route fare when API returns a Route; this is the single
 * frontend source when matching by place names.
 */
export const PREDETERMINED_PLACES = [
  { id: 'ongoye', name: 'Ongoye', lat: -28.854, lng: 31.846 },
  { id: 'empangeni', name: 'Empangeni', lat: -28.7808, lng: 31.8925 },
  { id: 'esikhawini', name: 'Esikhawini', lat: -28.883, lng: 31.9 },
  { id: 'richards-bay', name: 'Richards Bay', lat: -28.781, lng: 32.0377 },
];

/** Unordered pairs — same fare both directions */
export const LOCAL_FARES = [
  { a: 'Ongoye', b: 'Empangeni', fare: 24 },
  { a: 'Ongoye', b: 'Esikhawini', fare: 20 },
  { a: 'Ongoye', b: 'Richards Bay', fare: 34 },
  { a: 'Esikhawini', b: 'Empangeni', fare: 23 },
  { a: 'Esikhawini', b: 'Richards Bay', fare: 18 },
  { a: 'Richards Bay', b: 'Empangeni', fare: 21 },
];

function norm(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/e?sikhawini/gi, 'esikhawini')
    .replace(/kwa-?dlangezwa|unizulu/gi, 'ongoye');
}

export function lookupLocalFare(originName, destName) {
  const o = norm(originName);
  const d = norm(destName);
  if (!o || !d || o === d) return null;
  for (const row of LOCAL_FARES) {
    const a = norm(row.a);
    const b = norm(row.b);
    if ((o === a && d === b) || (o === b && d === a)) {
      return row.fare;
    }
  }
  return null;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function nearestRank(lat, lng) {
  let best = null;
  let bestKm = Infinity;
  for (const p of PREDETERMINED_PLACES) {
    const km = haversineKm(lat, lng, p.lat, p.lng);
    if (km < bestKm) {
      bestKm = km;
      best = { ...p, distanceKm: Math.round(km * 10) / 10 };
    }
  }
  return best;
}

export const FARE_ROWS = LOCAL_FARES.map((r) => [r.a, r.b, r.fare]);