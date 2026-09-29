"""
THEMBA transport — merged domain models.

Decisions applied:
- Route: FYP structure (Rank → Destination + fixed fare) + search-first geometry,
  distance_km, deviation_threshold_m, vehicle_class (no separate "routing plan" model).
- Trip: FYP trip is source of truth (operator, schedule, capacity, trip_code, engage).
- Passenger on trip: FYP Booking only (Boarding from search-first maps here).
- Vehicle: FYP Vehicle + search-first VehicleLocation (live GPS).
- Operator scope: FYP OperatorAtRank + OperatorProfile.
- Fares: fixed Route.fare for corridors; TaxiFareRule for Google/ORS ad-hoc routes.
- Duplicate engaged_* fields from FYP source fixed (single pair).
- Driver profile support: ratings, complaints, notifications.
- DriverNotification: link_trip, link_booking, meta (for ride-request deep links).
- RideRequest: passenger dispatch signal, not a booking.
- PassengerNotification: slim status messages for the passenger bar.
- Announcement: RankFlow Ops scoped (topic/message/status/audience/rank/route/service).
- SafetyIncident + AuditLog + OperatorNotification for the RankFlow admin console.
- DriverRating / DriverComplaint: one rating / one complaint per trip per passenger.
"""
from django.conf import settings
from django.db import models
from django.utils import timezone


