from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path


def health(request):
    return JsonResponse(
        {
            "service": "THEMBA API",
            "status": "ok",
            "docs": {
                "auth": "POST /api/auth/login/",
                "trips": "GET /api/trips/",
                "routes": "GET /api/routes/",
                "my_trips": "GET /api/my-trips/",
                "routing": "POST /api/routing/directions/",
                "gps": "POST /api/vehicles/<id>/location/",
                "panic": "POST /api/panic-alerts/",
            },
        }
    )


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", health),
    path("api/", include("accounts.urls")),
    path("api/", include("transport.urls")),
]
