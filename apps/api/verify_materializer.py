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

from app.materialize import materialize, schedule_params, week_parity_of, weekday_of

# The CLI's preview query, imported from the script rather than copied, so this
# file cannot accidentally verify a stale copy of the thing under test.
from materialize import _PREVIEW as CLI_PREVIEW

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

        # ---- 8. Week parity ----
        #
        # Alternating weeks are a SCHEDULE, not a rotation: parity is computed
        # from the date, so nothing advances and nothing is remembered. These
        # checks are what keep that true in practice.
        print("\nWeek parity")
        reset(conn)
        pids: dict[str, UUID] = {}
        for name in ("Ada", "Ben"):
            pids[name] = q(conn, "select id from members where name = %s", (name,))["id"]
        zone_a = q(conn,
            "insert into chore_definitions (household_id, name, cadence) "
            "values (%s,'Zone A','weekly') returning id", (HOUSEHOLD,))["id"]
        zone_b = q(conn,
            "insert into chore_definitions (household_id, name, cadence) "
            "values (%s,'Zone B','weekly') returning id", (HOUSEHOLD,))["id"]
        # The pairing under test: two people swapping two zones every Saturday.
        for did, even, odd in [(zone_a, "Ada", "Ben"), (zone_b, "Ben", "Ada")]:
            for member, parity in [(even, 0), (odd, 1)]:
                conn.execute(
                    "insert into chore_assignments (definition_id, member_id, day_of_week, week_parity) "
                    "values (%s,%s,5,%s)", (did, pids[member], parity))

        sats = [date(2026, 8, 15) + timedelta(days=7 * i) for i in range(4)]
        for s in sats:
            materialize(conn, HOUSEHOLD, s)
        # Narrowed to the zone titles: these people also carry the fixture's daily
        # chores, and asserting over their whole list would be testing the
        # fixture rather than the parity.
        ZONES = {"Zone A", "Zone B"}
        zones = {s: {m: titles_for(conn, m, s) & ZONES for m in ("Ada", "Ben")} for s in sats}

        check("each Saturday assigns exactly one zone per person",
              all(len(zones[s][m]) == 1 for s in sats for m in ("Ada", "Ben")),
              f"{zones}")
        check("the two people never hold the same zone on the same Saturday",
              all(zones[s]["Ada"] != zones[s]["Ben"] for s in sats))
        check("zones swap on consecutive Saturdays",
              all(zones[sats[i]]["Ada"] != zones[sats[i + 1]]["Ada"] for i in range(3)))
        check("and swap back — a 2-week cycle, not a drift",
              zones[sats[0]]["Ada"] == zones[sats[2]]["Ada"]
              and zones[sats[1]]["Ada"] == zones[sats[3]]["Ada"])
        check("over two weeks each person does both zones exactly once",
              zones[sats[0]]["Ada"] | zones[sats[1]]["Ada"] == {"Zone A", "Zone B"})

        # THE YEAR-BOUNDARY CHECK. ISO week numbers are discontinuous across New
        # Year — 2026-12-26 / 2027-01-02 / 2027-01-09 have ISO parities 0, 1, 1 —
        # so an implementation using isocalendar() would silently stop swapping
        # zones for one week every January. This is the check that catches it.
        print("\nThe year boundary (where ISO week numbering would break)")
        ny = [date(2026, 12, 26), date(2027, 1, 2), date(2027, 1, 9), date(2027, 1, 16)]
        check("ordinal parity alternates on every Saturday across New Year",
              [week_parity_of(d) for d in ny] in ([0, 1, 0, 1], [1, 0, 1, 0]),
              f"got {[week_parity_of(d) for d in ny]}")
        check("ISO week numbering would NOT — the bug this avoids is real",
              [d.isocalendar()[1] % 2 for d in ny] not in ([0, 1, 0, 1], [1, 0, 1, 0]),
              "isocalendar() alternated here; re-check the assumption")
        for d in ny:
            materialize(conn, HOUSEHOLD, d)
        ny_zones = [titles_for(conn, "Ada", d) for d in ny]
        check("and the zones themselves keep swapping through New Year",
              all(ny_zones[i] != ny_zones[i + 1] for i in range(3)), f"{ny_zones}")

        # A null parity must mean EVERY week, not "parity 0".
        print("\nNull parity means every week")
        every = q(conn,
            "insert into chore_definitions (household_id, name, cadence) "
            "values (%s,'Every Saturday','weekly') returning id", (HOUSEHOLD,))["id"]
        conn.execute(
            "insert into chore_assignments (definition_id, member_id, day_of_week, week_parity) "
            "values (%s,%s,5,null)", (every, pids["Ada"]))
        for s in sats:
            materialize(conn, HOUSEHOLD, s)
        check("a null-parity assignment materializes on BOTH parities",
              all("Every Saturday" in titles_for(conn, "Ada", s) for s in sats))
        check("a parity-specific one still does not",
              sum("Zone A" in titles_for(conn, "Ada", s) for s in sats) == 2)

        # ---- 9. The dry-run must not lie ----
        #
        # The CLI preview and the real insert are two queries over the same
        # schedule. If they drift, `--dry-run` reports a schedule the nightly run
        # does not produce — while being the tool used to confirm the parity
        # anchor before trusting a Saturday. They share SCHEDULE_WHERE; this
        # proves the sharing actually holds end to end.
        print("\nThe --dry-run preview agrees with the real insert")
        for label, day in [("parity 0", sats[1]), ("parity 1", sats[0])]:
            conn.execute("delete from chore_instances where due_on = %s", (day,))
            previewed = {
                (r["member_name"], r["title"])
                for r in conn.execute(
                    CLI_PREVIEW, {**schedule_params(HOUSEHOLD, day), "due_on": day}
                ).fetchall()
            }
            materialize(conn, HOUSEHOLD, day)
            actual = {
                (r["name"], r["title"])
                for r in conn.execute(
                    "select m.name, ci.title from chore_instances ci "
                    "join members m on m.id = ci.assignee_id where ci.due_on = %s", (day,)
                ).fetchall()
            }
            check(f"preview == reality on a {label} day ({day})", previewed == actual,
                  f"preview-only {previewed - actual}, created-only {actual - previewed}")

        # ---- 10. Household scoping ----
        reset(conn)
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
