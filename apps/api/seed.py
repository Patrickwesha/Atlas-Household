"""
seed.py — load the household, members, and today's chore instances into Postgres.

Reads seed.json (real family data, gitignored) from this directory and DIRECT_URL
from the environment / repo .env. Seeds are session-scoped, so it uses the direct
endpoint and refuses a "-pooler" host, exactly like the migration. Inserts use the
fixed UUIDs from seed.json with `on conflict (id) do nothing`, so re-running the
same day is a no-op. due_on is resolved at runtime in America/Chicago.

Slice 1 only: one household, five members, two chore instances for today.

Run from apps/api:
    uv run python seed.py              # strict: on conflict (id) do nothing
    uv run python seed.py --refresh    # dev opt-in: re-date the instances to today
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg

HERE = Path(__file__).resolve().parent        # apps/api
REPO_ROOT = HERE.parents[1]                    # .../Atlas-Household
SEED_JSON = HERE / "seed.json"
TZ = ZoneInfo("America/Chicago")


def load_env_file(path: Path) -> None:
    """Tiny .env loader; never overrides a var already set in the environment."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed the Atlas Household database (slice 1)."
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help=(
            "Dev opt-in: delete the fixed-ID chore instances and re-insert them "
            "dated today (America/Chicago). NOT the default; never use on an "
            "automated path."
        ),
    )
    args = parser.parse_args()

    if not SEED_JSON.exists():
        print(f"ERROR: {SEED_JSON.name} not found. Copy seed.example.json to seed.json", file=sys.stderr)
        print("and fill in real data (seed.json is gitignored).", file=sys.stderr)
        return 1

    load_env_file(REPO_ROOT / ".env")
    direct_url = os.environ.get("DIRECT_URL", "").strip()
    if not direct_url:
        print("ERROR: DIRECT_URL is not set (checked the environment and repo .env).", file=sys.stderr)
        return 1
    if "-pooler" in direct_url:
        print("ERROR: DIRECT_URL points at the POOLED host ('-pooler'). Refusing to seed", file=sys.stderr)
        print("through Neon's pooler — use the direct endpoint.", file=sys.stderr)
        return 1

    data = json.loads(SEED_JSON.read_text(encoding="utf-8"))
    household = data["household"]
    members = data["members"]
    chores = data["chores_today"]
    member_id_by_key = {m["key"]: m["id"] for m in members}

    for c in chores:
        if c["assignee"] not in member_id_by_key:
            print(f"ERROR: chore '{c['title']}' references unknown member key '{c['assignee']}'.", file=sys.stderr)
            return 1

    today = datetime.now(TZ).date()
    verb = "Refreshing" if args.refresh else "Seeding"
    print(f"{verb} '{household['name']}' for {today.isoformat()} (America/Chicago) ...")

    with psycopg.connect(direct_url) as conn:            # one transaction, commits on clean exit
        with conn.cursor() as cur:
            # Household and members are always strict on-conflict-do-nothing.
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
            if args.refresh:
                # Opt-in only: drop the fixed-ID instances so they re-insert dated
                # today (and reset to not-done). Instances only — never household
                # or members.
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

    if args.refresh:
        print(f"  refreshed {len(chores)} chore instance(s) to {today.isoformat()}.")
    else:
        print(f"  household: 1 | members: {len(members)} | chore_instances for today: {len(chores)}")
        print("Seed complete. Existing rows (matching id) were left untouched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
