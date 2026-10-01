from rest_framework import serializers
from .models import (
    Rank,
    Destination,
    OperatorAtRank,
    Route,
    RouteStop,
    Vehicle,
    Trip,
    Booking,
    VerificationCode,
    TripFlag,
    TripAssetChange,
    VehicleLocation,
    TaxiFareRule,
    PanicAlert,
    RideRequest,
    PassengerNotification,
    DriverComplaint,
    DriverRating,
)


class RankSerializer(serializers.ModelSerializer):
    class Meta:
        model = Rank
        fields = ["id", "name", "area", "latitude", "longitude"]


class DestinationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Destination
        fields = ["id", "name", "area", "latitude", "longitude"]


class RouteStopSerializer(serializers.ModelSerializer):
    class Meta:
        model = RouteStop
        fields = ["id", "name", "order", "lat", "lng", "fare_from_origin"]


class RouteSerializer(serializers.ModelSerializer):
    departure = RankSerializer(read_only=True)
    destination = DestinationSerializer(read_only=True)
    stops = RouteStopSerializer(many=True, read_only=True)

    class Meta:
        model = Route
        fields = [
            "id",
            "code",
            "name",
            "departure",
            "destination",
            "fare",
            "service_category",
            "typical_duration_minutes",
            "geometry",
            "distance_km",
            "average_speed_kmh",
            "vehicle_class",
            "deviation_threshold_m",
            "active",
            "stops",
        ]


class VehicleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Vehicle
        fields = [
            "id",
            "plate_number",
            "make",
            "model",
            "seat_capacity",
            "roadworthy",
            "status",
            "notes",
        ]


class VehicleLocationSerializer(serializers.ModelSerializer):
    class Meta:
        model = VehicleLocation
        fields = [
            "id",
            "vehicle",
            "trip",
            "lat",
            "lng",
            "speed_kmh",
            "heading_deg",
            "accuracy_m",
            "source",
            "recorded_at",
        ]


class TripSerializer(serializers.ModelSerializer):
    route = RouteSerializer(read_only=True)
    operator_name = serializers.SerializerMethodField()
    vehicle_plate = serializers.SerializerMethodField()
    driver_name = serializers.SerializerMethodField()
    seats_taken = serializers.IntegerField(read_only=True)
    seats_available = serializers.IntegerField(read_only=True)
    is_engaged = serializers.SerializerMethodField()

    class Meta:
        model = Trip
        fields = [
            "id",
            "trip_code",
            "route",
            "operator_name",
            "departure_date",
            "expected_departure_time",
            "actual_departure_time",
            "estimated_arrival",
            "seat_capacity",
            "seats_taken",
            "seats_available",
            "status",
            "driver_name",
            "vehicle_plate",
            "vehicle_id",
            "engaged_at",
            "is_engaged",
            "notes",
        ]

    def get_is_engaged(self, obj):
        return bool(obj.engaged_at or obj.engaged_by_id)

    def get_operator_name(self, obj):
        try:
            return obj.operator.association.association_name or ""
        except Exception:
            return ""

    def get_vehicle_plate(self, obj):
        try:
            return obj.vehicle.plate_number
        except Exception:
            return None

    def get_driver_name(self, obj):
        try:
            u = obj.driver.user
            name = f"{u.first_name} {u.last_name}".strip()
            return name or u.phone or u.username
        except Exception:
            return None


