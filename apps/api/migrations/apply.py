"""
apply.py — apply the hand-written SQL migrations to Postgres.

RETIRED as of slice 2. It applied 0001_init.sql once, by hand, and that is the
only .sql file it will ever find: from 0002 onward Alembic owns migrations (see
apps/api/alembic.ini and migrations/versions/). Alembic's version table was
brought in sync with what this script did via `alembic stamp`, so running this
again against a live database is unnecessary, not dangerous — 0001_init.sql's
CREATE TABLEs would simply fail on a schema that already has them.

It stays in the tree because it is the record of how the initial schema actually
got applied, and because it is still the fastest way to stand up a scratch
database that provably matches production's starting point.

Reads DIRECT_URL (the non-pooled Neon endpoint) from the environment, falling
back to the repo-root .env. Each .sql file controls its own transaction
(begin/commit inside), applied in filename order.

Run from apps/api:
    uv run python migrations/apply.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent      # apps/api/migrations

# Running a script inside migrations/ puts migrations/ on sys.path, not apps/api,
# so `app` is not importable without this. seed.py and materialize.py live at the
# apps/api root and need no equivalent. Alembic's env.py gets the same effect from
# `prepend_sys_path = .` in alembic.ini.
sys.path.insert(0, str(MIGRATIONS_DIR.parent))

from app.envfile import DirectUrlError, resolve_direct_url  # noqa: E402


def main() -> int:
    try:
        direct_url = resolve_direct_url()
    except DirectUrlError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
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
