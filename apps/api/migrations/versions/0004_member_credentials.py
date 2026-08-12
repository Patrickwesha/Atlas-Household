"""member credentials — the first real user auth

Revision ID: 0004
Revises: 0003
Create Date: slice 3, phase C

ONE NEW TABLE, ADDITIVE, NOTHING ELSE TOUCHED. No existing table gains a column
and no existing column changes type, so code that predates this migration keeps
working against a database that has it — which is what makes the deploy
reversible by promoting the previous build, with no migration to undo.

WHY A SEPARATE TABLE RATHER THAN COLUMNS ON `members`. A member is a face on the
wall; a credential is a way to log in, and only two of the five have one. Put
`password_hash` on `members` and every board query that does `select *` starts
carrying a hash around, one careless response model away from being serialised
to the kiosk. Nothing on the kiosk path joins this table at all.

`on delete restrict` for the same reason it is used everywhere else here: a
member with history must not be deletable, and that includes deleting them out
from under a live session.

EMAIL IS `text` WITH A UNIQUE INDEX ON `lower(email)`, NOT citext. citext needs
`create extension`, which can fail on a managed Postgres for reasons that have
nothing to do with this change — and a migration that dies on an extension at
the moment of shipping is a bad trade for a case-insensitive comparison we can
express with an index. Lookups must use `where lower(email) = lower(%s)` so they
hit that index.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        create table member_credentials (
            member_id     uuid        primary key references members (id) on delete restrict,

            email         text        not null,
            -- argon2id, encoded in argon2's own PHC string, which carries the
            -- parameters with it. Never a bare digest: rehashing later has to be
            -- able to read what the old cost settings were.
            password_hash text        not null,

            created_at    timestamptz not null default now(),
            updated_at    timestamptz not null default now()
        )
        """
    )
    # Case-insensitive uniqueness without the citext extension. Every lookup
    # must say `where lower(email) = lower(%s)` or it will not use this.
    op.execute(
        "create unique index member_credentials_lower_email_idx "
        "on member_credentials (lower(email))"
    )
    op.execute(
        """
        comment on table member_credentials is
            'Dashboard logins. Adults only — the role check lives in the API, because a CHECK constraint cannot reach members.role. Never joined by any kiosk query.'
        """
    )


def downgrade() -> None:
    op.execute("drop table member_credentials")
