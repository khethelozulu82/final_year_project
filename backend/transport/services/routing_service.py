"""
Routing providers for THEMBA.

Used for:
  - PREDETERMINED route geometry (cached on the Route model)
  - AD-HOC passenger routes when Google Routes is unavailable
    (OpenRouteService fallback)

Order of preference for get_driving_route / get_ad_hoc_route:
  1. OpenRouteService (if ORS_API_KEY is set)
  2. OSRM-compatible service (if ROUTING_SERVICE_URL is set)
  (No straight-line fallback — raise if both fail.)

ORS docs: https://openrouteservice.org/dev/#/api-docs/v2/directions
"""
import logging

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/json"


class RoutingServiceError(Exception):
    pass


def get_driving_route(origin, destination, timeout=8):
    """
    origin / destination: (lat, lng) tuples.
    Returns geometry, distance_km, duration_min, source ("ors" | "osrm").
    No straight-line fallback — raises RoutingServiceError if both fail.
    """
    errors = []

    ors_key = getattr(settings, "ORS_API_KEY", None) or ""
    if ors_key.strip():
        try:
            return _ors_route(origin, destination, ors_key.strip(), timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenRouteService unavailable: %s", exc)
            errors.append(f"ORS: {exc}")
    else:
        errors.append("ORS: ORS_API_KEY not set")

    base_url = getattr(settings, "ROUTING_SERVICE_URL", None) or ""
    if base_url.strip():
        try:
            return _osrm_route(origin, destination, base_url.strip(), timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            logger.warning("OSRM routing unavailable: %s", exc)
            errors.append(f"OSRM: {exc}")
    else:
        errors.append("OSRM: ROUTING_SERVICE_URL not set")

    raise RoutingServiceError(
        "Road routing unavailable (straight-line fallback disabled). "
        + "; ".join(errors)
        + ". Set ORS_API_KEY or ensure ROUTING_SERVICE_URL is reachable."
    )


def get_ad_hoc_route(origin, destination, timeout=8):
    """Same as get_driving_route; explicit name for passenger ad-hoc use."""
    return get_driving_route(origin, destination, timeout=timeout)


def _ors_route(origin, destination, api_key, timeout=8):
    """
    Call OpenRouteService driving-car directions.
    Coordinates are [lng, lat] in the ORS body (opposite of Google lat/lng habit).
    """
    body = {
        "coordinates": [
            [origin[1], origin[0]],
            [destination[1], destination[0]],
        ],
    }
    response = requests.post(
        ORS_DIRECTIONS_URL,
        json=body,
        headers={
            "Authorization": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        timeout=timeout,
    )
    if response.status_code == 401 or response.status_code == 403:
        raise RoutingServiceError(
            "OpenRouteService rejected the API key. Check ORS_API_KEY and that "
            "the key is active at https://openrouteservice.org/dev/#/account"
        )
    if response.status_code == 429:
        raise RoutingServiceError(
            "OpenRouteService quota exceeded. Wait a minute or upgrade the free plan."
        )
    response.raise_for_status()
    payload = response.json()
    routes = payload.get("routes") or []
    if not routes:
        raise RoutingServiceError("OpenRouteService returned no route for these points.")

    route = routes[0]
    summary = route.get("summary") or {}
    distance_m = float(summary.get("distance") or 0)
    duration_s = float(summary.get("duration") or 0)

    geometry = _decode_ors_geometry(route)
    if len(geometry) < 2:
        raise RoutingServiceError("OpenRouteService returned empty geometry.")

    return {
        "geometry": geometry,
        "distance_km": round(distance_m / 1000, 3),
        "duration_min": round(duration_s / 60, 1),
        "source": "ors",
    }


def _decode_ors_geometry(route):
    """
    ORS JSON directions returns an encoded polyline in route['geometry'].
    Decode to [[lat, lng], ...].
    """
    encoded = route.get("geometry")
    if not encoded or not isinstance(encoded, str):
        return []
    return _decode_polyline(encoded)


def _decode_polyline(encoded):
    """Google/ORS encoded polyline algorithm → list of [lat, lng]."""
    coordinates = []
    index = 0
    lat = 0
    lng = 0
    length = len(encoded)

    while index < length:
        result = 0
        shift = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        dlat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += dlat

        result = 0
        shift = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        dlng = ~(result >> 1) if (result & 1) else (result >> 1)
        lng += dlng

        coordinates.append([lat / 1e5, lng / 1e5])

    return coordinates


def _osrm_route(origin, destination, base_url, timeout=5):
    """OSRM expects lng,lat order."""
    coords = f"{origin[1]},{origin[0]};{destination[1]},{destination[0]}"
    url = f"{base_url.rstrip('/')}/route/v1/driving/{coords}"
    response = requests.get(
        url,
        params={"overview": "full", "geometries": "geojson"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    route = payload["routes"][0]
    coordinates = route["geometry"]["coordinates"]  # [[lng, lat], ...]
    geometry = [[lat, lng] for lng, lat in coordinates]
    return {
        "geometry": geometry,
        "distance_km": round(route["distance"] / 1000, 3),
        "duration_min": round(route["duration"] / 60, 1),
        "source": "osrm",
    }
