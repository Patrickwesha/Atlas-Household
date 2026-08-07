# Gauntlet 01 — adversarial review of the kiosk slice

Six critics, one per domain, against the real code and a live stack (local
Postgres → FastAPI → Vite → Chromium at the wall iPad's 1080×810 @2x). Kid
usability, adversarial use, failure modes, time and date, data integrity,
physical and visual.

**Three rounds — the ceiling.** Round 1 found FIX NOW defects in all six
domains. Fixing them introduced two more, caught because the adversarial critic
re-tested against the patched tree rather than the one it started on. Round 2
re-attacked those fixes and found four more FIX NOW, **every one of them caused
by a round 1 fix**. Round 3 re-attacked round 2's fixes.

That pattern is the main result of this exercise: on this surface, roughly one
in four fixes introduced a new defect of equal severity, and none of them would
have been found by testing the code the critics started on. The rounds were not
ceremony.

Round 2 was run by three critics covering two domains each rather than six
covering one, because its attack surface was only the changed code. All six
domains were still owned. Round 3 the same.

Ground rules the critics worked under: defects in what exists only, no features,
no refactors; anything needing a schema change is automatically FIX NEXT SLICE
because 0002 belongs to Alembic; and the Phase 1 "do not ship" list (due times,
escalation copy, the Calendar tab, the subtasks expander, any count or tap
target on the dependent) was out of scope, not a finding.

Every finding below is one a critic **reproduced**. Where something was reasoned
about but not reproduced it says so.

---

## FIX NOW — all fixed, all verified

### 1. A device token with an invisible character bricked the kiosk permanently
`apps/api/app/auth.py`, `apps/web/src/api.ts`

`secrets.compare_digest` raises `TypeError` on a `str` containing non-ASCII, so
the API answered **500, not 401**. Worse on the device: the browser refuses to
put a non-ASCII byte in a header at all, so `fetch` threw before any request
left the iPad, surfacing as `NetworkError` → "Can't reach the server." forever.
`clearToken()` fires on exactly one condition — a 401 — which could never
arrive. There was no route back to the setup screen.

A zero-width space or a non-breaking space survives a copy out of chat or email,
so this is a plausible first-setup mistake, not an exotic one. Measured:

| token | HTTP | recovers to setup | token cleared |
|---|---|---|---|
| wrong, plain ASCII | 401 | yes | yes |
| NBSP inside | request never sent | **no** | no |
| zero-width space inside | request never sent | **no** | no |

**Fixed:** compare as bytes (`.encode()`), still constant-time — every bad token
is now an honest 401. Client-side, `isSendable()` turns an unsendable stored
token into `ApiError(401)` so it takes the existing token-clearing path.
**Verified:** accented, NBSP, emoji, empty and oversized tokens all 401; all
three bad-token cases now land on the setup screen with the token cleared.

### 2. A failed tap changed nothing on screen — at all
`apps/web/src/App.tsx`

When `POST /complete` failed, the catch restored the row and said nothing: no
toast, no banner, no colour change. Because the failure returns fast, React
batched the optimistic update and the rollback into a single render, so the
green state was painted for **1 frame out of 130** (~8ms) — imperceptible. A
pixel diff of the screen before the tap and 3s after a failed tap: **0 of
3,499,200 pixels changed.** Pressing the button and pressing a picture of the
button were identical. True for every failure mode: abort, 500, 404, 401, 502
HTML, truncated JSON.

**Fixed:** a red error toast naming the chore. **Verified:** shown for a genuine
500, with the chore's title, and no Undo button on it.

### 3. The silent rollback was a guess, and displayed the opposite of the database
`apps/web/src/App.tsx`

`catch { applyInstance(instance) }` assumed a failed request meant the server did
nothing. When the write commits and only the *response* is lost — the ordinary
shape of a mid-tap wifi drop — the kiosk reverted to the wrong value and showed
it as fact until the next poll, up to 60s later. Reproduced in both directions
(a complete showing as not-done, and an undo showing as done).

**Fixed:** roll back, then `await refresh()` and reconcile against the returned
board. **Verified:** with the write committed and the reply dropped, the row
repaints green and the DB agrees.

### 4. Any second tap un-did the chore, at every interval from 60ms to 1.2s
`apps/web/src/App.tsx`

The row was a toggle over optimistic state with no guard, so the universal
"did that register?" second tap sent `uncomplete`. The chore ended unrecorded
**and** the toast — the only confirmation — was actively cleared. There was no
interval at which a second tap was safe.

An in-flight lock alone does **not** fix this, and the first attempt at one
didn't: the API answers in milliseconds, so the second tap arrives after the
first has settled and reads as a deliberate toggle. Caught by testing the fix.

**Fixed:** `TAP_COOLDOWN_MS` (2s) per row. Inside the window a repeat tap
re-asserts the current state via the toast instead of reversing it — not
silently ignored, because a swallowed tap is what "broken" looks like. Undo
clears the row's cooldown so a deliberate reversal still works immediately.
**Verified:** at gaps of 60/120/250/400/700/1200ms the app now sends only
`complete` and the chore ends done.

### 5. Un-completing happened in total silence
`apps/web/src/App.tsx`

The feedback was backwards: completing gave a 6s toast **with Undo**; the
destructive direction gave nothing at all. One stray brush on a done row erased
a completion with no message and nothing to press.

**Fixed:** an `undone` toast confirms it. (That it still carries no Undo of its
own is recorded below as FIX NEXT SLICE.)

### 6. A routine board poll reverted the row under the kid's finger
`apps/web/src/App.tsx` — found by the lead, not a critic

`refresh()` called `setBoard(b)` wholesale, so any poll landing between a tap
and its response overwrote the optimistic row. Traced:

```
15.96s  POST /complete sent
16.27s  row GREEN (optimistic)     ← kid sees the tick
16.32s  GET /board (routine poll)
17.31s  row PLAIN                  ← tick VANISHES
18.48s  complete responds 200
19.38s  row GREEN again
```

The 60s timer, `focus` and `visibilitychange` could all trigger it — and the
tick disappearing is exactly what makes a kid tap again, which (per finding 4)
un-did the chore.

**Fixed:** `refresh()` keeps the optimistic row for any instance in `pending`.
**Verified:** the row now holds green through a mid-flight poll.

### 7. The toast's Undo button sat inside a live chore row
`apps/web/src/index.css`, `apps/web/src/App.tsx`

With a full list the fixed-position toast landed on top of the list. The Undo
button's box fell **entirely inside the bottom row's box**, so for six seconds
after every completion, a tap aimed at that chore hit Undo — reversing the
previous completion *and* not completing the one aimed at. A tap on the toast
body was swallowed entirely. Confirmed by hit-testing: the centre of the last
row returned `BUTTON | text=Undo`.

**Fixed:** `.sheet.grow` reserves a 116px strip so the list never paints under
the toast (reserved permanently rather than added on show — shifting rows under
a finger mid-tap is its own hazard), plus `pointer-events: none` on the toast
body so only Undo is interactive. **Verified:** 17px clearance, zero visible
rows clashing, and nothing but the sheet under Undo at either scroll position.

### 8. The offline banner covered the name and part of the Back button
`apps/web/src/index.css`, `apps/web/src/App.tsx`

`position: fixed; top: 0` landed on the header exactly when things were already
going wrong: **61% of the person's name** covered, and the top 11px of the Back
button — which also won the hit test there, shrinking the only way off the
person screen from 56px to 45px.

**Fixed:** the banner renders in normal flow inside `Shell`. **Verified:** 0px
overlap with both, and Back's top edge now hit-tests to Back.

### 9. "Try again" produced no response while the API was down
`apps/web/src/App.tsx`

`onClick={() => void refresh()}` set no pending state, so the DOM was unchanged
before, during and after. Each tap fired a real request (8 taps → 8 requests)
with no indication anything had happened. Wording was also adult jargon with no
instruction.

**Fixed:** a `retrying` state showing "Trying…", the button disabled during it,
and a "Tell a grown-up if it keeps saying this." line.

### 10. The chore row had no press feedback
`apps/web/src/index.css`

`.trow:active { transform: scale(0.995) }` — a 0.5% shrink on a 990px row, about
2px per side, with no background change. The most-pressed control in the app had
~6× weaker feedback than `.pcard` (`scale(.97)` plus a background lift) beside
it. Combined with findings 2 and 3, a failed tap had no press state, no
optimistic paint and no message.

**Fixed:** `scale(.98)` plus a background change, with a done-row variant.

### 11. The progress ring carried almost no information
`apps/web/src/index.css`

The gold arc against its own track measured **1.59–1.63:1** against a 3:1 bar
for a graphic you must perceive to read the screen. The track against the card
was 1.51–1.56:1. It degraded from there: 1.34:1 under 30% glare, 1.21:1
off-axis + glare. Not a colour-blindness problem (deuteranopia 1.60:1) — a pure
luminance one, which is why glare and viewing angle killed it. At six feet the
130px ring separated done from not-done at 1.45:1 while the ~20px pill beneath
it did so at 4.48:1. The biggest graphic on the board was decoration that looked
like data.

**Fixed:** the track is darkened (`rgba(35,28,59,.45)`) instead of lightened, and
the arc thickened 7px → 11px. **Verified:** gold vs track **4.54:1**.

### 12. A kid at 0% got the same ring as the dependent who cannot be tapped
`apps/web/src/index.css`

`conic-gradient(gold calc(--p * 1%), track 0)` at `--p: 0` renders as solid
track — byte-identical to `.ring-none`, the dependent's ring. Measured 1.12:1
apart, and that residual was the card fill behind it, not the ring. 0-of-N is
the state every kid is in every morning, so that is exactly when the board drew
them as "the person with nothing, who isn't a button."

**Fixed:** the dependent now has no ring at all (`background: none; padding: 0`).
**Verified:** dependent ring has no conic track and is visibly smaller.

### 13. The empty tick circle — the only "tap me" mark on a row — was at 1.31:1
`apps/web/src/index.css`

`#D9D3EE` on `#F4F2FB`, against a 3:1 bar, falling to 1.14:1 under off-axis +
glare. On a glare-washed panel the circles vanish and the row is a flat lilac
slab with words on it.

**Fixed:** border darkened to `#847BB2`. **Verified:** 3.47:1.

### 14. The dependent card was indistinguishable from a tappable one
`apps/web/src/index.css`

Card body vs an adjacent tappable card: **1.10:1**. Same size, same border, same
ring, same avatar, same name typography. The only real difference was the absent
count pill, which reads as "no chores" or "still loading", not "don't touch".
Tapping it produced nothing — no navigation, no `:active`, no message — which is
what a frozen app looks like.

**Fixed:** no card background, no border, smaller ring and name, `opacity .75`,
so it reads as a label in the row rather than a fifth button. Still a face and a
name, still no count, still nothing to press.

### 15. The person screen celebrated an empty list
`apps/web/src/App.tsx`

`countLabel` deliberately refuses to say "All done" for an empty list — and
twelve lines later the person screen rendered **"No chores today 🎉"** over
"0 of 0 tasks done". That state is not exotic: it is what the wall shows every
day after the seeded day (there is no materializer this slice), and every night
after midnight. The confetti was decorating an absence of data.

**Fixed:** "Nothing on your list today." — no confetti.

### 16. The error toast told the kid to undo work that had actually saved
`apps/web/src/App.tsx` — **introduced by the fix for finding 3**

Caught only because the adversarial critic re-tested against the patched tree.
When a write committed but the response was lost, the new reconcile correctly
repainted the row **green with "Done ✓"** while the toast simultaneously said
`Couldn't save "Feed the dog". Tap it again.` One screen, two contradictory
statements — and obeying the red one sent `uncomplete` and deleted the
completion. The 2s cooldown only delayed it.

**Fixed:** the toast now reports what the reconcile actually found. It only
claims failure when the reconciled row shows the write did not happen.
(The pending-set entry is also released *before* the reconcile, or `refresh()`
would preserve the row it just rolled back and defeat its own purpose.)
**Verified:** committed-but-lost-response now shows a green row and a "— done"
toast; a genuine 500 still shows the error and still says to tap again.

### 17. The Undo button rode across screens onto the next kid
`apps/web/src/App.tsx`

The toast was global and survived every navigation. Kid One completes a chore
and taps Back; for the remaining ~6s the family screen — and then whatever
person screen the next kid opens — carried a live Undo pointing at Kid One's
instance. Kid Two's screen said "Kid Two" at the top and the one floating button
wiped Kid One's completion. A second route to the same state: tap a chore and
hit Back before the write lands, and the toast materialises on the family screen
*after* the kid who caused it has walked away.

**Fixed:** the toast carries the `memberId` of the screen that raised it and is
only rendered when that matches the current screen. **Verified:** Undo is
present on the originating screen, absent on the family screen, absent on the
other kid's screen, and a toast whose response lands after Back never appears.

---

## FIX NOW — round 2: defects the round 1 fixes introduced

Every one of these was caused by a fix above. All fixed and verified.

### 18. A hung request pinned a permanent false ✓ and killed the row
`apps/web/src/api.ts`, `apps/web/src/App.tsx` — caused by fix 6

`pending` was cleared only in `finally`, and nothing in `api.ts` had a timeout,
so a request that never settled kept its id in `pending` **forever**. Fix 6's
merge then dutifully preserved that row's optimistic value against every poll,
focus refetch and visibility refetch. Two compounding effects: the wall showed a
✓ the database did not have, permanently; and `toggle` early-returns on a
pending row, so it stopped accepting taps entirely. Measured over 190s: five
successful board fetches all disagreed with the screen and all lost. Only a full
page reload cleared it — not something a kid can do to a wall-mounted PWA.

Not hypothetical: `statement_timeout` is `0`, so a row lock blocks `POST
/complete` indefinitely (a `curl --max-time 20` gave up first, at
`http_code=000`); and Wi-Fi dropping after a request is on the wire leaves a
half-open socket with no RST.

Before fix 6 the 60s poll corrected this. Fix 6 is what made the lie permanent.

**Fixed:** `AbortSignal.timeout(20_000)` on every request. **Verified:** the
tick clears after the timeout, the kid is told, and the row still accepts taps
afterwards.

### 19. A slow board GET erased the tick of a chore that had saved
`apps/web/src/App.tsx` — caused by fix 6

The merge protected only rows *still* in `pending`. A board GET issued **before**
a write and answered **after** it arrives once the write has finished and left
the set, so the stale snapshot overwrote a committed row. Round 1's symptom was
"the tick vanishes and comes back"; this one vanishes and does **not** come
back until the next 60s poll. Reproduced at board latencies of 2500, 1200, 800,
400 and **250ms** — and the everyday trigger needs no artificial delay, because
waking the iPad fires two board GETs that a cold Lambda answers in 1–3s while a
warm write answers in ~200ms.

**Fixed:** a `writeSeq` counter; `refresh()` captures it at issue time and keeps
any row written since. **Verified:** the tick survives at 800/1500/2500ms.

### 20. The cooldown swallowed the retry the error toast demands
`apps/web/src/App.tsx` — caused by fixes 2 and 4 together

The error toast says **"Tap it again."** and renders ~40–80ms after the tap. But
`lastTap` was stamped at the *start* of the failed tap, so the row stayed in
cooldown for ~1.95s — squarely across the 0.5–1.5s a human takes to read and
re-tap. The obedient retry sent nothing. Measured dead window: 1.92–1.97s,
beginning the instant the instruction appears.

**Fixed:** a failed write clears that row's cooldown — nothing was written, so
there is nothing to protect. **Verified:** retries at 400/900/1500ms all go out
and save.

### 21. The cooldown toast claimed work had been undone when nothing happened
`apps/web/src/App.tsx` — caused by fix 4

The cooldown branch re-asserted state by reusing `done`/`undone`, which are
worded as **transitions**. So a tap the code deliberately did not act on was
reported as an action: "Feed the dog — not done any more". Combined with the
above, the sequence was: tap fails → "Tap it again." → kid taps → no request →
"not done any more".

**Fixed:** a new `already` kind that states the row — "… is already done ✓" /
"… is not done yet". **Verified.**

### 22. The in-flow offline banner moved every chore row 46px
`apps/web/src/index.css`, `apps/web/src/App.tsx` — caused by fix 8

Fix 8 stopped the banner covering the Back button by putting it in flow — and
in doing so made it push the whole list down by its own height whenever the
network hiccupped. Measured 46.0px against a 104px row pitch and a 92px row:
**37% of a row became the row above it**, the next 12px became dead gap, and a
tap that straddled the change was swallowed entirely (Chrome fires `click` on
the common ancestor, so it vanished into the `<ul>` with no toggle and no
toast). It toggles repeatedly on a flaky link. A kid aiming at "Make your bed"
marked "Homework folder in backpack" done.

The `.sheet.grow` comment already named "shifting the list under a finger
mid-tap" as a hazard; fix 8 reintroduced exactly that.

**Fixed:** the banner is always rendered and its strip permanently reserved;
only `visibility` toggles. It neither covers a control nor moves the list.
**Verified:** rows sit at identical pixels with the banner on and off.

### 23. "Try again" could stick on "Trying…" forever
`apps/web/src/App.tsx` — caused by fix 9

`refresh()` swallows every error, so it settles only when the fetch settles —
and there was no timeout. Against a hung request `.finally` never ran and
`retrying` was stuck `true` with no other path to clear it. The flag outlived
the failure: after a token wipe, a grown-up who typed the **correct** token met
a fresh error card with a greyed-out "Trying…" button and zero requests in
flight. Fix 9 existed because a retry that changed nothing looked dead; it now
looked *busy* forever, which is worse.

**Fixed:** guarded re-entry, a 25s hard stop, and a reset when the token
changes.

### 24. The merge preserved the row it had just rolled back
`apps/web/src/App.tsx` — caused by fix 19, found while verifying it

A React subtlety, not a logic error: the `setBoard` updater is a closure React
runs **later, during render**. It read `lastWrite` lazily, and by then the catch
had already recorded the write — so `seq > issuedAt` was true and the merge
preserved the stale rolled-back row instead of the server's truth. The symptom
was the committed-but-lost-response case regressing: DB done, toast "— done",
row plain. A later refresh corrected it, which is what identified the cause.

**Fixed:** snapshot the `keepLocal` set eagerly when the response lands, rather
than reading refs inside the updater.

### 25. The dependent's name shrink was dead CSS, and its dimming hurt contrast
`apps/web/src/index.css` — caused by fix 14

`.pcard-static .nm` has equal specificity to `.pcard .nm` and was declared
earlier, so it **silently never applied** — the name rendered at full size and
half of fix 14 never ran. Separately, `opacity: .75` on the card dropped that
name to 3.56:1 (2.88:1 under 15% glare), making it the first name on the board
to fail — a fix that made one thing worse while fixing another.

**Fixed:** doubled class to win the tie, and the dimming moved onto the ring so
the name keeps full contrast. **Verified:** 16.2px vs a sibling's 20.52px, card
opacity back to 1.

### 26. The chore list had no cue when rows were clipped
`apps/web/src/App.tsx`, `apps/web/src/index.css` — round 1 FIX NEXT SLICE 25, made worse by fix 7

Fix 7's 116px reserve cut the visible list by one row, and at 1080×810 with six
chores the list ended **flush — a 0px sliver, no cue at all**. The banner
reservation later moved the fold and that exact case is gone, but at 1024×768
the fold still lands on a **23.1px band containing nothing**: 0 of 44px of the
check circle, 0 of 26px of the title, strongest mark 1.11:1, and iPadOS overlays
the scrollbar so there is none. Whether the cue was adequate was an accident of
viewport height, not a decision.

**Fixed:** a bottom fade applied only while content is genuinely clipped,
measured with a scroll listener and a `ResizeObserver` — so it never suggests
more content when the list ends. **Verified** across seven viewports: the cue
appears exactly when something is clipped, is absent when the list fits, and
disappears once scrolled to the bottom.

---

## FIX NEXT SLICE — real, not blocking, not started

**API and data**
1. `complete`/`uncomplete` accept any instance in the household regardless of
   `due_on`, while `GET /board` is scoped to today. A past-dated miss can be
   silently erased. One-line guard: add `and due_on = %s` to both UPDATEs.
2. The dependent rule is application-only. Once a row holds a dependent's id
   (e.g. a parent demotes a child after they completed something), `coalesce`
   preserves it and `uncomplete` has no role check at all — the API refuses to
   *create* a state it happily serves and preserves.
3. A dependent's assigned chore is completable by anyone (`assignee_id` is never
   role-checked), and is simultaneously unreachable from the kiosk.
