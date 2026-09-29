"""
Authenticate with phone OR email (plus password).
Use alongside ModelBackend; set in AUTHENTICATION_BACKENDS.
"""
from django.contrib.auth.backends import ModelBackend
from django.contrib.auth import get_user_model
from django.db.models import Q


class PhoneOrEmailBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        User = get_user_model()
        if username is None:
            username = kwargs.get(User.USERNAME_FIELD)
        if not username or password is None:
            return None
        ident = username.strip()
        try:
            if "@" in ident:
                user = User.objects.get(email__iexact=ident)
            else:
                user = User.objects.filter(
                    Q(phone=ident) | Q(username=ident) | Q(email__iexact=ident)
                ).first()
                if user is None:
                    return None
        except User.DoesNotExist:
            return None
        if user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
