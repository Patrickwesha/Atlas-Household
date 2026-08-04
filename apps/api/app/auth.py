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
    `Authorization: Bearer <token>`. 401 otherwise, compared in constant time."""
    if credentials is None or not secrets.compare_digest(
        credentials.credentials, config.DEVICE_TOKEN
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing device token",
            headers={"WWW-Authenticate": "Bearer"},
        )