4. The check and the write are in separate transactions (`autocommit=True`), so
   the application-level dependent rule is TOCTOU-racy against a concurrent role
   change. Reasoned from the source; the race was not won in testing.
5. Schema enforces none of the row-level assumptions: no
   `check ((completed_at is null) = (completed_by is null))`, no composite FK on
   household, no dependent constraint. *(Schema change → automatically here.)*
6. `/docs`, `/redoc` and `/openapi.json` are unauthenticated and reachable in
   production — `require_kiosk` is a router dependency, so it guards `/api/*`
   only. One-line fix: `docs_url=None, redoc_url=None, openapi_url=None`.
7. `completed_by` is structurally incapable of recording who tapped: the client
   can only ever send the assignee of the row, so `completed_by = assignee_id`
   in 100% of rows. Verified: `select bool_and(completed_by = assignee_id) …` →
   `t`. Recording the tapper needs an identity the kiosk does not have.
8. `uncomplete` takes no body — an unattributed destructive write that discards
   the original completion time irrecoverably.

**Tap and toast**
9. Undo reverses the *previous* chore during the optimistic window: the row goes
   green on tap but the toast retargets a round trip later. At 600ms latency
   that window is 600ms wide — exactly when a kid who mis-tapped reaches for it.
10. The `undone` toast has no Undo. The reversible action got the safety net;
    the irreversible one did not.
