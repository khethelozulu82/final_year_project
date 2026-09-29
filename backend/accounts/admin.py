from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import (
    User,
    PassengerProfile,
    DriverProfile,
    OperatorProfile,
    AdminProfile,
    RankCode,
)


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ("username", "phone", "email", "role", "is_staff")
    list_filter = ("role", "is_staff")
    fieldsets = BaseUserAdmin.fieldsets + (
        ("THEMBA", {"fields": ("role", "phone")}),
    )
    add_fieldsets = BaseUserAdmin.add_fieldsets + (
        ("THEMBA", {"fields": ("role", "phone", "email")}),
    )


admin.site.register(PassengerProfile)
admin.site.register(DriverProfile)
admin.site.register(OperatorProfile)
admin.site.register(AdminProfile)
admin.site.register(RankCode)
