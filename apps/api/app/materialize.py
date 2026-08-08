"""The nightly materializer: turn definitions + assignments into a day's chores.

Before this existed, seed.py was the only writer of chore_instances and the board
(scoped to due_on = today) went empty every morning until someone re-seeded by
hand. This is the thing that makes the wall fill itself.

WHAT IT DOES
Joins chore_definitions to chore_assignments on the target date's weekday and
inserts one chore_instance per (definition, member). Nothing else. It does not
delete, does not update, and does not touch a row it did not create.

WHAT IT DOES NOT DO
- It does not stamp anything "missed". `missed` stays what 0001_init.sql said it
  was: derivable as `due_on < today and completed_at is null`. A stored flag
  would be a second source of truth that can disagree with completed_at, it
  needs a nightly UPDATE across real history to maintain, and it goes ambiguous
  the moment someone completes yesterday's chore this morning.
- It does not write cutoff_at. That column belongs to Phase 2 and is deliberately
  left NULL here.
"""

from __future__ import annotations

from datetime import date
from uuid import UUID

import psycopg
from psycopg.rows import DictRow

# Inserted in ONE statement so the whole day is atomic without needing an
# explicit transaction, and so concurrency needs no lock: two callers racing
# (the 08:00 cron against the 11:00 one, or a cron against a board self-heal)
# both run this and the loser inserts nothing.
#
# `on conflict do nothing` arbitrates on the unique index added in 0002,
# (definition_id, assignee_id, due_on). That is what makes a second run a TRUE
# no-op — not "inserts the same values again", but touches no row at all, so a
# completed_at set an hour ago is not merely preserved, it is never visited.
#
# `d.name` is copied into `title` at insert time and never read again. Renaming a
# definition must not rewrite what the board said last Tuesday.
_INSERT_DAY = """
    insert into chore_instances (household_id, assignee_id, definition_id, title, due_on)
    select d.household_id, a.member_id, d.id, d.name, %(due_on)s
      from chore_definitions d
      join chore_assignments a on a.definition_id = d.id
     where d.household_id = %(household_id)s
       and d.is_active
       and a.day_of_week = %(dow)s
    on conflict (definition_id, assignee_id, due_on) do nothing
    returning id
"""


def weekday_of(due_on: date) -> int:
    """The day-of-week value chore_assignments uses: 0=Monday .. 6=Sunday.

    This is Python's date.weekday(). It is NOT Postgres's extract(dow), which is
    0=Sunday — using that here would shift every assignment by a day on six days
    out of seven, and the symptom on the wall would look like "the kids didn't do
    their chores" rather than like a bug. The convention is recorded as a comment
    on the column itself, and asserted in verify_materializer.py.

    A named function rather than an inline .weekday() call so there is exactly
    one place the convention is expressed.
    """
    return due_on.weekday()


def materialize(
    conn: psycopg.Connection[DictRow], household_id: UUID, due_on: date
) -> list[UUID]:
    """Create `due_on`'s chore instances for a household. Returns the ids created.

    Idempotent: an empty list means every instance for that day already existed,
    which is the expected result of every run after the first.
    """
    rows = conn.execute(
        _INSERT_DAY,
        {"household_id": household_id, "due_on": due_on, "dow": weekday_of(due_on)},
    ).fetchall()
    return [row["id"] for row in rows]
