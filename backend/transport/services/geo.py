"""Pure geo-math helpers with zero external dependencies (no network calls).

Keeping this dependency-free means routing/fare/speed calculations can be
unit tested and used as a fallback even if the external OSRM-compatible
routing service is unreachable.
"""
import math


EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points, in kilometres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def bearing_deg(lat1, lng1, lat2, lng2):
    """Initial compass bearing (0-360) from point 1 to point 2."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_lambda = math.radians(lng2 - lng1)

    x = math.sin(d_lambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(d_lambda)
    theta = math.atan2(x, y)
    return (math.degrees(theta) + 360) % 360


def path_length_km(points):
    """Total length of a [lat, lng] polyline, in kilometres."""
    total = 0.0
    for (lat1, lng1), (lat2, lng2) in zip(points, points[1:]):
        total += haversine_km(lat1, lng1, lat2, lng2)
    return total


def _to_local_xy_km(lat, lng, ref_lat):
    """
    Cheap equirectangular projection to local kilometres, accurate enough for
    route-deviation checks over the few-km scale of a single taxi route.
    """
    lat_km = lat * 111.32
    lng_km = lng * 111.32 * math.cos(math.radians(ref_lat))
    return lat_km, lng_km


def distance_point_to_segment_km(point, seg_start, seg_end):
    """Shortest distance from `point` to the line segment seg_start-seg_end, in km."""
    ref_lat = point[0]
    px, py = _to_local_xy_km(*point, ref_lat)
    ax, ay = _to_local_xy_km(*seg_start, ref_lat)
    bx, by = _to_local_xy_km(*seg_end, ref_lat)

    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy

    if length_sq == 0:
        t = 0.0
    else:
        t = ((px - ax) * dx + (py - ay) * dy) / length_sq
        t = max(0.0, min(1.0, t))

    closest_x = ax + t * dx
    closest_y = ay + t * dy
    return math.hypot(px - closest_x, py - closest_y)


def distance_point_to_polyline_km(point, polyline):
    """Shortest distance from `point` ([lat,lng]) to any segment of `polyline`."""
    if not polyline:
        return None
    if len(polyline) == 1:
        return haversine_km(point[0], point[1], polyline[0][0], polyline[0][1])

    return min(
        distance_point_to_segment_km(point, tuple(a), tuple(b))
        for a, b in zip(polyline, polyline[1:])
    )


def point_at_fraction(points, fraction):
    """
    Interpolate a point along a [lat, lng] polyline at `fraction` (0-1) of its
    total length. Used to simulate a vehicle moving along its route geometry
    for live-tracking demos/tests.
    """
    if not points:
        return None
    if len(points) == 1 or fraction <= 0:
        return points[0]
    if fraction >= 1:
        return points[-1]

    total = path_length_km(points)
    target = total * fraction
    covered = 0.0

    for (lat1, lng1), (lat2, lng2) in zip(points, points[1:]):
        seg = haversine_km(lat1, lng1, lat2, lng2)
        if seg == 0:
            continue
        if covered + seg >= target:
            seg_fraction = (target - covered) / seg
            lat = lat1 + (lat2 - lat1) * seg_fraction
            lng = lng1 + (lng2 - lng1) * seg_fraction
            return (lat, lng)
        covered += seg

    return points[-1]
