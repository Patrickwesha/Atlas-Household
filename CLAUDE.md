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
- **Do not add dependencies without asking.**
- **All auth is a FastAPI dependency.** Never branch on token type inside a
  shared dependency. Add a new dependency instead. `require_kiosk` is the only
  one today. A `current_adult` dependency can be added later without touching
  it.

## Scope: current slice

One thin vertical slice, deployed, that a kid can tap on the iPad.

In scope:

- Tables: `households`, `members`, `chore_instances`. Nothing else.
- API: `GET /api/board` and `POST /api/instances/{id}/complete`. Nothing else.
- Web: one full-screen kiosk page. Five name tiles, tap a name to see that
  person's chores for today, tap one to complete, tap back.
- Seed: one household, five members, a few instances for today, loaded from a
  gitignored `seed.json`.

Not in this slice. Do not build, scaffold, or stub: `chore_definitions`,
`chore_assignments`, subtasks, recurrence, the nightly materializer,
escalation, notifications, adult login, roles, any admin UI, any other module.
