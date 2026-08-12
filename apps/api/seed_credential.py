"""seed_credential.py — create or reset one adult's dashboard login.

    uv run python seed_credential.py --member Panashe --email you@example.com

Generates a strong password, prints it ONCE, and never writes it anywhere. Only
the argon2id hash reaches the database. If you lose it, run this again — it
resets rather than recovers, because a password you can recover is one the
database could have told someone.

ADULTS ONLY, checked here against members.role. The API checks it again on every
request (app/auth.py current_adult), so a demotion takes effect immediately
rather than at the end of an eight-hour session.

Uses DIRECT_URL and refuses a "-pooler" host, exactly like seed.py and the
migrations.
"""

from __future__ import annotations

import argparse
import secrets
import string
import sys

import psycopg
from argon2 import PasswordHasher

from app.envfile import DirectUrlError, resolve_direct_url

# Unambiguous alphabet: no O/0, no l/1/I. This gets read off a screen and typed
# on an iPad, and a password that is hard to transcribe gets written on a
# sticky note, which is worse than a shorter one.
_ALPHABET = (
    "".join(c for c in string.ascii_uppercase if c not in "OI")
    + "".join(c for c in string.ascii_lowercase if c not in "l")
    + "".join(c for c in string.digits if c not in "01")
    + "!@#$%^&*-_=+"
)


def _generate(length: int = 24) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or reset a dashboard login.")
    parser.add_argument("--member", required=True, help="The adult's name, as in members.name")
    parser.add_argument("--email", required=True, help="Sign-in email")
    parser.add_argument(
        "--password",
        help="Use this instead of generating one. Avoid: it lands in your shell history.",
    )
    args = parser.parse_args()

    try:
        direct_url = resolve_direct_url()
    except DirectUrlError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    password = args.password or _generate()
    hashed = PasswordHasher().hash(password)

    with psycopg.connect(direct_url) as conn:
        with conn.cursor() as cur:
            member = cur.execute(
                "select id, name, role from members where name = %s", (args.member,)
            ).fetchone()
            if member is None:
                print(f"ERROR: no member named {args.member!r}.", file=sys.stderr)
                return 1
            member_id, name, role = member
            if role != "adult":
                print(
                    f"ERROR: {name} is a {role}, not an adult. The dashboard writes "
                    "chore definitions; only adults get a login.",
                    file=sys.stderr,
                )
                return 1

            clash = cur.execute(
                "select member_id from member_credentials "
                " where lower(email) = lower(%s) and member_id <> %s",
                (args.email, member_id),
            ).fetchone()
            if clash is not None:
                print(
                    f"ERROR: {args.email} is already used by another member.",
                    file=sys.stderr,
                )
                return 1

            existed = cur.execute(
                "select 1 from member_credentials where member_id = %s", (member_id,)
            ).fetchone()
            cur.execute(
                "insert into member_credentials (member_id, email, password_hash) "
                "values (%s, %s, %s) "
                "on conflict (member_id) do update set "
                "  email = excluded.email, "
                "  password_hash = excluded.password_hash, "
                "  updated_at = now()",
                (member_id, args.email, hashed),
            )

    verb = "Reset" if existed else "Created"
    print()
    print(f"  {verb} the dashboard login for {name}.")
    print(f"    email    : {args.email}")
    print(f"    password : {password}")
    print()
    print("  This is the only time it is shown. It is not written to any file, and")
    print("  the database holds only the argon2id hash. Lose it and run this again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
