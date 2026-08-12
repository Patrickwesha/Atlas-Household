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
# The late-chore summary's own bearer token, held by an iOS Shortcut. NOT
# _require()d, for the same reason as CRON_SECRET: one missing variable must
# never take the kiosk down with it. Unset means require_outstanding() denies
# every request — the endpoint reports who has not done what, so a
# misconfigured deploy has to fail closed. See app/auth.py.
OUTSTANDING_TOKEN: str | None = os.environ.get("OUTSTANDING_TOKEN") or None
# The dashboard's JWT signing key. NOT _require()d — same rule as the two above,
# and the rule is now explicit: only DATABASE_URL, DEVICE_TOKEN and HOUSEHOLD_ID
# may ever be _require()d, because those three are the board itself. Everything
# added after them fails closed, so one unset variable can never take the wall
# down. Unset here means current_adult denies every request and nobody can log
# in to the dashboard; the kiosk does not notice.
SESSION_SECRET: str | None = os.environ.get("SESSION_SECRET") or None
# How long a dashboard session lasts. Deliberately short: a parent may well log
# in ON the wall iPad, which the kids then use unattended. Paired with
# sessionStorage on the client, so closing the tab ends the session outright and
# this is only the ceiling for a tab left open.
SESSION_HOURS: int = 8
ALLOWED_ORIGINS: list[str] = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
]
