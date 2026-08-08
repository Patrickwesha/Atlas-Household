"""Alembic environment.

Two deliberate departures from the stock template:

1. NO AUTOGENERATE. This project has no SQLAlchemy models — the API talks to
   Postgres through psycopg with hand-written SQL (app/db.py, app/routes.py) —
   and none are being added just to feed Alembic. `target_metadata` is therefore
   None and `alembic revision --autogenerate` would emit an empty migration or,
   worse, propose dropping every table it cannot see. Every revision in
   versions/ is written by hand. Create them with:

       alembic revision -m "what it does"

2. NO sqlalchemy.url IN alembic.ini. The connection comes from DIRECT_URL, and a
   "-pooler" host is REFUSED (see app/envfile.resolve_direct_url). DDL must not
   run through Neon's transaction pooler: the same client connection can land on
   a different server session between statements, which breaks Alembic's own
   transaction and its version-table locking. The pooled DATABASE_URL belongs to
   the running API and to nothing else. This also keeps a connection string out
   of a file in a PUBLIC repo.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool
from sqlalchemy.engine import make_url

from app.envfile import resolve_direct_url

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# See note 1 above. Hand-written revisions only.
target_metadata = None


def _migration_url() -> str:
    """DIRECT_URL, pointed at psycopg3.

    Two adjustments to the raw connection string, both necessary:

    - SQLAlchemy maps a bare `postgresql://` to **psycopg2**, which this project
      does not install and never will — the API talks to Postgres through
      psycopg3 (app/db.py). Forcing `postgresql+psycopg` means Alembic applies
      DDL through the exact same driver the running application uses, rather
      than a second one installed only for migrations.
    - Neon hands out `postgres://` in some places and `postgresql://` in others.
      make_url() normalises both.

    The URL is NOT written back into alembic.ini via set_main_option(). That path
    runs through ConfigParser, which treats `%` as interpolation syntax — and a
    generated database password containing a percent-encoded byte would blow up
    with a stack trace about "invalid interpolation" that names nothing useful.
    """
    return str(make_url(resolve_direct_url()).set(drivername="postgresql+psycopg"))


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of running it (`alembic upgrade head --sql`).

    Useful for reading exactly what would be applied to Neon before applying it.
    """
    context.configure(
        url=_migration_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations against a live connection."""
    connectable = create_engine(_migration_url(), poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