11. A second client shows a chore's state wrongly for up to a poll interval
    (measured 54s) and its taps act on stale intent.
12. Two duplicate board fetches on every wake (`focus` and `visibilitychange`
    both fire), with no ordering guard, so an older response can land second.

**Failure and time**
13. On wake or after midnight the old board stays on screen unlabelled for the
    whole refetch — the header rolls to the new date while the cards below still
    show yesterday's completions. The stale machinery exists but is wired only
    to errors, not to "this data is from before you woke me".
14. A 9-second cold start shows one static word, "Loading…", with no motion —
    indistinguishable from a frozen kiosk.
15. On a slow network the toast and its Undo arrive ~9s after the tap, by which
    time nobody is standing there.
16. A 401 *on a tap* is not special-cased — it hits the same catch as any other
    failure. And when the board poll 401s, a kid is dropped onto an adult
    password prompt with no explanation and no way back.
17. No error boundary: a render-time exception blanks the whole kiosk with no
    recovery but a reload. Trigger used was synthetic (`response_model` should
    prevent the API emitting such a body), but the exposure is real.
18. The empty board is presented as normal rather than as "not set up" — which
    is what the wall will most likely show tomorrow morning.
19. The midnight refetch is spent on the *iPad's* clock, not the server's, so
    the header and board disagree for as long as the iPad is skewed (measured
    40s at +45s skew, 300s at +5min).
