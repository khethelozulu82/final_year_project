/**
 * Client-side routing helper. Wraps the backend's `/api/routing/directions/`
 * endpoint and normalises the response shape used by PassengerMapDashboard.
 *
 * computeRoute(origin, destination)
 *   origin       : { lat, lng } | { latitude, longitude }
 *   destination  : { lat, lng } | { latitude, longitude }
 *
 * Returns: { geometry, distanceKm, durationMin, source, fare, fareNotice }
 */
import { api } from '../api';

function _pair(p) {
  if (!p) return null;
  const lat = p.lat ?? p.latitude;
  const lng = p.lng ?? p.longitude;
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return null;
  return { lat: latN, lng: lngN };
}

export async function computeRoute(origin, destination) {
  const a = _pair(origin);
  const b = _pair(destination);
  if (!a || !b) {
    throw new Error('computeRoute: valid origin and destination are required.');
  }

  // Backend expects { origin: {lat,lng}, destination: {lat,lng} }
  const data = await api.directions(
    { lat: a.lat, lng: a.lng },
    { lat: b.lat, lng: b.lng }
  );

  if (!data || data.error) {
    throw new Error(data?.error || 'Routing service unavailable.');
  }

  const geometry = Array.isArray(data.geometry) ? data.geometry : [];
  const distanceKm = Number(data.distance_km ?? data.distanceKm ?? 0);
  const durationMin = Number(data.duration_min ?? data.durationMin ?? 0);
  const fareRaw = data.fare != null ? Number(data.fare) : null;
  const fare = Number.isFinite(fareRaw) ? fareRaw : null;

  return {
    geometry,
    distanceKm,
    durationMin,
    source: data.source || 'backend',
    fare,
    fareNotice: data.fare_notice || data.notice || null,
  };
}

export default { computeRoute };