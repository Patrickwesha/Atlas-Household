"""
verify_materializer.py — assert the materializer's guarantees against a real database.

The gauntlet measured the kiosk; nothing in this repo asserted anything. The
materializer is the first piece of pure logic worth pinning down, because its
failure modes are quiet: a weekday off by one looks like "the kids didn't do
their chores", and a broken idempotency check looks like nothing at all until it
erases a completion.

Stdlib + psycopg only — no test-runner dependency. Exits non-zero on the first
failure, so it works as a pre-deploy gate.

POINT IT AT A SCRATCH DATABASE. It writes freely and truncates between checks.
It refuses to run against a URL containing "neon.tech" for that reason.

    createdb atlas_verify
    VERIFY_DATABASE_URL=postgresql://localhost/atlas_verify uv run python verify_materializer.py
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import DictRow, dict_row

from app.materialize import materialize, weekday_of

HOUSEHOLD = UUID("00000000-0000-0000-0000-0000000000f1")

# Fixed dates with known weekdays. Hard-coded rather than computed, so a bug in
# the test's own date arithmetic cannot agree with a bug in the code under test.
MONDAY = date(2026, 8, 3)      # a Monday, in the past
TUESDAY = date(2026, 8, 4)
SATURDAY = date(2026, 8, 29)   # a Saturday, in the future
SUNDAY = date(2026, 8, 30)

failures: list[str] = []
checks_run = 0


def q(conn: psycopg.Connection[DictRow], sql: str, params: Any = ()) -> DictRow:
    """Run a query that must return exactly one row, and say so if it does not.

    psycopg's fetchone() is Optional, and every call site here queries by primary
    key or is an aggregate — so None means the fixture is wrong, not that the row
    is absent. Raising names the query instead of an IndexError twenty lines away.
    """
    row = conn.execute(sql, params).fetchone()
    if row is None:
        raise AssertionError(f"expected exactly one row from: {' '.join(sql.split())[:80]}")
    return row


def check(name: str, condition: bool, detail: str = "") -> None:
    global checks_run
    checks_run += 1
    if condition:
        print(f"  ✅ {name}")
    else:
        print(f"  ❌ {name}" + (f"\n       {detail}" if detail else ""))
        failures.append(name)


def titles_for(conn: psycopg.Connection[DictRow], member: str, due_on: date) -> set[str]:
    rows = conn.execute(
        "select ci.title from chore_instances ci join members m on m.id = ci.assignee_id "
        "where m.name = %s and ci.due_on = %s",
        (member, due_on),
    ).fetchall()
    return {r["title"] for r in rows}


def reset(conn: psycopg.Connection[DictRow]) -> dict[str, UUID]:
    """A clean household: 2 adults, 2 kids, 1 dependent, 4 definitions."""
    conn.execute("truncate chore_instances, chore_assignments, chore_definitions, members, households cascade")
    conn.execute("insert into households (id, name) values (%s, 'Verify House')", (HOUSEHOLD,))

    ids: dict[str, UUID] = {}
    for name, role in [
        ("Ada", "adult"), ("Ben", "adult"), ("Cy", "kid"), ("Di", "kid"), ("Eve", "dependent")
    ]:
        ids[name] = q(conn, 
            "insert into members (household_id, name, role, color) values (%s,%s,%s,'#000') returning id",
            (HOUSEHOLD, name, role),
        )["id"]

    def define(name: str, cadence: str, assignments: list[tuple[str, list[int]]]) -> UUID:
        did = q(conn, 
            "insert into chore_definitions (household_id, name, cadence) values (%s,%s,%s) returning id",
            (HOUSEHOLD, name, cadence),
        )["id"]
        for member, days in assignments:
            for day in days:
                conn.execute(
                    "insert into chore_assignments (definition_id, member_id, day_of_week) values (%s,%s,%s)",
                    (did, ids[member], day),
                )
        return did

    # The design under test: ONE definition, split across two people by weekday.
    ids["kitchen"] = define("Kitchen reset", "daily", [("Ada", [0, 2, 4]), ("Ben", [1, 3, 5])])
    # All-hands, every day, no special case.
    ids["reset"] = define("Family reset", "daily", [(m, list(range(7))) for m in ("Ada", "Ben", "Cy", "Di")])
    # Saturday only.
    ids["deep"] = define("Deep clean", "weekly", [("Cy", [5])])
    # Retired: must never materialize.
    ids["old"] = define("Retired chore", "daily", [("Cy", list(range(7)))])
    conn.execute("update chore_definitions set is_active = false where id = %s", (ids["old"],))
    return ids


def main() -> int:
    url = os.environ.get("VERIFY_DATABASE_URL", "").strip()
    if not url:
        print("ERROR: set VERIFY_DATABASE_URL to a SCRATCH database.", file=sys.stderr)
        return 2
    if "neon.tech" in url:
        print("ERROR: VERIFY_DATABASE_URL looks like Neon. This script truncates tables.", file=sys.stderr)
        return 2

    with psycopg.connect(url, autocommit=True, row_factory=dict_row) as conn:
        ids = reset(conn)

        # ---- 1. The right people get the right chores on the right weekday ----
        print("\nWeekday routing")
        materialize(conn, HOUSEHOLD, MONDAY)
        check("Monday: the Mon/Wed/Fri person gets the kitchen reset",
              "Kitchen reset" in titles_for(conn, "Ada", MONDAY))
        check("Monday: the Tue/Thu/Sat person does NOT",
              "Kitchen reset" not in titles_for(conn, "Ben", MONDAY))
        check("Monday: all four get the all-hands reset, with no special case",
              all("Family reset" in titles_for(conn, m, MONDAY) for m in ("Ada", "Ben", "Cy", "Di")))
        check("Monday: no Saturday-only chore",
              "Deep clean" not in titles_for(conn, "Cy", MONDAY))
        check("Monday: the dependent gets nothing (no assignment exists for one)",
              titles_for(conn, "Eve", MONDAY) == set())
        check("An is_active=false definition never materializes",
              "Retired chore" not in titles_for(conn, "Cy", MONDAY))

        materialize(conn, HOUSEHOLD, TUESDAY)
        check("Tuesday: the split flips to the other person",
              "Kitchen reset" in titles_for(conn, "Ben", TUESDAY)
              and "Kitchen reset" not in titles_for(conn, "Ada", TUESDAY))

        materialize(conn, HOUSEHOLD, SATURDAY)
        check("Future Saturday: the Saturday-only chore appears",
              "Deep clean" in titles_for(conn, "Cy", SATURDAY))
        check("Future Saturday: the kitchen reset is on the Tue/Thu/Sat person",
              "Kitchen reset" in titles_for(conn, "Ben", SATURDAY)
              and "Kitchen reset" not in titles_for(conn, "Ada", SATURDAY))

        materialize(conn, HOUSEHOLD, SUNDAY)
        check("Sunday: nobody has the kitchen reset (assigned to neither Sun)",
              titles_for(conn, "Ada", SUNDAY) == {"Family reset"}
              and titles_for(conn, "Ben", SUNDAY) == {"Family reset"})

        # ---- 2. The 0=Monday convention, the extract(dow) trap ----
        print("\nWeekday convention (0=Monday, not Postgres extract(dow)=Sunday)")
        check("weekday_of() calls a known Monday 0", weekday_of(MONDAY) == 0,
              f"got {weekday_of(MONDAY)}")
        check("weekday_of() calls a known Sunday 6", weekday_of(SUNDAY) == 6,
              f"got {weekday_of(SUNDAY)}")
        pg_dow = q(conn, "select extract(dow from %s::date) as d", (MONDAY,))["d"]
        check("Postgres extract(dow) disagrees, as documented — 1 for that Monday",
              int(pg_dow) == 1, f"extract(dow) gave {pg_dow}; the column comment must stay")

        # ---- 3. Idempotency, by identity and not by count ----
        print("\nIdempotency")
        before = conn.execute(
            "select id from chore_instances where due_on = %s order by id", (MONDAY,)
        ).fetchall()
        created_again = materialize(conn, HOUSEHOLD, MONDAY)
        after = conn.execute(
            "select id from chore_instances where due_on = %s order by id", (MONDAY,)
        ).fetchall()
        check("a second run for the same day creates nothing", created_again == [])
        # Comparing IDS, not counts: a delete-and-reinsert would keep the count
        # identical while destroying every completion on the day.
        check("and the same rows survive — ids unchanged, not merely the count",
              [r["id"] for r in before] == [r["id"] for r in after])

        # ---- 4. A completed instance survives a re-run ----
        print("\nCompleted work survives")
        target = q(conn, 
            "select ci.id from chore_instances ci join members m on m.id = ci.assignee_id "
            "where ci.due_on = %s and m.name = 'Ada' limit 1", (MONDAY,)
        )["id"]
        conn.execute(
            "update chore_instances set completed_at = now(), completed_by = assignee_id where id = %s",
            (target,),
        )
        stamp = q(conn, 
            "select completed_at, completed_by from chore_instances where id = %s", (target,)
        )
        materialize(conn, HOUSEHOLD, MONDAY)
        after_row = q(conn, 
            "select completed_at, completed_by from chore_instances where id = %s", (target,)
        )
        check("completed_at is untouched by a re-run", after_row["completed_at"] == stamp["completed_at"])
        check("completed_by is untouched by a re-run", after_row["completed_by"] == stamp["completed_by"])
        check("and no duplicate row appeared for it",
              q(conn, 
                  "select count(*) as n from chore_instances where due_on = %s and definition_id = "
                  "(select definition_id from chore_instances where id = %s) and assignee_id = "
                  "(select assignee_id from chore_instances where id = %s)",
                  (MONDAY, target, target),
              )["n"] == 1)

        # ---- 5. Slice-1 rows survive ----
        print("\nLegacy (definition_id null) rows survive")
        ada = ids["Ada"]
        legacy = q(conn, 
            "insert into chore_instances (household_id, assignee_id, title, due_on) "
            "values (%s,%s,'Hand-seeded chore',%s) returning id", (HOUSEHOLD, ada, MONDAY)
        )["id"]
        legacy_twin = q(conn, 
            "insert into chore_instances (household_id, assignee_id, title, due_on) "
            "values (%s,%s,'Another hand-seeded chore',%s) returning id", (HOUSEHOLD, ada, MONDAY)
        )["id"]
        check("two null-definition rows for the same person+day coexist "
              "(NULLs are distinct in the unique index)", legacy != legacy_twin)
        materialize(conn, HOUSEHOLD, MONDAY)
        check("a materializer run leaves them alone",
              q(conn, 
                  "select count(*) as n from chore_instances where id = any(%s)", ([legacy, legacy_twin],)
              )["n"] == 2)

        # ---- 6. Title is a snapshot ----
        print("\nTitle snapshot")
        conn.execute("update chore_definitions set name = 'Kitchen reset (renamed)' where id = %s",
                     (ids["kitchen"],))
        materialize(conn, HOUSEHOLD, MONDAY)
        check("renaming a definition does not rewrite an existing instance",
              "Kitchen reset" in titles_for(conn, "Ada", MONDAY))
        future = MONDAY + timedelta(days=7)
        materialize(conn, HOUSEHOLD, future)
        check("but a newly materialized day picks up the new name",
              "Kitchen reset (renamed)" in titles_for(conn, "Ada", future))

        # ---- 7. Phase 1 writes nothing Phase 2 owns ----
        print("\nPhase 2 columns stay untouched")
        check("cutoff_at is NULL on every materialized row",
              q(conn, 
                  "select count(*) as n from chore_instances where cutoff_at is not null"
              )["n"] == 0)

        # ---- 8. Household scoping ----
        print("\nHousehold scoping")
        other = uuid4()
        conn.execute("insert into households (id, name) values (%s, 'Someone Else')", (other,))
        other_member = q(conn, 
            "insert into members (household_id, name, role, color) values (%s,'Zed','kid','#000') returning id",
            (other,),
        )["id"]
        other_def = q(conn, 
            "insert into chore_definitions (household_id, name, cadence) values (%s,'Their chore','daily') returning id",
            (other,),
        )["id"]
        conn.execute(
            "insert into chore_assignments (definition_id, member_id, day_of_week) values (%s,%s,0)",
            (other_def, other_member),
        )
        day = MONDAY + timedelta(days=14)
        materialize(conn, HOUSEHOLD, day)
        check("another household's definitions never materialize into this one",
              q(conn, 
                  "select count(*) as n from chore_instances where due_on = %s and title = 'Their chore'",
                  (day,),
              )["n"] == 0)

    print(f"\n{checks_run} checks, {len(failures)} failed.")
    if failures:
        for name in failures:
            print(f"  FAILED: {name}")
        return 1
    print("All materializer guarantees hold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
