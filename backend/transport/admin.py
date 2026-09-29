from django.contrib import admin
from . import models

for m in [
    models.Rank,
    models.Destination,
    models.OperatorAtRank,
    models.Route,
    models.RouteStop,
    models.Vehicle,
    models.DriverVehicle,
    models.VehicleLocation,
    models.Trip,
    models.Booking,
    models.VerificationCode,
    models.TripFlag,
    models.TripAssetChange,
    models.TaxiFareRule,
    models.PanicAlert,
    models.RideRequest,
    models.PassengerNotification,
]:
    admin.site.register(m)