class Rank(models.Model):
    """Physical place where taxis load. Shared by many operators."""

    name = models.CharField(max_length=150)
    area = models.CharField(max_length=150, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return f"{self.name} ({self.area})" if self.area else self.name


class Destination(models.Model):
    name = models.CharField(max_length=150)
    area = models.CharField(max_length=150, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class OperatorAtRank(models.Model):
    """Operator approved presence at a rank (FYP). Set by rank admin."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending approval"
        ACTIVE = "active", "Active"
        REJECTED = "rejected", "Rejected"
        INACTIVE = "inactive", "Inactive"

    operator = models.ForeignKey(
        "accounts.OperatorProfile",
        on_delete=models.CASCADE,
        related_name="rank_memberships",
    )
    rank = models.ForeignKey(
        Rank, on_delete=models.PROTECT, related_name="operator_memberships"
    )
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING
    )
    requested_at = models.DateTimeField(auto_now_add=True)
    approved_by = models.ForeignKey(
        "accounts.AdminProfile",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="approved_memberships",
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        unique_together = [("operator", "rank")]
        ordering = ["rank__name"]

    def __str__(self):
        return f"{self.operator} @ {self.rank} ({self.status})"


class Route(models.Model):
    """
    Shared corridor: Rank → Destination with fixed fare (FYP),
    plus road geometry and tracking fields (themba-search-first).
    """

    class ServiceCategory(models.TextChoices):
        UNSTRUCTURED = "unstructured", "Unstructured"
        STRUCTURED = "structured", "Structured"

    class VehicleClass(models.TextChoices):
        QUANTUM_15 = "quantum_15", "Toyota Quantum (15-seater)"
        QUANTUM_22 = "quantum_22", "Toyota Quantum (22-seater, Ses'fikile)"
        SEDAN = "sedan", "Metered taxi / sedan"

    code = models.CharField(
        max_length=20, unique=True, null=True, blank=True, help_text="e.g. TH-EMP-002"
    )
    name = models.CharField(max_length=120, blank=True)
    departure = models.ForeignKey(
        Rank, on_delete=models.PROTECT, related_name="routes_from"
    )
    destination = models.ForeignKey(
        Destination, on_delete=models.PROTECT, related_name="routes_to"
    )
    fare = models.DecimalField(max_digits=8, decimal_places=2)
    service_category = models.CharField(
        max_length=20,
        choices=ServiceCategory.choices,
        default=ServiceCategory.STRUCTURED,
    )
    typical_duration_minutes = models.PositiveIntegerField(null=True, blank=True)

    geometry = models.JSONField(
        default=list,
        blank=True,
        help_text="Ordered [lat, lng] pairs from ORS/OSRM; filled once, cached.",
    )
    distance_km = models.FloatField(null=True, blank=True)
    average_speed_kmh = models.FloatField(default=45.0)
    vehicle_class = models.CharField(
        max_length=20,
        choices=VehicleClass.choices,
        default=VehicleClass.QUANTUM_15,
    )
    deviation_threshold_m = models.FloatField(
        null=True,
        blank=True,
        help_text="Override default off-route threshold (metres) for this corridor.",
    )
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["departure__name", "destination__name"]
        unique_together = [("departure", "destination")]

    def __str__(self):
        label = self.name or f"{self.departure.name} → {self.destination.name}"
        return f"{label} (R{self.fare})"

    def estimated_duration_min(self):
        if self.typical_duration_minutes:
            return self.typical_duration_minutes
        if self.distance_km and self.average_speed_kmh:
            return round((self.distance_km / self.average_speed_kmh) * 60)
        return None


class RouteStop(models.Model):
    """Ordered stop along a route (boarding + ETA)."""

    route = models.ForeignKey(Route, related_name="stops", on_delete=models.CASCADE)
    name = models.CharField(max_length=120)
    lat = models.FloatField()
    lng = models.FloatField()
    order = models.PositiveIntegerField(default=0)
    fare_from_origin = models.DecimalField(max_digits=8, decimal_places=2, default=0)

    class Meta:
        ordering = ["route", "order"]

    def __str__(self):
        return f"{self.route_id} stop {self.order}: {self.name}"


class Vehicle(models.Model):
    """Physical taxi. Not permanently bound to one route; assignment is on Trip."""

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        QUEUED = "queued", "In rank queue"
        OFFLINE = "offline", "Offline"
        MAINTENANCE = "maintenance", "Maintenance"

    plate_number = models.CharField(max_length=20, unique=True)
    make = models.CharField(max_length=50, blank=True, default="Toyota")
    model = models.CharField(max_length=50, blank=True, default="Quantum")
    seat_capacity = models.PositiveSmallIntegerField(default=15)
    roadworthy = models.BooleanField(default=True)
    roadworthy_expiry = models.DateField(null=True, blank=True)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.OFFLINE
    )
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.plate_number} ({self.make} {self.model})".strip()


class DriverVehicle(models.Model):
    """Driver approved to operate a vehicle (FYP)."""

    driver = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.CASCADE,
        related_name="vehicle_assignments",
    )
    vehicle = models.ForeignKey(
        Vehicle, on_delete=models.CASCADE, related_name="driver_assignments"
    )
    assigned_at = models.DateTimeField(auto_now_add=True)
    active = models.BooleanField(default=True)

    class Meta:
        unique_together = [("driver", "vehicle", "active")]


class VehicleLocation(models.Model):
    """Live + historical GPS pings attached to a Vehicle."""

    class Source(models.TextChoices):
        GPS = "gps", "Real GPS"
        SIMULATED = "simulated", "Simulated / test data"

    vehicle = models.ForeignKey(
        Vehicle, related_name="locations", on_delete=models.CASCADE
    )
    trip = models.ForeignKey(
        "Trip",
        related_name="location_pings",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
    )
    lat = models.FloatField()
    lng = models.FloatField()
    speed_kmh = models.FloatField(
        null=True, blank=True, help_text="Null if GPS speed unavailable"
    )
    heading_deg = models.FloatField(default=0)
    accuracy_m = models.FloatField(default=0)
    source = models.CharField(
        max_length=20, choices=Source.choices, default=Source.GPS
    )
    recorded_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-recorded_at"]
        indexes = [
            models.Index(fields=["vehicle", "-recorded_at"]),
            models.Index(fields=["trip", "-recorded_at"]),
        ]

    def __str__(self):
        return f"{self.vehicle.plate_number} @ {self.recorded_at:%H:%M:%S}"


class Trip(models.Model):
    """
    FYP Trip = source of truth.
    Operator is OPTIONAL: a trip scheduled with operator=null appears to any
    operator whose active rank matches the route's departure rank.
    """

    class Status(models.TextChoices):
        SCHEDULED = "scheduled", "Scheduled"
        BOARDING = "boarding", "Boarding"
        IN_PROGRESS = "in_progress", "In progress"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"
        FLAGGED = "flagged", "Flagged — needs admin review"

    operator = models.ForeignKey(
        "accounts.OperatorProfile",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="trips",
    )
    route = models.ForeignKey(Route, on_delete=models.PROTECT, related_name="trips")
    departure_date = models.DateField()
    expected_departure_time = models.TimeField(null=True, blank=True)
    actual_departure_time = models.DateTimeField(null=True, blank=True)
    estimated_arrival = models.DateTimeField(null=True, blank=True)
    seat_capacity = models.PositiveSmallIntegerField(default=15)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.SCHEDULED
    )
    trip_code = models.CharField(max_length=30, unique=True)
    driver = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="trips",
    )
    vehicle = models.ForeignKey(
        Vehicle,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="trips",
    )
    engaged_by = models.ForeignKey(
        "accounts.OperatorProfile",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="engaged_trips",
    )
    engaged_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["departure_date", "expected_departure_time", "id"]

    @property
    def seats_taken(self):
        return self.bookings.exclude(
            status__in=[Booking.Status.CANCELLED, Booking.Status.NO_SHOW]
        ).count()

    @property
    def seats_available(self):
        return max(self.seat_capacity - self.seats_taken, 0)

    def __str__(self):
        return f"{self.trip_code} {self.route} @ {self.departure_date}"


class Booking(models.Model):
    """Passenger on a trip (FYP). Registered user or walk-in fields."""

    class Status(models.TextChoices):
        RESERVED = "reserved", "Reserved"
        BOARDED = "boarded", "Boarded"
        COMPLETED = "completed", "Completed"
        NO_SHOW = "no_show", "No show"
        CANCELLED = "cancelled", "Cancelled"

    trip = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="bookings")
    passenger = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="bookings",
    )
    walk_in_name = models.CharField(max_length=150, blank=True)
    walk_in_phone = models.CharField(max_length=15, blank=True)
    walk_in_id_number = models.CharField(max_length=13, blank=True)
    walk_in_next_of_kin_name = models.CharField(max_length=150, blank=True)
    walk_in_next_of_kin_phone = models.CharField(max_length=15, blank=True)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.RESERVED
    )
    fare_paid = models.DecimalField(max_digits=8, decimal_places=2, default=0)
    boarding_stop = models.ForeignKey(
        RouteStop, on_delete=models.SET_NULL, null=True, blank=True
    )
    booked_at = models.DateTimeField(auto_now_add=True)
    boarded_at = models.DateTimeField(null=True, blank=True)
    boarded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="boarded_bookings",
    )

    class Meta:
        ordering = ["-booked_at"]

    def display_name(self):
        if self.passenger:
            full = f"{self.passenger.first_name} {self.passenger.last_name}".strip()
            return full or (self.passenger.phone or self.passenger.email or self.passenger.username)
        return self.walk_in_name or "Walk-in"

    def __str__(self):
        return f"{self.display_name()} → {self.trip.trip_code} ({self.status})"


class VerificationCode(models.Model):
    """Per-booking verification for boarding / trip-verified feedback."""

    booking = models.OneToOneField(
        Booking, on_delete=models.CASCADE, related_name="verification_code"
    )
    code = models.CharField(max_length=20)
    issued_at = models.DateTimeField(auto_now_add=True)
    verified_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"{self.code} ({'verified' if self.verified_at else 'pending'})"


class TripFlag(models.Model):
    class Category(models.TextChoices):
        SAFETY = "safety", "Safety"
        DELAY = "delay", "Delay"
        MISCONDUCT = "misconduct", "Misconduct"
        VEHICLE = "vehicle", "Vehicle issue"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        RESOLVED = "resolved", "Resolved"

    trip = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="flags")
    category = models.CharField(max_length=30, choices=Category.choices)
    description = models.TextField(blank=True)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.OPEN
    )
    flagged_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="flags_raised",
    )
    flagged_at = models.DateTimeField(auto_now_add=True)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="flags_resolved",
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolution_notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-flagged_at"]

    def __str__(self):
        return f"{self.trip.trip_code} — {self.get_category_display()} ({self.status})"


class TripAssetChange(models.Model):
    """Audit log of driver or vehicle reassignment on a trip (FYP)."""

    class Reason(models.TextChoices):
        DRIVER_NOT_FIT = "driver_not_fit", "Driver not fit to drive"
        DRIVER_RESPONSIBILITIES = "driver_responsibilities", "Driver has other responsibilities"
        DRIVER_ROTATION = "driver_rotation", "Driver rotation change"
        VEHICLE_NOT_FIT = "vehicle_not_fit", "Vehicle not fit for travel"
        VEHICLE_FORFEIT = "vehicle_forfeit", "Vehicle voluntary forfeit"
        VEHICLE_SWAP = "vehicle_swap", "Vehicle swapped in queue"
        OTHER = "other", "Other"

    trip = models.ForeignKey(
        Trip, on_delete=models.CASCADE, related_name="asset_changes"
    )
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="asset_changes_made",
    )
    changed_at = models.DateTimeField(auto_now_add=True)
    old_driver = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="replaced_from",
    )
    new_driver = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="replaced_to",
    )
    old_vehicle = models.ForeignKey(
        Vehicle,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="replaced_from",
    )
    new_vehicle = models.ForeignKey(
        Vehicle,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="replaced_to",
    )
    reason = models.CharField(max_length=30, choices=Reason.choices)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-changed_at"]

    def __str__(self):
        return f"{self.trip.trip_code} — {self.get_reason_display()}"


class TaxiFareRule(models.Model):
    """Ad-hoc fare formula for Google/ORS-calculated routes."""

    DEMONSTRATION_NOTICE = (
        "Demonstration configuration — not official South African taxi fares."
    )

    name = models.CharField(max_length=80, default="Default ad-hoc fare")
    base_fare = models.DecimalField(max_digits=6, decimal_places=2, default=5.00)
    price_per_km = models.DecimalField(max_digits=6, decimal_places=2, default=2.00)
    minimum_fare = models.DecimalField(max_digits=6, decimal_places=2, default=10.00)
    maximum_fare = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )
    active = models.BooleanField(default=True)
    route_specific_override = models.ForeignKey(
        Route,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="fare_overrides",
    )

    class Meta:
        ordering = ["-active", "name"]

    def __str__(self):
        return f"{self.name} ({'active' if self.active else 'inactive'})"

    def estimate(self, distance_km):
        fare = float(self.base_fare) + float(self.price_per_km) * float(distance_km)
        fare = max(fare, float(self.minimum_fare))
        if self.maximum_fare is not None:
            fare = min(fare, float(self.maximum_fare))
        return round(fare, 2)


class PanicAlert(models.Model):
    """Persisted panic/emergency from passenger."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="panic_alerts",
    )
    trip = models.ForeignKey(
        Trip, on_delete=models.SET_NULL, null=True, blank=True, related_name="panic_alerts"
    )
    booking = models.ForeignKey(
        Booking,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="panic_alerts",
    )
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    accuracy_m = models.FloatField(null=True, blank=True)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"PanicAlert {self.id} @ {self.created_at:%Y-%m-%d %H:%M}"


# ---------------------------------------------------------------------------
# Driver profile support: ratings, complaints, notifications
# ---------------------------------------------------------------------------


class DriverRating(models.Model):
    """Passenger rating of a driver (1–5 stars). One per trip per passenger."""

    driver = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.CASCADE,
        related_name="ratings",
    )
    trip = models.ForeignKey(
        Trip,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="driver_ratings",
    )
    passenger = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="driver_ratings_given",
    )
    score = models.PositiveSmallIntegerField()
    comment = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["driver", "trip", "passenger"],
                name="unique_rating_per_passenger_per_trip",
            )
        ]

    def __str__(self):
        return f"{self.driver} — {self.score}/5"


