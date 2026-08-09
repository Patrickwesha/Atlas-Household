"""
verify_api.py — assert the API's auth separation and the board self-heal, over real HTTP.

Two things that cannot be checked against the database alone:

1. THE TWO TOKENS DO NOT OVERLAP. The kiosk device token must not reach the
   materializer, and the cron secret must not reach the board or the write
   endpoints. This is the whole reason require_cron is a separate dependency
   rather than a branch inside require_kiosk, and a regression here would be
   invisible until someone went looking.

2. THE SELF-HEAL IS BOUNDED AND CANNOT BLANK THE WALL. The board materializes an
   empty day, in the same response — but only an empty one, and never at the cost
   of returning an error to a kid standing in the kitchen.

Boots uvicorn as a subprocess and talks to it with stdlib urllib. No test runner,
no HTTP client dependency.

POINT IT AT A SCRATCH DATABASE — it writes and truncates. Refuses a Neon URL.

    VERIFY_DATABASE_URL=postgresql://localhost/atlas_verify uv run python verify_api.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import DictRow, dict_row

HOUSEHOLD = UUID("00000000-0000-0000-0000-0000000000f2")
KIOSK_TOKEN = "kiosk-token-for-verification-only"
CRON_SECRET = "cron-secret-for-verification-only"
PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"

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


def call(path: str, token: str | None = None, method: str = "GET", body: Any = None) -> tuple[int, Any]:
    """Returns (status, parsed body-or-None). A 4xx/5xx is a result, not an error."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", method=method, data=data)
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as exc:
        return exc.code, None


def seed(conn: psycopg.Connection[Any]) -> None:
    """One household, one daily all-hands definition for two people."""
    conn.execute("truncate chore_instances, chore_assignments, chore_definitions, members, households cascade")
    conn.execute("insert into households (id, name) values (%s, 'Self-heal House')", (HOUSEHOLD,))
    ids = {}
    for name in ("Ada", "Ben"):
        ids[name] = q(conn, 
            "insert into members (household_id, name, role, color) values (%s,%s,'kid','#000') returning id",
            (HOUSEHOLD, name),
        )["id"]
    did = q(conn, 
        "insert into chore_definitions (household_id, name, cadence) values (%s,'Daily chore','daily') returning id",
        (HOUSEHOLD,),
    )["id"]
    for member in ids.values():
        for day in range(7):
            conn.execute(
                "insert into chore_assignments (definition_id, member_id, day_of_week) values (%s,%s,%s)",
                (did, member, day),
            )


def boot(env_extra: dict[str, str], url: str) -> subprocess.Popen[bytes]:
    env = {**os.environ, "DATABASE_URL": url, "HOUSEHOLD_ID": str(HOUSEHOLD),
           "DEVICE_TOKEN": KIOSK_TOKEN, "ALLOWED_ORIGINS": "", **env_extra}
    env.pop("CRON_SECRET", None)
    env.update(env_extra)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT), "--log-level", "warning"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        time.sleep(0.1)
        try:
            call("/api/board", KIOSK_TOKEN)
            return proc
        except Exception:
            continue
    proc.kill()
    raise RuntimeError("uvicorn did not come up")


