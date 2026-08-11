"""Pydantic request/response models — the API's typed contract. mypy checks
these against the route signatures, so a mismatched field surfaces at check time.
"""

from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel


class Household(BaseModel):
    id: UUID
    name: str


class Member(BaseModel):
    id: UUID
    name: str
    role: str
    color: str


class Instance(BaseModel):
    id: UUID
    assignee_id: UUID
    title: str
    due_on: date
    completed_at: datetime | None
    completed_by: UUID | None
    # Snapshotted at materialization from the definition's cutoff_time, resolved
    # in the household timezone. null means this chore has no deadline — never
    # "already late".
    cutoff_at: datetime | None


class Board(BaseModel):
    household: Household
    members: list[Member]
    instances: list[Instance]
    # The DATABASE's clock at the moment this board was built — the same clock
    # that resolved every cutoff_at above.
    #
    # Sent because the kiosk must not decide what is late from its own clock. A
    # wall iPad with a skewed clock is a recorded failure (GAUNTLET-01, FIX NEXT
    # SLICE 19 and 20), and here it would turn chores red early or leave them
    # green long after the deadline. The client anchors on this instant and then
    # only measures ELAPSED time from it, which is the one thing a wrong clock
    # still does correctly.
    server_time: datetime


class CompleteRequest(BaseModel):
    completed_by: UUID


class MaterializeResult(BaseModel):
    """What the nightly cron reports. `created` is 0 on every run after the
    day's first — that is success, not a failure to find work."""

    due_on: date
    created: int


class HistoryDay(BaseModel):
    """One date that HAS instances for this member.

    A date ABSENT from History.days has no instances at all, and the calendar
    must draw that differently from a day with total > 0 and completed == 0.
    "0 of 4 done" is a real, bad day. "no rows exist" is a day before this
    system was tracking anything, and drawing it as an empty ring would tell a
    kid they failed on a day nobody was asking.
    """

    date: date
    total: int
    completed: int


class History(BaseModel):
    """A month of one member's completion history, plus the two bounds the
    calendar needs in order to refuse to navigate somewhere meaningless.

    `today` and `first_date` are here rather than left to the client on
    purpose. The kiosk's own clock is not trustworthy for this — a wall iPad
    with a skewed or wrong clock is a recorded, reproduced failure (see
    GAUNTLET-01, FIX NEXT SLICE 19 and 20), and a browser that thinks it is a
    different month would grey out the wrong days and hide real history. Both
    dates are resolved server-side in APP_TIMEZONE, the same zone the board
    resolves "today" in.
    """

    member_id: UUID
    # Normalised "YYYY-MM" — echoes back what was actually served, which is not
    # always what was asked for (an omitted month means "the current one").
    month: str
    today: date
    # The member's earliest instance of any date, or null if they have none.
    # The calendar stops paging back here: there is nothing before it but
    # blank months, and paging into them looks like data loss.
    first_date: date | None
    days: list[HistoryDay]
