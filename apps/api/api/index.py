"""Vercel serverless entrypoint.

Vercel's Python runtime serves the ASGI `app` it finds in this file. The
vercel.json rewrite sends every request path here, and FastAPI routes it on the
original path (/api/board, /api/instances/...). Local dev does not use this
file — it runs `uvicorn app.main:app` directly.
"""

from app.main import app

__all__ = ["app"]
