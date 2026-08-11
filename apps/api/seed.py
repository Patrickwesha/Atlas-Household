"""
seed.py — load the household, members, and recurring chore definitions into Postgres.

Reads seed.json (real family data, gitignored) from this directory and DIRECT_URL
from the environment / repo .env. Seeds are session-scoped, so it uses the direct
endpoint and refuses a "-pooler" host, exactly like the migrations.

THIS IS AN EDIT SURFACE, NOT JUST A SEEDER. Until the parent dashboard exists it
is the only way to change a chore definition, so a definition's editable fields
(name, area, cutoff_time, sort_order, is_active) are UPSERTED. They used to be
`on conflict do nothing`, which meant every rename, re-order and cutoff change
silently did not happen — the file said one thing and the wall said another.

That is safe because of the snapshot pattern, not in spite of it: instances copy
`title` at insert and `cutoff_at` at materialization, so editing a definition
cannot rewrite what the board said last Tuesday.

Households, members, ASSIGNMENTS and legacy `chores_today` remain insert-only.
Changing who is assigned to what is a different and more dangerous operation.

Every run prints a current-vs-proposed diff of all definitions BEFORE writing
anything. Read it. `--dry-run` prints the same diff and writes nothing.

SLICE 2: this seeds the RECURRING model — chore_definitions plus the assignment
rows that say who does what on which weekday. It no longer creates a day's
chores; app/materialize.py does that, nightly, on its own. Running seed.py is now
something you do when the chore list itself changes, not every morning.

`chores_today` is still accepted and is OPTIONAL. It seeds one-off fixed-ID
instances the slice-1 way, and exists only so an existing seed.json keeps working
and `--refresh` still has something to re-date. New setups should leave it out.

Run from apps/api:
    uv run python seed.py --dry-run           # show the diff, write nothing
    uv run python seed.py                     # apply it
    uv run python seed.py --backfill-cutoffs  # plus: fill today's null cutoff_at
    uv run python seed.py --refresh           # dev opt-in: re-date `chores_today`
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

# Alternating weeks, in words for the same reason days are: 0 and 1 are
# meaningless to read and easy to transpose. Absent means every week.
#
# Which real-world week is "even" is an accident of the calendar — see
# app/materialize.week_parity_of. Pin it by dry-running a Saturday after seeding;
# if the zones come back swapped from reality, swap these values in seed.json.
WEEK_KEYS = {"every": None, "even": 0, "odd": 1}

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


def _parse_week(raw: Any, where: str) -> int | None:
    """'every' (or absent) -> None; 'even' -> 0; 'odd' -> 1."""
    if raw is None:
        return None
    if not isinstance(raw, str) or raw.lower() not in WEEK_KEYS:
        raise SeedError(
            f"{where}: unknown week {raw!r}. Use one of {sorted(WEEK_KEYS)}, or omit it."
        )
    return WEEK_KEYS[raw.lower()]


def _warn_parity_gaps(definition: dict[str, Any]) -> None:
    """Warn when a weekday is covered on only one of the two alternating weeks.

    A definition that says "Panashe, Saturday, even" and nothing else leaves every
    ODD Saturday with nobody assigned. Nothing errors — the board is simply empty
    that week, which is the exact failure this whole slice exists to prevent, and
    it would first show up a fortnight after seeding when nobody is looking for it.

    A warning rather than a refusal: a genuinely fortnightly chore is a legitimate
    thing to want.
    """
    parities_by_day: dict[int, set[int | None]] = {}
    for assignment in definition["assignments"]:
        week = _parse_week(assignment.get("week"), "")
        for day in _parse_days(assignment["days"], ""):
            parities_by_day.setdefault(day, set()).add(week)

    for day, parities in sorted(parities_by_day.items()):
        if None in parities:
            continue  # somebody is on it every week
        missing = {0, 1} - parities
        if missing:
            absent = "odd" if 0 in parities else "even"
            print(
                f"  NOTE: '{definition['name']}' is assigned on "
                f"{DAY_KEYS[day]} only in {'even' if 0 in parities else 'odd'} weeks. "
                f"Nobody has it on an {absent} {DAY_KEYS[day]}."
            )


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
            _parse_week(assignment.get("week"), f"{where}, member '{key}'")
        _warn_parity_gaps(definition)

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


# The definition fields seed.py is allowed to CHANGE on an existing row.
#
# Deliberately not `id` (that is the identity) and deliberately not the
# assignments, which stay insert-only — see the upsert in main() for why.
_EDITABLE = ("name", "area", "cutoff_time", "sort_order", "is_active")


def _normalise_time(value: Any) -> str | None:
    """"HH:MM" for a seed.json string or a psycopg time, None for null.

    Both sides of the diff have to be comparable, and they arrive in different
    shapes: seed.json gives "22:30", the database gives datetime.time(22, 30).
    Without this, every run would report every cutoff as changed.
    """
    if value is None:
        return None
    if isinstance(value, str):
        parts = value.split(":")
        return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
    return f"{value.hour:02d}:{value.minute:02d}"


def _proposed_fields(definition: dict[str, Any]) -> dict[str, Any]:
    """What seed.json says a definition should be, with defaults applied."""
    return {
        "name": definition["name"],
        "area": definition.get("area"),
        "cutoff_time": _normalise_time(definition.get("cutoff_time")),
        "sort_order": definition.get("sort_order", 0),
        "is_active": definition.get("is_active", True),
    }


def _print_definition_diff(
    cur: psycopg.Cursor[Any], household_id: str, definitions: list[dict[str, Any]]
) -> int:
    """Print current-vs-proposed for every definition. Returns the change count.

    Runs BEFORE any write, every time — not only under --dry-run. seed.py is the
    only edit surface for definitions until the parent dashboard exists, and an
    edit surface that changes live rows without showing what it is about to
    change is one you cannot safely use on a board the family is standing at.
    """
    rows = {
        str(r[0]): dict(zip(("name", "area", "cutoff_time", "sort_order", "is_active"), r[1:]))
        for r in cur.execute(
            "select id, name, area, cutoff_time, sort_order, is_active "
            "from chore_definitions where household_id = %s",
            (household_id,),
        ).fetchall()
    }

    changed = 0
    print()
    print("  Definition changes:")
    for definition in definitions:
        proposed = _proposed_fields(definition)
        current = rows.get(definition["id"])
        if current is None:
            print(f"    + NEW  {proposed['name']}")
            for field in _EDITABLE:
                print(f"           {field:12} -> {proposed[field]!r}")
            changed += 1
            continue

        current_norm = {**current, "cutoff_time": _normalise_time(current["cutoff_time"])}
        diffs = [f for f in _EDITABLE if current_norm[f] != proposed[f]]
        if not diffs:
            print(f"    = {proposed['name']}  (no change)")
            continue
        changed += 1
        print(f"    ~ {proposed['name']}")
        for field in diffs:
            print(f"           {field:12} {current_norm[field]!r} -> {proposed[field]!r}")
        same = [f for f in _EDITABLE if f not in diffs]
        if same:
            print(f"           unchanged: {', '.join(same)}")

    orphans = set(rows) - {d["id"] for d in definitions}
    if orphans:
        print()
        print("    NOTE: these definitions exist in the database but not in seed.json.")
        print("    They are LEFT ALONE — seed.py never deletes or deactivates. Set")
        print("    is_active false in seed.json if you meant to retire one:")
        for oid in sorted(orphans):
            print(f"      {rows[oid]['name']}  ({oid})")

    print()
    print(f"  {changed} definition(s) would change, {len(definitions) - changed} unchanged.")
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the Atlas Household database.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the definition diff and write NOTHING. Use before every real run.",
    )
    parser.add_argument(
        "--backfill-cutoffs",
        action="store_true",
        help=(
            "One-off: set cutoff_at on TODAY's existing instances from their "
            "definition, but ONLY where cutoff_at is currently null AND the "
            "resolved cutoff is still in the future. Never touches a past day, "
            "never overwrites a cutoff already snapshotted, and can never make "
            "an existing chore retroactively late."
        ),
    )
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

            # Always, before any write — not only under --dry-run.
            _print_definition_diff(cur, household["id"], definitions)
            if args.dry_run:
                conn.rollback()
                print()
                print("DRY RUN — nothing was written.")
                return 0

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
                # UPSERT the definition's FIELDS. Until the parent dashboard
                # exists this is the only way to edit a definition at all, and
                # `do nothing` meant every rename, re-order and cutoff change
                # silently did not happen — the worst kind of failure, because
                # the file said one thing and the wall said another.
                #
                # Safe precisely because of the snapshot pattern: chore_instances
                # copy `title` at insert and `cutoff_at` at materialization, so
                # editing a definition cannot rewrite what the board said last
                # Tuesday. That is what the snapshots are FOR.
                #
                # `cadence` is not updated: it is descriptive only and the
                # materializer never reads it, so changing it here would imply a
                # schedule change that does not happen. The schedule lives in
                # chore_assignments.
                #
                # ASSIGNMENTS STAY `do nothing` (below). Who is assigned to what
                # is a different and more dangerous operation — an upsert there
                # would silently move a chore between two kids, and the natural
                # key means a removed assignment would not disappear anyway, so
                # it would half-work. Not opened in this change.
                cur.execute(
                    "insert into chore_definitions "
                    "(id, household_id, name, area, cadence, cutoff_time, sort_order, is_active) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s) "
                    "on conflict (id) do update set "
                    "    name        = excluded.name, "
                    "    area        = excluded.area, "
                    "    cutoff_time = excluded.cutoff_time, "
                    "    sort_order  = excluded.sort_order, "
                    "    is_active   = excluded.is_active",
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
                    week = _parse_week(assignment.get("week"), definition["name"])
                    for day in _parse_days(assignment["days"], definition["name"]):
                        # No fixed UUID needed: (definition_id, member_id,
                        # day_of_week) is the natural key, unique-constrained in
                        # migration 0002. week_parity is deliberately NOT part of
                        # that key — see 0003 for why.
                        cur.execute(
                            "insert into chore_assignments "
                            "(definition_id, member_id, day_of_week, week_parity) "
                            "values (%s, %s, %s, %s) "
                            "on conflict (definition_id, member_id, day_of_week) do nothing",
                            (definition["id"], member_id, day, week),
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

            if args.backfill_cutoffs:
                # Instances snapshot cutoff_at when they are MATERIALIZED, so a
                # day created before its definitions had cutoffs keeps cutoff_at
                # null forever and nothing on it can ever go late. That is
                # correct behaviour and it looks exactly like a broken feature.
                #
                # This fills that gap once, and it is bounded so it cannot
                # accuse anyone:
                #   - today only. A past day is history; giving it deadlines it
                #     never had would turn finished chores retroactively late.
                #   - cutoff_at is null only. Never overwrites a real snapshot.
                #   - the resolved cutoff must still be in the FUTURE. A chore
                #     whose deadline already passed today never had one while
                #     the day was live, and going red for it now would be the
                #     board inventing a deadline nobody was told about.
                backfilled = cur.execute(
                    "update chore_instances ci "
                    "   set cutoff_at = (ci.due_on + d.cutoff_time) at time zone %s "
                    "  from chore_definitions d "
                    " where d.id = ci.definition_id "
                    "   and ci.household_id = %s "
                    "   and ci.due_on = %s "
                    "   and ci.cutoff_at is null "
                    "   and d.cutoff_time is not null "
                    "   and ((ci.due_on + d.cutoff_time) at time zone %s) > now() "
                    # Rendered back in the HOUSEHOLD's zone, not the session's.
                    # cutoff_at is a timestamptz and psycopg prints it in the
                    # connection timezone, which is UTC — so a 9:30 PM cutoff
                    # reported itself as "02:30" and read like a bug in the
                    # conversion it was there to confirm.
                    "returning ci.title, "
                    "  to_char(ci.cutoff_at at time zone %s, 'HH24:MI') as local_hm",
                    (str(TZ), household["id"], today, str(TZ), str(TZ)),
                ).fetchall()
                print()
                print(f"  cutoff backfill for {today.isoformat()}: {len(backfilled)} instance(s)")
                for title, local_hm in sorted(backfilled, key=lambda r: (r[1], r[0])):
                    print(f"      {local_hm}  {title}")
                skipped = cur.execute(
                    "select count(*) from chore_instances ci join chore_definitions d "
                    " on d.id = ci.definition_id "
                    " where ci.household_id = %s and ci.due_on = %s and ci.cutoff_at is null "
                    "   and d.cutoff_time is not null",
                    (household["id"], today),
                ).fetchone()
                if skipped and skipped[0]:
                    print(
                        f"      ({skipped[0]} left null — their cutoff already passed "
                        "today, so they are not made late after the fact)"
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