class DriverComplaint(models.Model):
    """Complaint raised against a driver. One per trip per passenger."""

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        OPERATOR_REVIEWING = "operator_reviewing", "Operator reviewing"
        ESCALATED = "escalated", "Escalated"
        RESPONSE_SENT = "response_sent", "Response sent"
        RESOLVED = "resolved", "Resolved"
        DISMISSED = "dismissed", "Dismissed"

    driver = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.CASCADE,
        related_name="complaints",
    )
    trip = models.ForeignKey(
        Trip,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="driver_complaints",
    )
    raised_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="driver_complaints_raised",
    )
    category = models.CharField(max_length=40, default="other")
    description = models.TextField()
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.OPEN
    )
    escalation_reason = models.TextField(blank=True)
    escalated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="complaints_escalated",
    )
    escalated_at = models.DateTimeField(null=True, blank=True)
    admin_note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["trip", "raised_by"],
                name="unique_complaint_per_passenger_per_trip",
            )
        ]

    def __str__(self):
        return f"{self.driver} — {self.category} ({self.status})"


class DriverNotification(models.Model):
    """In-app notification delivered to a driver's profile panel."""

    driver = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.CASCADE,
        related_name="notifications",
    )
    title = models.CharField(max_length=120)
    body = models.TextField(blank=True)
    read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    link_trip = models.ForeignKey(
        "Trip",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="driver_notifications",
    )
    link_booking = models.ForeignKey(
        "Booking",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="driver_notifications",
    )
    meta = models.JSONField(
        default=dict,
        blank=True,
        help_text="Optional: passenger_lat, passenger_lng, passenger_name, trip_code",
    )

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.driver} — {self.title}"


