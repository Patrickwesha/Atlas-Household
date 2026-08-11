"""The late-chore summary, as plain text.

Its own router with its own dependency (`require_outstanding`), mounted
separately from the kiosk router and the cron router in main.py. Three tokens,
three blast radii, and none of them widened — see app/auth.py.

WHY PLAIN TEXT AND NOT JSON: the consumer is an iOS Shortcut, where "Get
Contents of URL" hands back a string and "If <result> has any value" is a single
tile. JSON would need a parse step and a count comparison to express the same
thing, and every extra tile is another place a phone automation quietly breaks.

WHY AN EMPTY BODY RATHER THAN "Nothing is late": so the caller can skip. The
Shortcut's whole logic is `if the body is not empty, send it` — a friendly
sentence would make every run a message, and a reminder that arrives every night
whether or not anything is wrong is one nobody reads by the second week. Same
reasoning as the chime firing once: an alert that is always on is not an alert.

READ ONLY. This route runs one SELECT. It deliberately does NOT materialize the
day the way GET /board does: the board self-heals because an empty wall on a
school morning is a failure worth writing rows to prevent, whereas an empty
summary just means nothing is late, which is the good case.
"""

from __future__ import annotations

import psycopg
from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from psycopg.rows import DictRow

from . import config
from .auth import require_outstanding
from .db import get_db

router = APIRouter(prefix="/api", dependencies=[Depends(require_outstanding)])

# Past cutoff, still not done, today only.
#
# TODAY ONLY, matching the board. A chore from last Tuesday that nobody ever
# ticked is a conversation, not a 9pm text message, and including history would
# make the summary grow without bound until someone tidied the past.
#
# cutoff_at is the snapshot on the instance, not the definition's current
# cutoff_time — so moving a cutoff never retroactively changes who was late.
# A null cutoff_at means no deadline and can never appear here.
_OUTSTANDING = (
    "select m.name as member_name, ci.title, "
    "       to_char(ci.cutoff_at at time zone %s, 'FMHH12:MI AM') as due_label "
    "  from chore_instances ci "
    "  join members m on m.id = ci.assignee_id "
    " where ci.household_id = %s "
    "   and ci.due_on = (now() at time zone %s)::date "
    "   and ci.cutoff_at is not null "
    "   and ci.cutoff_at < now() "
    "   and ci.completed_at is null "
    " order by ci.cutoff_at, m.name, ci.title"
)


@router.get("/outstanding", response_class=PlainTextResponse)
def get_outstanding(
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> PlainTextResponse:
    """One line per late chore, or an empty body when nothing is late.

        LD — Take out trash (6:15 PM)
        Panashe — Wash dishes / unload dishwasher (9:30 PM)

    The title is the instance's snapshot, so it reads as what the board actually
    said that day rather than as whatever the definition is called now.
    """
    rows = conn.execute(
        _OUTSTANDING,
        (config.APP_TIMEZONE, config.HOUSEHOLD_ID, config.APP_TIMEZONE),
    ).fetchall()
    body = "\n".join(
        f"{r['member_name']} — {r['title']} ({r['due_label']})" for r in rows
    )
    # No trailing newline on an empty body: "" must be falsy to the Shortcut,
    # and "\n" is not.
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8")
