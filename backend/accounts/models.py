"""
THEMBA accounts — merged identity model.

Decisions applied:
- Demo credentials retained (password themba123; seeded role accounts).
- Login identity: phone OR email/Gmail (either may be used to sign in).
- Profiles and operator/rank association model from Final_Year_Project.
- Role set aligned with both systems (passenger / driver / operator / admin).
"""
from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models
from django.db.models import Q


class UserManager(BaseUserManager):
    """Create users with phone and/or email; at least one required for login."""

    def _normalize_phone(self, phone):
        if not phone:
            return ""
        return str(phone).strip()

    def create_user(self, phone=None, email=None, password=None, **extra_fields):
        phone = self._normalize_phone(phone)
        email = (email or "").strip().lower()
        if not phone and not email:
            raise ValueError("A phone number or email address is required.")

        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)

        # username kept unique for AbstractUser; prefer explicit username, then phone, else email
        username = extra_fields.pop("username", phone or email)
        user = self.model(
            phone=phone or None,
            email=email or "",
            username=username,
            **extra_fields,
        )
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, phone=None, email=None, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("role", User.Role.ADMIN)
        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")
        return self.create_user(phone=phone, email=email, password=password, **extra_fields)

    def get_by_natural_key(self, username):
        """
        Resolve login by phone OR email (case-insensitive for email).
        Supports themba-search-first style demos and FYP phone logins.
        """
        ident = (username or "").strip()
        if "@" in ident:
            return self.get(email__iexact=ident)
        # try phone first, then username fallback
        qs = self.filter(Q(phone=ident) | Q(username=ident))
        user = qs.first()
        if user is None:
            raise self.model.DoesNotExist(f"No user matching {ident!r}")
        return user


class User(AbstractUser):
    """
    Single auth user for all roles.
    Login with phone OR email; password for demo accounts: themba123.
    """

    class Role(models.TextChoices):
        PASSENGER = "passenger", "Passenger"
        DRIVER = "driver", "Driver"
        OPERATOR = "operator", "Operator"
        ADMIN = "admin", "Admin"

    role = models.CharField(
        max_length=20, choices=Role.choices, default=Role.PASSENGER
    )
    # Either field may be null if the other is set; uniqueness enforced when present
    phone = models.CharField(max_length=15, unique=True, null=True, blank=True)
    # email already on AbstractUser; ensure unique when used for login
    email = models.EmailField(blank=True, default="", unique=False)

    # Prefer phone for USERNAME_FIELD when present; auth backend also accepts email
    USERNAME_FIELD = "username"
    REQUIRED_FIELDS = []

    objects = UserManager()

    def __str__(self):
        return f"{self.phone or self.email or self.username} ({self.role})"


class PassengerProfile(models.Model):
    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="passenger_profile"
    )
    primary_route_hint = models.CharField(max_length=120, blank=True)
    next_of_kin_name = models.CharField(max_length=150)
    next_of_kin_phone = models.CharField(max_length=15)
    second_next_of_kin_name = models.CharField(max_length=150, blank=True)
    second_next_of_kin_phone = models.CharField(max_length=15, blank=True)

    def __str__(self):
        return f"Passenger: {self.user}"


class RankCode(models.Model):
    """Taxi association code. Operators register against this; not single-use."""

    code = models.CharField(max_length=20, unique=True)
    association_name = models.CharField(max_length=150)
    operating_region = models.CharField(max_length=150)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.code} — {self.association_name}"


class DriverProfile(models.Model):
    class VerificationStatus(models.TextChoices):
        PENDING = "pending", "Pending verification"
        VERIFIED = "verified", "Verified"
        REJECTED = "rejected", "Rejected"

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="driver_profile"
    )
    license_number = models.CharField(max_length=30)
    id_number = models.CharField(
        max_length=13, blank=True, help_text="SA ID for DoT registry lookup"
    )
    photo = models.ImageField(upload_to="driver_photos/", blank=True, null=True)
    association = models.ForeignKey(
        RankCode,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="driver_applications",
    )
    status = models.CharField(
        max_length=20,
        choices=VerificationStatus.choices,
        default=VerificationStatus.PENDING,
    )
    verified_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"Driver: {self.user} ({self.status})"


class OperatorProfile(models.Model):
    """FYP operator model — linked to a taxi association (RankCode)."""

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="operator_profile"
    )
    association = models.ForeignKey(
        RankCode, on_delete=models.PROTECT, related_name="operators"
    )

    def __str__(self):
        return f"Operator: {self.user} ({self.association.association_name})"


class AdminProfile(models.Model):
    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="admin_profile"
    )
    institution_name = models.CharField(max_length=150)
    rank = models.ForeignKey(
        "transport.Rank",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="admins",
    )

    def __str__(self):
        rank_label = self.rank.name if self.rank else "unassigned"
        return f"Admin: {self.user} ({self.institution_name}) @ {rank_label}"