20. A wrong iPad clock puts a wrong date on the wall indefinitely with no
    reconciliation and no warning.
21. `resetLabel()` is wrong by a full hour between 00:00 and 01:59 on both DST
    days — wall-clock arithmetic over a 23- or 25-hour day.
22. The header is stale for up to 10s after wake (`TICK_MS`), so the wall shows
    last night's date and time over this morning's board.
23. A chore completed just before midnight loses its Undo while the toast is
    still on screen, because `toastInstance` is looked up in the current board.

**Visual and usability**
24. Every type ramp lands at 76–88% of its designed size on a 1080px iPad, and
    seven elements sit at their clamp *minimum* — including the count pill and
    the Undo button. Meanwhile 57% of the people grid is empty gradient.
25. A hidden overflow row has no cue: at exactly 7 rows the 7th is 0px visible,
    with no partial row, no fade and an overlay scrollbar.
26. The Back button's chip is 1.33:1 against the page, and its arrow is the only
    400-weight glyph in the app.
27. The family-reset strip uses the app's own button grammar (circular icon,
    bold title, muted subtitle, coloured pill) but is inert.
28. 11.5% of the task-list surface is inter-row gap that swallows a tap with no
    feedback.
29. The focus ring is `3px solid #fff` — invisible on every control inside the
    white sheet and on the entire setup screen (1.00:1).