class Announcement(models.Model):
    """Rank/route-scoped announcement to drivers and/or operators."""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        SCHEDULED = "scheduled", "Scheduled"
        PUBLISHED = "published", "Published"
        INACTIVE = "inactive", "Inactive"

    class Audience(models.TextChoices):
        DRIVERS_OPERATORS = "drivers_operators", "Drivers + operators"
        DRIVERS = "drivers", "Drivers only"
        OPERATORS = "operators", "Operators only"
        ALL_USERS = "all_users", "Every user"

    topic = models.CharField(max_length=200)
    message = models.TextField()
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.DRAFT
    )
    audience = models.CharField(
        max_length=30, choices=Audience.choices, default=Audience.DRIVERS_OPERATORS
    )
    rank = models.ForeignKey(
        Rank, on_delete=models.SET_NULL, null=True, blank=True, related_name="announcements"
    )
    route = models.ForeignKey(
        Route, on_delete=models.SET_NULL, null=True, blank=True, related_name="announcements"
    )
    service = models.CharField(max_length=40, blank=True, default="commuter")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="announcements_created",
    )
    published_at = models.DateTimeField(null=True, blank=True)
    scheduled_for = models.DateTimeField(null=True, blank=True)
    reach_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return f"{self.topic} ({self.status})"


