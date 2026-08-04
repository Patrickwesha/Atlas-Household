"""The kiosk API: today's board, plus complete / uncomplete for one instance.

Every route is guarded by require_kiosk (router-level dependency). "today" is
resolved server-side in the configured timezone, and every query is scoped to
the configured HOUSEHOLD_ID — explicit, never an implicit "first row" lookup.
"""

from __future__ import annotations

from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from psycopg.rows import DictRow

from . import config
from .auth import require_kiosk
from .db import get_db
from .schemas import Board, CompleteRequest, Household, Instance, Member

router = APIRouter(prefix="/api", dependencies=[Depends(require_kiosk)])


def _today() -> date:
    return datetime.now(ZoneInfo(config.APP_TIMEZONE)).date()


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
    instances = conn.execute(
        "select id, assignee_id, title, due_on, completed_at, completed_by "
        "from chore_instances where household_id = %s and due_on = %s "
        "order by title",
        (config.HOUSEHOLD_ID, _today()),
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
