"""The kiosk API: today's board, plus complete / uncomplete for one instance.

Every route is guarded by require_kiosk (router-level dependency). "today" is
resolved server-side in the configured timezone, and every query is scoped to
the configured HOUSEHOLD_ID — explicit, never an implicit "first row" lookup.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from psycopg.rows import DictRow

from . import config
from .auth import require_kiosk
from .db import get_db
from .materialize import materialize
from .schemas import Board, CompleteRequest, Household, Instance, Member

router = APIRouter(prefix="/api", dependencies=[Depends(require_kiosk)])

log = logging.getLogger(__name__)

# Ordered by the definition's sort_order, joined rather than snapshotted.
#
# sort_order is the one field it is CORRECT to read live. title is snapshotted
# onto the instance because rewriting what the board said last Tuesday would be
# rewriting history — but re-ordering last Tuesday's rows changes nothing that
# was ever true about them. So this joins for it, and a re-ordering takes effect
# everywhere at once instead of only on days materialized afterwards.
#
# NULLS LAST is for the slice-1 rows: they have no definition_id, so the LEFT
# JOIN gives them a NULL sort_order. They sink to the bottom rather than sorting
# anywhere in particular. (Postgres already defaults ascending NULLs last — said
# out loud because the behaviour is load-bearing, not incidental.)
#
# ci.id is the final tiebreak, and it is not decoration: without it, two rows
# with the same sort_order and title have an order Postgres may vary between
# queries, which on a 60-second poll means rows swapping places under a finger.
# That failure mode cost three rounds of the gauntlet.
_INSTANCES_FOR_DAY = (
    "select ci.id, ci.assignee_id, ci.title, ci.due_on, ci.completed_at, ci.completed_by "
    "from chore_instances ci "
    "left join chore_definitions d on d.id = ci.definition_id "
    "where ci.household_id = %s and ci.due_on = %s "
    "order by d.sort_order nulls last, ci.title, ci.id"
)


def _today() -> date:
    return datetime.now(ZoneInfo(config.APP_TIMEZONE)).date()


def _self_heal(conn: psycopg.Connection[DictRow], due_on: date) -> bool:
    """Last line of defence for an empty board. Returns True if it created rows.

    Two Vercel crons already materialize each day (08:00 and 11:00 UTC). This
    catches the case where both failed — a Neon cold start that timed out, a bad
    deploy, a platform incident — because the cost of that is a kid walking up to
    a blank wall on a school morning, and there is no longer a seed.py habit
    standing behind it.

    It is bounded hard, and every bound matters:

    - ONLY when the day has ZERO instances. It can never add to a day that
      already has one row, so it cannot duplicate a chore, cannot resurrect one
      an adult cleared, and cannot appear underneath a tap in flight.
    - It can only ever create the rows the cron would have created anyway. The
      kiosk token gains no power to invent a chore that was not already
      scheduled.
    - EVERY exception is swallowed. A materializer bug must never turn into
      "Can't load the board" on the wall: a board that renders yesterday's
      emptiness is bad, and a board that renders an error card is worse. This is
      a safety net, and a safety net that can take down the thing it protects is
      not one.

    Concurrency needs no lock — the unique index from 0002 plus `on conflict do
    nothing` makes the loser of any race a no-op.
    """
    try:
        return len(materialize(conn, config.HOUSEHOLD_ID, due_on)) > 0
    except Exception:
        log.exception("Board self-heal failed for %s; serving the board as-is", due_on)
        return False


@router.get("/board", response_model=Board)
def get_board(conn: psycopg.Connection[DictRow] = Depends(get_db)) -> Board:
    household = conn.execute(
        "select id, name from households where id = %s",
        (config.HOUSEHOLD_ID,),
    ).fetchone()
    if household is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Configured HOUSEHOLD_ID does not exist",
        )
    members = conn.execute(
        "select id, name, role, color from members "
        "where household_id = %s order by created_at",
        (config.HOUSEHOLD_ID,),
    ).fetchall()
    today = _today()
    instances = conn.execute(
        _INSTANCES_FOR_DAY, (config.HOUSEHOLD_ID, today)
    ).fetchall()
    # Re-read only when the heal actually inserted something, so the rows land in
    # THIS response. Handing back an empty board and letting the next 60s poll
    # pick them up would mean the kid standing there is shown "nothing today".
    if not instances and _self_heal(conn, today):
        instances = conn.execute(
            _INSTANCES_FOR_DAY, (config.HOUSEHOLD_ID, today)
        ).fetchall()
    return Board(
        household=Household(**household),
        members=[Member(**m) for m in members],
        instances=[Instance(**i) for i in instances],
    )


@router.post("/instances/{instance_id}/complete", response_model=Instance)
def complete_instance(
    instance_id: UUID,
    body: CompleteRequest,
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> Instance:
    completer = conn.execute(
        "select role from members where id = %s and household_id = %s",
        (body.completed_by, config.HOUSEHOLD_ID),
    ).fetchone()
    if completer is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="completed_by is not a member of this household",
        )
    if completer["role"] == "dependent":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A dependent cannot complete a chore",
        )
    # coalesce -> the first completer sticks, so a second tap is a true no-op.
    row = conn.execute(
        "update chore_instances "
        "set completed_at = coalesce(completed_at, now()), "
        "    completed_by = coalesce(completed_by, %s) "
        "where id = %s and household_id = %s "
        "returning id, assignee_id, title, due_on, completed_at, completed_by",
        (body.completed_by, instance_id, config.HOUSEHOLD_ID),
    ).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Instance not found"
        )
    return Instance(**row)


@router.post("/instances/{instance_id}/uncomplete", response_model=Instance)
def uncomplete_instance(
    instance_id: UUID,
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> Instance:
    row = conn.execute(
        "update chore_instances set completed_at = null, completed_by = null "
        "where id = %s and household_id = %s "
        "returning id, assignee_id, title, due_on, completed_at, completed_by",
        (instance_id, config.HOUSEHOLD_ID),
    ).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Instance not found"
        )
    return Instance(**row)
