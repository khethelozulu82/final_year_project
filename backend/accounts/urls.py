from django.urls import path
from . import views

urlpatterns = [
    path("auth/login/", views.login_view, name="auth-login"),
    path("auth/logout/", views.logout_view, name="auth-logout"),
    path("auth/me/", views.me_view, name="auth-me"),

    path("auth/register/passenger/", views.register_passenger, name="register-passenger"),
    path("auth/register/driver/", views.register_driver, name="register-driver"),
    path("auth/register/operator/", views.register_operator, name="register-operator"),
]