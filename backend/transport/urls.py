from django.urls import path
from . import views

urlpatterns = [
    # Public
    path("ranks/", views.api_list_ranks),
    path("destinations/", views.api_list_destinations),
    path("routes/", views.api_list_routes),
    path("trips/", views.api_list_trips),
    path("trips/<int:trip_id>/", views.api_trip_detail),
    path("trips/<int:trip_id>/live/", views.api_trip_live_tracking),

    # Passenger
    path("bookings/", views.api_create_booking),
    path("bookings/mine/", views.api_my_bookings),
    path("bookings/verify-code/", views.api_redeem_verification_code),

    # Passenger — complaint / rating review / history
    path(
        "passenger/trips/<int:trip_id>/file-complaint/",
        views.api_passenger_file_complaint,
    ),
    path(
        "passenger/trips/<int:trip_id>/review-status/",
        views.api_passenger_trip_review_status,
    ),
    path("passenger/history/", views.api_passenger_history),

    path("passenger/announcements/", views.api_passenger_announcements),
    path("passenger/notifications/", views.api_my_passenger_notifications),
    path(
        "passenger/notifications/<int:notification_id>/read/",
        views.api_passenger_notification_read,
    ),

    # Operator
    path("my-trips/", views.api_my_trips),
    path("my-memberships/", views.api_my_memberships),
    path("request-rank/", views.api_request_rank),
    path("my-trips/<int:trip_id>/manifest/", views.api_trip_manifest),
    path("my-trips/<int:trip_id>/walk-in/", views.api_register_walk_in),
    path("my-trips/<int:trip_id>/engage/", views.api_engage_trip),
    path("my-trips/<int:trip_id>/release/", views.api_release_trip),
    path("my-trips/<int:trip_id>/cancel/", views.api_cancel_trip),
    path("my-trips/<int:trip_id>/flag/", views.api_flag_trip),
    path(
        "my-trips/<int:trip_id>/bookings/<int:booking_id>/verify/",
        views.api_verify_booking,
    ),

    # Driver / GPS
    path("vehicles/mine/", views.api_my_vehicle),
    path("vehicles/<int:vehicle_id>/location/", views.api_vehicle_location),
    path("vehicles/<int:vehicle_id>/location/latest/", views.api_vehicle_latest_location),
    path("fleet/", views.api_fleet_snapshot),

    # Driver-specific
    path("driver/trips/", views.api_driver_my_trips),
    path("driver/confirm-trip/", views.api_driver_confirm_trip),
    path("driver/profile/", views.api_driver_profile),
    path("driver/notifications/<int:notification_id>/read/", views.api_driver_notification_read),
    path("driver/notifications/read-all/", views.api_driver_notifications_read_all),

    # Routing
    path("routing/directions/", views.api_ad_hoc_directions),
    path("routing/calculate/", views.api_calculate_route_fare),

    # Panic
    path("panic-alerts/", views.api_panic_alert),

    # Admin
    path("admin/summary/", views.api_admin_summary),
    path("admin/users/", views.api_admin_users),
    path("admin/users/<int:user_id>/set-active/", views.api_admin_user_set_active),
    path("admin/memberships/", views.api_admin_memberships),
    path("admin/memberships/<int:membership_id>/decide/", views.api_admin_membership_decide),
    path("admin/flags/", views.api_admin_flags),
    path("admin/panics/", views.api_admin_panics),
    path("admin/drivers/", views.api_admin_drivers),
    path("admin/drivers/<int:driver_id>/verify/", views.api_admin_driver_verify),

    path("admin/trip-options/", views.api_admin_trip_options),
    path("admin/trips/", views.api_admin_trip_queue),
    path("admin/trips/schedule/", views.api_admin_schedule_trip),
    path("admin/trips/<int:trip_id>/", views.api_admin_trip_detail),

    path("admin/overview/", views.api_admin_overview),
    path("admin/announcements/", views.api_admin_announcements),
    path("admin/announcements/<int:ann_id>/", views.api_admin_announcement_detail),
    path("admin/complaints/", views.api_admin_complaints),
    path("admin/complaints/<int:complaint_id>/escalate/", views.api_escalate_complaint),
    path("admin/complaints/<int:complaint_id>/review/", views.api_admin_complaint_review),
    path("admin/safety/", views.api_admin_safety),
    path("admin/safety/<int:incident_id>/decide/", views.api_admin_safety_decide),
    path("admin/panics/live/", views.api_admin_panics_live),
    path("admin/trips/simulate/", views.api_admin_simulate_trip),
    path("history/", views.api_history),
    path("ratings/", views.api_rate_driver),
    path("drivers/<int:driver_id>/rating/", views.api_driver_rating_summary),

    path("ride-requests/", views.api_create_ride_request),
    path("ride-requests/<int:request_id>/", views.api_ride_request_detail),
    path("ride-requests/<int:request_id>/accept/", views.api_accept_ride_request),
    path("ride-requests/<int:request_id>/reject/", views.api_reject_ride_request),

    # Operator-facing announcement aliases
    path("announcements/", views.api_admin_announcements),
    path("announcements/<int:ann_id>/", views.api_admin_announcement_detail),

    path("operator/dashboard/", views.api_operator_dashboard),
    path("operator/drivers/", views.api_operator_drivers),
    path("operator/complaints/", views.api_operator_complaints),
    path("operator/panics/", views.api_operator_panics),
    path("my-trips/<int:trip_id>/confirm/", views.api_operator_confirm_trip),
    path("my-trips/<int:trip_id>/verify-assets/", views.api_operator_verify_assets),
]