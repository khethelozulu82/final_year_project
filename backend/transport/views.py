"""
Merged API views: FYP trip/booking/operator + search-first routing/GPS/panic.
Includes:
  - Passenger complaint flow (one per trip, only after COMPLETED)
  - Passenger rating flow (one per trip, only after COMPLETED)
  - Passenger history endpoint
  - Walk-in registration uses next-of-kin as mobile / id replacement
  - Terminal trip status cascades onto bookings so passenger views update.
  - Admin trip scheduling requires a VERIFIED driver and a vehicle.
"""
import logging
import math

from .models import (  # noqa: E402
    Announcement,
    AuditLog,
    SafetyIncident,
    OperatorNotification,
    PassengerNotification,
    DriverComplaint,
    DriverRating,
    DriverNotification,
    PanicAlert,
    OperatorAtRank,
)

import requests
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.db import models as dj_models
from django.utils import timezone
from django.utils.crypto import get_random_string
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from accounts.models import OperatorProfile
from accounts.serializers import UserPublicSerializer

from .models import (
    RideRequest,
    Booking,
    Destination,
    OperatorAtRank,
    PanicAlert,
    Rank,
    Route,
    TaxiFareRule,
    Trip,
    TripAssetChange,
    TripFlag,
    Vehicle,
    VehicleLocation,
    VerificationCode,
    DriverNotification,
    DriverComplaint,
    DriverRating,
)
from .serializers import (
    BookingSerializer,
    DestinationSerializer,
    PanicAlertSerializer,
    RideRequestSerializer,
    PassengerNotificationSerializer,
    RankSerializer,
    RouteSerializer,
    TripSerializer,
    VehicleLocationSerializer,
    VehicleSerializer,
)
from .services.routing_service import get_ad_hoc_route, get_driving_route, RoutingServiceError
from .services.fare_service import estimate_ad_hoc_fare
from .services.deviation import check_deviation


logger = logging.getLogger(__name__)


def _operator(request):
    try:
        return request.user.operator_profile
    except Exception:
        return None


def _cascade_trip_status_to_bookings(trip, new_status):
    """
    When a Trip reaches a terminal status, mirror it onto every active
    Booking on that trip so the passenger's My bookings view reflects it.

    Called from:
      - api_admin_simulate_trip (Dev tab progression)
      - api_admin_trip_detail (PATCH status)

    Cancellation already has its own cascade in api_cancel_trip; this helper
    is what handles the COMPLETED transition (and provides a uniform
    fallback for CANCELLED too).
    """
    terminal_map = {
        Trip.Status.COMPLETED: Booking.Status.COMPLETED,
        Trip.Status.CANCELLED: Booking.Status.CANCELLED,
    }
    target = terminal_map.get(new_status)
    if target is None:
        return 0

    affected = 0
    qs = trip.bookings.exclude(
        status__in=[Booking.Status.CANCELLED, Booking.Status.COMPLETED]
    )
    for b in qs:
        b.status = target
        b.save(update_fields=["status"])
        affected += 1

        if b.passenger_id:
            PassengerNotification.objects.create(
                passenger=b.passenger,
                title=f"Trip {trip.trip_code} {new_status}",
                body=(
                    f"Your trip {trip.route.departure.name} → "
                    f"{trip.route.destination.name} on {trip.departure_date} "
                    f"is now {new_status}. Open Archived trips to leave feedback."
                ),
                meta={
                    "type": (
                        "trip_completed"
                        if new_status == Trip.Status.COMPLETED
                        else "trip_cancelled"
                    ),
                    "trip_id": trip.id,
                    "trip_code": trip.trip_code,
                    "booking_id": b.id,
                },
            )
    return affected


# ---------- Public discovery ----------


def _operator_can_access_trip(op, trip):
    if trip.operator_id == op.id:
        return True
    rank_ids = set(
        OperatorAtRank.objects.filter(
            operator=op, status=OperatorAtRank.Status.ACTIVE
        ).values_list("rank_id", flat=True)
    )
    return trip.route_id and trip.route.departure_id in rank_ids


def _get_operator_trip(op, trip_id):
    try:
        trip = Trip.objects.select_related(
            "route__departure", "route__destination", "driver__user", "vehicle", "operator__user"
        ).get(pk=trip_id)
    except Trip.DoesNotExist:
        return None
    if not _operator_can_access_trip(op, trip):
        return None
    return trip


@api_view(["GET"])
@permission_classes([AllowAny])
def api_list_ranks(request):
    return Response(RankSerializer(Rank.objects.all(), many=True).data)


@api_view(["GET"])
@permission_classes([AllowAny])
def api_list_destinations(request):
    return Response(DestinationSerializer(Destination.objects.all(), many=True).data)


@api_view(["GET"])
@permission_classes([AllowAny])
def api_list_routes(request):
    qs = Route.objects.filter(active=True).select_related("departure", "destination")
    from_q = request.query_params.get("from", "").strip()
    to_q = request.query_params.get("to", "").strip()
    if from_q:
        qs = qs.filter(
            dj_models.Q(departure__name__icontains=from_q)
            | dj_models.Q(departure__area__icontains=from_q)
        )
    if to_q:
        qs = qs.filter(destination__name__icontains=to_q)
    return Response(RouteSerializer(qs, many=True).data)


@api_view(["GET"])
@permission_classes([AllowAny])
def api_list_trips(request):
    """Upcoming / bookable trips for passengers."""
    today = timezone.localdate()
    qs = (
        Trip.objects.filter(
            departure_date__gte=today,
            status__in=[
                Trip.Status.SCHEDULED,
                Trip.Status.BOARDING,
                Trip.Status.IN_PROGRESS,
            ],
        )
        .select_related(
            "route__departure",
            "route__destination",
            "vehicle",
            "driver__user",
            "operator__association",
        )
        .order_by("departure_date", "expected_departure_time")
    )
    from_q = request.query_params.get("from", "").strip()
    to_q = request.query_params.get("to", "").strip()
    if from_q:
        qs = qs.filter(
            dj_models.Q(route__departure__name__icontains=from_q)
            | dj_models.Q(route__departure__area__icontains=from_q)
        )
    if to_q:
        qs = qs.filter(route__destination__name__icontains=to_q)

    data = TripSerializer(qs, many=True).data

    role = getattr(request.user, "role", "") or ""
    if role not in ("operator", "driver", "admin"):
        for row in data:
            row.pop("trip_code", None)

    return Response(data)


@api_view(["GET"])
@permission_classes([AllowAny])
def api_trip_detail(request, trip_id):
    try:
        trip = Trip.objects.select_related(
            "route__departure", "route__destination", "vehicle", "driver__user", "operator__association"
        ).get(pk=trip_id)
    except Trip.DoesNotExist:
        return Response({"detail": "Trip not found."}, status=404)

    data = TripSerializer(trip).data
    role = getattr(request.user, "role", "") or ""
    if role not in ("operator", "driver", "admin"):
        data.pop("trip_code", None)
    return Response(data)


