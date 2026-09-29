"""
Ad-hoc fare estimation — original themba-search-first logic.
Road distance comes from ORS/OSRM; fare always from TaxiFareRule.
"""
from ..models import TaxiFareRule


def estimate_ad_hoc_fare(distance_km, route=None):
    """
    Returns (fare, notice).
    """
    rule = None
    if route is not None:
        rule = TaxiFareRule.objects.filter(
            route_specific_override=route, active=True
        ).first()
    if rule is None:
        rule = TaxiFareRule.objects.filter(
            active=True, route_specific_override__isnull=True
        ).first()

    if rule is None:
        fare = round(max(5.0 + 2.0 * float(distance_km), 10.0), 2)
    else:
        fare = rule.estimate(distance_km)

    notice = getattr(TaxiFareRule, "DEMONSTRATION_NOTICE", None) or (
        "Demonstration fare from THEMBA TaxiFareRule configuration."
    )
    return fare, notice
