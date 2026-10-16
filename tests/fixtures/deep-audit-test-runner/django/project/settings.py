SECRET_KEY = "fixture-only"
INSTALLED_APPS = ["django.contrib.contenttypes", "app"]
DEFAULT_AUTO_FIELD = "django.db.models.AutoField"
USE_TZ = True
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "production_fixture",
        "USER": "fixture_only",
        "PASSWORD": "not-a-real-secret",
        "HOST": "production.example.invalid",
        "PORT": "5432",
    }
}