30. The done-row tint is 1.01:1 (1.00:1 under deuteranopia) — the whole done
    signal rests on the check circle, which itself falls to 2.69:1 off-axis.
31. Member tile borders are 1.67:1 and fills 1.22:1 against the gradient; the
    only tap targets on the resting screen have edges below the 3:1 bar.

**Added in round 2**

32. A cooldown-ignored tap still re-aims the toast at a different chore, sliding
    the Undo button 76px; pressing it then erases the wrong one. A branch that
    ignores a tap should not mutate global toast state.
33. Two rows failing at once are announced as one — a single global toast, so
    the second failure is reported to nobody. Likewise a success toast can
    overwrite an error toast when another row settles after it.
34. Back pressed mid-reconcile buries a real failure: the error toast is
    member-scoped and is created after the kid has left, so it is never shown.
35. A failed tap can now log the kiosk out. The catch awaits `refresh()`, so a
    500 on `/complete` plus a 401 board clears the token and drops the wall to
    the setup screen within ~200ms, where before it waited for the next poll.
36. The toast resurrects on re-entry: Back then re-select the same person within
    `TOAST_MS` and the "— done [Undo]" toast reappears. It is hidden, not
    dismissed.
37. A tap that fails across midnight always reports a false failure — the
    reconcile looks the row up in the new day's board, does not find it, and
    says "Couldn't save".
