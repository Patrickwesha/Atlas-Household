# Deploying Atlas Household to Vercel

Two Vercel projects from this one repo, different root directories:

| | API project | Web project |
|---|---|---|
| Root directory | `apps/api` | `apps/web` |
| Runtime | Python (serverless) | Vite static |
| Stable URL | `https://atlas-api-sigma.vercel.app` | `https://atlas-web-henna.vercel.app` |

The API and the web each need the other's URL, so deploy in this order:
**API → set the web's `VITE_API_BASE_URL` → web → set the API's `ALLOWED_ORIGINS` → redeploy the API.**

## The real URLs

> **Vercel suffixed BOTH project names.** The plain names were taken, so the
> real URLs are `atlas-api-sigma.vercel.app` and `atlas-web-henna.vercel.app` —
> not `atlas-api.vercel.app` / `atlas-web.vercel.app`. Copying the pretty name
> out of a runbook is how you spend an hour on a CORS error that is really a
> typo. The suffix is random per project; assume any new project gets one.

Each project exposes three URLs. Only the stable one is safe to configure against:

| Project | URL | Use it? |
|---|---|---|
| API | `https://atlas-api-sigma.vercel.app` | ✅ **stable production** |
| API | `https://atlas-api-git-main-patrick-kweshas-projects.vercel.app` | branch alias; follows `main`, fine to poke at, don't configure against it |
| API | `https://atlas-ygkszztx0-patrick-kweshas-projects.vercel.app` | ❌ per-deployment — dies on your next push |
| Web | `https://atlas-web-henna.vercel.app` | ✅ **stable production** |
| Web | `https://atlas-web-git-main-patrick-kweshas-projects.vercel.app` | branch alias |
| Web | `https://atlas-qya0tdd6g-patrick-kweshas-projects.vercel.app` | ❌ per-deployment |

> The per-deploy URL sits directly beneath the stable one in the dashboard. It
> works today and breaks on your next push, which makes it the easiest mistake
> to make and the most confusing one to debug.

## Part A — API project (deploy first)

1. Vercel → **Add New → Project** → import `Patrickwesha/Atlas-Household`.
2. **Root Directory:** `apps/api`. Framework preset: **Other** (Vercel detects
   Python from `requirements.txt` + the `api/` folder).
3. Name it `atlas-api` → Vercel assigned `https://atlas-api-sigma.vercel.app`.
4. Add the **API environment variables** (table at the bottom). You may leave
   `ALLOWED_ORIGINS` empty for now and set it in Part C.
5. **Deploy.** Copy the **stable** URL: `https://atlas-api-sigma.vercel.app`.
6. Smoke test: open `https://atlas-api-sigma.vercel.app/api/board`. You should
   get a **401 JSON** (`{"detail":"Invalid or missing device token"}`) — that
   means it's up. An HTML login page instead → see Troubleshooting.

   Two things that response tells you, beyond "it's alive":
   - **JSON rather than an HTML login page** means Deployment Protection is not
     intercepting.
   - **401 rather than 500** means `config.py` imported cleanly, so
     `DATABASE_URL`, `DEVICE_TOKEN` and `HOUSEHOLD_ID` are all set — they are
     `_require`d at import, and a missing one crashes the function instead. It
     proves they are *present*, not that `DATABASE_URL` is *correct*; the first
     authenticated board load tells you that.

   The root `/` returning `{"detail":"Not Found"}` is **normal** — FastAPI has no
   `/` route. Ignore the `/`, `/favicon.ico` and `/favicon.png` 404s in the logs;
   that is just a browser visiting the root.

## Part B — Web project

1. **Add New → Project** → import the same repo again.
2. **Root Directory:** `apps/web`. Framework preset: **Vite** (auto-detected).
3. Name it `atlas-web` → Vercel assigned `https://atlas-web-henna.vercel.app`.
4. Add `VITE_API_BASE_URL` = `https://atlas-api-sigma.vercel.app`
   — the stable API URL from Part A, **no trailing slash** (the client builds
   `${BASE}/api/board`, so a slash yields `//api/board`).
5. **Deploy.** Stable URL: `https://atlas-web-henna.vercel.app`.