# ---------- Passenger booking ----------


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_trip_live_tracking(request, trip_id):
    try:
        trip = Trip.objects.select_related(
            "route__departure",
            "route__destination",
            "vehicle",
            "driver__user",
            "operator__association",
        ).get(pk=trip_id)
    except Trip.DoesNotExist:
        return Response({"detail": "Trip not found."}, status=404)

    role = getattr(request.user, "role", "") or ""
    if role == "passenger":
        has = Booking.objects.filter(
            trip=trip,
            passenger=request.user,
            status__in=[Booking.Status.RESERVED, Booking.Status.BOARDED],
        ).exists()
        if not has:
            return Response(
                {"detail": "Book this trip (or enter your verification code) before tracking."},
                status=403,
            )

    data = TripSerializer(trip).data
    loc = None
    if trip.vehicle_id:
        loc_obj = (
            VehicleLocation.objects.filter(vehicle_id=trip.vehicle_id)
            .order_by("-recorded_at")
            .first()
        )
        if loc_obj:
            loc = VehicleLocationSerializer(loc_obj).data
    data["live_location"] = loc
    data["has_live_location"] = loc is not None
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_create_booking(request):
    trip_id = request.data.get("trip_id")
    trip_code = (request.data.get("trip_code") or "").strip().upper()

    if not trip_id and not trip_code:
        return Response({"detail": "trip_id or trip_code is required."}, status=400)

    if trip_code:
        trip = (
            Trip.objects.select_related("route")
            .filter(trip_code__iexact=trip_code)
            .first()
        )
        if not trip:
            return Response({"detail": "Invalid trip verification code."}, status=404)
        if trip_id and int(trip_id) != trip.id:
            return Response({"detail": "trip_id does not match trip_code."}, status=400)
    else:
        try:
            trip = Trip.objects.select_related("route").get(pk=trip_id)
        except Trip.DoesNotExist:
            return Response({"detail": "Trip not found."}, status=404)

    if trip.seats_available < 1:
        return Response({"detail": "No seats available."}, status=400)
    if trip.status not in (Trip.Status.SCHEDULED, Trip.Status.BOARDING):
        return Response({"detail": "Trip is not open for booking."}, status=400)

    existing = Booking.objects.filter(
        trip=trip,
        passenger=request.user,
        status__in=[Booking.Status.RESERVED, Booking.Status.BOARDED],
    ).first()
    if existing:
        return Response(BookingSerializer(existing).data)

    booking = Booking.objects.create(
        trip=trip,
        passenger=request.user,
        status=Booking.Status.RESERVED,
        fare_paid=trip.route.fare,
    )
    code = get_random_string(6).upper()
    VerificationCode.objects.create(booking=booking, code=code)

    data = BookingSerializer(booking).data
    data["verification_code"] = code
    return Response(data, status=201)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_my_bookings(request):
    """
    Passenger booking list for the My bookings panel.

    By default returns only ACTIVE bookings (reserved / boarded).
    Cancelled and completed bookings are archived — pass ?include=all
    to fetch them for a history view.
    """
    include = (request.query_params.get("include") or "").strip().lower()

    qs = (
        Booking.objects.filter(passenger=request.user)
        .select_related(
            "trip__route__departure",
            "trip__route__destination",
            "trip__driver__user",
            "trip__operator__user",
        )
        .prefetch_related("verification_code")
        .order_by("-booked_at")
    )

    if include != "all":
        qs = qs.filter(
            status__in=[Booking.Status.RESERVED, Booking.Status.BOARDED]
        )

    return Response(BookingSerializer(qs, many=True).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_redeem_verification_code(request):
    code = (request.data.get("code") or request.data.get("verification_code") or "").strip().upper()
    if not code:
        return Response({"detail": "code is required."}, status=400)

    vc = (
        VerificationCode.objects.select_related(
            "booking__trip__route__departure",
            "booking__trip__route__destination",
            "booking__trip__driver__user",
            "booking__trip__operator__user",
            "booking__passenger",
        )
        .filter(code__iexact=code)
        .first()
    )
    if vc is None:
        trip = Trip.objects.select_related(
            "route__departure", "route__destination", "driver__user", "operator__user"
        ).filter(trip_code__iexact=code).first()
        if not trip:
            return Response({"detail": "Invalid verification code."}, status=404)
        if trip.seats_available < 1 and not Booking.objects.filter(
            trip=trip, passenger=request.user
        ).exclude(status=Booking.Status.CANCELLED).exists():
            return Response({"detail": "No seats available on this trip."}, status=400)
        booking = Booking.objects.filter(
            trip=trip, passenger=request.user
        ).exclude(status=Booking.Status.CANCELLED).first()
        if not booking:
            booking = Booking.objects.create(
                trip=trip,
                passenger=request.user,
                status=Booking.Status.RESERVED,
                fare_paid=trip.route.fare,
            )
            vc = VerificationCode.objects.create(booking=booking, code=get_random_string(6).upper())
        else:
            vc = getattr(booking, "verification_code", None)
            if vc is None:
                vc = VerificationCode.objects.create(
                    booking=booking, code=get_random_string(6).upper()
                )
    else:
        booking = vc.booking
        trip = booking.trip
        if booking.passenger_id is None:
            booking.passenger = request.user
            if not (booking.walk_in_name or "").strip():
                booking.walk_in_name = (
                    f"{request.user.first_name} {request.user.last_name}".strip()
                    or request.user.username
                )
            booking.save()

            if trip.driver_id:
                DriverNotification.objects.create(
                    driver=trip.driver,
                    title="Passenger claimed booking",
                    body=(
                        f"{booking.display_name()} verified code {vc.code} "
                        f"on {trip.trip_code}."
                    ),
                    link_trip=trip,
                    link_booking=booking,
                    meta={
                        "type": "code_claimed",
                        "trip_id": trip.id,
                        "trip_code": trip.trip_code,
                        "booking_id": booking.id,
                    },
                )
        elif booking.passenger_id != request.user.id:
            return Response(
                {"detail": "This verification code belongs to another passenger."},
                status=403,
            )

    if vc.verified_at is None:
        vc.verified_at = timezone.now()
        vc.save(update_fields=["verified_at"])

    if booking.status in (Booking.Status.RESERVED, getattr(Booking.Status, "CONFIRMED", "reserved")):
        booking.status = Booking.Status.BOARDED
        booking.boarded_at = timezone.now()
        booking.boarded_by = request.user
        booking.save()

    trip = booking.trip
    dep = getattr(trip.route, "departure", None)
    dest = getattr(trip.route, "destination", None)
    driver_name = None
    if trip.driver_id and getattr(trip.driver, "user", None):
        u = trip.driver.user
        driver_name = f"{u.first_name} {u.last_name}".strip() or u.username
    operator_name = None
    if trip.operator_id and getattr(trip.operator, "user", None):
        u = trip.operator.user
        operator_name = f"{u.first_name} {u.last_name}".strip() or u.username

    return Response(
        {
            "booking_id": booking.id,
            "id": booking.id,
            "status": booking.status,
            "fare_paid": str(booking.fare_paid) if booking.fare_paid is not None else None,
            "verification_code": vc.code,
            "trip_id": trip.id,
            "trip_code": trip.trip_code,
            "departure_date": str(trip.departure_date),
            "expected_departure_time": str(trip.expected_departure_time) if trip.expected_departure_time else None,
            "trip_status": trip.status,
            "origin": getattr(dep, "name", None),
            "destination": getattr(dest, "name", None),
            "driver_name": driver_name,
            "operator_name": operator_name,
            "seat_capacity": trip.seat_capacity,
            "seats_taken": getattr(trip, "seats_taken", None),
            "route": {
                "id": trip.route_id,
                "fare": str(trip.route.fare) if trip.route_id else None,
                "departure": {"name": getattr(dep, "name", None), "latitude": float(dep.latitude) if dep and dep.latitude is not None else None, "longitude": float(dep.longitude) if dep and dep.longitude is not None else None},
                "destination": {"name": getattr(dest, "name", None), "latitude": float(dest.latitude) if dest and dest.latitude is not None else None, "longitude": float(dest.longitude) if dest and dest.longitude is not None else None},
                "geometry": getattr(trip.route, "geometry", None) or [],
            },
            "message": "Trip verified and added to My bookings.",
        }
    )


# ------------------------------------------------------------------
# Passenger-facing announcements
# ------------------------------------------------------------------
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_passenger_announcements(request):
    """Global + passenger-targeted announcements for the passenger Notifications panel."""
    if getattr(request.user, "role", "") != "passenger":
        return Response({"detail": "Passengers only."}, status=403)

    now = timezone.now()
    qs = (
        Announcement.objects.filter(
            status=Announcement.Status.PUBLISHED,
            audience__in=[
                Announcement.Audience.ALL_USERS,
                "passengers",
            ],
        )
        .order_by("-published_at", "-updated_at")[:50]
    )

    def _visible(a):
        if a.scheduled_for and a.scheduled_for > now:
            return False
        return True

    rows = []
    for a in qs:
        if not _visible(a):
            continue
        rows.append(
            {
                "id": a.id,
                "title": a.topic,
                "body": a.message,
                "when": (a.published_at or a.updated_at).isoformat() if (a.published_at or a.updated_at) else None,
                "scope": "global" if a.audience == Announcement.Audience.ALL_USERS else "passengers",
                "rank_id": a.rank_id,
                "route_id": a.route_id,
            }
        )

    return Response(rows)


# ---------- Operator ----------


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_my_trips(request):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    rank_ids = list(
        OperatorAtRank.objects.filter(
            operator=op, status=OperatorAtRank.Status.ACTIVE
        ).values_list("rank_id", flat=True)
    )
    qs = Trip.objects.select_related(
        "route__departure",
        "route__destination",
        "vehicle",
        "driver__user",
        "operator__user",
        "operator__association",
    )
    if rank_ids:
        qs = qs.filter(route__departure_id__in=rank_ids)
    else:
        qs = qs.filter(operator=op)
    qs = qs.order_by("departure_date", "expected_departure_time", "id")
    return Response(TripSerializer(qs, many=True).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_trip_manifest(request, trip_id):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not found or not in your rank scope."}, status=404)
    data = TripSerializer(trip).data
    data["is_engaged"] = bool(trip.engaged_at or trip.engaged_by_id)
    bookings = trip.bookings.select_related("passenger").prefetch_related("verification_code")
    booked, walk_ins = [], []
    for b in bookings:
        try:
            vc = b.verification_code
        except Exception:
            vc = None
        name = b.display_name()
        entry = {
            "booking_id": b.id,
            "name": name,
            "phone": (b.passenger.phone if b.passenger else b.walk_in_phone) or "",
            "status": b.status,
            "walk_in": b.passenger is None,
            "verification_code": vc.code if vc else None,
            "code_verified": bool(vc and vc.verified_at),
            "next_of_kin_name": b.walk_in_next_of_kin_name or "",
            "next_of_kin_phone": b.walk_in_next_of_kin_phone or "",
        }
        (walk_ins if b.passenger is None else booked).append(entry)
    data["booked_passengers"] = booked
    data["walk_in_passengers"] = walk_ins
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_register_walk_in(request, trip_id):
    """
    Operator registers a walk-in passenger.

    Walk-in uses next-of-kin fields in place of mobile / ID:
      - next_of_kin_name    (was: mobile)
      - next_of_kin_phone   (was: id_number)
    """
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not found or not in your rank scope."}, status=404)
    if trip.seats_available < 1:
        return Response({"detail": "No seats available."}, status=400)

    name = (request.data.get("name") or "").strip()
    if not name:
        fn = (request.data.get("first_name") or "").strip()
        sn = (request.data.get("surname") or request.data.get("last_name") or "").strip()
        name = f"{fn} {sn}".strip()
    if not name:
        return Response({"detail": "name is required."}, status=400)

    nok_name = (request.data.get("next_of_kin_name") or "").strip()
    nok_phone = (request.data.get("next_of_kin_phone") or "").strip()

    booking = Booking.objects.create(
        trip=trip,
        walk_in_name=name,
        walk_in_phone=nok_phone,
        walk_in_id_number=nok_name,
        walk_in_next_of_kin_name=nok_name,
        walk_in_next_of_kin_phone=nok_phone,
        status=Booking.Status.RESERVED,
        fare_paid=trip.route.fare,
    )
    code = get_random_string(6).upper()
    VerificationCode.objects.create(booking=booking, code=code)

    data = BookingSerializer(booking).data
    data["verification_code"] = code
    return Response(data, status=201)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_engage_trip(request, trip_id):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not found or not in your rank scope."}, status=404)
    trip.engaged_by = op
    trip.engaged_at = timezone.now()
    if trip.status == Trip.Status.SCHEDULED:
        trip.status = Trip.Status.BOARDING
    trip.save()
    return Response(TripSerializer(trip).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_release_trip(request, trip_id):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not found or not in your rank scope."}, status=404)
    trip.engaged_by = None
    trip.engaged_at = None
    trip.save(update_fields=["engaged_by", "engaged_at"])
    return Response(TripSerializer(trip).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_cancel_trip(request, trip_id):
    """
    Cancel a trip. Cascade:
      - Trip.status → cancelled
      - Trip.engaged_by / engaged_at → cleared
      - All non-terminal bookings → cancelled
      - Assigned driver + every passenger notified
      - Audit entry written
    """
    op = _operator(request)
    is_admin = getattr(request.user, "role", "") == "admin"

    if op is None and not is_admin:
        return Response({"detail": "Operator or admin only."}, status=403)

    if is_admin:
        try:
            trip = Trip.objects.select_related(
                "route__departure",
                "route__destination",
                "driver__user",
                "operator__user",
                "vehicle",
            ).get(pk=trip_id)
        except Trip.DoesNotExist:
            return Response({"detail": "Trip not found."}, status=404)
    else:
        trip = _get_operator_trip(op, trip_id)
        if trip is None:
            return Response(
                {"detail": "Trip not found or not in your rank scope."}, status=404
            )

    if trip.status == Trip.Status.CANCELLED:
        return Response(
            {"detail": "Trip is already cancelled.", "id": trip.id, "status": trip.status},
            status=400,
        )
    if trip.status == Trip.Status.COMPLETED:
        return Response(
            {"detail": "Completed trips cannot be cancelled."}, status=400
        )

    reason = (request.data.get("reason") or "").strip()[:500]

    trip.status = Trip.Status.CANCELLED
    trip.engaged_by = None
    trip.engaged_at = None
    if reason:
        existing = trip.notes or ""
        trip.notes = (existing + f"\nCancellation reason: {reason}").strip()[:1000]
    trip.save()

    affected = 0
    for booking in trip.bookings.exclude(
        status__in=[Booking.Status.CANCELLED, Booking.Status.COMPLETED]
    ).select_related("passenger"):
        booking.status = Booking.Status.CANCELLED
        booking.save(update_fields=["status"])
        affected += 1

        if booking.passenger_id:
            PassengerNotification.objects.create(
                passenger=booking.passenger,
                title=f"Trip {trip.trip_code} cancelled",
                body=(
                    f"Your trip {trip.route.departure.name} → "
                    f"{trip.route.destination.name} on {trip.departure_date} "
                    f"has been cancelled."
                    + (f" Reason: {reason}" if reason else "")
                ),
                meta={
                    "type": "trip_cancelled",
                    "trip_id": trip.id,
                    "trip_code": trip.trip_code,
                    "booking_id": booking.id,
                    "reason": reason or None,
                },
            )

    if trip.driver_id:
        DriverNotification.objects.create(
            driver=trip.driver,
            title=f"Trip {trip.trip_code} cancelled",
            body=(
                f"{trip.route.departure.name} → {trip.route.destination.name} "
                f"on {trip.departure_date} has been cancelled."
                + (f" Reason: {reason}" if reason else "")
            ),
            link_trip=trip,
            meta={
                "type": "trip_cancelled",
                "trip_id": trip.id,
                "trip_code": trip.trip_code,
                "reason": reason or None,
            },
        )

    try:
        _audit(
            request.user,
            "trip.cancel",
            "trip",
            trip.id,
            f"Cancelled {trip.trip_code} · {affected} booking(s) cancelled",
            {"reason": reason or None, "bookings_cancelled": affected},
        )
    except Exception:
        pass

    return Response(
        {
            "id": trip.id,
            "trip_code": trip.trip_code,
            "status": trip.status,
            "bookings_cancelled": affected,
            "reason": reason or None,
            "message": f"Trip {trip.trip_code} cancelled · {affected} booking(s) cancelled.",
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_verify_booking(request, trip_id, booking_id):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not found or not in your rank scope."}, status=404)
    try:
        booking = Booking.objects.get(pk=booking_id, trip=trip)
    except Booking.DoesNotExist:
        return Response({"detail": "Booking not found."}, status=404)

    code = (request.data.get("code") or "").strip().upper()
    try:
        vc = booking.verification_code
    except Exception:
        vc = None
    if vc and code and vc.code.upper() != code:
        return Response({"detail": "Invalid verification code."}, status=400)
    booking.status = Booking.Status.BOARDED
    booking.boarded_at = timezone.now()
    booking.boarded_by = request.user
    booking.save()
    if vc and not vc.verified_at:
        vc.verified_at = timezone.now()
        vc.save(update_fields=["verified_at"])
    return Response(BookingSerializer(booking).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_my_memberships(request):
    op = _operator(request)
    if not op:
        return Response({"detail": "Not an operator account."}, status=403)
    qs = OperatorAtRank.objects.filter(operator=op).select_related("rank")
    data = [
        {
            "id": m.id,
            "status": m.status,
            "notes": getattr(m, "notes", "") or "",
            "rank": RankSerializer(m.rank).data,
        }
        for m in qs
    ]
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_request_rank(request):
    op = _operator(request)
    if not op:
        return Response({"detail": "Not an operator account."}, status=403)
    rank_id = request.data.get("rank_id")
    notes = (request.data.get("notes") or "")[:500]
    try:
        rank = Rank.objects.get(pk=rank_id)
    except Rank.DoesNotExist:
        return Response({"detail": "Rank not found."}, status=404)
    if OperatorAtRank.objects.filter(operator=op, rank=rank).exists():
        return Response({"detail": "Already requested or member of this rank."}, status=400)
    m = OperatorAtRank.objects.create(
        operator=op,
        rank=rank,
        status=OperatorAtRank.Status.PENDING,
        notes=notes,
    )
    return Response(
        {"id": m.id, "status": m.status, "rank": RankSerializer(rank).data, "notes": notes},
        status=201,
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_flag_trip(request, trip_id):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not found or not in your rank scope."}, status=404)
    flag = TripFlag.objects.create(
        trip=trip,
        category=request.data.get("category", TripFlag.Category.OTHER),
        description=request.data.get("description", ""),
        flagged_by=request.user,
    )
    trip.status = Trip.Status.FLAGGED
    trip.save(update_fields=["status"])
    return Response({"id": flag.id, "status": flag.status}, status=201)


# ---------- Driver ----------


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_my_vehicle(request):
    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "Not a driver account."}, status=403)
    assignment = (
        dp.vehicle_assignments.filter(active=True).select_related("vehicle").first()
    )
    if assignment:
        return Response(VehicleSerializer(assignment.vehicle).data)
    trip = (
        Trip.objects.filter(driver=dp, status=Trip.Status.IN_PROGRESS)
        .select_related("vehicle")
        .first()
    )
    if trip and trip.vehicle:
        return Response(VehicleSerializer(trip.vehicle).data)
    return Response({"detail": "No vehicle assigned."}, status=404)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_driver_my_trips(request):
    if request.user.role != "driver":
        return Response({"detail": "Drivers only."}, status=403)
    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "No driver profile."}, status=404)
    qs = (
        Trip.objects.filter(driver=dp)
        .select_related(
            "route__departure", "route__destination", "vehicle", "driver__user"
        )
        .prefetch_related("route__stops")
        .order_by("-departure_date", "-expected_departure_time")
    )
    return Response(TripSerializer(qs, many=True).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_driver_confirm_trip(request):
    if request.user.role != "driver":
        return Response({"detail": "Drivers only."}, status=403)
    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "No driver profile."}, status=404)

    code = (
        request.data.get("trip_code") or request.data.get("code") or ""
    ).strip().upper()
    if not code:
        return Response({"detail": "trip_code is required."}, status=400)

    trip = (
        Trip.objects.filter(trip_code__iexact=code)
        .select_related("route__departure", "route__destination", "vehicle")
        .prefetch_related("route__stops")
        .first()
    )
    if not trip:
        return Response({"detail": "Invalid trip code."}, status=404)

    if trip.status in (Trip.Status.COMPLETED, Trip.Status.CANCELLED):
        return Response(
            {"detail": f"Trip is {trip.status} and cannot be confirmed."},
            status=400,
        )

    if trip.driver_id and trip.driver_id != dp.id:
        return Response(
            {"detail": "Trip already assigned to another driver."}, status=403
        )
    if trip.driver_id is None:
        trip.driver = dp
        trip.save(update_fields=["driver"])

    return Response(TripSerializer(trip).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_driver_profile(request):
    if request.user.role != "driver":
        return Response({"detail": "Drivers only."}, status=403)
    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "No driver profile."}, status=404)

    ratings = dp.ratings.all()
    avg = ratings.aggregate(dj_models.Avg("score"))["score__avg"]

    return Response(
        {
            "user": UserPublicSerializer(request.user).data,
            "license_number": dp.license_number,
            "status": dp.status,
            "rating_avg": round(avg, 2) if avg is not None else None,
            "rating_count": ratings.count(),
            "complaint_count": dp.complaints.count(),
            "open_complaints": dp.complaints.filter(status="open").count(),
            "trips": TripSerializer(
                Trip.objects.filter(driver=dp)
                .select_related(
                    "route__departure",
                    "route__destination",
                    "vehicle",
                )
                .order_by("-departure_date")[:20],
                many=True,
            ).data,
            "notifications": [
                {
                    "id": n.id,
                    "title": n.title,
                    "body": n.body,
                    "read": n.read,
                    "created_at": n.created_at,
                    "trip_id": n.link_trip_id,
                    "booking_id": n.link_booking_id,
                    "meta": n.meta or {},
                }
                for n in dp.notifications.order_by("-created_at")[:30]
            ],
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_vehicle_location(request, vehicle_id):
    try:
        vehicle = Vehicle.objects.get(pk=vehicle_id)
    except Vehicle.DoesNotExist:
        return Response({"detail": "Vehicle not found."}, status=404)

    allowed = False
    if request.user.role == "admin":
        allowed = True
    elif request.user.role == "operator":
        op = _operator(request)
        allowed = op is not None and Trip.objects.filter(
            operator=op, vehicle=vehicle
        ).exists()
    elif request.user.role == "driver":
        try:
            dp = request.user.driver_profile
            allowed = dp.vehicle_assignments.filter(
                vehicle=vehicle, active=True
            ).exists() or Trip.objects.filter(
                driver=dp,
                vehicle=vehicle,
                status__in=[Trip.Status.BOARDING, Trip.Status.IN_PROGRESS],
            ).exists()
        except Exception:
            allowed = False

    if not allowed:
        return Response({"detail": "Not allowed to update this vehicle."}, status=403)

    try:
        lat = float(request.data["lat"])
        lng = float(request.data["lng"])
    except (KeyError, TypeError, ValueError):
        return Response({"detail": "lat and lng required as numbers."}, status=400)

    source = request.data.get("source", VehicleLocation.Source.GPS)
    if source == VehicleLocation.Source.SIMULATED:
        return Response({"detail": "Simulated GPS is disabled."}, status=400)

    trip_id = request.data.get("trip_id")
    trip = None
    if trip_id:
        trip = (
            Trip.objects.filter(pk=trip_id, vehicle=vehicle)
            .select_related("route")
            .first()
        )
    if trip is None:
        trip = (
            Trip.objects.filter(
                vehicle=vehicle,
                status__in=[Trip.Status.BOARDING, Trip.Status.IN_PROGRESS],
            )
            .select_related("route")
            .order_by("-engaged_at")
            .first()
        )

    loc = VehicleLocation.objects.create(
        vehicle=vehicle,
        trip=trip,
        lat=lat,
        lng=lng,
        speed_kmh=request.data.get("speed_kmh"),
        heading_deg=float(request.data.get("heading_deg") or 0),
        accuracy_m=float(request.data.get("accuracy_m") or 0),
        source=source,
    )

    route_status = "unknown"
    distance_from_route_m = None
    if trip and trip.route:
        dev = check_deviation(lat, lng, trip.route)
        route_status = dev.status
        distance_from_route_m = dev.distance_m

    if trip and trip.status == Trip.Status.BOARDING:
        trip.status = Trip.Status.IN_PROGRESS
        trip.actual_departure_time = timezone.now()
        trip.save(update_fields=["status", "actual_departure_time"])

    payload = {
        "vehicle_id": vehicle.id,
        "trip_id": trip.id if trip else None,
        "lat": lat,
        "lng": lng,
        "speed_kmh": loc.speed_kmh,
        "heading_deg": loc.heading_deg,
        "accuracy_m": loc.accuracy_m,
        "source": loc.source,
        "route_status": route_status,
        "distance_from_route_m": distance_from_route_m,
        "recorded_at": loc.recorded_at.isoformat(),
    }

    channel_layer = get_channel_layer()
    if channel_layer is not None:
        try:
            async_to_sync(channel_layer.group_send)(
                "fleet_tracking",
                {"type": "fleet.update", "payload": payload},
            )
            if trip:
                async_to_sync(channel_layer.group_send)(
                    f"trip_{trip.id}",
                    {"type": "trip.location", "payload": payload},
                )
        except Exception as exc:
            logger.warning("WS broadcast failed: %s", exc)

    return Response(payload)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_vehicle_latest_location(request, vehicle_id):
    loc = (
        VehicleLocation.objects.filter(vehicle_id=vehicle_id)
        .order_by("-recorded_at")
        .first()
    )
    if not loc:
        return Response({"detail": "No location yet."}, status=404)
    return Response(VehicleLocationSerializer(loc).data)


# ---------- Routing (ORS / OSRM) ----------


@api_view(["POST"])
@permission_classes([AllowAny])
def api_ad_hoc_directions(request):
    data = request.data or {}
    origin_raw = data.get("origin") or {}
    dest_raw = data.get("destination") or {}

    def _pair(raw):
        if not isinstance(raw, dict):
            return None
        lat = raw.get("lat", raw.get("latitude"))
        lng = raw.get("lng", raw.get("longitude"))
        try:
            return (float(lat), float(lng))
        except (TypeError, ValueError):
            return None

    origin = _pair(origin_raw)
    destination = _pair(dest_raw)
    if not origin or not destination:
        return Response(
            {"error": "origin and destination with lat/lng are required."},
            status=400,
        )

    try:
        directions = get_ad_hoc_route(origin, destination)
    except RoutingServiceError as exc:
        return Response({"error": str(exc)}, status=502)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Routing failed")
        return Response({"error": f"Routing unavailable: {exc}"}, status=502)

    fare, notice = estimate_ad_hoc_fare(directions["distance_km"])
    return Response(
        {
            "geometry": directions["geometry"],
            "distance_km": directions["distance_km"],
            "duration_min": directions["duration_min"],
            "source": directions["source"],
            "fare": fare,
            "fare_notice": notice,
        }
    )


@api_view(["POST"])
@permission_classes([AllowAny])
def api_calculate_route_fare(request):
    try:
        distance_km = float(request.data.get("distanceKm") or request.data["distance_km"])
    except (KeyError, TypeError, ValueError):
        return Response({"error": "distance_km required."}, status=400)
    fare, notice = estimate_ad_hoc_fare(distance_km)
    return Response(
        {
            "fare": fare,
            "notice": notice,
            "fare_notice": notice,
            "distance_km": distance_km,
            "estimated_fare": fare,
        }
    )


# ---------- Panic ----------


@api_view(["POST"])
@permission_classes([AllowAny])
def api_panic_alert(request):
    data = dict(request.data) if hasattr(request.data, "dict") else (request.data or {})
    alert = PanicAlert.objects.create(
        user=request.user if request.user.is_authenticated else None,
        trip_id=data.get("tripId") or data.get("trip_id"),
        booking_id=data.get("bookingId") or data.get("booking_id"),
        latitude=data.get("latitude"),
        longitude=data.get("longitude"),
        accuracy_m=data.get("accuracy"),
        payload=data,
    )
    channel_layer = get_channel_layer()
    if channel_layer is not None:
        try:
            async_to_sync(channel_layer.group_send)(
                "fleet_tracking",
                {
                    "type": "panic.alert",
                    "payload": PanicAlertSerializer(alert).data,
                },
            )
        except Exception as exc:
            logger.warning("Panic broadcast failed: %s", exc)
    return Response({"id": alert.id, "status": "received"}, status=201)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_fleet_snapshot(request):
    if request.user.role not in ("operator", "admin"):
        return Response({"detail": "Operators and admins only."}, status=403)
    vehicles = Vehicle.objects.all()
    out = []
    for v in vehicles:
        loc = v.locations.order_by("-recorded_at").first()
        if not loc:
            continue
        out.append(
            {
                "vehicle": VehicleSerializer(v).data,
                "location": VehicleLocationSerializer(loc).data,
            }
        )
    return Response(out)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_driver_notification_read(request, notification_id):
    if request.user.role != "driver":
        return Response({"detail": "Drivers only."}, status=403)
    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "No driver profile."}, status=404)
    try:
        n = DriverNotification.objects.get(pk=notification_id, driver=dp)
    except DriverNotification.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    n.read = True
    n.save(update_fields=["read"])
    return Response({"id": n.id, "read": True})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_driver_notifications_read_all(request):
    if request.user.role != "driver":
        return Response({"detail": "Drivers only."}, status=403)
    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "No driver profile."}, status=404)
    updated = DriverNotification.objects.filter(driver=dp, read=False).update(read=True)
    return Response({"updated": updated, "read": True})


