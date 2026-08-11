"""The kiosk API: today's board, plus complete / uncomplete for one instance.

Every route is guarded by require_kiosk (router-level dependency). "today" is
resolved server-side in the configured timezone, and every query is scoped to
the configured HOUSEHOLD_ID — explicit, never an implicit "first row" lookup.
"""

from __future__ import annotations

import logging
import re
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
from .schemas import (
    Board,
    CompleteRequest,
    History,
    HistoryDay,
    Household,
    Instance,
    Member,
)

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
    "select ci.id, ci.assignee_id, ci.title, ci.due_on, ci.completed_at, ci.completed_by, "
    "       ci.cutoff_at "
    "from chore_instances ci "
    "left join chore_definitions d on d.id = ci.definition_id "
    "where ci.household_id = %s and ci.due_on = %s "
    "order by d.sort_order nulls last, ci.title, ci.id"
)


# WHY `definition_id is not null` IS IN BOTH QUERIES BELOW, AND MUST STAY.
#
# It is the machine-readable line between "the chore system tracked this day"
# and "this day predates the chore system". Every instance the materializer
# creates carries a definition_id; the slice-1 rows seeded from `chores_today`
# carry NULL, and always will — nothing backfills them, and 0002 added the
# column nullable precisely so they survived untouched.
#
# Without the filter, a day whose only row is a leftover slice-1 chore renders
# as a FULL DIAL — a flawless day — because 1 of 1 was completed. That is
# literally true and completely misleading: the system was not running, nobody
# was asked for anything, and the calendar would be handing out a perfect score
# for a day it never watched. Dashed is the honest answer, and this is what
# makes it possible to say so without deleting anything (see CLAUDE.md,
# "deactivate, never delete").
#
# THIS DELIBERATELY MAKES /api/history AND /api/board DISAGREE for any date
# holding legacy rows. It is not a bug and must not be "fixed" by aligning
# them: the board answers "what is due today", which includes a legacy row a
# kid can still tap; history answers "what did this system track", which a
# legacy row was never part of. Two different questions, two correct answers.
#
# count(ci.completed_at) counts NON-NULL values, so it is the completed tally.
# count(*) is every row. Both scoped by household AND assignee: household_id
# alone would leak a sibling's day into this member's calendar.
_HISTORY_FOR_MONTH = (
    "select ci.due_on as date, count(*) as total, count(ci.completed_at) as completed "
    "from chore_instances ci "
    "where ci.household_id = %s and ci.assignee_id = %s "
    "and ci.definition_id is not null "
    "and ci.due_on >= %s and ci.due_on < %s "
    "group by ci.due_on "
    "order by ci.due_on"
)

# Where the calendar stops paging back. Everything before this is blank months,
# and letting someone scroll into them looks like history that got lost.
#
# Filtered identically to the query above, and that consistency is the point: a
# first_date derived from an untracked legacy row would let the calendar page
# back to a month whose every square is dashed, which reads as lost history
# rather than as history that never existed.
_FIRST_INSTANCE_FOR_MEMBER = (
    "select min(ci.due_on) as first_date from chore_instances ci "
    "where ci.household_id = %s and ci.assignee_id = %s "
    "and ci.definition_id is not null"
)

_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def _today() -> date:
    return datetime.now(ZoneInfo(config.APP_TIMEZONE)).date()


def _month_bounds(month_start: date) -> tuple[date, date]:
    """First day of the month, and first day of the NEXT month.

    A half-open range, so the query needs no knowledge of month lengths and no
    special case for February or for December rolling the year.
    """
    start = month_start.replace(day=1)
    end = (
        date(start.year + 1, 1, 1)
        if start.month == 12
        else date(start.year, start.month + 1, 1)
    )
    return start, end


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
        return len(materialize(conn, config.HOUSEHOLD_ID, due_on, config.APP_TIMEZONE)) > 0
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
    # Read AFTER the self-heal, so the instant returned is never older than the
    # rows returned with it. Taken from the DATABASE rather than this process:
    # it is the same clock that resolved every cutoff_at, so lateness is decided
    # against one clock end to end rather than two that can drift apart.
    server_time = conn.execute("select now() as t").fetchone()
    assert server_time is not None  # `select now()` always returns a row
    return Board(
        household=Household(**household),
        members=[Member(**m) for m in members],
        instances=[Instance(**i) for i in instances],
        server_time=server_time["t"],
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
        "returning id, assignee_id, title, due_on, completed_at, completed_by, cutoff_at",
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
        "returning id, assignee_id, title, due_on, completed_at, completed_by, cutoff_at",
        (instance_id, config.HOUSEHOLD_ID),
    ).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Instance not found"
        )
    return Instance(**row)


@router.get("/history", response_model=History)
def get_history(
    member_id: UUID,
    month: str | None = None,
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> History:
    """One member's per-day completion counts for a month. READ ONLY.

    Counts ONLY instances that came from a chore_definition. Slice-1 legacy rows
    are excluded, so a day that predates the chore system reads as "no data"
    rather than as a perfect score — see the note above _HISTORY_FOR_MONTH,
    including why this is meant to disagree with GET /board.

    Deliberately NOT like GET /board: this route never materializes anything.
    The board's self-heal exists because an empty wall on a school morning is a
    failure; an empty square on a calendar is just a day that had no chores, and
    writing rows for a date someone happens to scroll past would invent history.

    `month` is OPTIONAL, and that is the point. Omitting it means "the month it
    is now", resolved in APP_TIMEZONE on the server — so the kiosk's first
    request needs no opinion about what today is. Only after this response does
    it know the server's date, and every later decision (which days are future,
    how far back paging may go) is made from `today` and `first_date` here
    rather than from the iPad's clock.

    A dependent is not special-cased. They cannot complete a chore and the kiosk
    gives them no tile, so this returns an empty month for them — but the rule
    that keeps them off the calendar is a UI rule, and putting a role check in a
    read-only counting query would state it in a second place that could later
    disagree with the first.
    """
    known = conn.execute(
        "select 1 from members where id = %s and household_id = %s",
        (member_id, config.HOUSEHOLD_ID),
    ).fetchone()
    if known is None:
        # 404, not an empty month: an unknown id is a bug or a probe, and
        # answering it with a plausible-looking empty calendar hides both.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No such member in this household",
        )

    today = _today()
    if month is None:
        month_start = today
    else:
        if _MONTH_RE.match(month) is None:
            raise HTTPException(
                # UNPROCESSABLE_CONTENT, not UNPROCESSABLE_ENTITY: the latter is
                # deprecated in Starlette 1.3 and emits a warning on every bad
                # month. Same 422 on the wire.
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="month must be YYYY-MM",
            )
        month_start = date(int(month[:4]), int(month[5:7]), 1)

    start, end = _month_bounds(month_start)
    rows = conn.execute(
        _HISTORY_FOR_MONTH, (config.HOUSEHOLD_ID, member_id, start, end)
    ).fetchall()
    first = conn.execute(
        _FIRST_INSTANCE_FOR_MEMBER, (config.HOUSEHOLD_ID, member_id)
    ).fetchone()

    return History(
        member_id=member_id,
        month=f"{start.year:04d}-{start.month:02d}",
        today=today,
        first_date=None if first is None else first["first_date"],
        days=[HistoryDay(**r) for r in rows],
    )
