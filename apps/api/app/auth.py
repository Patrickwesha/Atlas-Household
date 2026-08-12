"""Authentication dependencies.

There are four, and they never mix.

- `require_kiosk`       the shared device token on the wall iPad
- `require_cron`        the nightly materializer's secret, held by Vercel
- `require_outstanding` the read-only late summary's token, in an iOS Shortcut
- `current_adult`       a real person, signed in to the dashboard

Separate dependencies, not one dependency with a branch. Different device,
different blast radius, different revocation: rotating the kiosk token because a
kid's friend photographed the iPad must not also break the cron, and a leaked
cron secret must not be able to read the board.

`require_kiosk` IS NEVER WIDENED. That token sits on a screen anyone in the
kitchen can walk up to, including a kid's friend with a phone camera. It reads
the board and completes a chore; it can never write a definition, and the
dashboard is unreachable with it. That is why `current_adult` is a fourth
function here rather than a role check bolted onto the first one.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

import jwt
import psycopg
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg.rows import DictRow

from . import config
from .db import get_db

_bearer = HTTPBearer(auto_error=False)


def require_kiosk(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Allow the request only if it carries the shared device token as
    `Authorization: Bearer <token>`. 401 otherwise, compared in constant time.

    Compared as BYTES, not str. secrets.compare_digest() raises TypeError on a
    str containing any non-ASCII character, which FastAPI turns into a 500 —
    so a token pasted with an invisible character (a non-breaking space or a
    zero-width space, both of which survive a copy from chat or email) used to
    crash this dependency instead of rejecting the request. Encoding first makes
    every wrong token an honest 401, which is the path the kiosk knows how to
    recover from.
    """
    provided = b"" if credentials is None else credentials.credentials.encode("utf-8")
    if credentials is None or not secrets.compare_digest(
        provided, config.DEVICE_TOKEN.encode("utf-8")
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing device token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_cron(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Allow the request only if it carries CRON_SECRET as
    `Authorization: Bearer <secret>`. Vercel Cron sends exactly this header on
    every invocation. 401 otherwise, compared in constant time on bytes for the
    same reason recorded in require_kiosk.

    FAILS CLOSED WHEN CRON_SECRET IS UNSET. This guards the only endpoint in the
    application that writes without a human deciding to, on a URL anyone can
    reach, in a repo anyone can read. A missing secret must therefore mean "deny
    everyone", never "allow anyone" — a misconfigured deploy shows up as a red
    cron run in the Vercel dashboard, which is noticed, rather than as an open
    write endpoint, which is not.

    Note that config.CRON_SECRET is deliberately NOT _require()d at import: the
    kiosk must keep working even if this one variable is missing. Failing closed
    here is what buys that safety.
    """
    expected = config.CRON_SECRET
    if expected is None or credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing cron secret",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not secrets.compare_digest(
        credentials.credentials.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing cron secret",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_outstanding(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Allow the request only if it carries OUTSTANDING_TOKEN as
    `Authorization: Bearer <token>`. 401 otherwise, compared in constant time on
    bytes for the reason recorded in require_kiosk.

    ITS OWN TOKEN, AND NEITHER OF THE OTHERS IS WIDENED. This one lives in an
    iOS Shortcut on a phone — a third place, with a third way to leak. Reusing
    the kiosk token would mean a shortcut on a lost phone can read the whole
    board, and reusing the cron secret would give a read-only summary the same
    credential as the only endpoint that writes. Rotating any one of the three
    must not break the other two.

    FAILS CLOSED WHEN OUTSTANDING_TOKEN IS UNSET, exactly like require_cron.
    Unset means deny everyone. The endpoint it guards names who in this house
    has not done what — that is family data on a public URL, and a missing
    variable must never be the thing that opens it.
    """
    expected = config.OUTSTANDING_TOKEN
    if expected is None or credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing outstanding token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not secrets.compare_digest(
        credentials.credentials.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing outstanding token",
            headers={"WWW-Authenticate": "Bearer"},
        )


_JWT_ALG = "HS256"


def issue_session(member_id: UUID) -> tuple[str, datetime]:
    """Sign a dashboard session token. Returns (token, expires_at).

    Raises if SESSION_SECRET is unset — the caller is the login route, which
    turns that into a 503. Never a token signed with a fallback secret: a
    predictable key is worse than no login at all.
    """
    secret = config.SESSION_SECRET
    if secret is None:
        raise RuntimeError("SESSION_SECRET is not set")
    expires = datetime.now(timezone.utc) + timedelta(hours=config.SESSION_HOURS)
    token = jwt.encode(
        {"sub": str(member_id), "exp": expires}, secret, algorithm=_JWT_ALG
    )
    return token, expires


def current_adult(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    conn: psycopg.Connection[DictRow] = Depends(get_db),
) -> DictRow:
    """The signed-in adult, or 401. Guards every dashboard route.

    ALONGSIDE require_kiosk, never inside it. The kiosk's device token cannot
    reach anything this guards, and this cannot complete a chore on the wall.

    THE ROLE IS RE-READ ON EVERY REQUEST, not trusted from the token. A JWT
    cannot be revoked before it expires, so if the only role check happened at
    login, demoting an adult would leave them with dashboard write access for up
    to SESSION_HOURS. Reading `members` each time costs one indexed primary-key
    lookup and makes a demotion take effect on the next request.

    Fails closed when SESSION_SECRET is unset: no secret, no valid signature,
    nobody gets in.
    """
    secret = config.SESSION_SECRET
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Sign in required",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if secret is None or credentials is None:
        raise unauthorized
    try:
        claims = jwt.decode(
            credentials.credentials,
            secret,
            algorithms=[_JWT_ALG],
            options={"require": ["exp", "sub"]},
        )
        member_id = UUID(str(claims["sub"]))
    except Exception:
        # Expired, tampered, wrong algorithm, unparseable subject — all the same
        # answer. Distinguishing them tells an attacker which part they got right.
        raise unauthorized from None

    member = conn.execute(
        "select id, name, role, household_id from members "
        "where id = %s and household_id = %s",
        (member_id, config.HOUSEHOLD_ID),
    ).fetchone()
    if member is None or member["role"] != "adult":
        raise unauthorized
    return member
