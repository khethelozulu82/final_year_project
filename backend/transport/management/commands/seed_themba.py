"""
Single seed: Rank → Route(+geometry) → Vehicle → Trip → optional Booking.

Creates:
  1. Associations (RankCode) — KDL001 / ESK001 / RBY001 / EMP001
  2. Ranks + Destinations — Ongoye, Empangeni, Esikhawini, Richards Bay
  3. Routes + RouteStops + TaxiFareRule
  4. Real accounts (password: Passw0rd!)
       - 3 passengers
       - 7 drivers        (all VERIFIED)
       - 9 operators      (each tied to an association + rank membership)
       - 7 administrators (each tied to a rank, is_staff=True)
     Each account gets phone AND a constructed email so login works with either.
  5. Fallback demo accounts (password: themba123)
       passenger_demo / driver_demo / operator_demo / admin_demo
  6. Vehicles, DriverVehicle link, today + tomorrow trips.

Idempotent: safe to re-run.
"""
from datetime import time, timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import (
    AdminProfile,
    DriverProfile,
    OperatorProfile,
    PassengerProfile,
    RankCode,
)
from transport.models import (
    Destination,
    DriverVehicle,
    OperatorAtRank,
    Rank,
    Route,
    RouteStop,
    TaxiFareRule,
    Trip,
    Vehicle,
)

DEMO_PASSWORD = "themba123"   # *_demo accounts
REAL_PASSWORD = "Passw0rd!"   # real dataset accounts
User = get_user_model()


def _email_for(first, last):
    f = (first or "").strip().lower().replace(" ", ".")
    l = (last or "").strip().lower().replace(" ", ".")
    return f"{f}.{l}@themba.local" if f and l else ""


def _safe_email_for(first, last, phone):
    base = _email_for(first, last)
    if not base:
        return f"{phone}@themba.local"
    clash = User.objects.filter(email__iexact=base).exclude(phone=phone).exists()
    if not clash:
        return base
    suffix = str(phone)[-4:]
    f = (first or "").strip().lower().replace(" ", ".")
    l = (last or "").strip().lower().replace(" ", ".")
    return f"{f}.{l}.{suffix}@themba.local"


def _safe_username_for(phone):
    candidate = str(phone)
    clash = User.objects.filter(username=candidate).exclude(phone=phone).exists()
    if clash:
        candidate = f"u{phone}"
    return candidate