38. A rejected token gives no feedback at all: the identical setup card returns
    with the input cleared and no message, on the one screen that exists to
    unbrick the kiosk.
39. `lastTap` and `lastWrite` are never pruned. Not a leak at this scale (UUID
    keys, ~10 rows/day, one ~100-byte entry per tap) and keys can never be
    reused, but nothing expires them.
40. The ring track is still only 1.95:1 against its own card (up from 1.48:1),
    so at 0% you cannot easily see that a ring is there. The arc-vs-track fix is
    real (1.60:1 → 4.62:1) but neither the arc nor the check border reaches its
    bar under 30% glare or off-axis (2.60:1 / 2.02:1).
41. `.trow:active`'s background change is 1.16:1 (todo) and 1.10:1 (done) — the
    done variant is 37% weaker, on the row most likely to be re-tapped. The
    `scale(.98)` is what actually makes the press read.
42. The error toast is the only toast that fails under glare: 6.84:1 flat but
    4.04:1 at 30% glare and 3.72:1 off-axis.
43. Un-ticking by accident costs a 2s lockout with no way out: the `undone` and
    `already` toasts carry no button, so the row is the only control and it is
    refusing.
44. Portrait 810×1080 orphans the dependent onto its own grid row with the lower
    two-thirds of the screen empty. Cosmetic, portrait only.

