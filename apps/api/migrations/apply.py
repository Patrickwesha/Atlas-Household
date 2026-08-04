"""
apply.py — apply the hand-written SQL migrations to Postgres (slice 1).

Reads DIRECT_URL (the non-pooled Neon endpoint) from the environment, falling
back to the repo-root .env if it isn't already set. DDL must NOT run through
Neon's transaction pooler, so this refuses a "-pooler" host and never touches
DATABASE_URL. Each .sql file controls its own transaction (begin/commit inside),
applied in filename order. From 0002 onward Alembic owns migrations and this
script is retired.

Run from apps/api:
    uv run python migrations/apply.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent      # apps/api/migrations
REPO_ROOT = MIGRATIONS_DIR.parents[2]                 # .../Atlas-Household


def load_env_file(path: Path) -> None:
    """Tiny .env loader (KEY=VALUE per line). No dependency, and it never
    overrides a value already present in the real environment."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)               # split once: URLs contain '='
        os.environ.setdefault(key.strip(), value.strip())


def main() -> int:
    load_env_file(REPO_ROOT / ".env")

    direct_url = os.environ.get("DIRECT_URL", "").strip()
    if not direct_url:
        print("ERROR: DIRECT_URL is not set (checked the environment and repo .env).", file=sys.stderr)
        return 1
    if "-pooler" in direct_url:
        print("ERROR: DIRECT_URL points at the POOLED host ('-pooler'). Migrations must", file=sys.stderr)
        print("use the DIRECT endpoint — refusing to run DDL through Neon's pooler.", file=sys.stderr)
        return 1

    sql_files = sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if not sql_files:
        print("No migration files found.", file=sys.stderr)
        return 1

    print(f"Applying {len(sql_files)} migration(s) via the direct endpoint:")
    # autocommit=True: each .sql file's own begin/commit defines its transaction.
    with psycopg.connect(direct_url, autocommit=True) as conn:
        for path in sql_files:
            print(f"  - {path.name} ... ", end="", flush=True)
            conn.execute(path.read_text(encoding="utf-8"))
            print("done")

    print("All migrations applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