class Command(BaseCommand):
    help = "Seed THEMBA demo + real-user data for multi-device testing"

    def _upsert_real_user(self, phone, email, first, last, role):
        username = _safe_username_for(phone)
        email = (email or _safe_email_for(first, last, phone)).strip().lower()
        user, created = User.objects.get_or_create(
            phone=phone,
            defaults={
                "username": username,
                "email": email,
                "role": role,
                "first_name": first,
                "last_name": last,
            },
        )
        if not created:
            user.username = username
            user.email = email
            user.role = role
            user.first_name = first
            user.last_name = last
        user.is_active = True
        user.set_password(REAL_PASSWORD)
        user.save()
        return user

    def _upsert_demo_user(self, username, phone, email, role, first, last):
        phone_owner = User.objects.filter(phone=phone).exclude(username=username).first()
        if phone_owner is not None:
            return User.objects.filter(username=username).first()
        user, created = User.objects.get_or_create(
            username=username,
            defaults={
                "phone": phone,
                "email": email,
                "role": role,
                "first_name": first,
                "last_name": last,
            },
        )
        if not created:
            user.phone = phone
            user.email = email
            user.role = role
            user.first_name = first
            user.last_name = last
        user.is_active = True
        user.set_password(DEMO_PASSWORD)
        user.save()
        return user

    def handle(self, *args, **options):
        self.stdout.write("Seeding THEMBA…")

        # 1. Associations
        codes = {}
        for code, name in [
            ("KDL001", "Kwa-Dlangezwa Taxi Association"),
            ("ESK001", "eSikhawini Taxi Association"),
            ("RBY001", "Richards Bay Taxi Association"),
            ("EMP001", "Empangeni Taxi Association"),
        ]:
            rc, _ = RankCode.objects.update_or_create(
                code=code,
                defaults={
                    "association_name": name,
                    "operating_region": "King Cetshwayo",
                    "is_active": True,
                },
            )
            codes[code] = rc

        # 2. Ranks + Destinations
        place_specs = [
            ("Ongoye", "King Cetshwayo", -28.854, 31.846),
            ("Empangeni", "King Cetshwayo", -28.7808, 31.8925),
            ("Esikhawini", "King Cetshwayo", -28.883, 31.9),
            ("Richards Bay", "King Cetshwayo", -28.781, 32.0377),
        ]
        ranks, dests = {}, {}
        for name, area, lat, lng in place_specs:
            r, _ = Rank.objects.update_or_create(
                name=name,
                defaults={"area": area, "latitude": lat, "longitude": lng},
            )
            ranks[name] = r
            d, _ = Destination.objects.update_or_create(
                name=name,
                defaults={"area": area, "latitude": lat, "longitude": lng},
            )
            dests[name] = d

        # 3. Routes + RouteStops
        route_specs = [
            ("TH-ONG-EMP", "Ongoye → Empangeni", "Ongoye", "Empangeni", 24, 18),
            ("TH-ONG-ESI", "Ongoye → Esikhawini", "Ongoye", "Esikhawini", 20, 15),
            ("TH-ONG-RB", "Ongoye → Richards Bay", "Ongoye", "Richards Bay", 34, 35),
            ("TH-ESI-EMP", "Esikhawini → Empangeni", "Esikhawini", "Empangeni", 23, 20),
            ("TH-ESI-RB", "Esikhawini → Richards Bay", "Esikhawini", "Richards Bay", 18, 22),
            ("TH-RB-EMP", "Richards Bay → Empangeni", "Richards Bay", "Empangeni", 21, 25),
        ]
        routes = {}
        for code, name, dep_name, dest_name, fare, mins in route_specs:
            dep, dest = ranks[dep_name], dests[dest_name]
            geom = [
                [float(dep.latitude), float(dep.longitude)],
                [float(dest.latitude), float(dest.longitude)],
            ]
            dist = abs(float(dep.latitude) - float(dest.latitude)) * 111 + abs(
                float(dep.longitude) - float(dest.longitude)
            ) * 95
            route, _ = Route.objects.update_or_create(
                code=code,
                defaults={
                    "name": name,
                    "departure": dep,
                    "destination": dest,
                    "fare": fare,
                    "service_category": Route.ServiceCategory.STRUCTURED,
                    "typical_duration_minutes": mins,
                    "geometry": geom,
                    "distance_km": round(dist, 1),
                    "average_speed_kmh": 40,
                    "vehicle_class": Route.VehicleClass.QUANTUM_15,
                    "deviation_threshold_m": 150,
                    "active": True,
                },
            )
            routes[code] = route
            RouteStop.objects.filter(route=route).delete()
            RouteStop.objects.bulk_create(
                [
                    RouteStop(
                        route=route, name=dep.name,
                        lat=float(dep.latitude), lng=float(dep.longitude),
                        order=0, fare_from_origin=0,
                    ),
                    RouteStop(
                        route=route, name=dest.name,
                        lat=float(dest.latitude), lng=float(dest.longitude),
                        order=1, fare_from_origin=fare,
                    ),
                ]
            )

        TaxiFareRule.objects.update_or_create(
            name="Default ad-hoc fare",
            defaults={
                "base_fare": 5, "price_per_km": 2,
                "minimum_fare": 10, "active": True,
            },
        )

        # 4. REAL PASSENGERS
        for phone, first, last in [
            ("0821111111", "Sibusiso", "Dlamini"),
            ("0821111112", "Thandi",   "Mkhize"),
            ("0821111113", "Sipho",    "Nkosi"),
        ]:
            u = self._upsert_real_user(phone, None, first, last, "passenger")
            PassengerProfile.objects.update_or_create(
                user=u,
                defaults={"next_of_kin_name": "", "next_of_kin_phone": ""},
            )

        # 5. REAL DRIVERS
        real_drivers = {}
        for i, (phone, first, last, assoc) in enumerate([
            ("0830000001", "Bongani", "Mthembu",  "KDL001"),
            ("0830000002", "Sipho",   "Ndlovu",   "ESK001"),
            ("0830000003", "Thabo",   "Khumalo",  "EMP001"),
            ("0830000004", "Musa",    "Dube",     "RBY001"),
            ("0830000005", "Lucky",   "Mahlangu", "EMP001"),
            ("0830000006", "Peter",   "Ncube",    "EMP001"),
            ("0711111111", "Musa",    "Dube",     "EMP001"),
        ], start=1):
            u = self._upsert_real_user(phone, None, first, last, "driver")
            dp, _ = DriverProfile.objects.update_or_create(
                user=u,
                defaults={
                    "license_number": f"KZN-DRV-{i:03d}",
                    "status": DriverProfile.VerificationStatus.VERIFIED,
                    "association": codes.get(assoc),
                    "verified_at": timezone.now(),
                },
            )
            real_drivers[phone] = dp

        # 6. REAL OPERATORS
        real_operators = {}
        for phone, first, last, assoc, rank_names in [
            ("0820000003", "Nqobile", "Zondi",    "KDL001", ["Ongoye"]),
            ("0820000004", "Sipho",   "Ndlovu",   "ESK001", ["Esikhawini"]),
            ("0820000005", "Thabo",   "Khumalo",  "EMP001", ["Empangeni"]),
            ("0820000006", "Mjijimi", "Cele",     "RBY001", ["Richards Bay"]),
            ("0820000007", "Bheki",   "Mahlangu", "EMP001", ["Empangeni"]),
            ("0820000008", "Lindiwe", "Ncube",    "EMP001", ["Empangeni"]),
            ("0820000009", "Musa",    "Dube",     "EMP001", ["Empangeni"]),
            ("0820000010", "Mpho",    "Radebe",   "EMP001", ["Empangeni"]),
            ("0820000011", "Zanele",  "Mkhize",   "EMP001", ["Empangeni"]),
        ]:
            u = self._upsert_real_user(phone, None, first, last, "operator")
            op, _ = OperatorProfile.objects.update_or_create(
                user=u, defaults={"association": codes[assoc]},
            )
            for rn in rank_names:
                OperatorAtRank.objects.update_or_create(
                    operator=op, rank=ranks[rn],
                    defaults={"status": OperatorAtRank.Status.ACTIVE},
                )
            real_operators[phone] = op

        # 7. REAL ADMINS
        for phone, first, last, rank_name in [
            ("0700000001", "Sizwe",  "Nkosi",    "Ongoye"),
            ("0700000002", "Andile", "Mabaso",   "Esikhawini"),
            ("0700000003", "Lerato", "Molefe",   "Richards Bay"),
            ("0700000004", "Dumi",   "Cele",     "Empangeni"),
            ("0700000005", "Nandi",  "Zulu",     "Empangeni"),
            ("0700000006", "Pieter", "van Wyk",  "Empangeni"),
            ("0700000007", "Grace",  "Mthembu",  "Empangeni"),
        ]:
            u = self._upsert_real_user(phone, None, first, last, "admin")
            u.is_staff = True
            u.save(update_fields=["is_staff"])
            AdminProfile.objects.update_or_create(
                user=u,
                defaults={
                    "institution_name": "THEMBA Platform",
                    "rank": ranks.get(rank_name),
                },
            )

        # 8. DEMO ACCOUNTS
        demo_passenger = self._upsert_demo_user(
            "passenger_demo", "0700001001", "passenger@themba.local",
            "passenger", "Sibusiso", "Dlamini",
        )
        demo_driver_u = self._upsert_demo_user(
            "driver_demo", "0700001002", "driver@themba.local",
            "driver", "Bongani", "Mthembu",
        )
        demo_operator_u = self._upsert_demo_user(
            "operator_demo", "0700001003", "operator@themba.local",
            "operator", "Nqobile", "Zondi",
        )
        demo_admin_u = self._upsert_demo_user(
            "admin_demo", "0700001004", "admin@themba.local",
            "admin", "THEMBA", "Admin",
        )
        if demo_admin_u:
            demo_admin_u.is_staff = True
            demo_admin_u.save(update_fields=["is_staff"])

        if demo_passenger:
            PassengerProfile.objects.update_or_create(
                user=demo_passenger,
                defaults={"next_of_kin_name": "Thandi Dlamini",
                          "next_of_kin_phone": "0700002001"},
            )
        demo_dp = None
        if demo_driver_u:
            demo_dp, _ = DriverProfile.objects.update_or_create(
                user=demo_driver_u,
                defaults={
                    "license_number": "KZN-DRV-001",
                    "status": DriverProfile.VerificationStatus.VERIFIED,
                    "association": codes["KDL001"],
                    "verified_at": timezone.now(),
                },
            )
        demo_op = None
        if demo_operator_u:
            demo_op, _ = OperatorProfile.objects.update_or_create(
                user=demo_operator_u, defaults={"association": codes["KDL001"]},
            )
            for rn in ("Ongoye", "Empangeni", "Esikhawini", "Richards Bay"):
                OperatorAtRank.objects.update_or_create(
                    operator=demo_op, rank=ranks[rn],
                    defaults={"status": OperatorAtRank.Status.ACTIVE},
                )
        if demo_admin_u:
            AdminProfile.objects.update_or_create(
                user=demo_admin_u,
                defaults={"institution_name": "THEMBA Platform",
                          "rank": ranks["Ongoye"]},
            )

        # 9. Vehicles
        v1, _ = Vehicle.objects.update_or_create(
            plate_number="ND 123-456",
            defaults={"make": "Toyota", "model": "Quantum",
                      "seat_capacity": 15, "roadworthy": True,
                      "status": Vehicle.Status.QUEUED},
        )
        v2, _ = Vehicle.objects.update_or_create(
            plate_number="ND 345-678",
            defaults={"make": "Toyota", "model": "Quantum",
                      "seat_capacity": 15, "status": Vehicle.Status.QUEUED},
        )
        if demo_dp:
            DriverVehicle.objects.filter(driver=demo_dp, vehicle=v1).delete()
            DriverVehicle.objects.create(driver=demo_dp, vehicle=v1, active=True)

        # 10. Trips
        trip_operator = demo_op or next(iter(real_operators.values()), None)
        trip_driver = demo_dp or next(iter(real_drivers.values()), None)

        today = timezone.localdate()
        for code, route_code, t, vehicle, driver in [
            ("TRP-ONG-EMP-01", "TH-ONG-EMP", time(8, 30), v1, trip_driver),
            ("TRP-ONG-RB-01",  "TH-ONG-RB",  time(9, 0),  v2, None),
            ("TRP-RB-EMP-01",  "TH-RB-EMP",  time(10, 0), None, None),
        ]:
            Trip.objects.update_or_create(
                trip_code=code,
                defaults={
                    "operator": trip_operator,
                    "route": routes[route_code],
                    "departure_date": today,
                    "expected_departure_time": t,
                    "seat_capacity": 15,
                    "status": Trip.Status.SCHEDULED,
                    "vehicle": vehicle,
                    "driver": driver,
                },
            )
            Trip.objects.update_or_create(
                trip_code=code + "-TMR",
                defaults={
                    "operator": trip_operator,
                    "route": routes[route_code],
                    "departure_date": today + timedelta(days=1),
                    "expected_departure_time": t,
                    "seat_capacity": 15,
                    "status": Trip.Status.SCHEDULED,
                    "vehicle": vehicle,
                    "driver": driver,
                },
            )

        self.stdout.write(self.style.SUCCESS(
            f"Done. Routes={Route.objects.count()} "
            f"Trips={Trip.objects.count()} "
            f"Vehicles={Vehicle.objects.count()} "
            f"Users={User.objects.count()}"
        ))
        self.stdout.write("")
        self.stdout.write("REAL ACCOUNTS (password: Passw0rd!)")
        self.stdout.write("  Login with phone OR email — both work.")
        self.stdout.write("  Passengers:  0821111111 … 0821111113")
        self.stdout.write("  Drivers:     0830000001 … 0830000006, 0711111111")
        self.stdout.write("  Operators:   0820000003 … 0820000011")
        self.stdout.write("  Admins:      0700000001 … 0700000007")
        self.stdout.write("")
        self.stdout.write("DEMO ACCOUNTS (password: themba123)")
        self.stdout.write("  passenger_demo / driver_demo / operator_demo / admin_demo")
        self.stdout.write("  Or phone 0700001001…0700001004")
        self.stdout.write("  Or email *@themba.local")