"""Environment configuration.

Loads the repo `.env` in local dev (a no-op on Vercel, where the platform
provides the variables; `setdefault` means a real env var always wins). Every
value here is server-side — only VITE_ vars are ever public.
"""

from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

_REPO_ROOT = Path(__file__).resolve().parents[3]   # apps/api/app/config.py -> repo root


def _load_env_file(path: Path) -> None:
    """Minimal KEY=VALUE loader. Never overrides a var already in the environment."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)               # split once: URLs contain '='
        os.environ.setdefault(key.strip(), value.strip())


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name!r} is not set")
    return value


_load_env_file(_REPO_ROOT / ".env")

# Server talks to the POOLED endpoint. DIRECT_URL is for migrations/seed only.
DATABASE_URL: str = _require("DATABASE_URL")
DEVICE_TOKEN: str = _require("DEVICE_TOKEN")
# Parsed to UUID here so a malformed value fails fast at startup, and so queries
# pass a real uuid param (not text) to Postgres.
HOUSEHOLD_ID: UUID = UUID(_require("HOUSEHOLD_ID"))
APP_TIMEZONE: str = os.environ.get("APP_TIMEZONE", "America/Chicago")
ALLOWED_ORIGINS: list[str] = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
]