# ---------- Admin console ----------


def _require_admin(request):
    role = getattr(request.user, "role", "") or ""
    return role == "admin"


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_summary(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from django.contrib.auth import get_user_model
    from accounts.models import DriverProfile
    User = get_user_model()
    return Response(
        {
            "users": User.objects.count(),
            "passengers": User.objects.filter(role="passenger").count(),
            "drivers": User.objects.filter(role="driver").count(),
            "operators": User.objects.filter(role="operator").count(),
            "trips": Trip.objects.count(),
            "trips_flagged": Trip.objects.filter(status=Trip.Status.FLAGGED).count(),
            "bookings": Booking.objects.count(),
            "pending_memberships": OperatorAtRank.objects.filter(
                status=OperatorAtRank.Status.PENDING
            ).count(),
            "open_flags": TripFlag.objects.filter(status=TripFlag.Status.OPEN).count(),
            "panic_alerts": PanicAlert.objects.count(),
            "drivers_pending": DriverProfile.objects.filter(status="pending").count(),
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_users(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from django.contrib.auth import get_user_model
    User = get_user_model()
    role = (request.query_params.get("role") or "").strip()
    qs = User.objects.all().order_by("-date_joined")
    if role:
        qs = qs.filter(role=role)
    qs = qs[:200]
    data = [
        {
            "id": u.id,
            "username": u.username,
            "phone": getattr(u, "phone", "") or "",
            "email": u.email or "",
            "first_name": u.first_name,
            "last_name": u.last_name,
            "role": u.role,
            "is_active": u.is_active,
            "date_joined": u.date_joined,
        }
        for u in qs
    ]
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_admin_user_set_active(request, user_id):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from django.contrib.auth import get_user_model
    User = get_user_model()
    try:
        u = User.objects.get(pk=user_id)
    except User.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    if u.id == request.user.id:
        return Response({"detail": "Cannot deactivate yourself."}, status=400)
    active = request.data.get("is_active")
    if active is None:
        return Response({"detail": "is_active required."}, status=400)
    u.is_active = bool(active)
    u.save(update_fields=["is_active"])
    return Response({"id": u.id, "is_active": u.is_active})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_memberships(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    status_filter = (request.query_params.get("status") or "pending").strip()
    qs = OperatorAtRank.objects.select_related("operator__user", "rank").order_by("-id")
    if status_filter and status_filter != "all":
        qs = qs.filter(status=status_filter)
    data = []
    for m in qs[:100]:
        op_user = getattr(m.operator, "user", None)
        data.append(
            {
                "id": m.id,
                "status": m.status,
                "rank_id": m.rank_id,
                "rank_name": m.rank.name if m.rank_id else None,
                "operator_id": m.operator_id,
                "operator_name": (
                    f"{op_user.first_name} {op_user.last_name}".strip()
                    if op_user
                    else str(m.operator_id)
                ),
                "operator_phone": getattr(op_user, "phone", "") if op_user else "",
            }
        )
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_admin_membership_decide(request, membership_id):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)

    try:
        m = OperatorAtRank.objects.select_related("rank", "operator").get(pk=membership_id)
    except OperatorAtRank.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    decision = (request.data.get("decision") or "").strip().lower()
    if decision not in ("approve", "reject"):
        return Response({"detail": "decision must be approve or reject."}, status=400)
    if decision == "approve":
        m.status = OperatorAtRank.Status.ACTIVE
        try:
            admin_prof = request.user.admin_profile
            m.approved_by = admin_prof
        except Exception:
            pass
        m.approved_at = timezone.now()
    else:
        m.status = OperatorAtRank.Status.REJECTED
        m.approved_at = timezone.now()
    m.save()
    return Response({"id": m.id, "status": m.status})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_flags(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    qs = TripFlag.objects.select_related("trip", "flagged_by").order_by("-id")[:100]
    data = []
    for f in qs:
        data.append(
            {
                "id": f.id,
                "trip_id": f.trip_id,
                "trip_code": getattr(f.trip, "trip_code", None),
                "category": getattr(f, "category", None),
                "notes": getattr(f, "notes", "") or getattr(f, "description", ""),
                "status": f.status,
                "flagged_by": getattr(f.flagged_by, "username", None),
                "created_at": getattr(f, "created_at", None),
            }
        )
    return Response(data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_panics(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    qs = PanicAlert.objects.select_related("user", "trip").order_by("-id")[:100]
    data = []
    for p in qs:
        data.append(
            {
                "id": p.id,
                "user": getattr(p.user, "username", None) if getattr(p, "user_id", None) else None,
                "trip_id": getattr(p, "trip_id", None),
                "lat": getattr(p, "latitude", None),
                "lng": getattr(p, "longitude", None),
                "message": str(getattr(p, "payload", "") or ""),
                "created_at": getattr(p, "created_at", None),
            }
        )
    return Response(data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_drivers(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from accounts.models import DriverProfile

    qs = DriverProfile.objects.select_related("user").order_by("-id")[:100]
    data = []
    for d in qs:
        u = d.user
        data.append(
            {
                "id": d.id,
                "user_id": u.id,
                "name": f"{u.first_name} {u.last_name}".strip() or u.username,
                "phone": getattr(u, "phone", "") or "",
                "license_number": d.license_number,
                "status": d.status,
                "is_active": u.is_active,
            }
        )
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_admin_driver_verify(request, driver_id):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from accounts.models import DriverProfile

    try:
        d = DriverProfile.objects.get(pk=driver_id)
    except DriverProfile.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    decision = (request.data.get("decision") or "verify").strip().lower()
    if decision in ("verify", "approve", "verified"):
        d.status = DriverProfile.VerificationStatus.VERIFIED
        d.verified_at = timezone.now()
    elif decision in ("reject", "rejected"):
        d.status = DriverProfile.VerificationStatus.REJECTED
    else:
        return Response({"detail": "decision must be verify or reject."}, status=400)
    d.save()
    return Response({"id": d.id, "status": d.status})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_trip_options(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from accounts.models import OperatorProfile, DriverProfile

    routes = []
    for r in Route.objects.select_related("departure", "destination").order_by("id"):
        dep = getattr(r.departure, "name", "") or ""
        dest = getattr(r.destination, "name", "") or ""
        fare = r.fare
        routes.append(
            {
                "id": r.id,
                "label": f"{dep} → {dest} (R{fare})",
                "departure": dep,
                "destination": dest,
                "fare": str(fare),
            }
        )

    operators = []
    for op in OperatorProfile.objects.select_related("user", "association").order_by("id"):
        u = op.user
        assoc = getattr(op.association, "association_name", "") if op.association_id else ""
        name = f"{u.first_name} {u.last_name}".strip() or u.username
        operators.append(
            {"id": op.id, "label": f"{name}" + (f" ({assoc})" if assoc else "")}
        )

    # Only VERIFIED drivers appear as assignable options.
    drivers = []
    for d in (
        DriverProfile.objects.select_related("user")
        .filter(status=DriverProfile.VerificationStatus.VERIFIED)
        .order_by("id")
    ):
        u = d.user
        name = f"{u.first_name} {u.last_name}".strip() or u.username
        phone = getattr(u, "phone", "") or ""
        drivers.append(
            {
                "id": d.id,
                "label": f"{name}" + (f" ({phone})" if phone else ""),
                "status": d.status,
            }
        )

    vehicles = []
    for v in Vehicle.objects.order_by("id"):
        vehicles.append(
            {
                "id": v.id,
                "label": f"{v.plate_number}"
                + (f" · {v.make} {v.model}".strip() if (v.make or v.model) else ""),
            }
        )

    return Response(
        {"routes": routes, "operators": operators, "drivers": drivers, "vehicles": vehicles}
    )


def _gen_trip_code(route, departure_date):
    dep = (getattr(getattr(route, "departure", None), "name", None) or "XXX")[:3].upper()
    dest = (getattr(getattr(route, "destination", None), "name", None) or "YYY")[:3].upper()
    day = departure_date.strftime("%m%d") if departure_date else "0000"
    base = f"TRP-{dep}-{dest}-{day}"
    code = base
    n = 1
    while Trip.objects.filter(trip_code=code).exists():
        n += 1
        code = f"{base}-{n}"
    return code


def _trip_queue_row(t):
    route = t.route
    dep = getattr(getattr(route, "departure", None), "name", "") if route else ""
    dest = getattr(getattr(route, "destination", None), "name", "") if route else ""
    op_user = getattr(getattr(t, "operator", None), "user", None)
    drv_user = getattr(getattr(t, "driver", None), "user", None)
    return {
        "id": t.id,
        "trip_code": t.trip_code,
        "route_id": t.route_id,
        "route_label": f"{dep} → {dest}" if dep or dest else str(t.route_id),
        "operator_id": t.operator_id,
        "operator_name": (
            f"{op_user.first_name} {op_user.last_name}".strip() if op_user else None
        ),
        "departure_date": t.departure_date,
        "expected_departure_time": t.expected_departure_time,
        "seat_capacity": t.seat_capacity,
        "seats_taken": t.seats_taken,
        "status": t.status,
        "driver_id": t.driver_id,
        "driver_name": (
            f"{drv_user.first_name} {drv_user.last_name}".strip() if drv_user else None
        ),
        "vehicle_id": t.vehicle_id,
        "vehicle_plate": getattr(t.vehicle, "plate_number", None) if t.vehicle_id else None,
        "notes": t.notes or "",
        "can_delete": t.status
        in (Trip.Status.SCHEDULED, Trip.Status.CANCELLED, Trip.Status.FLAGGED)
        and t.seats_taken == 0,
        "can_edit": t.status
        in (Trip.Status.SCHEDULED, Trip.Status.BOARDING, Trip.Status.FLAGGED),
    }


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_trip_queue(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    qs = Trip.objects.select_related(
        "route__departure",
        "route__destination",
        "operator__user",
        "driver__user",
        "vehicle",
    ).order_by("departure_date", "expected_departure_time", "id")
    status_filter = (request.query_params.get("status") or "").strip()
    if status_filter:
        qs = qs.filter(status=status_filter)
    return Response([_trip_queue_row(t) for t in qs[:150]])


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_admin_schedule_trip(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from accounts.models import OperatorProfile, DriverProfile
    from datetime import datetime

    data = request.data
    try:
        route_id = int(data.get("route_id"))
    except (TypeError, ValueError):
        return Response({"detail": "route_id is required."}, status=400)

    try:
        route = Route.objects.select_related("departure", "destination").get(pk=route_id)
    except Route.DoesNotExist:
        return Response({"detail": "Invalid route."}, status=400)

    operator = None
    if data.get("operator_id"):
        try:
            operator = OperatorProfile.objects.get(pk=int(data["operator_id"]))
        except (OperatorProfile.DoesNotExist, TypeError, ValueError):
            return Response({"detail": "Invalid operator_id."}, status=400)

    dep_date_raw = data.get("departure_date")
    if not dep_date_raw:
        return Response({"detail": "departure_date is required."}, status=400)
    try:
        if isinstance(dep_date_raw, str):
            departure_date = datetime.strptime(dep_date_raw[:10], "%Y-%m-%d").date()
        else:
            departure_date = dep_date_raw
    except ValueError:
        return Response({"detail": "departure_date must be YYYY-MM-DD."}, status=400)

    exp_time = data.get("expected_departure_time") or None
    if exp_time == "":
        exp_time = None
    if isinstance(exp_time, str) and exp_time:
        try:
            exp_time = datetime.strptime(exp_time[:5], "%H:%M").time()
        except ValueError:
            try:
                exp_time = datetime.strptime(exp_time[:8], "%H:%M:%S").time()
            except ValueError:
                return Response(
                    {"detail": "expected_departure_time must be HH:MM."}, status=400
                )

    try:
        seat_capacity = int(data.get("seat_capacity") or 15)
    except (TypeError, ValueError):
        seat_capacity = 15

    # ----- Driver is REQUIRED -----
    driver_raw = data.get("driver_id")
    if driver_raw in (None, "", "null"):
        return Response({"detail": "driver_id is required."}, status=400)
    try:
        driver = DriverProfile.objects.get(pk=int(driver_raw))
    except (DriverProfile.DoesNotExist, TypeError, ValueError):
        return Response({"detail": "Invalid driver_id."}, status=400)
    if driver.status != DriverProfile.VerificationStatus.VERIFIED:
        return Response(
            {"detail": "Selected driver is not verified."}, status=400
        )

    # ----- Vehicle is REQUIRED -----
    vehicle_raw = data.get("vehicle_id")
    if vehicle_raw in (None, "", "null"):
        return Response({"detail": "vehicle_id is required."}, status=400)
    try:
        vehicle = Vehicle.objects.get(pk=int(vehicle_raw))
    except (Vehicle.DoesNotExist, TypeError, ValueError):
        return Response({"detail": "Invalid vehicle_id."}, status=400)

    trip_code = (data.get("trip_code") or "").strip().upper() or _gen_trip_code(
        route, departure_date
    )
    if Trip.objects.filter(trip_code=trip_code).exists():
        trip_code = _gen_trip_code(route, departure_date)

    trip = Trip.objects.create(
        operator=operator,
        route=route,
        departure_date=departure_date,
        expected_departure_time=exp_time,
        seat_capacity=seat_capacity,
        status=Trip.Status.SCHEDULED,
        trip_code=trip_code,
        driver=driver,
        vehicle=vehicle,
        notes=(data.get("notes") or "")[:500],
    )
    trip = Trip.objects.select_related(
        "route__departure",
        "route__destination",
        "operator__user",
        "driver__user",
        "vehicle",
    ).get(pk=trip.pk)
    if driver:
        dep = getattr(getattr(route, "departure", None), "name", "") or ""
        dest = getattr(getattr(route, "destination", None), "name", "") or ""
        plate = getattr(vehicle, "plate_number", "") if vehicle else ""
        DriverNotification.objects.create(
            driver=driver,
            title="New trip assignment",
            body=(
                f"You are assigned: {dep} → {dest} on {departure_date}"
                + (f", vehicle {plate}" if plate else "")
                + ". Check My trips for details."
            ),
            link_trip=trip,
            meta={"type": "trip_assigned", "trip_id": trip.id, "hide_code": True},
        )
    try:
        _audit(request.user, "trip.schedule", "trip", trip.id, trip_code)
    except Exception:
        pass
    return Response(_trip_queue_row(trip), status=201)


@api_view(["GET", "PATCH", "DELETE"])
@permission_classes([IsAuthenticated])
def api_admin_trip_detail(request, trip_id):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from accounts.models import OperatorProfile, DriverProfile
    from datetime import datetime

    try:
        trip = Trip.objects.select_related(
            "route__departure",
            "route__destination",
            "operator__user",
            "driver__user",
            "vehicle",
        ).get(pk=trip_id)
    except Trip.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)

    if request.method == "GET":
        return Response(_trip_queue_row(trip))

    if request.method == "DELETE":
        if trip.status not in (
            Trip.Status.SCHEDULED,
            Trip.Status.CANCELLED,
            Trip.Status.FLAGGED,
        ):
            return Response(
                {"detail": "Only scheduled, cancelled, or flagged trips can be deleted."},
                status=400,
            )
        if trip.seats_taken > 0:
            return Response(
                {"detail": "Trip has bookings — set status cancelled instead of delete."},
                status=400,
            )
        code = trip.trip_code
        trip.delete()
        return Response({"detail": f"Deleted {code}."})

    if trip.status not in (
        Trip.Status.SCHEDULED,
        Trip.Status.BOARDING,
        Trip.Status.FLAGGED,
        Trip.Status.CANCELLED,
    ):
        return Response(
            {"detail": "Cannot edit a trip that is in progress or completed."},
            status=400,
        )

    data = request.data
    if "route_id" in data and data["route_id"]:
        try:
            trip.route = Route.objects.get(pk=int(data["route_id"]))
        except (Route.DoesNotExist, TypeError, ValueError):
            return Response({"detail": "Invalid route_id."}, status=400)
    if "operator_id" in data:
        if not data["operator_id"]:
            trip.operator = None
        else:
            try:
                trip.operator = OperatorProfile.objects.get(pk=int(data["operator_id"]))
            except (OperatorProfile.DoesNotExist, TypeError, ValueError):
                return Response({"detail": "Invalid operator_id."}, status=400)
    if "departure_date" in data and data["departure_date"]:
        raw = data["departure_date"]
        try:
            trip.departure_date = (
                datetime.strptime(str(raw)[:10], "%Y-%m-%d").date()
                if isinstance(raw, str)
                else raw
            )
        except ValueError:
            return Response({"detail": "Invalid departure_date."}, status=400)
    if "expected_departure_time" in data:
        exp = data.get("expected_departure_time")
        if not exp:
            trip.expected_departure_time = None
        elif isinstance(exp, str):
            try:
                trip.expected_departure_time = datetime.strptime(exp[:5], "%H:%M").time()
            except ValueError:
                return Response(
                    {"detail": "Invalid expected_departure_time."}, status=400
                )
    if "seat_capacity" in data and data["seat_capacity"] is not None:
        try:
            trip.seat_capacity = int(data["seat_capacity"])
        except (TypeError, ValueError):
            pass
    if "driver_id" in data:
        if not data["driver_id"]:
            return Response(
                {"detail": "driver_id cannot be cleared on an active trip."},
                status=400,
            )
        try:
            trip.driver = DriverProfile.objects.get(pk=int(data["driver_id"]))
        except (DriverProfile.DoesNotExist, TypeError, ValueError):
            return Response({"detail": "Invalid driver_id."}, status=400)
    if "vehicle_id" in data:
        if not data["vehicle_id"]:
            return Response(
                {"detail": "vehicle_id cannot be cleared on an active trip."},
                status=400,
            )
        try:
            trip.vehicle = Vehicle.objects.get(pk=int(data["vehicle_id"]))
        except (Vehicle.DoesNotExist, TypeError, ValueError):
            return Response({"detail": "Invalid vehicle_id."}, status=400)
    if "notes" in data:
        trip.notes = (data.get("notes") or "")[:500]

    previous_status = trip.status
    status_change_to_cancelled = False
    status_change_to_completed = False
    if "status" in data and data["status"] in dict(Trip.Status.choices):
        new_status = data["status"]
        if new_status == Trip.Status.CANCELLED and trip.status != Trip.Status.CANCELLED:
            status_change_to_cancelled = True
        if new_status == Trip.Status.COMPLETED and trip.status != Trip.Status.COMPLETED:
            status_change_to_completed = True
        trip.status = new_status

    trip.save()

    if status_change_to_completed:
        _cascade_trip_status_to_bookings(trip, Trip.Status.COMPLETED)

    if status_change_to_cancelled:
        try:
            affected = 0
            for booking in trip.bookings.exclude(
                status__in=[Booking.Status.CANCELLED, Booking.Status.COMPLETED]
            ).select_related("passenger"):
                booking.status = Booking.Status.CANCELLED
                booking.save(update_fields=["status"])
                affected += 1

                if booking.passenger_id:
                    PassengerNotification.objects.create(
                        passenger=booking.passenger,
                        title=f"Trip {trip.trip_code} cancelled",
                        body=(
                            f"Your trip {trip.route.departure.name} → "
                            f"{trip.route.destination.name} on {trip.departure_date} "
                            f"has been cancelled by an administrator."
                        ),
                        meta={
                            "type": "trip_cancelled",
                            "trip_id": trip.id,
                            "trip_code": trip.trip_code,
                            "booking_id": booking.id,
                        },
                    )

            if trip.driver_id:
                DriverNotification.objects.create(
                    driver=trip.driver,
                    title=f"Trip {trip.trip_code} cancelled",
                    body=(
                        f"{trip.route.departure.name} → {trip.route.destination.name} "
                        f"on {trip.departure_date} was cancelled by an administrator."
                    ),
                    link_trip=trip,
                    meta={
                        "type": "trip_cancelled",
                        "trip_id": trip.id,
                        "trip_code": trip.trip_code,
                    },
                )

            trip.engaged_by = None
            trip.engaged_at = None
            trip.save(update_fields=["engaged_by", "engaged_at"])
        except Exception as exc:
            logger.warning("Trip cancel cascade failed: %s", exc)

    trip = Trip.objects.select_related(
        "route__departure",
        "route__destination",
        "operator__user",
        "driver__user",
        "vehicle",
    ).get(pk=trip.pk)
    return Response(_trip_queue_row(trip))


def _audit(actor, action, entity_type="", entity_id="", detail="", meta=None):
    try:
        AuditLog.objects.create(
            actor=actor if getattr(actor, "is_authenticated", False) else None,
            action=action,
            entity_type=entity_type or "",
            entity_id=str(entity_id or ""),
            detail=detail or "",
            meta=meta or {},
        )
    except Exception:
        pass


def _announce_row(a):
    return {
        "id": a.id,
        "topic": a.topic,
        "message": a.message,
        "status": a.status,
        "audience": a.audience,
        "rank_id": a.rank_id,
        "rank_name": a.rank.name if a.rank_id else None,
        "route_id": a.route_id,
        "route_label": (
            f"{getattr(a.route.departure, 'name', '')} → {getattr(a.route.destination, 'name', '')}"
            if a.route_id
            else None
        ),
        "service": a.service,
        "reach_count": a.reach_count,
        "published_at": a.published_at,
        "scheduled_for": a.scheduled_for,
        "created_by": getattr(a.created_by, "username", None),
        "updated_at": a.updated_at,
    }


def _publish_announcement(ann, actor):
    from django.contrib.auth import get_user_model
    from accounts.models import DriverProfile, OperatorProfile

    User = get_user_model()
    notified = 0
    rank = ann.rank
    audience = ann.audience

    def notify_driver(dp):
        nonlocal notified
        DriverNotification.objects.create(
            driver=dp,
            title=ann.topic,
            body=ann.message,
            meta={"type": "announcement", "announcement_id": ann.id},
        )
        notified += 1

    def notify_operator_user(u):
        nonlocal notified
        OperatorNotification.objects.create(
            operator_user=u,
            title=ann.topic,
            body=ann.message,
            meta={"type": "announcement", "announcement_id": ann.id},
        )
        notified += 1

    if audience == Announcement.Audience.ALL_USERS:
        for u in User.objects.filter(is_active=True)[:500]:
            if u.role == "driver":
                try:
                    notify_driver(u.driver_profile)
                except Exception:
                    pass
            elif u.role == "operator":
                notify_operator_user(u)
    else:
        driver_qs = DriverProfile.objects.select_related("user")
        op_qs = OperatorProfile.objects.select_related("user")
        if rank:
            op_ids = OperatorAtRank.objects.filter(
                rank=rank, status=OperatorAtRank.Status.ACTIVE
            ).values_list("operator_id", flat=True)
            op_qs = op_qs.filter(id__in=op_ids)
        if audience in (
            Announcement.Audience.DRIVERS_OPERATORS,
            Announcement.Audience.DRIVERS,
        ):
            for dp in driver_qs.filter(status="verified")[:200]:
                notify_driver(dp)
        if audience in (
            Announcement.Audience.DRIVERS_OPERATORS,
            Announcement.Audience.OPERATORS,
        ):
            for op in op_qs[:200]:
                notify_operator_user(op.user)

    ann.status = Announcement.Status.PUBLISHED
    ann.published_at = timezone.now()
    ann.reach_count = notified
    ann.save(update_fields=["status", "published_at", "reach_count", "updated_at"])
    _audit(actor, "announcement.publish", "announcement", ann.id, ann.topic, {"reach": notified})
    return notified


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def api_admin_announcements(request):
    if not _require_admin(request) and getattr(request.user, "role", "") != "operator":
        return Response({"detail": "Admin or operator only."}, status=403)

    if request.method == "GET":
        qs = Announcement.objects.select_related(
            "rank", "route__departure", "route__destination", "created_by"
        ).order_by("-updated_at")[:100]
        return Response([_announce_row(a) for a in qs])

    data = request.data
    topic = (data.get("topic") or "").strip()
    message = (data.get("message") or "").strip()
    if not topic or not message:
        return Response({"detail": "topic and message required."}, status=400)
    ann = Announcement.objects.create(
        topic=topic,
        message=message,
        status=data.get("status") or Announcement.Status.DRAFT,
        audience=data.get("audience") or Announcement.Audience.DRIVERS_OPERATORS,
        rank_id=data.get("rank_id") or None,
        route_id=data.get("route_id") or None,
        service=(data.get("service") or "commuter")[:40],
        created_by=request.user,
    )
    if data.get("publish"):
        _publish_announcement(ann, request.user)
        ann.refresh_from_db()
    _audit(request.user, "announcement.create", "announcement", ann.id, topic)
    return Response(_announce_row(ann), status=201)


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def api_admin_announcement_detail(request, ann_id):
    if not _require_admin(request) and getattr(request.user, "role", "") != "operator":
        return Response({"detail": "Admin or operator only."}, status=403)
    try:
        ann = Announcement.objects.select_related(
            "rank", "route__departure", "route__destination", "created_by"
        ).get(pk=ann_id)
    except Announcement.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)

    if request.method == "GET":
        return Response(_announce_row(ann))

    data = request.data
    for field in ("topic", "message", "audience", "service"):
        if field in data and data[field] is not None:
            setattr(ann, field, data[field])
    if "rank_id" in data:
        ann.rank_id = data.get("rank_id") or None
    if "route_id" in data:
        ann.route_id = data.get("route_id") or None
    if data.get("deactivate"):
        ann.status = Announcement.Status.INACTIVE
    if data.get("publish"):
        ann.save()
        _publish_announcement(ann, request.user)
        ann.refresh_from_db()
    else:
        if "status" in data and data["status"] in dict(Announcement.Status.choices):
            ann.status = data["status"]
        ann.save()
    _audit(request.user, "announcement.update", "announcement", ann.id, ann.topic)
    return Response(_announce_row(ann))


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_complaints(request):
    if not _require_admin(request) and getattr(request.user, "role", "") != "operator":
        return Response({"detail": "Forbidden."}, status=403)
    qs = DriverComplaint.objects.select_related(
        "driver__user", "trip", "raised_by", "escalated_by"
    ).order_by("-created_at")[:100]
    escalated = [c for c in qs if c.status == DriverComplaint.Status.ESCALATED]
    others = [c for c in qs if c.status != DriverComplaint.Status.ESCALATED]
    ordered = escalated + others

    def row(c):
        du = getattr(c.driver, "user", None)
        return {
            "id": c.id,
            "category": c.category,
            "description": c.description,
            "status": c.status,
            "driver_name": f"{du.first_name} {du.last_name}".strip() if du else None,
            "trip_id": c.trip_id,
            "trip_code": getattr(c.trip, "trip_code", None),
            "raised_by": getattr(c.raised_by, "username", None),
            "escalation_reason": c.escalation_reason,
            "admin_note": c.admin_note,
            "created_at": c.created_at,
        }

    return Response([row(c) for c in ordered])


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_escalate_complaint(request, complaint_id):
    if getattr(request.user, "role", "") not in ("operator", "admin"):
        return Response({"detail": "Operator or admin only."}, status=403)

    try:
        c = DriverComplaint.objects.get(pk=complaint_id)
    except DriverComplaint.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    reason = (request.data.get("reason") or "").strip()
    if not reason:
        return Response({"detail": "reason required."}, status=400)
    c.status = DriverComplaint.Status.ESCALATED
    c.escalation_reason = reason
    c.escalated_by = request.user
    c.escalated_at = timezone.now()
    c.save()
    _audit(request.user, "complaint.escalate", "complaint", c.id, reason)
    return Response({"id": c.id, "status": c.status})


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_admin_complaint_review(request, complaint_id):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    try:
        c = DriverComplaint.objects.get(pk=complaint_id)
    except DriverComplaint.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    note = (request.data.get("admin_note") or "").strip()
    action = (request.data.get("action") or "reviewed").strip()
    if note:
        c.admin_note = note
    if action == "refer_safety":
        SafetyIncident.objects.create(
            title=c.category or "Referred from complaint",
            source="complaint",
            complaint=c,
            trip=c.trip,
            status=SafetyIncident.Status.AWAITING_REVIEW,
        )
        _audit(request.user, "complaint.refer_safety", "complaint", c.id)
    elif action == "resolve":
        c.status = DriverComplaint.Status.RESOLVED
    else:
        c.status = DriverComplaint.Status.RESPONSE_SENT
    c.save()
    _audit(request.user, "complaint.review", "complaint", c.id, action)
    return Response({"id": c.id, "status": c.status})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_safety(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    qs = SafetyIncident.objects.select_related("trip", "complaint").order_by("-created_at")[:100]
    return Response(
        [
            {
                "id": s.id,
                "title": s.title,
                "source": s.source,
                "status": s.status,
                "trip_id": s.trip_id,
                "complaint_id": s.complaint_id,
                "findings": s.findings,
                "created_at": s.created_at,
            }
            for s in qs
        ]
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_admin_safety_decide(request, incident_id):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)

    try:
        s = SafetyIncident.objects.get(pk=incident_id)
    except SafetyIncident.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    decision = (request.data.get("decision") or "").strip()
    s.findings = (request.data.get("findings") or s.findings or "")[:2000]
    if decision == "confirm":
        s.status = SafetyIncident.Status.CONFIRMED
        s.confirmed_by = request.user
        s.confirmed_at = timezone.now()
    elif decision == "not_safety":
        s.status = SafetyIncident.Status.NOT_CONFIRMED
    elif decision == "resolve":
        s.status = SafetyIncident.Status.RESOLVED
    else:
        return Response({"detail": "decision must be confirm|not_safety|resolve"}, status=400)
    s.save()
    _audit(request.user, "safety.decide", "safety", s.id, decision)
    return Response({"id": s.id, "status": s.status})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_history(request):
    qs = AuditLog.objects.select_related("actor").order_by("-created_at")
    role = getattr(request.user, "role", "")
    if role != "admin":
        qs = qs.filter(actor=request.user)
    qs = qs[:100]
    return Response(
        [
            {
                "id": a.id,
                "action": a.action,
                "entity_type": a.entity_type,
                "entity_id": a.entity_id,
                "detail": a.detail,
                "actor": getattr(a.actor, "username", None),
                "created_at": a.created_at,
            }
            for a in qs
        ]
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_rate_driver(request):
    """Passenger rates the driver — only after COMPLETED, once per trip."""
    if getattr(request.user, "role", "") != "passenger":
        return Response({"detail": "Passengers only."}, status=403)
    try:
        score = int(request.data.get("score"))
        trip_id = int(request.data.get("trip_id"))
    except (TypeError, ValueError):
        return Response({"detail": "score and trip_id required."}, status=400)
    if score < 1 or score > 5:
        return Response({"detail": "score must be 1–5."}, status=400)
    try:
        trip = Trip.objects.select_related("driver").get(pk=trip_id)
    except Trip.DoesNotExist:
        return Response({"detail": "Trip not found."}, status=404)

    booking = Booking.objects.filter(trip=trip, passenger=request.user).first()
    if not booking:
        return Response({"detail": "You were not on this trip."}, status=403)

    if trip.status != Trip.Status.COMPLETED:
        return Response(
            {"detail": "Rate only after the trip is completed."}, status=400
        )
    if not trip.driver_id:
        return Response({"detail": "No driver on trip."}, status=400)
    if DriverRating.objects.filter(trip=trip, passenger=request.user).exists():
        return Response(
            {"detail": "You have already rated this trip."}, status=400
        )

    comment = (request.data.get("comment") or "")[:500]
    rating = DriverRating.objects.create(
        driver=trip.driver,
        trip=trip,
        passenger=request.user,
        score=score,
        comment=comment,
    )
    _audit(request.user, "driver.rate", "trip", trip.id, f"{score}/5")
    return Response({"id": rating.id, "score": score}, status=201)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_driver_rating_summary(request, driver_id):
    from django.db.models import Avg, Count

    agg = DriverRating.objects.filter(driver_id=driver_id).aggregate(
        avg=Avg("score"), n=Count("id")
    )
    return Response(
        {
            "driver_id": driver_id,
            "average": round(float(agg["avg"] or 0), 2),
            "count": agg["n"] or 0,
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_admin_simulate_trip(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)

    trip_id = request.data.get("trip_id")
    step = (request.data.get("step") or "next").strip()
    try:
        trip = Trip.objects.select_related(
            "route__departure", "route__destination", "driver__user", "vehicle"
        ).get(pk=int(trip_id))
    except (Trip.DoesNotExist, TypeError, ValueError):
        return Response({"detail": "Valid trip_id required."}, status=400)

    order = [
        Trip.Status.SCHEDULED,
        Trip.Status.BOARDING,
        Trip.Status.IN_PROGRESS,
        Trip.Status.COMPLETED,
    ]
    if step == "reset":
        trip.status = Trip.Status.SCHEDULED
    elif step == "cancel":
        trip.status = Trip.Status.CANCELLED
    else:
        try:
            i = order.index(trip.status)
            if i < len(order) - 1:
                trip.status = order[i + 1]
        except ValueError:
            trip.status = Trip.Status.BOARDING

    if trip.status == Trip.Status.IN_PROGRESS and not trip.actual_departure_time:
        trip.actual_departure_time = timezone.now()
    trip.save()

    # Cascade terminal status to bookings so passenger views update.
    if trip.status in (Trip.Status.COMPLETED, Trip.Status.CANCELLED):
        _cascade_trip_status_to_bookings(trip, trip.status)

    if trip.driver_id:
        DriverNotification.objects.create(
            driver=trip.driver,
            title=f"Trip {trip.status.replace('_', ' ')}",
            body=f"Simulated: {trip.trip_code} is now {trip.status}.",
            link_trip=trip,
            meta={"type": "trip_progress", "status": trip.status, "simulated": True},
        )
    for b in trip.bookings.exclude(status="cancelled")[:30]:
        if b.passenger_id:
            PassengerNotification.objects.create(
                passenger=b.passenger,
                title=f"Trip update: {trip.status.replace('_', ' ')}",
                body=f"Your trip {trip.trip_code} is now {trip.status}.",
                meta={"type": "trip_progress", "trip_id": trip.id, "status": trip.status},
            )

    _audit(
        request.user,
        "trip.simulate",
        "trip",
        trip.id,
        trip.status,
        {"simulated": True},
    )
    return Response(_trip_queue_row(trip))


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_overview(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    from django.contrib.auth import get_user_model
    from accounts.models import DriverProfile

    User = get_user_model()
    return Response(
        {
            "active_trips": Trip.objects.filter(
                status__in=[Trip.Status.BOARDING, Trip.Status.IN_PROGRESS]
            ).count(),
            "rank_queue": Trip.objects.filter(status=Trip.Status.SCHEDULED).count(),
            "escalations": DriverComplaint.objects.filter(
                status=DriverComplaint.Status.ESCALATED
            ).count(),
            "pending_accounts": User.objects.filter(is_active=False).count()
            + DriverProfile.objects.filter(status="pending").count(),
            "open_panics": PanicAlert.objects.count(),
            "announcements_live": Announcement.objects.filter(
                status=Announcement.Status.PUBLISHED
            ).count(),
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_admin_panics_live(request):
    if not _require_admin(request):
        return Response({"detail": "Admins only."}, status=403)
    qs = PanicAlert.objects.select_related("user", "trip").order_by("-created_at")[:50]
    return Response(
        [
            {
                "id": p.id,
                "user": getattr(p.user, "username", None),
                "user_name": (
                    f"{p.user.first_name} {p.user.last_name}".strip()
                    if p.user_id
                    else None
                ),
                "trip_id": p.trip_id,
                "trip_code": getattr(p.trip, "trip_code", None),
                "lat": p.latitude,
                "lng": p.longitude,
                "accuracy_m": p.accuracy_m,
                "created_at": p.created_at,
                "payload": p.payload,
            }
            for p in qs
        ]
    )


# ---- Ride request (10 km) ----
RIDE_REQUEST_RADIUS_KM = 10.0


def _passenger_display_name(user):
    if not user:
        return "Passenger"
    full = f"{getattr(user, 'first_name', '')} {getattr(user, 'last_name', '')}".strip()
    return full or getattr(user, "phone", None) or getattr(user, "username", None) or "Passenger"


def _drivers_within_radius(lat, lng, radius_km=RIDE_REQUEST_RADIUS_KM):
    from .models import VehicleLocation, DriverVehicle, Trip
    from accounts.models import DriverProfile

    seen_vehicles = set()
    near_vehicle_ids = []
    for loc in VehicleLocation.objects.order_by("-recorded_at").iterator():
        if loc.vehicle_id in seen_vehicles:
            continue
        seen_vehicles.add(loc.vehicle_id)
        try:
            d = haversine_km(lat, lng, float(loc.lat), float(loc.lng))
        except (TypeError, ValueError):
            continue
        if d <= radius_km:
            near_vehicle_ids.append(loc.vehicle_id)

    driver_ids = set(
        DriverVehicle.objects.filter(vehicle_id__in=near_vehicle_ids).values_list(
            "driver_id", flat=True
        )
    )
    for t in Trip.objects.filter(vehicle_id__in=near_vehicle_ids, driver__isnull=False):
        driver_ids.add(t.driver_id)

    return list(DriverProfile.objects.filter(id__in=driver_ids))


def haversine_km(lat1, lng1, lat2, lng2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_create_ride_request(request):
    if getattr(request.user, "role", None) not in ("passenger", "admin"):
        return Response({"detail": "Passengers only."}, status=403)

    try:
        lat = float(request.data.get("lat") if request.data.get("lat") is not None else request.data.get("passenger_lat"))
        lng = float(request.data.get("lng") if request.data.get("lng") is not None else request.data.get("passenger_lng"))
    except (TypeError, ValueError):
        return Response(
            {"detail": "lat and lng are required (passenger current location)."},
            status=400,
        )

    trip = None
    trip_id = request.data.get("trip_id")
    if trip_id:
        try:
            trip = Trip.objects.select_related("route", "driver").get(pk=trip_id)
        except Trip.DoesNotExist:
            return Response({"detail": "Trip not found."}, status=404)

    pname = _passenger_display_name(request.user)
    rr = RideRequest.objects.create(
        passenger=request.user,
        trip=trip,
        passenger_lat=lat,
        passenger_lng=lng,
        passenger_name=pname,
        status=RideRequest.Status.PENDING,
    )

    drivers = list(_drivers_within_radius(lat, lng, RIDE_REQUEST_RADIUS_KM))

    if trip and trip.driver_id:
        if not any(d.id == trip.driver_id for d in drivers):
            drivers.append(trip.driver)

    if not drivers:
        from accounts.models import DriverProfile

        drivers = list(DriverProfile.objects.all()[:20])

    trip_code = trip.trip_code if trip else None
    from_name = ""
    to_name = ""
    if trip and trip.route_id:
        from_name = getattr(getattr(trip.route, "departure", None), "name", "") or ""
        to_name = getattr(getattr(trip.route, "destination", None), "name", "") or ""

    notified = 0
    for d in drivers:
        DriverNotification.objects.create(
            driver=d,
            title="Ride request",
            body=f"{pname} is nearby and requested a pickup"
            + (f" ({from_name} → {to_name})" if from_name or to_name else "")
            + ".",
            link_trip=trip,
            meta={
                "type": "ride_request",
                "request_id": rr.id,
                "trip_id": trip.id if trip else None,
                "trip_code": trip_code,
                "passenger_name": pname,
                "passenger_lat": lat,
                "passenger_lng": lng,
                "location_source": request.data.get("location_source") or "gps",
                "radius_km": RIDE_REQUEST_RADIUS_KM,
            },
        )
        notified += 1

    data = RideRequestSerializer(rr).data
    data["drivers_notified"] = notified
    data["radius_km"] = RIDE_REQUEST_RADIUS_KM
    return Response(data, status=201)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_ride_request_detail(request, request_id):
    try:
        rr = RideRequest.objects.select_related("trip", "accepted_by__user", "passenger").get(
            pk=request_id
        )
    except RideRequest.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    return Response(RideRequestSerializer(rr).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_accept_ride_request(request, request_id):
    from accounts.models import DriverProfile
    from django.db import transaction

    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "Drivers only."}, status=403)

    with transaction.atomic():
        try:
            rr = RideRequest.objects.select_for_update().get(pk=request_id)
        except RideRequest.DoesNotExist:
            return Response({"detail": "Not found."}, status=404)

        if rr.status != RideRequest.Status.PENDING:
            return Response(
                {"detail": f"Request is already {rr.status}."},
                status=409,
            )

        rr.status = RideRequest.Status.ACCEPTED
        rr.accepted_by = dp
        rr.accepted_at = timezone.now()
        rr.save(update_fields=["status", "accepted_by", "accepted_at", "updated_at"])

        for n in DriverNotification.objects.filter(meta__request_id=rr.id).exclude(
            driver=dp
        ):
            meta = dict(n.meta or {})
            meta["expired"] = True
            n.meta = meta
            n.read = True
            n.save(update_fields=["meta", "read"])

        driver_name = _passenger_display_name(dp.user)
        PassengerNotification.objects.create(
            passenger=rr.passenger,
            title="Driver incoming",
            body=f"{driver_name} accepted your request and is on the way.",
            meta={
                "type": "driver_incoming",
                "request_id": rr.id,
                "driver_id": dp.id,
            },
        )

    return Response(RideRequestSerializer(rr).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_reject_ride_request(request, request_id):
    try:
        dp = request.user.driver_profile
    except Exception:
        return Response({"detail": "Drivers only."}, status=403)

    try:
        rr = RideRequest.objects.get(pk=request_id)
    except RideRequest.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)

    if rr.status != RideRequest.Status.PENDING:
        return Response({"detail": f"Request is already {rr.status}."}, status=409)

    for n in DriverNotification.objects.filter(driver=dp, meta__request_id=rr.id):
        meta = dict(n.meta or {})
        meta["rejected_by_me"] = True
        n.meta = meta
        n.read = True
        n.save(update_fields=["meta", "read"])

    others = DriverNotification.objects.filter(meta__request_id=rr.id).exclude(
        driver=dp
    ).filter(read=False).count()
    if others == 0:
        rr.status = RideRequest.Status.REJECTED
        rr.save(update_fields=["status", "updated_at"])

    return Response({"detail": "Rejected.", "request": RideRequestSerializer(rr).data})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_my_passenger_notifications(request):
    qs = PassengerNotification.objects.filter(passenger=request.user).order_by("-created_at")[:50]
    return Response(PassengerNotificationSerializer(qs, many=True).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_passenger_notification_read(request, notification_id):
    try:
        n = PassengerNotification.objects.get(pk=notification_id, passenger=request.user)
    except PassengerNotification.DoesNotExist:
        return Response({"detail": "Not found."}, status=404)
    n.read = True
    n.save(update_fields=["read"])
    return Response({"id": n.id, "read": True})


# ------------------------------------------------------------------
# Passenger complaint + history (only after trip COMPLETED)
# ------------------------------------------------------------------


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_passenger_file_complaint(request, trip_id):
    if getattr(request.user, "role", "") != "passenger":
        return Response({"detail": "Passengers only."}, status=403)

    try:
        trip = Trip.objects.select_related("driver", "route").get(pk=trip_id)
    except Trip.DoesNotExist:
        return Response({"detail": "Trip not found."}, status=404)

    booking = Booking.objects.filter(trip=trip, passenger=request.user).first()
    if not booking:
        return Response({"detail": "You were not on this trip."}, status=403)
    if trip.status != Trip.Status.COMPLETED:
        return Response(
            {"detail": "You can only file a complaint after the trip is completed."},
            status=400,
        )
    if not trip.driver_id:
        return Response({"detail": "No driver to complain about."}, status=400)

    if DriverComplaint.objects.filter(trip=trip, raised_by=request.user).exists():
        return Response(
            {"detail": "You have already submitted a complaint for this trip."},
            status=400,
        )

    category = (request.data.get("category") or "other").strip()[:40]
    description = (request.data.get("description") or "").strip()
    if not description:
        return Response({"detail": "description is required."}, status=400)

    complaint = DriverComplaint.objects.create(
        driver=trip.driver,
        trip=trip,
        raised_by=request.user,
        category=category,
        description=description,
        status=DriverComplaint.Status.OPEN,
    )

    try:
        _audit(
            request.user,
            "complaint.create",
            "complaint",
            complaint.id,
            f"Passenger complaint on {trip.trip_code}",
        )
    except Exception:
        pass

    try:
        op = trip.operator
        if op and getattr(op, "user", None):
            OperatorNotification.objects.create(
                operator_user=op.user,
                title="New passenger complaint",
                body=f"{category} · trip {trip.trip_code}",
                meta={"type": "complaint", "complaint_id": complaint.id},
            )
    except Exception:
        pass

    return Response(
        {
            "id": complaint.id,
            "trip_id": trip.id,
            "trip_code": trip.trip_code,
            "category": complaint.category,
            "status": complaint.status,
            "message": "Complaint submitted. The operator will review it.",
        },
        status=201,
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_passenger_trip_review_status(request, trip_id):
    if getattr(request.user, "role", "") != "passenger":
        return Response({"detail": "Passengers only."}, status=403)

    try:
        trip = Trip.objects.get(pk=trip_id)
    except Trip.DoesNotExist:
        return Response({"detail": "Trip not found."}, status=404)

    booking = Booking.objects.filter(trip=trip, passenger=request.user).first()
    if not booking:
        return Response({"detail": "You were not on this trip."}, status=403)

    has_rating = DriverRating.objects.filter(
        trip=trip, passenger=request.user
    ).exists()
    has_complaint = DriverComplaint.objects.filter(
        trip=trip, raised_by=request.user
    ).exists()

    return Response(
        {
            "trip_id": trip.id,
            "trip_code": trip.trip_code,
            "status": trip.status,
            "completed": trip.status == Trip.Status.COMPLETED,
            "has_rating": has_rating,
            "has_complaint": has_complaint,
            "can_rate": trip.status == Trip.Status.COMPLETED and not has_rating,
            "can_complain": trip.status == Trip.Status.COMPLETED and not has_complaint,
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_passenger_history(request):
    if getattr(request.user, "role", "") != "passenger":
        return Response({"detail": "Passengers only."}, status=403)

    audits = AuditLog.objects.filter(actor=request.user).order_by("-created_at")[:60]
    complaints = (
        DriverComplaint.objects.filter(raised_by=request.user)
        .select_related("trip", "driver__user")
        .order_by("-created_at")[:30]
    )
    ratings = (
        DriverRating.objects.filter(passenger=request.user)
        .select_related("trip", "driver__user")
        .order_by("-created_at")[:30]
    )

    return Response(
        {
            "audits": [
                {
                    "id": a.id,
                    "action": a.action,
                    "detail": a.detail,
                    "created_at": a.created_at,
                }
                for a in audits
            ],
            "complaints": [
                {
                    "id": c.id,
                    "category": c.category,
                    "status": c.status,
                    "trip_code": getattr(c.trip, "trip_code", None),
                    "driver_name": (
                        f"{c.driver.user.first_name} {c.driver.user.last_name}".strip()
                        if c.driver_id and c.driver.user_id
                        else None
                    ),
                    "created_at": c.created_at,
                }
                for c in complaints
            ],
            "ratings": [
                {
                    "id": r.id,
                    "score": r.score,
                    "comment": r.comment,
                    "trip_code": getattr(r.trip, "trip_code", None),
                    "created_at": r.created_at,
                }
                for r in ratings
            ],
        }
    )


# ---------- Operator dashboard / confirmations ----------


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_operator_dashboard(request):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    rank_ids = list(
        OperatorAtRank.objects.filter(
            operator=op, status=OperatorAtRank.Status.ACTIVE
        ).values_list("rank_id", flat=True)
    )
    trips = Trip.objects.all()
    if rank_ids:
        trips = trips.filter(route__departure_id__in=rank_ids)
    else:
        trips = trips.filter(operator=op)
    today = timezone.localdate()
    today_trips = trips.filter(departure_date=today)
    passengers = Booking.objects.filter(trip__in=today_trips).exclude(
        status=Booking.Status.CANCELLED
    ).count()
    panics = PanicAlert.objects.filter(trip__in=trips).count()
    ranks = Rank.objects.filter(id__in=rank_ids)
    return Response(
        {
            "trips_today": today_trips.count(),
            "passengers_registered": passengers,
            "active_alerts": panics,
            "queue_count": trips.filter(
                status__in=[Trip.Status.SCHEDULED, Trip.Status.BOARDING]
            ).count(),
            "ranks": [{"id": r.id, "name": r.name} for r in ranks],
            "operator_name": f"{op.user.first_name} {op.user.last_name}".strip()
            or op.user.username,
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_operator_confirm_trip(request, trip_id):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not in your rank scope."}, status=404)
    trip.engaged_by = op
    trip.engaged_at = timezone.now()
    if trip.status == Trip.Status.SCHEDULED:
        trip.status = Trip.Status.BOARDING
    trip.save()
    try:
        _audit(
            request.user,
            "operator.confirm_trip",
            "trip",
            trip.id,
            f"Confirmed {trip.trip_code}",
        )
    except Exception:
        pass
    return Response(TripSerializer(trip).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_operator_drivers(request):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    rank_ids = list(
        OperatorAtRank.objects.filter(
            operator=op, status=OperatorAtRank.Status.ACTIVE
        ).values_list("rank_id", flat=True)
    )
    trips = Trip.objects.filter(driver__isnull=False)
    if rank_ids:
        trips = trips.filter(route__departure_id__in=rank_ids)
    else:
        trips = trips.filter(operator=op)
    driver_ids = trips.values_list("driver_id", flat=True).distinct()
    from accounts.models import DriverProfile

    out = []
    for d in DriverProfile.objects.filter(id__in=driver_ids).select_related("user"):
        u = d.user
        complaints = DriverComplaint.objects.filter(driver=d).count()
        veh = trips.filter(driver=d).select_related("vehicle").order_by("-id").first()
        out.append(
            {
                "id": d.id,
                "name": f"{u.first_name} {u.last_name}".strip() or u.username,
                "phone": getattr(u, "phone", "") or "",
                "license_number": d.license_number,
                "status": d.status,
                "complaints_count": complaints,
                "vehicle_plate": getattr(getattr(veh, "vehicle", None), "plate_number", None),
                "trip_id": veh.id if veh else None,
                "trip_code": veh.trip_code if veh else None,
            }
        )
    return Response(out)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def api_operator_verify_assets(request, trip_id):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    trip = _get_operator_trip(op, trip_id)
    if trip is None:
        return Response({"detail": "Trip not in scope."}, status=404)
    try:
        _audit(
            request.user,
            "operator.verify_driver_vehicle",
            "trip",
            trip.id,
            f"Verified assets on {trip.trip_code}",
            {"driver_id": trip.driver_id, "vehicle_id": trip.vehicle_id},
        )
    except Exception:
        pass
    return Response(
        {
            "detail": "Driver and vehicle verification recorded.",
            "trip_id": trip.id,
            "trip_code": trip.trip_code,
            "verified_at": timezone.now(),
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_operator_panics(request):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    rank_ids = list(
        OperatorAtRank.objects.filter(
            operator=op, status=OperatorAtRank.Status.ACTIVE
        ).values_list("rank_id", flat=True)
    )
    qs = list(
        PanicAlert.objects.select_related("user", "trip__route__departure")
        .order_by("-created_at")[:50]
    )
    if rank_ids:
        filtered = [
            p
            for p in qs
            if p.trip_id
            and p.trip.route_id
            and p.trip.route.departure_id in rank_ids
        ]
        qs = filtered if filtered else qs[:20]
    return Response(
        [
            {
                "id": p.id,
                "user": getattr(p.user, "username", None),
                "user_name": (
                    f"{p.user.first_name} {p.user.last_name}".strip()
                    if p.user_id
                    else None
                ),
                "trip_id": p.trip_id,
                "trip_code": getattr(p.trip, "trip_code", None),
                "lat": p.latitude,
                "lng": p.longitude,
                "created_at": p.created_at,
                "severity": p.payload,
            }
            for p in qs
        ]
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def api_operator_complaints(request):
    op = _operator(request)
    if op is None:
        return Response({"detail": "Not an operator account."}, status=403)
    rank_ids = list(
        OperatorAtRank.objects.filter(
            operator=op, status=OperatorAtRank.Status.ACTIVE
        ).values_list("rank_id", flat=True)
    )
    qs = DriverComplaint.objects.select_related(
        "driver__user", "trip__route__departure", "raised_by"
    ).order_by("-created_at")[:80]
    rows = []
    for c in qs:
        if rank_ids and c.trip_id and c.trip.route_id:
            if c.trip.route.departure_id not in rank_ids:
                continue
        du = getattr(c.driver, "user", None)
        rows.append(
            {
                "id": c.id,
                "category": c.category,
                "description": c.description,
                "status": c.status,
                "driver_name": f"{du.first_name} {du.last_name}".strip() if du else None,
                "trip_id": c.trip_id,
                "trip_code": getattr(c.trip, "trip_code", None),
                "created_at": c.created_at,
                "escalation_reason": c.escalation_reason,
            }
        )
    return Response(rows)