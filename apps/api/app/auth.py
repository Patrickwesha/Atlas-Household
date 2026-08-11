"""Authentication dependencies.

There are three, and they never mix. `require_kiosk` is the shared device token
on the wall iPad. `require_cron` is the nightly materializer's secret, held by
Vercel and by nothing else. `require_outstanding` is the read-only late-chore
summary's token, held by an iOS Shortcut on a phone.

Separate dependencies, not one dependency with a branch. Different device,
different blast radius, different revocation: rotating the kiosk token because a
kid's friend photographed the iPad must not also break the cron, and a leaked
cron secret must not be able to read the board. A future `current_adult` (real
per-user auth) arrives the same way — a fourth function here, not a fourth
branch inside one of these.
"""

from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import config

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
