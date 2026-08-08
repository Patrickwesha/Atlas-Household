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


class Board(BaseModel):
    household: Household
    members: list[Member]
    instances: list[Instance]


class CompleteRequest(BaseModel):
    completed_by: UUID


class MaterializeResult(BaseModel):
    """What the nightly cron reports. `created` is 0 on every run after the
    day's first — that is success, not a failure to find work."""

    due_on: date
    created: int
