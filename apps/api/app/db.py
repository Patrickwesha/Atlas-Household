"""Database access.

One psycopg connection per request, yielded as a FastAPI dependency. Two things
matter here:
- prepare_threshold=None: the API talks to Neon's POOLED (PgBouncer) endpoint,
  and psycopg3's auto-prepared statements are not safe through a transaction
  pooler (the same client connection may land on a different server session).
- row_factory=dict_row: rows come back as dicts, which map straight onto the
  Pydantic response models.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
from psycopg.rows import DictRow, dict_row

from . import config


def get_db() -> Iterator[psycopg.Connection[DictRow]]:
    with psycopg.connect(
        config.DATABASE_URL,
        prepare_threshold=None,
        autocommit=True,
        row_factory=dict_row,
    ) as conn:
        yield conn