# ------------------------------------------------------------------
# HARDENED BookingSerializer — now also exposes vehicle + trip status
# so the passenger Active-trip panel can show the assigned vehicle
# the moment the booking row is opened (before live tracking loads).
# ------------------------------------------------------------------
class BookingSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(read_only=True)
    trip_code = serializers.SerializerMethodField()
    trip_id = serializers.SerializerMethodField()
    verification_code = serializers.SerializerMethodField()
    route_from = serializers.SerializerMethodField()
    route_to = serializers.SerializerMethodField()
    departure_date = serializers.SerializerMethodField()
    driver_name = serializers.SerializerMethodField()
    operator_name = serializers.SerializerMethodField()
    vehicle_id = serializers.SerializerMethodField()
    vehicle_plate = serializers.SerializerMethodField()
    trip_status = serializers.SerializerMethodField()

    class Meta:
        model = Booking
        fields = [
            "id",
            "trip",
            "trip_id",
            "trip_code",
            "passenger",
            "walk_in_name",
            "walk_in_phone",
            "walk_in_id_number",
            "walk_in_next_of_kin_name",
            "walk_in_next_of_kin_phone",
            "status",
            "fare_paid",
            "booked_at",
            "boarded_at",
            "display_name",
            "verification_code",
            "route_from",
            "route_to",
            "departure_date",
            "driver_name",
            "operator_name",
            "vehicle_id",
            "vehicle_plate",
            "trip_status",
        ]
        read_only_fields = ["booked_at", "boarded_at"]

    def get_trip_code(self, obj):
        try:
            return obj.trip.trip_code
        except Exception:
            return None

    def get_trip_id(self, obj):
        try:
            return obj.trip_id
        except Exception:
            return None

    def get_verification_code(self, obj):
        try:
            vc = obj.verification_code
        except Exception:
            return None
        try:
            return vc.code if vc else None
        except Exception:
            return None

    def get_route_from(self, obj):
        try:
            return obj.trip.route.departure.name
        except Exception:
            return None

    def get_route_to(self, obj):
        try:
            return obj.trip.route.destination.name
        except Exception:
            return None

    def get_departure_date(self, obj):
        try:
            d = obj.trip.departure_date
            return str(d) if d else None
        except Exception:
            return None

    def get_driver_name(self, obj):
        try:
            u = obj.trip.driver.user
            return f"{u.first_name} {u.last_name}".strip() or u.username
        except Exception:
            return None

    def get_operator_name(self, obj):
        try:
            u = obj.trip.operator.user
            return f"{u.first_name} {u.last_name}".strip() or u.username
        except Exception:
            return None

    def get_vehicle_id(self, obj):
        try:
            return obj.trip.vehicle_id
        except Exception:
            return None

    def get_vehicle_plate(self, obj):
        try:
            v = obj.trip.vehicle
            return v.plate_number if v else None
        except Exception:
            return None

    def get_trip_status(self, obj):
        try:
            return obj.trip.status
        except Exception:
            return None


class BookingCreateSerializer(serializers.Serializer):
    trip_id = serializers.IntegerField()


class PanicAlertSerializer(serializers.ModelSerializer):
    class Meta:
        model = PanicAlert
        fields = [
            "id",
            "trip",
            "booking",
            "latitude",
            "longitude",
            "accuracy_m",
            "payload",
            "created_at",
        ]
        read_only_fields = ["created_at"]


class RideRequestSerializer(serializers.ModelSerializer):
    trip_code = serializers.SerializerMethodField()
    accepted_by_name = serializers.SerializerMethodField()

    class Meta:
        model = RideRequest
        fields = [
            "id",
            "passenger",
            "trip",
            "trip_code",
            "status",
            "passenger_lat",
            "passenger_lng",
            "passenger_name",
            "accepted_by",
            "accepted_by_name",
            "accepted_at",
            "created_at",
        ]
        read_only_fields = [
            "passenger",
            "status",
            "accepted_by",
            "accepted_at",
            "created_at",
            "passenger_name",
        ]

    def get_trip_code(self, obj):
        try:
            return obj.trip.trip_code
        except Exception:
            return None

    def get_accepted_by_name(self, obj):
        if not obj.accepted_by_id:
            return None
        try:
            u = obj.accepted_by.user
            full = f"{u.first_name} {u.last_name}".strip()
            return full or getattr(u, "phone", None) or u.username
        except Exception:
            return None


class PassengerNotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = PassengerNotification
        fields = ["id", "title", "body", "read", "created_at", "meta"]
        read_only_fields = ["created_at"]


class DriverComplaintSerializer(serializers.ModelSerializer):
    driver_name = serializers.SerializerMethodField()
    trip_code = serializers.SerializerMethodField()
    raised_by_name = serializers.SerializerMethodField()

    class Meta:
        model = DriverComplaint
        fields = [
            "id",
            "driver",
            "driver_name",
            "trip",
            "trip_code",
            "raised_by",
            "raised_by_name",
            "category",
            "description",
            "status",
            "escalation_reason",
            "admin_note",
            "created_at",
        ]
        read_only_fields = [
            "driver",
            "trip",
            "raised_by",
            "status",
            "escalation_reason",
            "admin_note",
            "created_at",
        ]

    def get_driver_name(self, obj):
        try:
            u = obj.driver.user
            return f"{u.first_name} {u.last_name}".strip() or u.username
        except Exception:
            return None

    def get_trip_code(self, obj):
        try:
            return obj.trip.trip_code
        except Exception:
            return None

    def get_raised_by_name(self, obj):
        try:
            u = obj.raised_by
            if not u:
                return None
            return f"{u.first_name} {u.last_name}".strip() or u.username
        except Exception:
            return None


class DriverRatingSerializer(serializers.ModelSerializer):
    class Meta:
        model = DriverRating
        fields = [
            "id",
            "driver",
            "trip",
            "passenger",
            "score",
            "comment",
            "created_at",
        ]
        read_only_fields = ["driver", "trip", "passenger", "created_at"]