class SafetyIncident(models.Model):
    """Independent safety register (confirm only via admin safety review)."""

    class Status(models.TextChoices):
        AWAITING_REVIEW = "awaiting_review", "Awaiting review"
        EVIDENCE_REVIEW = "evidence_review", "Evidence review"
        CONFIRMED = "confirmed", "Confirmed"
        NOT_CONFIRMED = "not_confirmed", "Not confirmed"
        RESOLVED = "resolved", "Resolved"

    title = models.CharField(max_length=200)
    source = models.CharField(max_length=40, default="complaint")  # complaint | independent
    complaint = models.ForeignKey(
        DriverComplaint,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="safety_incidents",
    )
    trip = models.ForeignKey(
        Trip, on_delete=models.SET_NULL, null=True, blank=True, related_name="safety_incidents"
    )
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.AWAITING_REVIEW
    )
    findings = models.TextField(blank=True)
    confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="safety_confirmed",
    )
    confirmed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class AuditLog(models.Model):
    """History of system changes visible to users (role-filtered in API)."""

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audit_actions",
    )
    action = models.CharField(max_length=80)
    entity_type = models.CharField(max_length=40, blank=True)
    entity_id = models.CharField(max_length=40, blank=True)
    detail = models.TextField(blank=True)
    meta = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class OperatorNotification(models.Model):
    operator_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="operator_notifications",
    )
    title = models.CharField(max_length=120)
    body = models.TextField(blank=True)
    read = models.BooleanField(default=False)
    meta = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class PassengerNotification(models.Model):
    passenger = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="passenger_notifications",
    )
    title = models.CharField(max_length=120)
    body = models.TextField(blank=True)
    read = models.BooleanField(default=False)
    meta = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class RideRequest(models.Model):
    """Passenger → nearby drivers: location ping, not a seat booking."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REJECTED = "rejected", "Rejected"
        EXPIRED = "expired", "Expired"
        CANCELLED = "cancelled", "Cancelled"

    RADIUS_KM = 10.0

    passenger = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="ride_requests",
    )
    trip = models.ForeignKey(
        Trip,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ride_requests",
    )
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING
    )
    passenger_lat = models.FloatField()
    passenger_lng = models.FloatField()
    passenger_name = models.CharField(max_length=150, blank=True)
    accepted_by = models.ForeignKey(
        "accounts.DriverProfile",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="accepted_ride_requests",
    )
    accepted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"RideRequest#{self.pk} {self.passenger_name} ({self.status})"