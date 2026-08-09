"""
seed.py — load the household, members, and recurring chore definitions into Postgres.

Reads seed.json (real family data, gitignored) from this directory and DIRECT_URL
from the environment / repo .env. Seeds are session-scoped, so it uses the direct
endpoint and refuses a "-pooler" host, exactly like the migrations. Inserts use
the fixed UUIDs from seed.json with `on conflict do nothing`, so re-running is a
no-op.

SLICE 2: this seeds the RECURRING model — chore_definitions plus the assignment
rows that say who does what on which weekday. It no longer creates a day's
chores; app/materialize.py does that, nightly, on its own. Running seed.py is now
something you do when the chore list itself changes, not every morning.

`chores_today` is still accepted and is OPTIONAL. It seeds one-off fixed-ID
instances the slice-1 way, and exists only so an existing seed.json keeps working
and `--refresh` still has something to re-date. New setups should leave it out.

Run from apps/api:
    uv run python seed.py              # strict: on conflict do nothing
    uv run python seed.py --refresh    # dev opt-in: re-date `chores_today` to today
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg

from app.envfile import DirectUrlError, resolve_direct_url

HERE = Path(__file__).resolve().parent        # apps/api
SEED_JSON = HERE / "seed.json"
TZ = ZoneInfo("America/Chicago")

# The seed file speaks day NAMES, the database stores 0-6. The mapping lives
# here, once, and matches Python's date.weekday() — which is what the
# materializer calls. A hand-edited JSON file is the worst possible place to make
# someone remember whether 0 is Monday or Sunday.
DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY_TO_INT = {name: i for i, name in enumerate(DAY_KEYS)}

CADENCES = {"daily", "weekly"}


class SeedError(Exception):
    """A problem with seed.json, phrased for whoever is editing it."""


def _parse_days(raw: Any, where: str) -> list[int]:
    """'all' or a list of 'mon'..'sun' -> sorted 0-6 integers."""
    if raw == "all":
        return list(range(7))
    if not isinstance(raw, list) or not raw:
        raise SeedError(
            f"{where}: 'days' must be a non-empty list of {DAY_KEYS}, or the string 'all'."
        )
    days: set[int] = set()
    for entry in raw:
        if not isinstance(entry, str) or entry.lower() not in DAY_TO_INT:
            raise SeedError(f"{where}: unknown day {entry!r}. Use one of {DAY_KEYS}, or 'all'.")
        days.add(DAY_TO_INT[entry.lower()])
    return sorted(days)


def _validate(data: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    """Check seed.json before opening a connection. Returns (id_by_key, role_by_key).

    Everything that can be wrong is reported from the file, not from a foreign-key
    violation three tables deep.
    """
    members = data["members"]
    id_by_key = {m["key"]: m["id"] for m in members}
    role_by_key = {m["key"]: m["role"] for m in members}

    for definition in data.get("chore_definitions", []):
        name = definition.get("name", "<unnamed>")
        where = f"chore_definition '{name}'"
        if definition.get("cadence") not in CADENCES:
            raise SeedError(
                f"{where}: cadence must be one of {sorted(CADENCES)}, "
                f"got {definition.get('cadence')!r}."
            )
        assignments = definition.get("assignments", [])
        if not assignments:
            raise SeedError(
                f"{where}: has no assignments, so it would never materialize for anyone. "
                "Remove it, or set is_active to false if you are retiring it."
            )
        for assignment in assignments:
            key = assignment.get("member")
            if key not in id_by_key:
                raise SeedError(f"{where}: unknown member key {key!r}.")
            # The API refuses a dependent completing a chore (app/routes.py) and
            # the kiosk gives them no tile to press. Materializing one would
            # create a row that literally nobody can ever clear, which then sits
            # on the board as a permanent un-done chore. Refuse it here, where
            # the mistake is, rather than silently dropping the assignment in the
            # materializer and leaving someone wondering why their edit did
            # nothing.
            if role_by_key[key] == "dependent":
                raise SeedError(
                    f"{where}: assigned to '{key}', who is a dependent. A dependent "
                    "cannot complete a chore, so this would materialize into a row "
                    "nobody can clear."
                )
            _parse_days(assignment.get("days"), f"{where}, member '{key}'")

    for chore in data.get("chores_today", []):
        if chore["assignee"] not in id_by_key:
            raise SeedError(
                f"chores_today '{chore['title']}': unknown member key {chore['assignee']!r}."
            )

    return id_by_key, role_by_key


def _guard_against_duplicate_people(
    cur: psycopg.Cursor[Any], household: dict[str, Any], members: list[dict[str, Any]]
) -> None:
    """Refuse to seed if this file would ADD a second copy of the family.

    Every insert here is `on conflict (id) do nothing`, which protects against
    re-running the SAME file and nothing else. A file with the right NAMES but
    different UUIDs conflicts with nothing, so it inserts a whole second family
    beside the first: ten tiles on the wall, five of them un-tappable duplicates
    with no chores. Nothing in the schema prevents it and nothing in the kiosk
    would explain it.

    That was harmless in slice 1, where seed.json was written once and never
    touched. Slice 2 is the first time anyone edits it against a database that
    is already live, which is exactly when the mistake becomes reachable — most
    obviously by hand-writing a fresh seed.json instead of editing the real one.

    The test is name-versus-id, not id alone, because those two cases must not be
    treated the same:
      - a name that already exists under a DIFFERENT id  -> a duplicate. Refuse.
      - a name that does not exist at all                -> a NEW person. Allow.
    A guard that blocked the second would make adding a family member impossible.
    """
    hh_id = UUID(household["id"])
    known_household = cur.execute(
        "select 1 from households where id = %s", (hh_id,)
    ).fetchone()
    if known_household is None:
        other = cur.execute("select id, name from households limit 1").fetchone()
        if other is not None:
            raise SeedError(
                f"household id {hh_id} is not in the database, but household "
                f"'{other[1]}' ({other[0]}) is. Seeding would create a SECOND "
                "household, and the kiosk (pointed at HOUSEHOLD_ID) would show an "
                "empty board. Fix the id in seed.json to match the real one."
            )
        return  # genuinely fresh database — nothing to collide with

    rows = cur.execute(
        "select id, name from members where household_id = %s", (hh_id,)
    ).fetchall()
    if not rows:
        return  # household exists but has no members yet
    name_to_id = {name: mid for mid, name in rows}
    id_to_name = {mid: name for mid, name in rows}

    duplicates: list[str] = []
    renames: list[str] = []
    for m in members:
        mid, mname = UUID(m["id"]), m["name"]
        if mid in id_to_name:
            if id_to_name[mid] != mname:
                renames.append(f"    {id_to_name[mid]!r} -> {mname!r} (id {mid})")
        elif mname in name_to_id:
            duplicates.append(f"    {mname}: seed.json says {mid}, database has {name_to_id[mname]}")

    if duplicates:
        raise SeedError(
            "these members already exist under DIFFERENT ids, so seeding would add a\n"
            "  second copy of each — the wall would show them twice:\n"
            + "\n".join(duplicates)
            + "\n\n  Nothing was written. Use the ids already in the database (they are in the\n"
            "  seed.json you originally seeded from), or query them:\n"
            "    select id, name, role from members where household_id = '" + str(hh_id) + "';"
        )

    # A rename is legitimate but silently does NOT happen — the insert conflicts
    # on id and is skipped, so the old name stays on the wall. Say so rather than
    # letting someone think it applied.
    if renames:
        print("  NOTE: seed.json renames members, and `on conflict (id) do nothing` will")
        print("  NOT apply the change. The database keeps the existing names:")
        for line in renames:
            print(line)


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the Atlas Household database.")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help=(
            "Dev opt-in: delete the legacy fixed-ID `chores_today` instances and "
            "re-insert them dated today (America/Chicago). NOT the default; never "
            "use on an automated path. Recurring chores do not need this — the "
            "materializer creates them."
        ),
    )
    args = parser.parse_args()

    if not SEED_JSON.exists():
        print(f"ERROR: {SEED_JSON.name} not found. Copy seed.example.json to seed.json", file=sys.stderr)
        print("and fill in real data (seed.json is gitignored).", file=sys.stderr)
        return 1

    try:
        direct_url = resolve_direct_url()
    except DirectUrlError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    data = json.loads(SEED_JSON.read_text(encoding="utf-8"))
    household = data["household"]
    members = data["members"]
    definitions = data.get("chore_definitions", [])
    chores = data.get("chores_today", [])

    try:
        member_id_by_key, _roles = _validate(data)
    except SeedError as exc:
        print(f"ERROR in {SEED_JSON.name}: {exc}", file=sys.stderr)
        return 1

    today = datetime.now(TZ).date()
    verb = "Refreshing" if args.refresh else "Seeding"
    print(f"{verb} '{household['name']}' ...")

    assignment_rows = 0
    with psycopg.connect(direct_url) as conn:            # one transaction, commits on clean exit
        with conn.cursor() as cur:
            # Before ANY write. Inside the transaction, so even if this somehow
            # raised after a write the whole thing would roll back.
            try:
                _guard_against_duplicate_people(cur, household, members)
            except SeedError as exc:
                print(f"ERROR in {SEED_JSON.name}: {exc}", file=sys.stderr)
                return 1

            cur.execute(
                "insert into households (id, name) values (%s, %s) on conflict (id) do nothing",
                (household["id"], household["name"]),
            )
            for m in members:
                cur.execute(
                    "insert into members (id, household_id, name, role, color) "
                    "values (%s, %s, %s, %s, %s) on conflict (id) do nothing",
                    (m["id"], household["id"], m["name"], m["role"], m["color"]),
                )

            for definition in definitions:
                cur.execute(
                    "insert into chore_definitions "
                    "(id, household_id, name, area, cadence, cutoff_time, sort_order, is_active) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s) on conflict (id) do nothing",
                    (
                        definition["id"],
                        household["id"],
                        definition["name"],
                        definition.get("area"),
                        definition["cadence"],
                        definition.get("cutoff_time"),
                        definition.get("sort_order", 0),
                        definition.get("is_active", True),
                    ),
                )
                for assignment in definition["assignments"]:
                    member_id = member_id_by_key[assignment["member"]]
                    for day in _parse_days(assignment["days"], definition["name"]):
                        # No fixed UUID needed: (definition_id, member_id,
                        # day_of_week) is the natural key, unique-constrained in
                        # migration 0002.
                        cur.execute(
                            "insert into chore_assignments (definition_id, member_id, day_of_week) "
                            "values (%s, %s, %s) "
                            "on conflict (definition_id, member_id, day_of_week) do nothing",
                            (definition["id"], member_id, day),
                        )
                        assignment_rows += 1

            if args.refresh and chores:
                # Opt-in only: drop the legacy fixed-ID instances so they re-insert
                # dated today (and reset to not-done). Instances only — never
                # household, members, definitions or assignments.
                cur.execute(
                    "delete from chore_instances where household_id = %s and id = any(%s)",
                    (UUID(household["id"]), [UUID(c["id"]) for c in chores]),
                )
            for c in chores:
                cur.execute(
                    "insert into chore_instances (id, household_id, assignee_id, title, due_on) "
                    "values (%s, %s, %s, %s, %s) on conflict (id) do nothing",
                    (c["id"], household["id"], member_id_by_key[c["assignee"]], c["title"], today),
                )

    print(f"  household: 1 | members: {len(members)}")
    print(f"  chore_definitions: {len(definitions)} | chore_assignments: {assignment_rows}")
    if chores:
        note = f"re-dated to {today.isoformat()}" if args.refresh else "left untouched if present"
        print(f"  legacy chores_today: {len(chores)} ({note})")
    print()
    print("Seed complete. Today's chores are NOT created here — the materializer does")
    print("that nightly. To create them now:  uv run python materialize.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
