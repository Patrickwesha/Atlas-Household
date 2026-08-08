"""initial schema — households, members, chore_instances

Revision ID: 0001
Revises:
Create Date: slice 1

THIS REVISION IS STAMPED AGAINST NEON, NOT RUN.

migrations/0001_init.sql was applied by hand before Alembic existed in this
project, so the version table had to be started in sync:

    alembic stamp 0001

It exists for two reasons anyway: the version graph needs an honest root, and a
scratch database built from `alembic upgrade head` alone must come out identical
to production's starting point.

The upgrade below is a VERBATIM transcription of migrations/0001_init.sql, minus
its own `begin;` / `commit;` (Alembic owns the transaction). It is deliberately
raw SQL rather than op.create_table(): op.create_table() would need explicit
index and constraint names, and the .sql relies on Postgres's auto-generated
ones. Reproducing the same names matters — the point of this file is that the
two paths produce byte-identical schemas, which is checked by
verify_materializer.py's schema-equivalence step (pg_dump --schema-only, diffed).

If you change this file, you have broken that equivalence. Don't. Write a new
revision instead.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        create table households (
            id          uuid        primary key default gen_random_uuid(),
            name        text        not null,
            created_at  timestamptz not null default now()
        )
        """
    )
    op.execute(
        """
        create table members (
            id            uuid        primary key default gen_random_uuid(),
            household_id  uuid        not null references households (id) on delete cascade,
            name          text        not null,
            role          text        not null check (role in ('adult', 'kid', 'dependent')),
            color         text        not null,                       -- tile color (hex)
            created_at    timestamptz not null default now()
        )
        """
    )
    op.execute(
        """
        create table chore_instances (
            id            uuid        primary key default gen_random_uuid(),
            household_id  uuid        not null references households (id) on delete cascade,

            -- Whose chore. RESTRICT, not CASCADE: deleting a member must be refused,
            -- never allowed to silently take their chore history with it. Deactivation
            -- (a future is_active flag) is the right way to retire a person, not delete.
            assignee_id   uuid        not null references members (id) on delete restrict,

            title         text        not null,   -- chore text, denormalized (no chore_definitions this slice)
            due_on        date        not null,   -- the day this instance is "for"

            -- NULL = not done. "missed" stays derivable: due_on < today and completed_at is null.
            completed_at  timestamptz,

            -- Who tapped complete. Left non-cascading on purpose: same protection as
            -- assignee_id — a member with recorded completions can't be hard-deleted.
            completed_by  uuid        references members (id),

            created_at    timestamptz not null default now()
        )
        """
    )
    # The board's only query: today's instances for a household.
    op.execute("create index on chore_instances (household_id, due_on)")


def downgrade() -> None:
    op.execute("drop table chore_instances")
    op.execute("drop table members")
    op.execute("drop table households")
