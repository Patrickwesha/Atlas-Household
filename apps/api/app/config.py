"""Environment configuration.

Loads the repo `.env` in local dev (a no-op on Vercel, where the platform
provides the variables; `setdefault` means a real env var always wins). Every
value here is server-side — only VITE_ vars are ever public.
"""

from __future__ import annotations

import os
from uuid import UUID

from .envfile import REPO_ROOT, load_env_file


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name!r} is not set")
    return value


load_env_file(REPO_ROOT / ".env")

# Server talks to the POOLED endpoint. DIRECT_URL is for migrations/seed only.
DATABASE_URL: str = _require("DATABASE_URL")
DEVICE_TOKEN: str = _require("DEVICE_TOKEN")
# Parsed to UUID here so a malformed value fails fast at startup, and so queries
# pass a real uuid param (not text) to Postgres.
HOUSEHOLD_ID: UUID = UUID(_require("HOUSEHOLD_ID"))
APP_TIMEZONE: str = os.environ.get("APP_TIMEZONE", "America/Chicago")
# The nightly materializer's shared secret. Vercel Cron sends it as
# `Authorization: Bearer <CRON_SECRET>` on every invocation.
#
# NOT _require()d, on purpose: this one variable must never be able to crash the
# whole API at import and take the kiosk down with it. Unset therefore means
# require_cron() denies EVERY request, including Vercel's — the failure shows up
# as a red cron run in the dashboard, never as an open write endpoint on a public
# URL. See app/auth.py.
CRON_SECRET: str | None = os.environ.get("CRON_SECRET") or None
ALLOWED_ORIGINS: list[str] = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
]
