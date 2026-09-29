from rest_framework import serializers
from django.contrib.auth import get_user_model

from .models import (
    User,
    DriverProfile,
    OperatorProfile,
    PassengerProfile,
    RankCode,
)


class UserPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "phone", "email", "role", "first_name", "last_name"]


class LoginSerializer(serializers.Serializer):
    """Accept phone, email, or username + password."""

    username = serializers.CharField(required=False, allow_blank=True)
    phone = serializers.CharField(required=False, allow_blank=True)
    email = serializers.EmailField(required=False, allow_blank=True)
    password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        ident = (
            (attrs.get("username") or "").strip()
            or (attrs.get("phone") or "").strip()
            or (attrs.get("email") or "").strip()
        )
        if not ident:
            raise serializers.ValidationError("Provide username, phone, or email.")
        attrs["ident"] = ident
        return attrs


# ------------------------------------------------------------------
# Registration serializers
# ------------------------------------------------------------------


class PassengerRegisterSerializer(serializers.Serializer):
    first_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=15)
    email = serializers.EmailField(required=False, allow_blank=True)
    password = serializers.CharField(write_only=True, min_length=6)

    next_of_kin_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    next_of_kin_phone = serializers.CharField(max_length=15, required=False, allow_blank=True)
    second_next_of_kin_name = serializers.CharField(
        max_length=150, required=False, allow_blank=True
    )
    second_next_of_kin_phone = serializers.CharField(
        max_length=15, required=False, allow_blank=True
    )

    def validate_phone(self, value):
        phone = (value or "").strip()
        if not phone:
            raise serializers.ValidationError("Phone number is required.")
        if User.objects.filter(phone=phone).exists():
            raise serializers.ValidationError("That phone number is already registered.")
        return phone

    def validate_email(self, value):
        email = (value or "").strip().lower()
        if email and User.objects.filter(email__iexact=email).exists():
            raise serializers.ValidationError("That email is already registered.")
        return email


class DriverRegisterSerializer(serializers.Serializer):
    first_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=15)
    email = serializers.EmailField(required=False, allow_blank=True)
    password = serializers.CharField(write_only=True, min_length=6)
    license_number = serializers.CharField(max_length=30, required=False, allow_blank=True)
    id_number = serializers.CharField(max_length=13, required=False, allow_blank=True)
    rank_code = serializers.CharField(max_length=20, required=False, allow_blank=True)

    def validate_phone(self, value):
        phone = (value or "").strip()
        if not phone:
            raise serializers.ValidationError("Phone number is required.")
        if User.objects.filter(phone=phone).exists():
            raise serializers.ValidationError("That phone number is already registered.")
        return phone

    def validate_email(self, value):
        email = (value or "").strip().lower()
        if email and User.objects.filter(email__iexact=email).exists():
            raise serializers.ValidationError("That email is already registered.")
        return email


class OperatorRegisterSerializer(serializers.Serializer):
    first_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=15)
    email = serializers.EmailField(required=False, allow_blank=True)
    password = serializers.CharField(write_only=True, min_length=6)
    rank_code = serializers.CharField(max_length=20)

    def validate_phone(self, value):
        phone = (value or "").strip()
        if not phone:
            raise serializers.ValidationError("Phone number is required.")
        if User.objects.filter(phone=phone).exists():
            raise serializers.ValidationError("That phone number is already registered.")
        return phone

    def validate_email(self, value):
        email = (value or "").strip().lower()
        if email and User.objects.filter(email__iexact=email).exists():
            raise serializers.ValidationError("That email is already registered.")
        return email

    def validate_rank_code(self, value):
        code = (value or "").strip().upper()
        if not code:
            raise serializers.ValidationError("Association rank code is required.")
        if not RankCode.objects.filter(code__iexact=code, is_active=True).exists():
            raise serializers.ValidationError(
                "That rank code is not recognised. Contact your association."
            )
        return code
