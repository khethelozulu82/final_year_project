from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/fleet/$", consumers.FleetTrackingConsumer.as_asgi()),
    re_path(r"ws/trips/(?P<trip_id>\d+)/$", consumers.TripTrackingConsumer.as_asgi()),
]