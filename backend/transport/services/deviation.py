"""
Route deviation detection: is a vehicle's current position close enough to
its assigned route's geometry to be considered "on route"?

Deliberately conservative: a tiny GPS wobble should never flip a vehicle to
OFF_ROUTE, so this compares against a configurable threshold (metres),
defaulting to settings.DEFAULT_ROUTE_DEVIATION_THRESHOLD_M, with a
per-route override.
"""
from dataclasses import dataclass

from django.conf import settings

from .geo import distance_point_to_polyline_km


@dataclass
class DeviationResult:
    status: str  # "on_route" | "off_route" | "unknown"
    distance_m: float | None

    def as_dict(self):
        return {'route_status': self.status, 'distance_from_route_m': self.distance_m}


def check_deviation(lat, lng, route):
    """
    route: a Route instance (or None). Returns a DeviationResult.
    """
    if route is None or not route.geometry:
        return DeviationResult(status='unknown', distance_m=None)

    threshold_m = route.deviation_threshold_m or settings.DEFAULT_ROUTE_DEVIATION_THRESHOLD_M
    distance_km = distance_point_to_polyline_km((lat, lng), route.geometry)
    distance_m = round(distance_km * 1000, 1)

    status = 'on_route' if distance_m <= threshold_m else 'off_route'
    return DeviationResult(status=status, distance_m=distance_m)