> **`VITE_API_BASE_URL` is baked in at BUILD time, not read at runtime.** Vite
> inlines it into the bundle. Vercel usually starts building the moment you
> import the repo — often before you have added the variable — and that first
> build hard-codes `undefined`. The kiosk then shows "Can't reach the server"
> no matter what you set afterwards, and nothing in the API logs will explain
> it, because no request is ever made.
>
> Fix: set the variable, then **Deployments → ⋯ → Redeploy**. Changing an env
> var alone does nothing to an already-built bundle.

## Part C — Wire CORS back to the API

1. API project → **Settings → Environment Variables** → set
   `ALLOWED_ORIGINS` = `https://atlas-web-henna.vercel.app`
   (no trailing slash — it is matched as an exact origin, and a slash will not
   match).
2. **Redeploy the API** (Deployments → ⋯ → Redeploy). Env changes only take
   effect on a new deploy.

## Part D — First real use on the iPad

1. On the iPad, open `https://atlas-web-henna.vercel.app` in **Safari**.
2. On the setup screen, paste the **device token** (same value as the API's
   `DEVICE_TOKEN`). The board should load.
3. **Share → Add to Home Screen** — installs the standalone PWA.
4. Open it from the **home-screen icon** (not Safari).
5. **The wall test that matters most:** with the installed PWA open, make the
   API unreachable (turn off the iPad Wi-Fi for a few seconds, or pause the API
   project in Vercel). Confirm the screen shows the **error state** ("Can't
   reach the server"), **not a blank board**. This was verified in the browser,
   but a standalone PWA is a different rendering context — verify it there,
   because a blank board that reads as "all done" is the failure that matters.

## Part E — On the wall

Everything in `docs/GAUNTLET-01.md` was measured in a headless browser at the
iPad's viewport. These checks **cannot** be run that way, and each is a real
gap, not a formality — so run them once the iPad is actually mounted, in the
kitchen, at the height and angle it will live at.

Findings from these go into the same three buckets as the rest of the gauntlet —
**FIX NOW / FIX NEXT SLICE / ACCEPTED** — appended to `docs/GAUNTLET-01.md` with
a reason recorded for anything accepted. Same bar: a defect in what exists, not
a feature request.

> **Run once already:** 2026-08-08, on the mounted iPad Pro (2024, M4). All five
> passed. See "Part E — the wall checks, run" in `docs/GAUNTLET-01.md` for what
> that did and did not establish, and for the two findings the device resolves.
> Re-run this list if the kiosk ever moves to a different iPad — two findings are
> viewport-dependent and come back on a smaller screen.

1. **Glare.** Look at the board at the times of day the kitchen is brightest,
   and with the ceiling lights on at night. Glare was modelled as a uniform
   white veil at 15% and 30%; a real specular highlight off a window is not
   uniform and the panel's coating is not modelled at all. What to watch: the
   gold progress arc and the empty tick circle are the first things to give out
   — measured at 2.60:1 and 2.02:1 under the simulated conditions, both under
   their 3:1 bar. If the arc disappears in real glare, the ring stops being
   information.
2. **Off-axis viewing.** Kids look **up** at a wall mount. Stand where they
   stand, not where you stand. The simulation applied a generic IPS gamma lift
   and contrast compression; real panel behaviour is not that. Watch the same
   two elements, plus whether the done-row tint still separates from a to-do row
   (it is only 1.01:1 — the green check circle carries that signal alone).
3. **The six-foot read.** Stand at the far side of the kitchen. Can you tell,
   without walking over, who still has chores left? The count pill is the
   element that has to answer that. Downscaled renders stood in for this, which
   models optical averaging but not the eye's contrast-sensitivity roll-off, so
   the simulation is **optimistic**.
4. **Safari standalone PWA.** Everything was verified in Chromium. Open the app
   from the **home-screen icon**, not Safari, and re-check: the error state (see
   Part D.5), the toast and its Undo button, and the chore list scrolling with
   real momentum and rubber-banding.
5. **Safe-area insets.** `env(safe-area-inset-*)` reports **0** in a headless
   browser, so none of the safe-area handling has ever actually run. There is a
   known suspected double-count: `.offline-banner` applies
   `padding-top: max(8px, env(safe-area-inset-top))` on top of `.kiosk`'s own
   `padding-top: env(safe-area-inset-top)`. Recorded as UNVERIFIED (FIX NEXT
   SLICE 54). Check whether the offline banner sits too low with the notch/home
   indicator in play, in both orientations.
6. **Which iPad is it?** Two findings depend on the exact viewport. Only 3 chore
   rows fit on an iPad mini 6 in landscape (1133×744) versus 4 on everything
   else. And the cue that a list continues below the fold is a partial row —
   57.6px with a visible check circle at 1080×810 (the 10.2"), but only a 23px
   featureless band at 1024×768. If your device is the latter, FIX NEXT SLICE 45
   is live for you and worth promoting.

Two things worth checking with the actual kids, which no instrument settles:
whether a 2-second cooldown after a tap reads as "it heard me" or as "it's
broken", and whether they notice a list continues below the fold at all.

## Part F — the nightly materializer (slice 2)

This is what stopped the board going empty every morning. Chores are now
**definitions** (`chore_definitions`) plus **assignments** (who, which weekday),
and a nightly job turns them into that day's `chore_instances`.

### F.1 — Migrate the database (once)

Migrations moved to Alembic. `0001` was applied by hand before Alembic existed,
so its version table has to be started in sync — **stamp first, then upgrade**:

```
cd apps/api
uv run alembic current                # expect: empty, the first time
uv run alembic stamp 0001             # says "0001 already happened". Applies no DDL.
uv run alembic upgrade head           # applies 0002
uv run alembic current                # expect: 0002 (head)
```

Runs against `DIRECT_URL` and **refuses a `-pooler` host**. If you want to read
the SQL before it touches Neon: `uv run alembic upgrade head --sql`.

> **Stamp before upgrade, not after.** Running `upgrade head` on an un-stamped
> database makes Alembic try to `create table households` on a database that
> already has one, and the error it prints will not mention stamping.

### F.2 — Load your chore definitions

Put them in the gitignored `seed.json` (see `seed.example.json` for the shape —
day names, not the 0-6 integers the database stores), then:

```
uv run python seed.py                              # definitions + assignments
uv run python materialize.py --dry-run             # who gets what today. Writes nothing.
uv run python materialize.py --date 2026-08-29 --dry-run   # check a Saturday without waiting
```

`seed.py` refuses a definition assigned to a **dependent** — the API rejects a
dependent completion and the kiosk gives them nothing to press, so it would
materialize into a row nobody can ever clear.

**`sort_order` is the order chores appear on the kiosk.** Leave gaps (10, 20, 30)
so a new chore can slot between two without renumbering, and put end-of-day
chores last — alphabetically the 8pm family reset sorts to the *top* of the list,
above chores due at breakfast. It is read live, so re-ordering takes effect on
every day at once, past and future; you do not need to re-materialize anything.

### F.3 — Set `CRON_SECRET` and deploy

Add `CRON_SECRET` to the API project's environment variables, then **redeploy**
(env changes need a new deploy). Confirm the jobs appear under
**API project → Settings → Cron Jobs**, and use **Run** there to trigger one by
hand. A successful run returns `{"due_on": "...", "created": N}`.

### F.4 — The three layers, and why there are three

| Layer | When | What it is for |
|---|---|---|
| Cron 1 | `0 8 * * *` UTC | The normal path. Creates tomorrow's board overnight. |
| Cron 2 | `0 11 * * *` UTC | Rescue. A true no-op if cron 1 worked. |
| Board self-heal | any board load on a day with **zero** rows | Last resort, if both crons failed. |

**Vercel Hobby cron constraints** (verified, and they shape all of the above):
once per day maximum *per job* (100 jobs per project, so two entries are fine),
**UTC only**, and the job fires **anywhere inside the hour you specify** —
`0 8 * * *` can run at 08:47.

**What that means in Chicago time, including DST:**

| Cron | Summer (CDT, UTC−5) | Winter (CST, UTC−6) |
|---|---|---|
| `0 8 * * *` | 3:00–3:59 am | 2:00–2:59 am |
| `0 11 * * *` | 6:00–6:59 am | 5:00–5:59 am |

Both land after midnight and before anyone is up, in both halves of the year, so
there is no seasonal adjustment to remember. That is why the hour was chosen.

The self-heal only ever fires on a day with **no** instances at all, so it cannot
duplicate a chore or resurrect one that was cleared. One consequence worth
knowing: **deleting a day's instances by hand no longer sticks** — the next board
load recreates them. Retire a chore by setting `is_active = false` on its
definition, not by deleting rows.

### F.5 — If a night is missed

You should not need this, but it is one command:

```
cd apps/api && uv run python materialize.py            # today
uv run python materialize.py --date 2026-08-15         # a specific day
```

Idempotent — running it against a day that already has its chores creates
nothing and touches no completion.

### F.6 — Checking it locally before you trust it

Both scripts want a **scratch** database and refuse a Neon URL:

```
VERIFY_DATABASE_URL=postgresql://localhost/atlas_verify uv run python verify_materializer.py
VERIFY_DATABASE_URL=postgresql://localhost/atlas_verify uv run python verify_api.py
```

The first pins the materializer's guarantees (weekday routing, idempotency by row
identity rather than row count, completed work surviving a re-run, slice-1 rows
surviving, the title snapshot). The second boots the API and pins the two tokens
not overlapping and the self-heal's bounds — including that a materializer which
raises still returns a 200 board.

## Troubleshooting

- **Preview deployments fail to load the board — EXPECTED.** Every branch/PR push
  gets a fresh `atlas-web-<hash>.vercel.app` that isn't in `ALLOWED_ORIGINS`, so
  the browser blocks the API call (CORS). Don't chase it — test against the
  production URLs only.
- **The API returns HTML instead of JSON** (symptom: a JSON parse error in the
  browser console, nothing that says "auth"). Cause: **Vercel Deployment
  Protection / Vercel Authentication** is intercepting with a login page. Fix:
  API project → **Settings → Deployment Protection** → turn **Vercel
  Authentication** off for production so the browser can call the API.
- **Board empty in production.** Since slice 2 this no longer means "a run was
  missed" — three layers would all have had to fail (Part F.4), and the board
  self-heals on load anyway. It almost always means **no chore is scheduled for
  that weekday**: no active definition is assigned to anyone on, say, a Sunday.
  Check it in one command, without guessing:

  ```
  cd apps/api && uv run python materialize.py --dry-run
  ```

  It prints the weekday it resolved and who is scheduled. "Nothing scheduled for
  this weekday" is your answer — fix it in `seed.json` and re-run `seed.py`.
  `seed.py --refresh` is **not** the fix; it only re-dates the legacy
  `chores_today` rows and has nothing to do with recurring chores.
- **Cron shows as failed in Vercel.** A 401 means `CRON_SECRET` is unset or
  differs between the cron and the environment — the endpoint fails closed on
  purpose. Set it and **redeploy**; an env change alone does not affect a
  deployment already built.
- **Python version.** Vercel defaults to Python 3.12, matching the project. If a
  build uses an older Python, set it in the API project's settings.

## Environment variables

**API project** (`apps/api`) — all server-side. The two marked *(secret)* must
never be committed; copy their values from your local `.env`.

| Name | Value | Set when |
|---|---|---|
| `DATABASE_URL` | *(secret)* your Neon **pooled** string (host contains `-pooler`) | Part A |
| `DEVICE_TOKEN` | *(secret)* your device token (the same one the iPad uses) | Part A |
| `HOUSEHOLD_ID` | the UUID in your `.env` (must match `seed.json`) | Part A |
| `APP_TIMEZONE` | `America/Chicago` | Part A |
| `ALLOWED_ORIGINS` | `https://atlas-web-henna.vercel.app` (exact origin, no trailing slash) | **Part C**, after the web deploys |
| `CRON_SECRET` | *(secret)* `openssl rand -hex 32` — a **different** value from `DEVICE_TOKEN` | **Part F**, before the first cron fires |

> `CRON_SECRET` is deliberately not the device token. Different device, different
> blast radius: rotating the iPad's token must not break the nightly job, and a
> leaked cron secret must not be able to read the board. If it is unset, the
> materializer endpoint **refuses every request, including Vercel's** — the
> failure shows up as a red cron run, never as an open write endpoint.

**Web project** (`apps/web`):

| Name | Value | Set when |
|---|---|---|
| `VITE_API_BASE_URL` | `https://atlas-api-sigma.vercel.app` (no trailing slash) | **Part B**, before the first build — see the build-time note in Part B |
