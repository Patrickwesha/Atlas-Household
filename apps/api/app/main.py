"""FastAPI application entrypoint. Mounts CORS (origins from ALLOWED_ORIGINS)
and the two routers: the kiosk board and the nightly materializer.

Each router carries its OWN auth dependency (see app/auth.py). They are mounted
separately rather than nested so that no future route can inherit the wrong one
by being added in the wrong place in a file.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .cron import router as cron_router
from .routes import router

# The interactive docs are off in every environment. `require_kiosk` is a ROUTER
# dependency, so /docs, /redoc and /openapi.json were never behind it — they were
# always public. That was cosmetic while every route only read. It stopped being
# cosmetic the moment /api/cron/materialize existed: publishing a map of the one
# endpoint that writes, on a public URL, for a public repo, is free
# reconnaissance. The schema is in this repo for anyone who needs it.
app = FastAPI(
    title="Atlas Household API",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(router)
app.include_router(cron_router)
