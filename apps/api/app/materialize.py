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

# WHO IS SCHEDULED ON A GIVEN DAY. The single source of truth for that question.
#
# It is a shared constant because it is written into two different queries: the
# insert below, and the CLI's --dry-run preview (materialize.py at the apps/api
# root), which also joins `members` so it can print names. If those two drifted,
# --dry-run would report a schedule the real run does not produce — and --dry-run
# is exactly the tool used to confirm the week-parity anchor before trusting a
# Saturday. A preview that lies about the thing it exists to check is worse than
# no preview. verify_materializer.py asserts the two return the same set.
#
# Expects params: household_id, dow, parity.
SCHEDULE_WHERE = """
     where d.household_id = %(household_id)s
       and d.is_active
       and a.day_of_week = %(dow)s
       and (a.week_parity is null or a.week_parity = %(parity)s)
"""

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
_INSERT_DAY = f"""
    insert into chore_instances (household_id, assignee_id, definition_id, title, due_on)
    select d.household_id, a.member_id, d.id, d.name, %(due_on)s
      from chore_definitions d
      join chore_assignments a on a.definition_id = d.id
    {SCHEDULE_WHERE}
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


def week_parity_of(due_on: date) -> int:
    """Which of the two alternating weeks `due_on` falls in: 0 or 1.

    Ordinal division, NOT the ISO week number. ISO week numbers are discontinuous
    at the year boundary — week 52 can be followed by week 1, producing two weeks
    of the same parity back to back. On real dates: 2026-12-26, 2027-01-02 and
    2027-01-09 give ISO parities 0, 1, 1, so on the second Saturday of January
    everyone's deep-clean zones would silently fail to swap, once a year, in a way
    nobody would think to check. Ordinal division is continuous forever.

    The block boundary lands on SUNDAY, so a parity week runs Sunday..Saturday.
    That matters for exactly one thing: a Saturday and the Sunday after it are in
    DIFFERENT blocks. Both alternate fairly, but it is not the Mon..Sun week most
    people picture.

    Which real-world week is 0 and which is 1 is an accident of the calendar. It
    is pinned by seeding and then checking a Saturday with
    `materialize.py --date <sat> --dry-run`; if the zones come back swapped from
    reality, the fix is to flip the values in seed.json, not to change this.
    """
    return (due_on.toordinal() // 7) % 2


def schedule_params(household_id: UUID, due_on: date) -> dict[str, object]:
    """The bind parameters SCHEDULE_WHERE needs. Shared with the CLI preview so
    the two cannot disagree about the weekday or the parity of a given date."""
    return {
        "household_id": household_id,
        "dow": weekday_of(due_on),
        "parity": week_parity_of(due_on),
    }


def materialize(
    conn: psycopg.Connection[DictRow], household_id: UUID, due_on: date
) -> list[UUID]:
    """Create `due_on`'s chore instances for a household. Returns the ids created.

    Idempotent: an empty list means every instance for that day already existed,
    which is the expected result of every run after the first.
    """
    rows = conn.execute(
        _INSERT_DAY,
        {**schedule_params(household_id, due_on), "due_on": due_on},
    ).fetchall()
    return [row["id"] for row in rows]
