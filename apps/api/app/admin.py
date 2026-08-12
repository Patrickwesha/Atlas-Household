"""The parent dashboard: sign in, and edit chore definitions.

Its own router with its own dependency (`current_adult`), mounted separately in
main.py exactly like the other three. That separation is the whole security
model: the kiosk's device token cannot reach a single route in this file, and
nothing here can complete a chore on the wall.

WHAT THIS DELIBERATELY CANNOT DO:

- DELETE. There is no delete route for a definition, an assignment set or a
  member. Retiring a chore is `is_active = false`. The FKs are `on delete
  restrict` precisely so history survives, and an endpoint that fought them
  would be arguing with the schema.
- Rewrite history. Every field here is either snapshotted onto the instance at
  creation (`name` -> title, `cutoff_time` -> cutoff_at) or read live on purpose
  (`sort_order`). Editing a definition changes what happens TOMORROW; it cannot
  change what the board said last Tuesday. See PREVIEW below.
- Assign a dependent. Enforced here, in the API, not only in the UI — the same
  rule seed.py enforces, for the same reason: a dependent cannot complete a
  chore, so the row would be one nobody can ever clear.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from uuid import UUID

import psycopg
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, status
from psycopg.rows import DictRow

from . import config
from .auth import current_adult, issue_session
from .db import get_db
from .materialize import week_parity_of, weekday_of
from .schemas import (
    AdminDefinition,
    AssignmentSpec,
    DefinitionWrite,
    LoginRequest,
    LoginResponse,
    Member,
    PreviewResult,
    PreviewRow,
)

# Login is the one route that cannot require a session, so it lives on its own
# router with NO dependency. Everything else hangs off `protected`.
public = APIRouter(prefix="/api/admin")
protected = APIRouter(prefix="/api/admin", dependencies=[Depends(current_adult)])

_hasher = PasswordHasher()


def _parse_hhmm(value: str | None) -> str | None:
    """"HH:MM" -> "HH:MM", or None. Rejects anything else.

    Validated here rather than left to Postgres: a bad time would otherwise
    surface as a driver error the dashboard cannot show a person.
    """
    if value is None or value == "":
        return None
    parts = value.split(":")
    if len(parts) != 2:
        raise HTTPException(422, "cutoff_time must be HH:MM or empty")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise HTTPException(422, "cutoff_time must be HH:MM or empty") from None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise HTTPException(422, "cutoff_time must be HH:MM or empty")
    return f"{hour:02d}:{minute:02d}"


def _reject_dependents(
    conn: psycopg.Connection[DictRow], assignments: list[AssignmentSpec]
) -> None:
    """Refuse any assignment to a dependent, or to a member of another household.

    IN THE API, NOT THE UI. A dependent cannot complete a chore — the kiosk
    gives them no tile and routes.py refuses the write — so materializing one
    creates a row that literally nobody can ever clear, which then sits on the
    board forever as an un-done chore. A CHECK constraint cannot express this
    because it would have to reach members.role, so this is the enforcement
    point and it must not move to the client.
    """
    if not assignments:
        return
    ids = list({a.member_id for a in assignments})
    rows = conn.execute(
        "select id, name, role from members where id = any(%s) and household_id = %s",
        (ids, config.HOUSEHOLD_ID),
    ).fetchall()
    known = {r["id"]: r for r in rows}
    for member_id in ids:
        row = known.get(member_id)
        if row is None:
            raise HTTPException(422, f"No such member in this household: {member_id}")
        if row["role"] == "dependent":
            raise HTTPException(
                422,
                f"{row['name']} is a dependent and cannot be assigned a chore — "
                "nobody would be able to mark it done.",
            )


def _load_definitions(conn: psycopg.Connection[DictRow]) -> list[dict[str, Any]]:
    defs = conn.execute(
        "select id, name, area, cadence, "
        "       to_char(cutoff_time, 'HH24:MI') as cutoff_time, "
        "       sort_order, is_active "
        "  from chore_definitions where household_id = %s "
        " order by sort_order, name",
        (config.HOUSEHOLD_ID,),
    ).fetchall()
    assignments = conn.execute(
        "select a.definition_id, a.member_id, a.day_of_week, a.week_parity "
        "  from chore_assignments a join chore_definitions d on d.id = a.definition_id "
        " where d.household_id = %s "
        " order by a.day_of_week, a.member_id",
        (config.HOUSEHOLD_ID,),
    ).fetchall()
    by_def: dict[UUID, list[AssignmentSpec]] = {}
    for a in assignments:
        by_def.setdefault(a["definition_id"], []).append(
            AssignmentSpec(
                member_id=a["member_id"],
                day_of_week=a["day_of_week"],
                week_parity=a["week_parity"],
            )
        )
    return [{**d, "assignments": by_def.get(d["id"], [])} for d in defs]


@public.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest, conn: psycopg.Connection[DictRow] = Depends(get_db)
) -> LoginResponse:
    """Exchange email + password for an 8-hour session token.

    The failure message is identical for an unknown email, a wrong password and
    a non-adult account. Distinguishing them turns this into an oracle for which
    addresses exist.
    """
    if config.SESSION_SECRET is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Dashboard sign-in is not configured on this server.",
        )
    row = conn.execute(
        "select c.member_id, c.password_hash, m.name, m.role "
        "  from member_credentials c join members m on m.id = c.member_id "
        " where lower(c.email) = lower(%s) and m.household_id = %s",
        (body.email, config.HOUSEHOLD_ID),
    ).fetchone()

    bad = HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong email or password")
    if row is None:
        # Hash anyway, so a missing account does not answer noticeably faster
        # than a wrong password.
        _hasher.hash(body.password)
        raise bad
    try:
        _hasher.verify(row["password_hash"], body.password)
    except VerifyMismatchError:
        raise bad from None
    except Exception:
        raise bad from None
    if row["role"] != "adult":
        raise bad

    token, expires = issue_session(row["member_id"])
    return LoginResponse(
        token=token,
        expires_at=expires,
        member_id=row["member_id"],
        member_name=row["name"],
    )


@protected.get("/members", response_model=list[Member])
def list_members(conn: psycopg.Connection[DictRow] = Depends(get_db)) -> list[Member]:
    """Everyone in the household, so the editor can offer them.

    Dependents ARE returned, with their role, so the UI can show them greyed
    with a reason rather than silently omitting them — a name that is simply
    missing reads as a bug. The API still refuses to assign them.
    """
    rows = conn.execute(
        "select id, name, role, color from members where household_id = %s "
        "order by created_at",
        (config.HOUSEHOLD_ID,),
    ).fetchall()
    return [Member(**r) for r in rows]


@protected.get("/definitions", response_model=list[AdminDefinition])
def list_definitions(
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> list[AdminDefinition]:
    return [AdminDefinition(**d) for d in _load_definitions(conn)]


@protected.put("/definitions/{definition_id}", response_model=AdminDefinition)
def update_definition(
    definition_id: UUID,
    body: DefinitionWrite,
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> AdminDefinition:
    """Update a definition's editable fields and replace its assignment set.

    The assignment set is REPLACED rather than merged, because "who does this
    chore" is a whole answer — a merge cannot express removing someone, and a
    dashboard that can add an assignment but not remove one is a trap.

    Deliberately NOT updating `cadence`: descriptive only, never read by the
    materializer, and changing it would imply a schedule change that does not
    happen.
    """
    cutoff = _parse_hhmm(body.cutoff_time)
    _reject_dependents(conn, body.assignments)

    with conn.transaction():
        updated = conn.execute(
            "update chore_definitions set name = %s, area = %s, cutoff_time = %s, "
            "       sort_order = %s, is_active = %s "
            " where id = %s and household_id = %s returning id",
            (
                body.name,
                body.area,
                cutoff,
                body.sort_order,
                body.is_active,
                definition_id,
                config.HOUSEHOLD_ID,
            ),
        ).fetchone()
        if updated is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such chore")
        # Replace the set. Safe against history: assignments only ever decide
        # what a FUTURE materialization creates. Instances already on the board
        # hold their own definition_id and are untouched.
        conn.execute(
            "delete from chore_assignments where definition_id = %s", (definition_id,)
        )
        for a in body.assignments:
            conn.execute(
                "insert into chore_assignments "
                "(definition_id, member_id, day_of_week, week_parity) "
                "values (%s, %s, %s, %s) "
                "on conflict (definition_id, member_id, day_of_week) do nothing",
                (definition_id, a.member_id, a.day_of_week, a.week_parity),
            )

    found = next(
        (d for d in _load_definitions(conn) if d["id"] == definition_id), None
    )
    if found is None:  # pragma: no cover — the update above just succeeded
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such chore")
    return AdminDefinition(**found)


@protected.post("/definitions/{definition_id}/preview", response_model=PreviewResult)
def preview_definition(
    definition_id: UUID,
    body: DefinitionWrite,
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> PreviewResult:
    """What saving this would do to TOMORROW. Writes nothing.

    Computed against the SAME rule the materializer uses — weekday_of and
    week_parity_of, imported, not reimplemented — because a preview that
    disagrees with what actually happens is worse than no preview. That is the
    lesson already recorded on SCHEDULE_WHERE in app/materialize.py.

    Tomorrow, not today: today's rows already exist and this change cannot
    touch them.
    """
    _reject_dependents(conn, body.assignments)
    tomorrow = (
        conn.execute(
            "select ((now() at time zone %s)::date + 1) as d", (config.APP_TIMEZONE,)
        ).fetchone()
        or {"d": date.today() + timedelta(days=1)}
    )["d"]
    dow, parity = weekday_of(tomorrow), week_parity_of(tomorrow)

    names = {
        r["id"]: r["name"]
        for r in conn.execute(
            "select id, name from members where household_id = %s",
            (config.HOUSEHOLD_ID,),
        ).fetchall()
    }

    def scheduled(
        assignments: list[AssignmentSpec], active: bool, title: str
    ) -> set[tuple[str, str]]:
        if not active:
            return set()
        return {
            (names.get(a.member_id, "someone"), title)
            for a in assignments
            if a.day_of_week == dow
            and (a.week_parity is None or a.week_parity == parity)
        }

    current = next(
        (d for d in _load_definitions(conn) if d["id"] == definition_id), None
    )
    if current is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such chore")

    before = scheduled(current["assignments"], current["is_active"], current["name"])
    after = scheduled(body.assignments, body.is_active, body.name)

    return PreviewResult(
        due_on=tomorrow,
        appear=[PreviewRow(member_name=m, title=t) for m, t in sorted(after - before)],
        disappear=[
            PreviewRow(member_name=m, title=t) for m, t in sorted(before - after)
        ],
    )
