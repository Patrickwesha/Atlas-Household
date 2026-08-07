# Kiosk visual design — slice 1

**What this file is.** The design tokens and decisions actually implemented in
`apps/web`, written by the person who implemented them.

**What this file is not.** It is not the visual prototype. A prototype HTML mock
exists outside this repo and is the intended source of truth; it did not reach
the session where this design was built, so the design below was implemented
from a written spec instead. When the mock lands it belongs at
`docs/design/kiosk-prototype.html`, unmodified, and this file becomes the record
of where the implementation diverges from it.

---

## Tokens

| Token | Value | Where |
|---|---|---|
| Gradient | `linear-gradient(160deg, #5B21B6, #7C3AED)` fixed | `body` |
| Sheet | `#FFFFFF`, radius `32px`, shadow `0 24px 60px rgba(30,8,70,.32)` | `.sheet` |
| Tile | `#F7F5FD` on `#E9E4F8`, radius `24px` | `.tile` |
| Accent | `#6D28D9` | household name, buttons, reset dot |
| Done | `#15803D` on `#DCFCE7` | rings, checks, completed rows |
| Danger | `#B91C1C` | error card heading, offline banner |
| Ink / muted | `#111827` / `#4B5563` | body text |
| Type | Nunito 400/600/700/800, Google Fonts CDN | `index.html` |
| Fallback | `'Avenir Next', Avenir, 'Trebuchet MS', system-ui, sans-serif` | `index.css` |

`theme-color` (`index.html`) and `theme_color`/`background_color`
(`public/manifest.json`) are `#5B21B6` so the installed PWA's status bar matches
the gradient instead of flashing the old blue.

## Structure

Purple ground → white rounded sheet → content. Two screens:

- **Family** — clock/date header, five tiles, the 8pm reset strip.
- **Person** — back button, avatar + name, progress bar, chore rows.

## Avatars

Six flat SVG faces, written inline in `src/avatars.tsx`. No image requests and
no external assets: nothing to 404, nothing that renders as a broken-image glyph
when the kitchen wifi drops. Face and skin tone are chosen by an FNV-1a hash of
`members.id`, so a person's face never migrates when the seed changes or a
member is added. `members.color` drives the hair and the background wash.

## Progress

Ring per person on the family screen, bar on the person screen. Both are
`done / total` over today's `chore_instances` for that assignee, computed
client-side from the existing `GET /api/board` response. No new endpoint.

Three distinct states, because collapsing them would state something false:

| Condition | Ring | Pill |
|---|---|---|
| `total === 0` | bare track, **no arc** | `Nothing today` |
| `0 < done < total` | member-color arc | `N left` |
| `done === total > 0` | full green ring | `All done` |

A zero-length arc with a round line cap still paints a dot, which reads as
"started" on a board where nothing has been done. The arc is therefore omitted
entirely at zero rather than drawn with zero length.

## Contrast is computed, not chosen

`members.color` is arbitrary data from the database, so no foreground color is
hardcoded against it. `src/colors.ts` computes WCAG relative luminance and picks
near-black or white for the count pill, and darkens a member's color until it
clears 4.5:1 against the white sheet before using it for their name. A future
seed containing `#FFE066` stays readable without anyone noticing it needs to.

Measured from the rendered page, every string passes WCAG AA. Lowest ratio
anywhere: **4.6:1** (a count pill, against a 4.5 floor).

## Font fallback

The wall iPad can lose the network, so the fallback chain is part of the design
rather than an afterthought. Verified by loading the app with
`fonts.googleapis.com` and `fonts.gstatic.com` blocked:

- Text stays visible throughout (`display=swap`).
- Rendered text runs **~18% wider** in the widest fallback tested.
- Nothing overflows: no tile name and no chore title clips in either mode.

Sizing is `rem`/`clamp()` and the ring is sized in CSS rather than pixels in JS,
so a swapped typeface changes the look without moving the layout.

If the fallback ever looks wrong on the actual iPad, the fix is to self-host the
Nunito `woff2` files in `public/` and drop the CDN link — deliberately not done
here, because it adds committed binaries to a public repo for a problem that may
not exist.

## Timezone

`hooks.ts` formats the clock and date with an explicit `KIOSK_TZ =
'America/Chicago'`, **not** the device's zone. The board's "today" is resolved
server-side in `APP_TIMEZONE` (`apps/api/app/config.py`, used by `_today()` in
`routes.py`); if the header used device-local time it could print a date the
board was never built for.

`CLAUDE.md` permits exactly one `VITE_` variable, so this cannot come from the
environment. **It is a constant that must be kept equal to the API's
`APP_TIMEZONE`.** Change one, change the other.

When the kiosk day rolls over, `useDayFlip` refetches immediately rather than
waiting out the 60s poll, so the header and the board cannot disagree for a
whole minute at midnight.

## Deliberately not built

Each of these would have the board state something the API cannot back. Listed
so the next slice knows they were considered and rejected, not forgotten:

| Not built | Why |
|---|---|
| Due times ("By 9:30 PM") | `chore_instances` has `due_on` (a date). There is no cutoff-time column. |
| Escalation copy ("X gets a nudge") | No notification service exists. The board would be promising something nothing delivers. |
| Calendar tab | Its history needs a real history endpoint. Shipping it with only today's data, or empty, teaches kids the tab is broken. |
| Subtask expander | No `chore_subtask_instances` table. |
| A tappable dependent tile with a count | The API refuses a dependent completion (`routes.py`). The UI must not offer what the server rejects. |

The 8pm family reset **is** shown, as a static schedule line. It has no
checkbox and no completed state, because nothing would record one.

## Interaction

- Optimistic completion, reconciled with the server's row, rolled back visibly
  on failure — and the confirmation toast is retracted with it, so a toast never
  claims a chore is done that the server refused.
- Undo runs through the existing `POST /api/instances/{id}/uncomplete`. It acts
  on the row's current state, not the snapshot the toast captured.
- Idle returns to the family screen after **60s**, not 30s — long enough to read
  a list without being bounced mid-read. The timer is armed only on the person
  screen and re-arms on every touch.
- Touch targets: tiles ≥ 200px tall, chore rows ≥ 104px, Back and Undo ≥ 88px.
- An unreachable API is always visually distinct from an empty board. A blank
  board reads as "all done", which is the failure that matters most here.