---

## ACCEPTED — known, deliberate, reasons recorded

1. **`completed_by` is client-chosen and forgeable.** This is a shared-device
   kiosk with one device token and no per-person identity; `CLAUDE.md` scopes
   adult login and roles out of this slice. Any member can be credited for any
   chore. Accepted because the alternative is an identity system, which is a
   different slice — but recorded so nothing is later built on this column as
   if it were an audit trail. See FIX NEXT SLICE 7.
2. **One kid can complete another kid's chore.** Same root cause, and inherent
   to a wall kiosk a child walks up to without logging in. The 12-year-old can
   clear the 11-year-old's list in 2.1 seconds and the board will say the
   11-year-old did it. Accepted for this slice; it is the strongest argument for
   per-person identity in a later one.
3. **CORS failure reads as "Can't reach the server."** Reproduced against a real
   cross-origin block. For a kid that is the right level of detail; for an adult
   it points at the wifi when the wifi is fine. The browser genuinely cannot
   distinguish the two, and `DEPLOY.md` already documents the preview-deploy
   trap. Recorded so it is not rediscovered as a bug.
4. **The board goes empty the day after seeding.** `seed.py` is the only writer
   of `chore_instances`, and the board is scoped to `due_on = today`, so day N+1
   returns nothing until someone re-seeds. Deliberate: the nightly materializer
   is explicitly out of this slice per `CLAUDE.md`, and `DEPLOY.md` documents
   the workaround. Verified it is correctly distinguishable from a failure —
   the error card and offline banner are separate code paths, so an empty board
   never reads as "the server is down". What *was* actionable about it — the
   celebration — is fixed as FIX NOW 15.
