"""The nightly materializer endpoint.

Its own router with its own dependency (`require_cron`), mounted separately from
the kiosk router in main.py. The kiosk device token cannot reach this, and this
secret cannot reach the board. That separation is the point — see app/auth.py.

WHY THIS IS A GET THAT WRITES: Vercel Cron issues GET and only GET. That is a
platform constraint, not a preference. It is the reason this lives behind its own
dependency on its own router rather than anywhere near the read endpoints.
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends
from psycopg.rows import DictRow

from . import config
from .auth import require_cron
from .db import get_db
from .materialize import materialize
from .schemas import MaterializeResult

router = APIRouter(prefix="/api/cron", dependencies=[Depends(require_cron)])


def _today() -> date:
    return datetime.now(ZoneInfo(config.APP_TIMEZONE)).date()


@router.get("/materialize", response_model=MaterializeResult)
def run_materializer(
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> MaterializeResult:
    """Create today's chore instances. Idempotent — running it again is a no-op.

    There is deliberately NO date parameter. The CLI (apps/api/materialize.py)
    is the only thing that can aim this at an arbitrary day; a date override
    reachable on a public URL is a way to quietly write rows into last March.

    `created` is what a Vercel run log should show: a number on the first run of
    the day and 0 on the second cron, which is how you tell "it ran" apart from
    "it ran and had work to do".
    """
    due_on = _today()
    created = materialize(conn, config.HOUSEHOLD_ID, due_on, config.APP_TIMEZONE)
    return MaterializeResult(due_on=due_on, created=len(created))
