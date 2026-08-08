"""Environment plumbing shared by the out-of-band scripts, in one place.

Two things were being copy-pasted: the repo `.env` loader (app/config.py,
migrations/apply.py, seed.py) and the DIRECT_URL + "refuse the pooler" guard
(migrations/apply.py, seed.py). Slice 2 adds two more callers — the Alembic
env.py and the materializer CLI — so a fourth and fifth copy of a guard that
protects the database is exactly the wrong direction.

Deliberately dependency-free (no python-dotenv). It is a few dozen lines, and
the API's runtime dependency list is something this repo keeps short on purpose.
"""

from __future__ import annotations

import os
from pathlib import Path

# apps/api/app/envfile.py -> apps/api -> apps -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]


def load_env_file(path: Path) -> None:
    """Load KEY=VALUE pairs from `path` into os.environ, never overriding a
    variable that is already set. A missing file is a no-op — on Vercel the
    platform provides the variables and there is no .env to read."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)          # split once: URLs contain '='
        os.environ.setdefault(key.strip(), value.strip())


class DirectUrlError(RuntimeError):
    """DIRECT_URL is missing or points somewhere it must not."""


def resolve_direct_url() -> str:
    """The DIRECT (non-pooled) Neon endpoint, for migrations and seeds only.

    Loads the repo .env first, so a script run from apps/api picks it up without
    every script re-implementing that. Raises DirectUrlError with a message
    written for a human at a terminal.

    The "-pooler" refusal is the important half. DDL and session-scoped work must
    not run through Neon's transaction pooler (PgBouncer): the same client
    connection can land on a different server session between statements, which
    breaks advisory locks, session settings, and Alembic's own transaction. The
    server (app/db.py) is the only thing that talks to the POOLED endpoint.
    """
    load_env_file(REPO_ROOT / ".env")
    direct_url = os.environ.get("DIRECT_URL", "").strip()
    if not direct_url:
        raise DirectUrlError(
            "DIRECT_URL is not set (checked the environment and the repo .env)."
        )
    if "-pooler" in direct_url:
        raise DirectUrlError(
            "DIRECT_URL points at the POOLED host ('-pooler'). Refusing to run "
            "session-scoped work through Neon's pooler — use the direct endpoint."
        )
    return direct_url
