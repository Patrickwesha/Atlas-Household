# Atlas Household

A PWA my family of five uses to run household chores. A kid walks up to the
kitchen iPad and taps their chores done.

**This repo is public. Assume everything committed is world-readable.**

## Stack and versions

Monorepo, two apps, both deployed to Vercel as separate projects with
different root directories.

- `apps/web`: React + TypeScript + Vite, PWA. Node 22.
- `apps/api`: FastAPI, Python 3.12, managed with uv.
- Database: Postgres on Neon (pooled connection string).
- Hosting: Vercel, two projects from this one repo.

Auth is one device token sent as `Authorization: Bearer <token>`, checked
against `DEVICE_TOKEN` from server env by a single FastAPI dependency called
`require_kiosk`.

## Rules (read before writing code)

- **Never expose secrets to the client.** Only `VITE_API_BASE_URL` may be a
  `VITE_` variable. Vite inlines every `VITE_` var into the public browser
  bundle, and this repo is public. The device token is stored in the browser's
  localStorage via a one-time setup screen and sent as an `Authorization`
  header. It is never a `VITE_` var.
- **Never commit `.env` or real family data.** Real seed data lives in a
  gitignored `seed.json`. Only `seed.example.json` with placeholder names is
  committed.
- **Do not create or alter database migrations unless I explicitly ask.**
  Alembic owns migrations from `0002` onward (`apps/api/alembic.ini`,
  `apps/api/migrations/versions/`). `0001` was applied by hand and is `stamp`ed,
  never run. Migrations connect through `DIRECT_URL` and **refuse a `-pooler`
  host** — DDL must never go through Neon's transaction pooler. There are no
  SQLAlchemy models, so **autogenerate is not used**; every revision is
  hand-written.
- **Do not add dependencies without asking.**
- **All auth is a FastAPI dependency.** Never branch on token type inside a
  shared dependency. Add a new dependency instead. `require_kiosk` is the only
  one today. A `current_adult` dependency can be added later without touching
  it.

## Scope: current slice — slice 2, phase 1 (recurring chores)

Slice 1 (the kiosk) is deployed and in daily use. Phase 1 makes the board fill
itself so nobody runs `seed.py --refresh` every morning.

In scope:

- Tables: adds `chore_definitions` and `chore_assignments`; adds
  `definition_id` and `cutoff_at` to `chore_instances`; adds
  `chore_assignments.week_parity` (0003) for alternating weeks. Nothing else.
- The materializer (`app/materialize.py`): one idempotent insert-select that
  creates a day's instances from definitions joined to assignments on that day's
  weekday. Run nightly by two Vercel crons, plus a bounded self-heal on the board.
- API: adds `GET /api/cron/materialize` behind its own `require_cron`. Nothing
  else changes.
- Seed: `chore_definitions` with embedded assignments, from the gitignored
  `seed.json`. `chores_today` is now optional legacy.
- Web: **unchanged this phase.**

Two design facts that are settled and must not be re-litigated:

- **One definition per real-world chore.** "Kitchen reset" is ONE definition with
  assignment rows splitting it across two adults by weekday — not two
  definitions. The all-hands 8pm reset is one definition with four members across
  seven days and needs no special case.
- **Assignment is a pure function of the date.** `day_of_week` and `week_parity`
  are both derived from the due date — nothing is remembered and nothing advances.
  What stays unrepresentable is **state**: no `rotation_index`, no
  `last_assigned_to`, no `next_up`, no counter that materialization increments.

  *(This replaces "there is no rotation concept, anywhere". Alternating weeks were
  added in migration 0003 for the Saturday deep clean. The rule was always
  protecting against a value someone has to look up, that changes, and that can
  therefore be disputed — "whose turn was it?" is the argument this system exists
  to end. A parity computed from the calendar is not that question, and the board
  answers it without anyone remembering anything. The moment whose-turn-it-is
  lives in a row that changes, the old rule is back in force.)*

`cutoff_time` and `cutoff_at` exist but are read and written by nothing — they
are here so Phase 2 is not a third migration.

`sort_order` **is** live: `GET /api/board` joins `chore_definitions` and orders
by it, `nulls last` so slice-1 rows sink to the bottom. It is joined, never
snapshotted onto the instance — unlike `title`, re-ordering old rows rewrites
nothing that was ever true about them, so a change takes effect everywhere at
once. Alphabetical order put the 8pm family reset at the top of the list.

Not in this slice. Do not build, scaffold, or stub: subtasks, the history
endpoint, Today/Calendar tabs, cutoff alerts or the kiosk chime, escalation,
notifications, adult login, roles, a parent dashboard, any admin UI, any other
module.

## The one deliberate exception to "reads don't write"

`GET /api/board` materializes the day **when, and only when, that day has zero
instances**, then returns them in the same response. It is the last line of
defence behind two crons, because an empty wall on a school morning is the
failure this slice exists to prevent.

It is bounded: it can never add to a day that already has a row, it can only ever
create rows a cron would have created anyway, and **every exception it raises is
swallowed** — a broken materializer must never turn into "Can't load the board".
Anything that loosens one of those bounds needs a new decision, not a patch.
