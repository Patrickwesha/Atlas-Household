// Clock and date for the kiosk header.
//
// Everything here is pinned to APP_TIMEZONE, deliberately. The board's "today"
// is resolved SERVER-side in APP_TIMEZONE (see apps/api/app/routes.py `_today`),
// so if the header used the iPad's own timezone the two could disagree — the
// header would read one date while the chore list below it was for another.
// Pinning both to the same zone makes that impossible.
//
// This mirrors the API's APP_TIMEZONE default. It is not a secret (it is in the
// committed .env.example); it is a display constant. If the family ever moves,
// this and the API's APP_TIMEZONE change together.
export const APP_TIMEZONE = 'America/Chicago'

// The nightly family reset, shown as a schedule. 21:30 = 9:30 PM.
// A display of when it happens — the app makes no claim that it was done.
//
// ONE SOURCE OF TRUTH. This used to be an hour constant here plus the string
// "8:00 PM" written out separately in TWO more places (the "Tomorrow …" branch
// below, and the strip subtitle in App.tsx). Three independent literals for one
// fact: move the reset and the countdown starts counting to a time the copy
// beside it does not say. The strip is the one thing everyone in the house
// looks at, so it must not be able to contradict itself. RESET_AT is formatted
// from the same numbers the countdown counts to.
//
// Practice runs 6:30–8:30 PM, which is why this is not 8:00 PM: a reset that
// starts mid-practice is one nobody can be at.
const RESET_HOUR = 21
const RESET_MINUTE = 30

/** "9:30 PM" — built from the constants above, never typed out separately.
 *
 *  Hand-formatted rather than via Intl: this is a fixed wall-clock rule in
 *  APP_TIMEZONE, not an instant, and formatting it through a Date would render
 *  it in whatever zone the iPad happens to be set to. */
function to12Hour(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`
}

export const RESET_AT = to12Hour(RESET_HOUR, RESET_MINUTE)

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
})

const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

// en-CA gives an ISO-shaped YYYY-MM-DD, which sorts and compares cleanly.
const keyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const hourMinuteFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: false,
})

/** "9:41 AM" */
export function formatClock(now: Date): string {
  return timeFmt.format(now)
}

/** "Friday, August 7" */
export function formatDate(now: Date): string {
  return dateFmt.format(now)
}

/** "2026-08-07" in APP_TIMEZONE — the same calendar day the API means by
 *  "today". Used to notice a midnight rollover. */
export function dateKey(now: Date): string {
  return keyFmt.format(now)
}

/** Wall-clock minutes since midnight in APP_TIMEZONE.
 *
 *  Read out of the formatter rather than computed with arithmetic on purpose:
 *  it is the wall clock the family reads, so DST transitions need no special
 *  case — on the spring-forward day 2am simply never appears. */
function minutesSinceMidnight(now: Date): number {
  const parts = hourMinuteFmt.formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  // hour12:false can render midnight as 24 in some engines; normalise it.
  return (hour % 24) * 60 + minute
}

/** Schedule text for the nightly reset strip: "in 3h 12m" / "Starting now" /
 *  "Tomorrow 9:30 PM". Describes the schedule only — never whether it was done. */
export function resetLabel(now: Date): string {
  const diff = RESET_HOUR * 60 + RESET_MINUTE - minutesSinceMidnight(now)
  if (diff > 15) {
    const h = Math.floor(diff / 60)
    const m = diff % 60
    return `in ${h ? `${h}h ` : ''}${m}m`
  }
  if (diff > -15) return 'Starting now'
  return `Tomorrow ${RESET_AT}`
}