def main() -> int:
    url = os.environ.get("VERIFY_DATABASE_URL", "").strip()
    if not url:
        print("ERROR: set VERIFY_DATABASE_URL to a SCRATCH database.", file=sys.stderr)
        return 2
    if "neon.tech" in url:
        print("ERROR: VERIFY_DATABASE_URL looks like Neon. This script truncates tables.", file=sys.stderr)
        return 2

    today = datetime.now(ZoneInfo(os.environ.get("APP_TIMEZONE", "America/Chicago"))).date()
    conn = psycopg.connect(url, autocommit=True, row_factory=dict_row)
    rows_today = lambda: conn.execute(  # noqa: E731
        "select id, completed_at from chore_instances where due_on = %s order by id", (today,)
    ).fetchall()

    seed(conn)
    proc = boot({"CRON_SECRET": CRON_SECRET}, url)
    try:
        print("\nAuth separation — the two tokens must not overlap")
        check("kiosk token reads the board", call("/api/board", KIOSK_TOKEN)[0] == 200)
        check("kiosk token is REFUSED by the materializer",
              call("/api/cron/materialize", KIOSK_TOKEN)[0] == 401)
        check("cron secret runs the materializer",
              call("/api/cron/materialize", CRON_SECRET)[0] == 200)
        check("cron secret is REFUSED by the board", call("/api/board", CRON_SECRET)[0] == 401)
        check("cron secret is REFUSED by /complete",
              call("/api/instances/00000000-0000-0000-0000-000000000000/complete",
                   CRON_SECRET, "POST", {"completed_by": str(HOUSEHOLD)})[0] == 401)
        check("no token is refused everywhere",
              call("/api/board")[0] == 401 and call("/api/cron/materialize")[0] == 401)
        check("the OpenAPI schema is not public", call("/openapi.json")[0] == 404)

        print("\nThe materializer endpoint")
        conn.execute("delete from chore_instances")
        status, body = call("/api/cron/materialize", CRON_SECRET)
        check("first run of the day creates rows", status == 200 and body["created"] == 2,
              f"got {body}")
        status, body = call("/api/cron/materialize", CRON_SECRET)
        check("the second cron of the day is a true no-op (created=0, not an error)",
              status == 200 and body["created"] == 0, f"got {body}")

        print("\nBoard self-heal")
        conn.execute("delete from chore_instances")
        status, board = call("/api/board", KIOSK_TOKEN)
        check("an empty day is healed IN THE SAME RESPONSE, not on the next poll",
              status == 200 and len(board["instances"]) == 2,
              f"got {len(board['instances']) if board else None} instances")
        before = [r["id"] for r in rows_today()]
        call("/api/board", KIOSK_TOKEN)
        check("a second board load creates nothing further",
              [r["id"] for r in rows_today()] == before)

        # The bound that matters: it must never add to a day that already has a row.
        conn.execute("delete from chore_instances where id = %s", (before[0],))
        call("/api/board", KIOSK_TOKEN)
        check("a PARTIALLY populated day is left alone — the heal is empty-only",
              len(rows_today()) == 1,
              f"got {len(rows_today())} rows; the heal fired on a non-empty day")

        # "All done" must not read as "empty".
        conn.execute("delete from chore_instances")
        call("/api/cron/materialize", CRON_SECRET)
        conn.execute("update chore_instances set completed_at = now() where due_on = %s", (today,))
        done_before = rows_today()
        call("/api/board", KIOSK_TOKEN)
        done_after = rows_today()
        check("a fully completed day is not re-materialized and completions are intact",
              [(r["id"], r["completed_at"]) for r in done_before]
              == [(r["id"], r["completed_at"]) for r in done_after])

        # ---- Board ordering: sort_order, not the alphabet ----
        #
        # This is the reason the change exists: the 8pm family reset is a real
        # chore now, and alphabetically "15-minute family reset" sorts to the TOP
        # of the list — above chores due at breakfast. Ordering by the
        # definition's sort_order puts the end of the day at the end of the list.
        print("\nBoard ordering (sort_order, joined live — not the alphabet)")
        conn.execute("delete from chore_instances")
        ada = q(conn, "select id from members where name = 'Ada'")["id"]
        # Deliberately adversarial: sort_order ascending is the exact REVERSE of
        # alphabetical, so a board that fell back to `order by title` cannot
        # accidentally pass this.
        for name, order in [("Zebra chore", 10), ("Middle chore", 20), ("Apple chore", 30)]:
            did = q(conn,
                "insert into chore_definitions (household_id, name, cadence, sort_order) "
                "values (%s,%s,'daily',%s) returning id", (HOUSEHOLD, name, order))["id"]
            conn.execute(
                "insert into chore_instances (household_id, assignee_id, definition_id, title, due_on) "
                "values (%s,%s,%s,%s,%s)", (HOUSEHOLD, ada, did, name, today))
        # A slice-1 row: no definition, therefore no sort_order. Named to sort
        # FIRST alphabetically, so "sinks to the bottom" is a real assertion.
        conn.execute(
            "insert into chore_instances (household_id, assignee_id, title, due_on) "
            "values (%s,%s,'AAA hand-seeded legacy',%s)", (HOUSEHOLD, ada, today))

        _, board = call("/api/board", KIOSK_TOKEN)
        got = [i["title"] for i in board["instances"] if i["assignee_id"] == str(ada)]
        check("the board orders by sort_order, not alphabetically",
              got == ["Zebra chore", "Middle chore", "Apple chore", "AAA hand-seeded legacy"],
              f"got {got}")
        check("a slice-1 row with no definition sinks to the bottom (NULLS LAST)",
              got[-1] == "AAA hand-seeded legacy", f"got {got}")
        check("the order is stable across polls — rows must not move under a finger",
              all([i["title"] for i in call("/api/board", KIOSK_TOKEN)[1]["instances"]
                   if i["assignee_id"] == str(ada)] == got for _ in range(5)))

        # The whole point, stated as the case that prompted it.
        conn.execute("delete from chore_instances")
        # Only the three just created — they have no assignments. Anything wider
        # hits `on delete restrict` on the seeded definition, which is the FK
        # doing its job: a definition with history cannot be deleted, only
        # deactivated.
        conn.execute(
            "delete from chore_definitions where household_id = %s and name = any(%s)",
            (HOUSEHOLD, ["Zebra chore", "Middle chore", "Apple chore"]),
        )
        reset_def = q(conn,
            "insert into chore_definitions (household_id, name, cadence, sort_order) "
            "values (%s,'15-minute family reset','daily',90) returning id", (HOUSEHOLD,))["id"]
        morning_def = q(conn,
            "insert into chore_definitions (household_id, name, cadence, sort_order) "
            "values (%s,'Make your bed','daily',10) returning id", (HOUSEHOLD,))["id"]
        for did, title in [(reset_def, "15-minute family reset"), (morning_def, "Make your bed")]:
            conn.execute(
                "insert into chore_instances (household_id, assignee_id, definition_id, title, due_on) "
                "values (%s,%s,%s,%s,%s)", (HOUSEHOLD, ada, did, title, today))
        _, board = call("/api/board", KIOSK_TOKEN)
        got = [i["title"] for i in board["instances"] if i["assignee_id"] == str(ada)]
        check("the 8pm family reset lands LAST, not first as the alphabet would have it",
              got == ["Make your bed", "15-minute family reset"], f"got {got}")
    finally:
        proc.terminate()
        proc.wait(timeout=10)

    # The most important one: a broken materializer must not take the board down.
    print("\nThe self-heal cannot blank the wall")
    conn.execute("delete from chore_instances")
    conn.execute("alter table chore_assignments rename to chore_assignments_hidden")
    proc = boot({"CRON_SECRET": CRON_SECRET}, url)
    try:
        status, board = call("/api/board", KIOSK_TOKEN)
        check("with the materializer guaranteed to raise, the board still returns 200",
              status == 200, f"got {status} — a self-heal that can 500 the board is worse than none")
        check("and it still serves the household and members it does have",
              board is not None and len(board["members"]) == 2)
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        conn.execute("alter table chore_assignments_hidden rename to chore_assignments")

    print("\nCRON_SECRET unset must fail CLOSED")
    proc = boot({}, url)
    try:
        check("the materializer refuses even a correct-looking secret",
              call("/api/cron/materialize", CRON_SECRET)[0] == 401)
        check("and refuses an empty bearer", call("/api/cron/materialize", "")[0] == 401)
        check("while the kiosk board keeps working", call("/api/board", KIOSK_TOKEN)[0] == 200)
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        conn.close()

    print(f"\n{checks_run} checks, {len(failures)} failed.")
    if failures:
        for name in failures:
            print(f"  FAILED: {name}")
        return 1
    print("Auth separation and self-heal bounds hold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