5. **Gradient banding sits at the visibility threshold.** 22 flat bands of ≥10
   CSS px, median Weber contrast 0.48%, max 0.53%; detectability begins around
   0.5–1%. A headless screenshot cannot settle it — the panel's own dithering
   and the ambient light level decide. Accepted rather than chased.
6. **The 2s tap cooldown blocks an immediate deliberate reversal by row tap.**
   Accepted: within that window the Undo button is on screen and is a bigger,
   clearer target than the row, and Undo clears the cooldown. The cost is a
   narrow one; the benefit is that no accidental double tap can erase a chore.
7. **The reserved 116px toast strip costs vertical space permanently.** Accepted
   over showing it only when the toast appears, because that would shift rows
   under a finger mid-tap — trading a layout hazard for a space cost. The
   offline banner's 44px strip is reserved for the same reason, and for the same
   reason: round 2 proved the alternative causes mistaps. 160px total. The
   reserve does its job — the toast clears the list at every viewport tested,
   by 11–15px.
8. **The offline banner red and the error toast red are the same colour** and
   can be on screen together. They are told apart by position and shape only —
   a full-width strip at the top versus a pill at the bottom. Accepted: colour
   carries no information there, but position does, and both are unambiguous.
9. **`isSendable()` is slightly stricter than HTTP requires.** It rejects space
   and tab, which HTTP would strip and the API accepts. Unreachable in practice
   (`TokenSetup` trims), and a false rejection lands on the recoverable setup
   screen. Accepted over loosening a security-adjacent check.

---

## What could not be verified here

Everything physical. Real glare, true off-axis behaviour on the actual panel,
the genuine six-foot read, and Safari standalone-PWA rendering need the iPad on
the wall. Glare was modelled as an additive white veil (15% / 30%), off-axis as
gamma 0.8 + raised black + contrast compression, distance as area downsampling —
these establish the *ranking* of what gives out first and roughly by how much,
not the behaviour of a specific panel. The as-rendered contrast numbers are
exact; the degraded ones are directional. `DEPLOY.md` Part D already carries the
wall test for the error state.

One methodological note: all six critics shared one database, and their
concurrent writes corrupted several DB-level assertions mid-run (including some
of the lead's). Findings were re-verified by request-sequence and UI assertions,
or against state set up immediately before measurement. The adversarial critic
installed an audit trigger capturing the causing SQL so the app's writes could
never be confused with another agent's.
