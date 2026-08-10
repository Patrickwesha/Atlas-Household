"""
materialize.py — create a day's chore_instances from definitions + assignments.

The same logic the nightly Vercel cron runs (app/materialize.py), with a date you
can aim. This is how you check that the right people get the right chores on the
right weekday without waiting for a Tuesday.

Reads DIRECT_URL and HOUSEHOLD_ID from the environment / repo .env, and refuses a
"-pooler" host, exactly like seed.py and the migrations. It does NOT import
app.config: that would require DEVICE_TOKEN and DATABASE_URL to be set just to
create some rows.

Run from apps/api:
    uv run python materialize.py                      # today, in APP_TIMEZONE
    uv run python materialize.py --date 2026-08-15    # a specific day
    uv run python materialize.py --date 2026-08-15 --dry-run   # writes nothing

--dry-run runs no INSERT at all — it is a SELECT over the same join, so there is
no transaction to trust and nothing to roll back.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row

from app.envfile import REPO_ROOT, DirectUrlError, load_env_file, resolve_direct_url
from app.materialize import (
    SCHEDULE_WHERE,
    materialize,
    schedule_params,
    week_parity_of,
    weekday_of,
)

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# What the run WOULD create, and what is already there.
#
# The WHERE clause is IMPORTED, not retyped. This query and the real insert used
# to carry two copies of the same predicate, and week parity is exactly the kind
# of change that gets added to one and forgotten in the other — at which point
# --dry-run reports a schedule the nightly run does not produce, while being the
# tool you use to confirm the parity anchor. The FROM differs (this one joins
# members, to print names); the definition of "who is scheduled" cannot.
_PREVIEW = f"""
    select m.name as member_name,
           m.role as member_role,
           d.name as title,
           d.area as area,
           d.cutoff_time as cutoff_time,
           ((%(due_on)s::date + d.cutoff_time) at time zone %(tz)s) as cutoff_at,
           exists (
               select 1 from chore_instances ci
                where ci.definition_id = d.id
                  and ci.assignee_id  = a.member_id
                  and ci.due_on       = %(due_on)s
           ) as already
      from chore_definitions d
      join chore_assignments a on a.definition_id = d.id
      join members m           on m.id = a.member_id
    {SCHEDULE_WHERE}
     order by m.name, d.sort_order, d.name
"""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Materialize a day's chore instances from definitions + assignments."
    )
    parser.add_argument(
        "--date",
        dest="target",
        help="Day to materialize, YYYY-MM-DD. Defaults to today in APP_TIMEZONE.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be created. Runs no INSERT.",
    )
    args = parser.parse_args()

    load_env_file(REPO_ROOT / ".env")
    tz_name = os.environ.get("APP_TIMEZONE", "America/Chicago")
    tz = ZoneInfo(tz_name)

    household_raw = os.environ.get("HOUSEHOLD_ID", "").strip()
    if not household_raw:
        print("ERROR: HOUSEHOLD_ID is not set (checked the environment and repo .env).", file=sys.stderr)
        return 1
    try:
        household_id = UUID(household_raw)
    except ValueError:
        print(f"ERROR: HOUSEHOLD_ID is not a valid UUID: {household_raw!r}", file=sys.stderr)
        return 1

    if args.target:
        try:
            due_on = date.fromisoformat(args.target)
        except ValueError:
            print(f"ERROR: --date must be YYYY-MM-DD, got {args.target!r}", file=sys.stderr)
            return 1
    else:
        due_on = datetime.now(tz).date()

    try:
        direct_url = resolve_direct_url()
    except DirectUrlError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    dow = weekday_of(due_on)
    parity = week_parity_of(due_on)
    verb = "Would materialize" if args.dry_run else "Materializing"
    print(
        f"{verb} {due_on.isoformat()} ({DAY_NAMES[dow]}, day_of_week={dow}, "
        f"week_parity={parity}) ..."
    )

    with psycopg.connect(direct_url, autocommit=True, row_factory=dict_row) as conn:
        preview = conn.execute(
            _PREVIEW,
            {**schedule_params(household_id, due_on), "due_on": due_on, "tz": tz_name},
        ).fetchall()

        if not preview:
            print(f"  Nothing scheduled for this weekday. No active definition is")
            print(f"  assigned to anyone on a {DAY_NAMES[dow]} in a parity-{parity} week.")
            return 0

        created: list[UUID] = []
        if not args.dry_run:
            created = materialize(conn, household_id, due_on, tz_name)

        current_member = None
        for row in preview:
            if row["member_name"] != current_member:
                current_member = row["member_name"]
                print(f"\n  {current_member} ({row['member_role']})")
            mark = "= already there" if row["already"] else ("+ would create" if args.dry_run else "+ created")
            area = f"  [{row['area']}]" if row["area"] else ""
            # The resolved cutoff is printed because it is the whole point of a
            # dry run before seeding cutoffs: a wrong timezone or a wrong
            # cutoff_time shows up here as a time, not later as chores turning
            # red at the wrong hour.
            if row["cutoff_time"] is None:
                cutoff = "  (no cutoff)"
            else:
                # Formatted by hand: strftime's %-I is glibc-only and %#I is
                # Windows-only, and this script is run from both.
                t = row["cutoff_time"]
                cutoff = (
                    f"  by {t.hour % 12 or 12}:{t.minute:02d} "
                    f"{'PM' if t.hour >= 12 else 'AM'}"
                    f"  [{row['cutoff_at']:%Y-%m-%d %H:%M %z}]"
                )
            print(f"      {mark}: {row['title']}{area}{cutoff}")

        fresh = sum(1 for r in preview if not r["already"])
        print()
        if args.dry_run:
            print(f"  {len(preview)} scheduled, {fresh} would be created. Nothing was written.")
        else:
            print(f"  {len(preview)} scheduled, {len(created)} created, {len(preview) - len(created)} already existed.")
            # A mismatch here means something raced us or the preview and the
            # insert disagree — worth seeing rather than swallowing.
            if len(created) != fresh:
                print(f"  NOTE: expected to create {fresh}. Another writer may have run concurrently.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
