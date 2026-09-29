from django.contrib.auth import authenticate, get_user_model
from django.db import transaction
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .models import (
    DriverProfile,
    OperatorProfile,
    PassengerProfile,
    RankCode,
)
from .serializers import (
    LoginSerializer,
    UserPublicSerializer,
    PassengerRegisterSerializer,
    DriverRegisterSerializer,
    OperatorRegisterSerializer,
)


# ---------- Auth ----------


@api_view(["POST"])
@permission_classes([AllowAny])
def login_view(request):
    """
    POST /api/auth/login/
    Body: { "username"|"phone"|"email": "...", "password": "..." }
    """
    ser = LoginSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    ident = ser.validated_data["ident"]
    password = ser.validated_data["password"]
    user = authenticate(request, username=ident, password=password)
    if user is None:
        return Response(
            {"detail": "Invalid credentials. Use phone, email, or username."},
            status=status.HTTP_401_UNAUTHORIZED,
        )
    if not user.is_active:
        return Response(
            {"detail": "Your account is not active yet."},
            status=status.HTTP_403_FORBIDDEN,
        )
    token, _ = Token.objects.get_or_create(user=user)
    return Response(
        {
            "token": token.key,
            "user": UserPublicSerializer(user).data,
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def me_view(request):
    return Response(UserPublicSerializer(request.user).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_view(request):
    Token.objects.filter(user=request.user).delete()
    return Response({"detail": "Logged out."})


# ---------- Registration ----------


@api_view(["POST"])
@permission_classes([AllowAny])
def register_passenger(request):
    """
    POST /api/auth/register/passenger/
    """
    ser = PassengerRegisterSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    v = ser.validated_data
    User = get_user_model()

    with transaction.atomic():
        user = User.objects.create_user(
            phone=v["phone"],
            email=(v.get("email") or "").strip().lower(),
            password=v["password"],
            first_name=(v.get("first_name") or "").strip(),
            last_name=(v.get("last_name") or "").strip(),
            role="passenger",
            is_active=True,
        )

        PassengerProfile.objects.create(
            user=user,
            next_of_kin_name=(v.get("next_of_kin_name") or "").strip(),
            next_of_kin_phone=(v.get("next_of_kin_phone") or "").strip(),
            second_next_of_kin_name=(v.get("second_next_of_kin_name") or "").strip(),
            second_next_of_kin_phone=(v.get("second_next_of_kin_phone") or "").strip(),
        )

    token, _ = Token.objects.get_or_create(user=user)
    return Response(
        {"token": token.key, "user": UserPublicSerializer(user).data},
        status=201,
    )


@api_view(["POST"])
@permission_classes([AllowAny])
def register_driver(request):
    """
    POST /api/auth/register/driver/
    """
    ser = DriverRegisterSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    v = ser.validated_data
    User = get_user_model()

    with transaction.atomic():
        user = User.objects.create_user(
            phone=v["phone"],
            email=(v.get("email") or "").strip().lower(),
            password=v["password"],
            first_name=(v.get("first_name") or "").strip(),
            last_name=(v.get("last_name") or "").strip(),
            role="driver",
            is_active=True,
        )

        association = None
        code = (v.get("rank_code") or "").strip().upper()
        if code:
            association = RankCode.objects.filter(code__iexact=code).first()

        DriverProfile.objects.create(
            user=user,
            license_number=(v.get("license_number") or "").strip(),
            id_number=(v.get("id_number") or "").strip(),
            association=association,
            status=DriverProfile.VerificationStatus.PENDING,
        )

    token, _ = Token.objects.get_or_create(user=user)
    return Response(
        {"token": token.key, "user": UserPublicSerializer(user).data},
        status=201,
    )


@api_view(["POST"])
@permission_classes([AllowAny])
def register_operator(request):
    """
    POST /api/auth/register/operator/
    """
    ser = OperatorRegisterSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    v = ser.validated_data
    User = get_user_model()

    with transaction.atomic():
        user = User.objects.create_user(
            phone=v["phone"],
            email=(v.get("email") or "").strip().lower(),
            password=v["password"],
            first_name=(v.get("first_name") or "").strip(),
            last_name=(v.get("last_name") or "").strip(),
            role="operator",
            is_active=True,
        )

        code = (v.get("rank_code") or "").strip().upper()
        association = RankCode.objects.get(code__iexact=code)

        OperatorProfile.objects.create(user=user, association=association)

    token, _ = Token.objects.get_or_create(user=user)
    return Response(
        {"token": token.key, "user": UserPublicSerializer(user).data},
        status=201,
    )