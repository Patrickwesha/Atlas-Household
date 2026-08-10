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

The kiosk authenticates with one device token sent as
`Authorization: Bearer <token>`, checked against `DEVICE_TOKEN` from server env
by a FastAPI dependency called `require_kiosk`. It is no longer the only
dependency — see the auth rule below.

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
  shared dependency. Add a new dependency instead. There are two today:
  `require_kiosk` (the wall iPad's shared device token) and `require_cron` (the
  materializer's secret). Phase B adds a third for `/api/outstanding`; Phase C
  adds `current_adult`. **Never widen `require_kiosk`.** That token sits on a
  screen anyone in the kitchen can walk up to, including a kid's friend with a
  phone camera — it must never gain the power to write a definition, read
  another household, or reach the dashboard.
- **Assignment is a pure function of the date.** `day_of_week` and `week_parity`
  are both derived from the due date — nothing is remembered and nothing
  advances. What stays unrepresentable is **state**: no `rotation_index`, no
  `last_assigned_to`, no `next_up`, no counter that materialization increments.
  "Whose turn was it?" is the argument this system exists to end; a parity
  computed from the calendar is not that question, because the board answers it
  without anyone remembering anything. The moment whose-turn-it-is lives in a
  row that changes, this rule is back in force.
- **Deactivate, never delete.** `is_active = false` is how a chore stops
  happening. The FKs into `chore_definitions` and `members` are `on delete
  restrict` deliberately: a member's history must survive a chore being retired,
  and an edit must never rewrite what the board said last Tuesday.

## Settled design facts — do not re-litigate

- **One definition per real-world chore.** "Kitchen reset" is ONE definition with
  assignment rows splitting it across two adults by weekday — not two
  definitions. The all-hands 8pm reset is one definition with four members across
  seven days and needs no special case.
- **`sort_order` is joined, never snapshotted.** `GET /api/board` joins
  `chore_definitions` and orders by it, `nulls last` so slice-1 rows sink to the
  bottom. Unlike `title`, re-ordering old rows rewrites nothing that was ever
  true about them, so a change takes effect everywhere at once. Alphabetical
  order put the 8pm family reset at the top of the list.
- **`title` IS snapshotted onto the instance.** That is what lets a definition be
  renamed without rewriting what the board said last Tuesday. Anything Phase C
  lets the dashboard edit has to be checked against this.

## Scope: slice 3 — history, cutoffs, and the parent dashboard

Slice 1 (the kiosk) and slice 2 phase 1 (recurring chores, the materializer, two
Vercel crons and a bounded board self-heal) are deployed and in daily use.

This slice runs in **three phases, in order, stopping between each**. A phase is
built, reviewed and confirmed before the next one starts.

### Phase A — Today / Calendar tabs

- API: `GET /api/history?member_id=<uuid>&month=YYYY-MM`. Per-date
  `{ date, total, completed }` derived from `chore_instances`, household-scoped,
  read-only, behind `require_kiosk`.
- Web: a Today / Calendar pill on the person screen, per
  `docs/design/kiosk-prototype.html`. **Today is the existing task list,
  unchanged and un-restyled.** The dependent gets no tabs and no calendar.
- Four day states, and the fourth is the one that matters: `complete` (total > 0,
  completed == total), `partial` (total > 0, completed < total), `today` (gold,
  and it FILLS as chores are ticked — a complete ring only once every chore is
  done, fed from the live board so it cannot lag what the Today tab shows), and
  **NO DATA** — no instances exist for that date.
  NO DATA must be visually distinct from BOTH "future" and "0 of N done", and
  gets its own legend entry. **A day before tracking started must not render as
  an empty ring.** An empty ring means "you did none of your chores"; showing
  that for a day the system did not exist is the board lying to the kids.
- Month nav must not fetch before the first materialized date, or into the
  future.
- **No schema changes.**

### Phase B — cutoff alerts and notifications

**No migration.** `chore_definitions.cutoff_time` and `chore_instances.cutoff_at`
already exist from 0002, deliberately unused, for exactly this.

- Cutoff times are seeded from `seed.json`. The materializer resolves
  `cutoff_at = cutoff_time + due_on` in the household timezone.
- The kiosk becomes the reminder: past cutoff and still pending, the tile goes
  amber then red, the header says how many are left tonight, the 8pm strip counts
  down in red once passed, and **one soft chime — at most once per instance per
  day, never repeating.** A kiosk that beeps repeatedly gets muted, and a muted
  kiosk is a dead one.
- Late is computed from `cutoff_at` **server-side**, never from the browser
  clock. Red never relies on colour alone — always paired with text and an icon.
  The state survives the 60s poll and midnight rollover without flickering or
  re-chiming.
- API: `GET /api/outstanding` — plain text, **empty body when nothing is late**,
  read-only, behind its OWN bearer dependency. A third one beside `require_kiosk`
  and `require_cron`; neither of those is widened.
- Two consumers: `docs/SHORTCUTS.md` (an iOS personal automation) and desktop Web
  Notifications in the web app — permission requested from a button tap, never on
  page load, and **no service worker**.

### Phase C — parent dashboard

The first real user auth and the first non-kiosk write surface. **Designed before
any code is written.**

- `member_credentials` (adults only): email + argon2id password hash. A
  `current_adult` dependency ALONGSIDE `require_kiosk`.
- CRUD over definitions and assignments: `name`, `area`, `cutoff_time`,
  `sort_order`, `is_active`; assignments as member × `day_of_week` ×
  `week_parity`.
- Deactivate, never delete (see Rules).
- Editing a definition must not rewrite history.
- A change must be previewable **before it saves**: which instances tomorrow
  would appear or disappear.
- Open question owned by this phase: a parent session sitting on the wall iPad,
  which the kids use unattended.

### Still forbidden — do not build, scaffold, or stub

Anything not named in phases A, B or C above, and these by name:

- subtasks — `chore_subtask_templates`, `chore_subtask_instances`, the steps
  expander in the prototype
- meal planning
- pantry or inventory
- a family calendar — the Phase A calendar is chore history and nothing else
- budgets, allowances, or anything with money in it
- any second module

Out-of-scope work that turns out to be necessary is a conversation, not a commit.

## The one deliberate exception to "reads don't write"

`GET /api/board` materializes the day **when, and only when, that day has zero
instances**, then returns them in the same response. It is the last line of
defence behind two crons, because an empty wall on a school morning is the
failure slice 2 existed to prevent.

It is bounded: it can never add to a day that already has a row, it can only ever
create rows a cron would have created anyway, and **every exception it raises is
swallowed** — a broken materializer must never turn into "Can't load the board".
Anything that loosens one of those bounds needs a new decision, not a patch.
