"""Authentication dependencies.

Today there is exactly one: `require_kiosk`, a shared device token. A future
`current_adult` (real per-user auth) will be a SEPARATE dependency added
alongside this one — never a branch on token type inside this one.
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
