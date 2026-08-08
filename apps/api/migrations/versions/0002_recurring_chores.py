"""recurring chores — definitions, assignments, and the columns Phase 2 needs

Revision ID: 0002
Revises: 0001
Create Date: slice 2, phase 1

Chores stop being rows someone types into seed.json and become DEFINITIONS with
ASSIGNMENTS. One definition per real-world chore; the assignment rows carry
who-on-which-day. "Kitchen reset" is ONE definition assigned to one adult
Mon/Wed/Fri and the other Tue/Thu/Sat — not two definitions. Splitting it means
maintaining the same chore twice, and the day the two copies diverge is the day
the arguing restarts, which is the problem this system exists to end.

There is no rotation concept here, and there is nowhere to put one. That is the
design, not an omission.

cutoff_time and cutoff_at are added NOW and read by NOTHING in Phase 1. They are
here so Phase 2 (cutoff alerts) is not a third migration against a live family
database. Same for sort_order, which Phase 3 will use for board ordering.

Why cutoff_time is a `time` and cutoff_at is a `timestamptz`: cutoff_time is a
wall-clock RULE ("by 7pm"), the thing a person writes down once. cutoff_at is
that rule RESOLVED for one instance — cutoff_time + due_on + the household's
timezone. Storing the rule as a timestamp would drift by an hour twice a year,
every year, on the two mornings nobody would think to check.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        create table chore_definitions (
            id            uuid        primary key default gen_random_uuid(),
            household_id  uuid        not null references households (id) on delete cascade,

            name          text        not null,   -- snapshotted onto each instance's title
            area          text,                   -- "Kitchen", "Upstairs bath" — grouping only

            -- DESCRIPTIVE ONLY. The schedule lives entirely in chore_assignments;
            -- the materializer never reads this column. It is here so an admin UI
            -- can group and label, and it is constrained so it cannot quietly
            -- become a second, disagreeing schedule.
            cadence       text        not null check (cadence in ('daily', 'weekly')),

            -- Phase 2. A wall-clock rule ("by 7pm"), not a timestamp. Nothing
            -- reads this in Phase 1.
            cutoff_time   time,

            -- Phase 3 (board ordering). Nothing reads this in Phase 1 — the board
            -- still orders by title, because rows moving on the wall is its own
            -- kind of bug.
            sort_order    int         not null default 0,

            -- Retirement path. Deleting a definition with history is REFUSED (see
            -- the restrict FKs below); this is how a chore stops happening.
            is_active     boolean     not null default true,

            created_at    timestamptz not null default now()
        )
        """
    )
    # The materializer's lookup: this household's live definitions.
    op.execute("create index on chore_definitions (household_id, is_active)")

    op.execute(
        """
        create table chore_assignments (
            id             uuid        primary key default gen_random_uuid(),

            -- RESTRICT on both, matching chore_instances.assignee_id in 0001:
            -- deleting a definition or a member that has history must be refused,
            -- never allowed to silently rewrite it. Use is_active instead.
            definition_id  uuid        not null references chore_definitions (id) on delete restrict,
            member_id      uuid        not null references members (id) on delete restrict,

            day_of_week    smallint    not null check (day_of_week between 0 and 6),

            created_at     timestamptz not null default now(),

            -- The natural key. Also means the seeder needs no fixed UUIDs for
            -- assignment rows: on conflict do nothing on these three is enough.
            unique (definition_id, member_id, day_of_week)
        )
        """
    )
    # The materializer filters on this every night.
    op.execute("create index on chore_assignments (day_of_week)")

    # THE TRAP THIS COMMENT EXISTS TO PREVENT: Postgres extract(dow) is 0=SUNDAY.
    # Python's date.weekday() is 0=MONDAY. The materializer is Python and uses
    # weekday() directly, so 0=Monday is the convention here. Anyone who later
    # writes `extract(dow from ...)` against this column will be wrong by a day
    # for six days out of seven, which is exactly the kind of bug that looks like
    # "the kids didn't do their chores".
    op.execute(
        """
        comment on column chore_assignments.day_of_week is
            '0=Monday .. 6=Sunday (Python date.weekday()). NOT Postgres extract(dow), which is 0=Sunday.'
        """
    )

    # Both nullable, so every row seeded in slice 1 survives untouched.
    op.execute(
        """
        alter table chore_instances
            add column definition_id uuid references chore_definitions (id) on delete restrict,
            add column cutoff_at     timestamptz
        """
    )
    op.execute(
        """
        comment on column chore_instances.cutoff_at is
            'Phase 2. Resolved per instance from the definition''s cutoff_time + due_on + household timezone. Nothing writes this in Phase 1.'
        """
    )

    # What makes the materializer idempotent: re-running a day inserts nothing.
    #
    # Plain, not partial, and that is load-bearing. Postgres treats NULLs as
    # DISTINCT in a unique index, so every slice-1 row (definition_id null) falls
    # outside this constraint entirely and can neither collide with a materialized
    # row nor be blocked by one. "Existing rows must survive" is satisfied by the
    # NULL semantics, not by an exception carved out for them.
    op.execute(
        "create unique index on chore_instances (definition_id, assignee_id, due_on)"
    )


def downgrade() -> None:
    op.execute("drop index chore_instances_definition_id_assignee_id_due_on_idx")
    op.execute("alter table chore_instances drop column cutoff_at")
    op.execute("alter table chore_instances drop column definition_id")
    op.execute("drop table chore_assignments")
    op.execute("drop table chore_definitions")
