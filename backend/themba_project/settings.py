"""
THEMBA host settings — LAN testing + production-ready.

- DEBUG: CORS open in dev, restricted in prod
- ALLOWED_HOSTS: comma-separated, or '*' in dev
- SQLite by default; PostgreSQL via DATABASE_URL (dj-database-url)
- WhiteNoise for static files in production
- Channels: in-memory if no REDIS_URL (single process); Redis for multi-process
- HTTPS proxy headers honoured when behind Railway/Render/Vercel
"""
import os
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "themba-dev-insecure-change-me")
DEBUG = os.getenv("DJANGO_DEBUG", "True").lower() in ("1", "true", "yes")

_hosts = os.getenv("DJANGO_ALLOWED_HOSTS", "*").strip()
ALLOWED_HOSTS = [h.strip() for h in _hosts.split(",") if h.strip()] or ["*"]

# When True (Railway/Render/Vercel), trust proxy headers so Django knows the
# request came over HTTPS and can build correct absolute URLs.
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    USE_X_FORWARDED_HOST = True
    SECURE_SSL_REDIRECT = False  # proxy already redirects; avoid loops


# ---------------------------------------------------------------------------
# Apps
# ---------------------------------------------------------------------------
INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework.authtoken",
    "corsheaders",
    "channels",
    "accounts",
    "transport",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "themba_project.urls"
ASGI_APPLICATION = "themba_project.asgi.application"
WSGI_APPLICATION = "themba_project.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]


# ---------------------------------------------------------------------------
# Database
#
# Priority:
#   1. DATABASE_URL (Postgres or any URL dj-database-url understands)
#   2. SQLite fallback for local dev
# ---------------------------------------------------------------------------
_database_url = os.getenv("DATABASE_URL", "").strip()

if _database_url:
    DATABASES = {
        "default": dj_database_url.parse(
            _database_url,
            conn_max_age=600,
            conn_health_checks=True,
            ssl_require=_database_url.startswith("postgres") and not DEBUG,
        )
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
AUTH_USER_MODEL = "accounts.User"
AUTHENTICATION_BACKENDS = [
    "accounts.auth_backend.PhoneOrEmailBackend",
    "django.contrib.auth.backends.ModelBackend",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
]

LANGUAGE_CODE = "en-za"
TIME_ZONE = "Africa/Johannesburg"
USE_I18N = True
USE_TZ = True


# ---------------------------------------------------------------------------
# Static files
#
# - STATIC_ROOT: where `collectstatic` puts everything for the web server
# - WhiteNoise: serves those files straight from Daphne, no nginx needed
# ---------------------------------------------------------------------------
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"


# ---------------------------------------------------------------------------
# CORS
#
# - In dev (DEBUG=True) with no CORS_ALLOWED_ORIGINS set → allow all
# - In prod → must set CORS_ALLOWED_ORIGINS explicitly
# ---------------------------------------------------------------------------
_cors = os.getenv("CORS_ALLOWED_ORIGINS", "").strip()
if DEBUG and not _cors:
    CORS_ALLOW_ALL_ORIGINS = True
else:
    CORS_ALLOW_ALL_ORIGINS = False
    CORS_ALLOWED_ORIGINS = [o.strip() for o in _cors.split(",") if o.strip()]

CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_HEADERS = [
    "accept",
    "authorization",
    "content-type",
    "origin",
    "user-agent",
    "x-csrftoken",
    "x-requested-with",
]


# ---------------------------------------------------------------------------
# DRF
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.TokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticatedOrReadOnly",
    ],
}


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------
_redis = os.getenv("REDIS_URL", "").strip()
if _redis:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [_redis]},
        }
    }
else:
    CHANNEL_LAYERS = {
        "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}
    }


# ---------------------------------------------------------------------------
# Routing / tracking
# ---------------------------------------------------------------------------
ORS_API_KEY = os.getenv("ORS_API_KEY", "")
ROUTING_SERVICE_URL = os.getenv(
    "ROUTING_SERVICE_URL", "https://router.project-osrm.org"
)
DEFAULT_ROUTE_DEVIATION_THRESHOLD_M = float(
    os.getenv("DEFAULT_ROUTE_DEVIATION_THRESHOLD_M", "150")
)