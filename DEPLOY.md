# Deploying Atlas Household to Vercel

Two Vercel projects from this one repo, different root directories:

| | API project | Web project |
|---|---|---|
| Root directory | `apps/api` | `apps/web` |
| Runtime | Python (serverless) | Vite static |
| Stable URL | `https://<api-name>.vercel.app` | `https://<web-name>.vercel.app` |

The API and the web each need the other's URL, so deploy in this order:
**API → set the web's `VITE_API_BASE_URL` → web → set the API's `ALLOWED_ORIGINS` → redeploy the API.**

> **Always use the STABLE production URL** (`atlas-api.vercel.app`), never the
> per-deployment URL (`atlas-api-9f3k2x.vercel.app`). The per-deploy URL belongs
> to one build: it works today and breaks on your next push. The two sit right
> next to each other in the dashboard — this is the easiest mistake to make.

## Part A — API project (deploy first)

1. Vercel → **Add New → Project** → import `Patrickwesha/Atlas-Household`.
2. **Root Directory:** `apps/api`. Framework preset: **Other** (Vercel detects
   Python from `requirements.txt` + the `api/` folder).
3. Name it e.g. `atlas-api` → stable URL `https://atlas-api.vercel.app`.
4. Add the **API environment variables** (table at the bottom). You may leave
   `ALLOWED_ORIGINS` empty for now and set it in Part C.
5. **Deploy.** Copy the **stable** URL: `https://atlas-api.vercel.app`.
6. Smoke test: open `https://atlas-api.vercel.app/api/board`. You should get a
   **401 JSON** (`{"detail":"Invalid or missing device token"}`) — that means
   it's up. An HTML login page instead → see Troubleshooting.

## Part B — Web project

1. **Add New → Project** → import the same repo again.
2. **Root Directory:** `apps/web`. Framework preset: **Vite** (auto-detected).
3. Name it e.g. `atlas-web` → `https://atlas-web.vercel.app`.
4. Add `VITE_API_BASE_URL` = the **stable API URL** from Part A
   (`https://atlas-api.vercel.app`, not a per-deploy URL).
5. **Deploy.** Copy the stable URL: `https://atlas-web.vercel.app`.

## Part C — Wire CORS back to the API

1. API project → **Settings → Environment Variables** → set `ALLOWED_ORIGINS`
   = the **stable web URL** (`https://atlas-web.vercel.app`).
2. **Redeploy the API** (Deployments → ⋯ → Redeploy). Env changes only take
   effect on a new deploy.

## Part D — First real use on the iPad

1. On the iPad, open `https://atlas-web.vercel.app` in **Safari**.
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
- **Board empty in production.** The seed pins instances to the date you last
  seeded (strict `on conflict do nothing`). Re-date them by running
  `uv run python seed.py --refresh` locally against the same Neon DB. Automatic
  day-over-day boards are the materializer, a later slice.
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
| `ALLOWED_ORIGINS` | your stable web URL (e.g. `https://atlas-web.vercel.app`) | **Part C**, after the web deploys |

**Web project** (`apps/web`):

| Name | Value | Set when |
|---|---|---|
| `VITE_API_BASE_URL` | your stable API URL (e.g. `https://atlas-api.vercel.app`) | **Part B**, after the API deploys |
